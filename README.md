# Canna Index — Sector Intelligence

AI-powered cannabis-sector intelligence terminal (Vite + React) with a secure
serverless proxy to the Anthropic API.

## Project layout
- `src/CannaTracker.jsx` — the full app (UI, desks, living hero, etc.)
- `src/main.jsx` — mounts the app
- `api/claude.js` — Vercel serverless function; holds the API key and relays calls to Anthropic
- The browser calls `/api/claude`, never Anthropic directly, so the key stays server-side.

## Deploy (Vercel)
1. Push this folder to GitHub.
2. In Vercel: New Project → import the repo (framework preset: **Vite**).
3. Add an Environment Variable:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your Anthropic key (starts with `sk-ant-...`)
   - Apply to Production (and Preview/Development if you want).
4. Deploy. The `/api/claude` function is detected automatically.

## Run locally
- `npm install`
- Front-end only: `npm run dev` (the `/api/claude` function will NOT run under plain Vite).
- Full stack incl. the function: install the Vercel CLI and run `vercel dev`, with
  `ANTHROPIC_API_KEY` set locally (e.g. in `.env.local`, which is git-ignored).

## Notes
- Model is set to `claude-sonnet-4-6` in `src/CannaTracker.jsx` (`MODEL` constant). Change if needed.
- This is a prototype: market figures are AI-sourced and indicative; the newsletter
  form is not yet wired to storage. Caching + real data feeds are the next deployment steps.
