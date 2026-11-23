require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const net = require('net');
if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);

const { MONGO_URI, JWT_SECRET, GEMINI_API_KEY, GEMINI_MODEL = 'gemini-3.8-flash', PORT = 5000 } = process.env;
const { GROQ_API_KEY, GROQ_MODEL = 'openai/gpt-oss-20b' } = process.env;
const USE_SEARCH = process.env.USE_WEB_SEARCH === 'true';
// FAST_MODE (default on) skips the Critic + revision stages. Set FAST_MODE=false for the full pipeline.
const FAST = process.env.FAST_MODE !== 'false';
// Researchers run one at a time by default (safer on free API tiers). Set PARALLEL_RESEARCH=true to run them together.
const PARALLEL = process.env.PARALLEL_RESEARCH === 'true';
// By default one research call answers all sub-questions (fewest API calls, best for free tiers). RESEARCH_MODE=separate uses one call per question.
const COMBINED = process.env.RESEARCH_MODE !== 'separate';
if (!MONGO_URI || !JWT_SECRET || !(GROQ_API_KEY || GEMINI_API_KEY)) {
  console.error('Missing env vars. Set MONGO_URI, JWT_SECRET and GROQ_API_KEY (or GEMINI_API_KEY) in server/.env.');
  process.exit(1);
}

// ---------- Models ----------
const User = mongoose.model('User', new mongoose.Schema({
  email: { type: String, unique: true, lowercase: true, trim: true },
  password: String,
}));
const Report = mongoose.model('Report', new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  topic: String, content: String,
  usage: { inputTokens: Number, outputTokens: Number, ms: Number },
}, { timestamps: true }));

