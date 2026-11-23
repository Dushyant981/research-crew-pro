import { useState, useEffect } from 'react';

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Tiny Markdown renderer. Escapes first so model output can't inject HTML.
function md(text) {
  return esc(text).split(/\n{2,}/).map((b) => {
    if (/^#{1,3} /.test(b)) return b.replace(/^(#{1,3}) (.*)$/, (_, h, t) => `<h${h.length}>${t}</h${h.length}>`);
    if (/^[-*] /m.test(b)) return '<ul>' + b.split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>';
    return `<p>${b}</p>`;
  }).join('').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function api(path, token, options = {}) {
  return fetch('/api' + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
  });
}

function AuthForm({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    const res = await api(`/auth/${mode}`, null, { method: 'POST', body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) return setError(data.error);
    onAuth(data.token, data.email);
  }

  return (
    <form className="card auth" onSubmit={submit}>
      <h2>{mode === 'login' ? 'Log in' : 'Create account'}</h2>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="err" role="alert">{error}</p>}
      <button>{mode === 'login' ? 'Log in' : 'Sign up'}</button>
      <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}
      </button>
    </form>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [email, setEmail] = useState(localStorage.getItem('email'));
  const [topic, setTopic] = useState('');
  const [steps, setSteps] = useState([]);
  const [report, setReport] = useState(null); // { content, usage }
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const logout = () => { localStorage.clear(); setToken(null); setReport(null); setSteps([]); };
  const onAuth = (t, e) => { localStorage.setItem('token', t); localStorage.setItem('email', e); setToken(t); setEmail(e); };

  async function loadHistory() {
    const res = await api('/reports', token);
    if (res.status === 401) return logout();
    setHistory(await res.json());
  }
  useEffect(() => { if (token) loadHistory(); }, [token]);

  async function run(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSteps([]); setReport(null);
    try {
      const res = await api('/research', token, { method: 'POST', body: JSON.stringify({ topic }) });
      if (!res.ok) throw new Error((await res.json()).error);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const ev = JSON.parse(line);
          if (ev.error) throw new Error(ev.error);
          if (ev.final) { setReport({ content: ev.final, usage: ev.usage }); loadHistory(); }
          else setSteps((s) => {
            const key = ev.agent + (ev.note || '');
            const i = s.findIndex((x) => x.key === key);
            const next = { ...ev, key };
            return i < 0 ? [...s, next] : s.map((x, j) => (j === i ? next : x));
          });
        }
      }
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  async function open(id) {
    const res = await api('/reports/' + id, token);
    const r = await res.json();
    setSteps([]); setReport({ content: r.content, usage: r.usage });
  }
  async function remove(id) {
    await api('/reports/' + id, token, { method: 'DELETE' });
    loadHistory();
  }

  if (!token) return <main><h1>ResearchCrew</h1><p className="sub">AI agents that plan, research, write and review reports for you.</p><AuthForm onAuth={onAuth} /></main>;

  return (
    <main>
      <header>
        <h1>ResearchCrew</h1>
        <span>{email} <button className="link" onClick={logout}>Log out</button></span>
      </header>
      <form className="row" onSubmit={run}>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. How do vector databases work?" maxLength={200} required aria-label="Research topic" />
        <button disabled={busy}>{busy ? 'Crew is working…' : 'Run the crew'}</button>
      </form>

      <ul className="log" aria-live="polite">
        {steps.map((s) => (
          <li key={s.key} className={s.status}>
            <b>{s.agent}</b> {s.status === 'done' ? 'finished' : s.note || 'working…'}
            {s.output && <pre>{s.output}</pre>}
          </li>
        ))}
      </ul>
      {error && <p className="err" role="alert">{error}</p>}

      {report && (
        <article className="card">
          <div dangerouslySetInnerHTML={{ __html: md(report.content) }} />
          {report.usage && <p className="meta">{report.usage.inputTokens + report.usage.outputTokens} tokens used · {(report.usage.ms / 1000).toFixed(1)}s</p>}
        </article>
      )}

      <h2>Your past reports</h2>
      {history.length === 0 && <p className="sub">Reports you generate will appear here.</p>}
      <ul className="history">
        {history.map((h) => (
          <li key={h._id}>
            <button className="link" onClick={() => open(h._id)}>{h.topic}</button>
            <span>{new Date(h.createdAt).toLocaleDateString()} <button className="link danger" onClick={() => remove(h._id)}>Delete</button></span>
          </li>
        ))}
      </ul>
    </main>
  );
}
