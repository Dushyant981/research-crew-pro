# ResearchCrew Pro

Full-stack multi-agent research app. Users sign up, enter a topic, and a crew of AI agents (Planner, Researchers with web search, Writer, Critic) produce a cited report, streamed live and saved to their account.

**Stack:** React (Vite), Node.js, Express, MongoDB (Mongoose), JWT auth, Anthropic API.

## Run locally
1. `cp server/.env.example server/.env` and fill in the values
2. Terminal 1: `cd server && npm install && npm run dev`
3. Terminal 2: `cd client && npm install && npm run dev`
4. Open http://localhost:5173

## Production
`npm run build` then `npm start` (Express serves the built React app on one port).

## Engineering notes
- bcrypt password hashing, JWT (7-day expiry), per-route rate limits
- Agents: parallel research, sequential write, critique, revise
- NDJSON streaming for live progress; retries on 429/529
- Per-report token and latency tracking
- Model output is HTML-escaped before rendering