// ---------- LLM + agents ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- LLM providers: each makes one attempt, adds token usage, and throws an error with .status on failure ----
async function groqCall(system, user, usage, max) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GROQ_API_KEY}` },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: GROQ_MODEL,
      // gpt-oss models "think" before answering and thinking tokens count toward the limit, so allow extra room and keep thinking short.
      max_tokens: max * 2,
      ...(GROQ_MODEL.startsWith('openai/gpt-oss') && { reasoning_effort: 'low' }),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`Groq API ${res.status}: ${await res.text()}`), { status: res.status });
  const data = await res.json();
  usage.inputTokens += data.usage?.prompt_tokens || 0;
  usage.outputTokens += data.usage?.completion_tokens || 0;
  return data.choices?.[0]?.message?.content || '';
}

async function geminiCall(system, user, usage, max) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: max * 4 },
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`Gemini API ${res.status}: ${await res.text()}`), { status: res.status });
  const data = await res.json();
  usage.inputTokens += data.usageMetadata?.promptTokenCount || 0;
  usage.outputTokens += data.usageMetadata?.candidatesTokenCount || 0;
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Tries Groq first, retrying on rate-limit/overload, then falls back to Gemini if a key is set.
async function callLLM(system, user, usage, { max = 1000 } = {}) {
  const chain = [GROQ_API_KEY && ['Groq', groqCall], GEMINI_API_KEY && ['Gemini', geminiCall]].filter(Boolean);
  let lastErr;
  for (const [name, fn] of chain) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn(system, user, usage, max);
      } catch (e) {
        lastErr = e;
        console.log(`${name} failed (attempt ${attempt + 1}): ${e.status || e.name}`);
        const retryable = !e.status || [429, 500, 503].includes(e.status);
        if (!retryable) { console.log(e.message.slice(0, 300)); break; } // bad key/model: skip to next provider
        await sleep(2000 * (attempt + 1));
      }
    }
  }
  throw new Error(lastErr?.status && ![429, 500, 503].includes(lastErr.status) ? lastErr.message : 'The AI service is busy. Try again in a minute.');
}

const agents = {
  planner: (topic, u) => callLLM('You are a research planner. Reply ONLY with a JSON array of exactly 3 short, distinct sub-questions. No markdown.', `Topic: ${topic}`, u),
  researcher: (topic, q, u) => callLLM(
    'You are a careful researcher. Answer in 120-180 words with concrete facts. ' + (USE_SEARCH ? 'Use web search and end with a "Sources:" line listing the URLs you used.' : 'Say so if you are unsure.'),
    `Overall topic: ${topic}\nSub-question: ${q}`, u, { max: 1500, search: USE_SEARCH }),
  researchAll: (topic, questions, u) => callLLM(
    'You are a careful researcher. Answer each numbered question in 100-150 words with concrete facts, under its own short heading. Say so if you are unsure.',
    `Overall topic: ${topic}\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`, u, { max: 2500 }),
  writer: (topic, notes, u, feedback = '') => callLLM(
    'You are a clear technical writer. Write a Markdown report: a # title, 2-3 ## sections, a short conclusion, and a "## Sources" list of any URLs from the notes. Under 450 words.',
    `Topic: ${topic}\n\nResearch notes:\n${notes}\n\n${feedback ? 'Critic feedback to address:\n' + feedback : ''}`, u, { max: 1800 }),
  critic: (report, u) => callLLM('You are a strict editor. Give 3 specific, actionable improvements as a short bullet list. Flag unsupported claims.', report, u),
};

// ---------- App + auth ----------
const app = express();
app.use(express.json({ limit: '10kb' }));

const sign = (user) => jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    req.userId = jwt.verify(token, JWT_SECRET).id;
    next();
  } catch { res.status(401).json({ error: 'Please log in again.' }); }
}

app.get('/api/health', (_, res) => res.json({ ok: true }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email = '', password = '' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (await User.findOne({ email })) return res.status(409).json({ error: 'That email is already registered.' });
  const user = await User.create({ email, password: await bcrypt.hash(password, 10) });
  res.json({ token: sign(user), email: user.email });
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const user = await User.findOne({ email: (req.body.email || '').toLowerCase() });
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) return res.status(401).json({ error: 'Wrong email or password.' });
  res.json({ token: sign(user), email: user.email });
});

// ---------- Reports ----------
app.get('/api/reports', auth, async (req, res) => {
  res.json(await Report.find({ user: req.userId }).sort('-createdAt').select('topic createdAt usage').limit(50));
});
app.get('/api/reports/:id', auth, async (req, res) => {
  const r = await Report.findOne({ _id: req.params.id, user: req.userId }).catch(() => null);
  r ? res.json(r) : res.status(404).json({ error: 'Report not found.' });
});
app.delete('/api/reports/:id', auth, async (req, res) => {
  await Report.deleteOne({ _id: req.params.id, user: req.userId }).catch(() => null);
  res.json({ ok: true });
});

const runLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Limit reached: 10 reports per hour.' } });
app.post('/api/research', auth, runLimiter, async (req, res) => {
  const topic = (req.body.topic || '').trim().slice(0, 200);
  if (!topic) return res.status(400).json({ error: 'Topic is required.' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  const send = (e) => res.write(JSON.stringify(e) + '\n');
  const usage = { inputTokens: 0, outputTokens: 0, ms: 0 };
  const t0 = Date.now();
  try {
    send({ agent: 'Planner', status: 'working' });
    const questions = JSON.parse((await agents.planner(topic, usage)).replace(/```json|```/g, '').trim());
    send({ agent: 'Planner', status: 'done', output: questions.map((q, i) => `${i + 1}. ${q}`).join('\n') });

    send({ agent: 'Researchers', status: 'working' });
    let answers;
    if (COMBINED) {
      answers = [await agents.researchAll(topic, questions, usage)];
    } else if (PARALLEL) {
      answers = await Promise.all(questions.map((q) => agents.researcher(topic, q, usage)));
    } else {
      answers = [];
      for (const [i, q] of questions.entries()) {
        send({ agent: 'Researchers', status: 'working', note: `researching ${i + 1} of ${questions.length}…` });
        answers.push(await agents.researcher(topic, q, usage));
      }
    }
    const notes = COMBINED ? answers[0] : questions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join('\n\n');
    send({ agent: 'Researchers', status: 'done', output: `${questions.length} sub-questions researched${COMBINED ? ' in one pass' : PARALLEL ? ' in parallel' : ''}${USE_SEARCH ? ' with web search' : ''}.` });

    send({ agent: 'Writer', status: 'working' });
    let content = await agents.writer(topic, notes, usage);
    send({ agent: 'Writer', status: 'done', output: FAST ? 'Report written.' : 'First draft written.' });

    if (!FAST) {
      send({ agent: 'Critic', status: 'working' });
      const feedback = await agents.critic(content, usage);
      send({ agent: 'Critic', status: 'done', output: feedback });

      send({ agent: 'Writer', status: 'working', note: 'revising' });
      content = await agents.writer(topic, notes, usage, feedback);
      send({ agent: 'Writer', status: 'done', output: 'Revision complete.', note: 'revising' });
    }

    usage.ms = Date.now() - t0;
    const saved = await Report.create({ user: req.userId, topic, content, usage });
    send({ final: content, id: saved._id, usage });
  } catch (err) {
    console.error(err);
    send({ error: err.message });
  }
  res.end();
});

// ---------- Serve the React build in production ----------
const dist = path.join(__dirname, '../client/dist');
app.use(express.static(dist));
app.get(/^\/(?!api).*/, (_, res) => res.sendFile(path.join(dist, 'index.html'), (err) => err && res.status(404).end()));

mongoose.connect(MONGO_URI).then(() => {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}).catch((e) => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
