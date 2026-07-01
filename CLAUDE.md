# KeyMux — Agent Guide

Local proxy + dark web dashboard that rotates Claude Code API keys across
multiple Anthropic-compatible providers (AeroLink, Freemodel, AgentRouter)
without restarting Claude Code. Node.js + Express, vanilla HTML/CSS/JS.

## ⛓️ Persistent-memory protocol (READ THIS FIRST, EVERY SESSION)

This project uses a self-perpetuating context handoff so any fresh agent can
continue work seamlessly:

1. **On session start:** open and read **`plot.md`** (local, gitignored) — it is
   the living log of everything done, current state, gotchas, and next steps.
   It is NOT on GitHub; it lives only on this machine.
2. **Do the user's task.**
3. **After finishing any change:** UPDATE `plot.md` — append a dated entry to the
   changelog (prompt → what changed → result) and refresh the "Current state" and
   "Next / open" sections.
4. **Then push code to GitHub:** commit changed source files and `git push origin main`.
   ⚠️ `plot.md` and `keys.json` are gitignored — never commit them.

This loop = persistent memory across chats. Keep `plot.md` accurate; the next
agent trusts it.

## 🚫 Operational rules (learned the hard way — do not violate)

- **NEVER start or kill the KeyMux server yourself.** The USER runs it
  (`npm start`) and restarts it. A background `node server.js` started by an
  agent collides on ports 7777/7778 and has killed the agent's own session.
- **Add/edit keys via the RUNNING server's HTTP API**, not by editing `keys.json`.
  The running server holds keys in memory and rewrites `keys.json` on every
  request/reconcile, so direct file edits get clobbered. Use:
  - `POST   http://localhost:7778/api/keys` `{label,account,provider,key,resetAt?}`
  - `DELETE http://localhost:7778/api/keys/:id`
  - `POST   http://localhost:7778/api/keys/:id/activate|exhaust|restore|reset|test`
  - `GET    http://localhost:7778/api/state`
  If the server is confirmed NOT running, you may seed via `node` importing
  `src/store.js` — but verify ports are clean first.
- **`keys.json` holds real secrets** and is gitignored. Never commit or paste it.
- **Providers must speak the Anthropic API** (`POST /v1/messages`). OpenAI-only
  gateways (e.g. BluesMinds) return `503 model_not_found` and are unsupported.
- **Reset times:** convert relative offsets ("resets in 5d 17h") and clock times
  ("resets Sat 7:39 PM") to absolute ISO using the real system clock
  (`node -e 'new Date()'`), not assumptions.

## Run / verify

- Start (user does this): `npm start` → proxy `:7777`, dashboard `:7778`.
- Env overrides: `KEYMUX_PROXY_PORT`, `KEYMUX_DASH_PORT`, `KEYMUX_GLM_MODEL`.
- Syntax check before commit: `node --check src/<file>.js`.
- Static (HTML/CSS/JS) changes need only a browser hard-refresh; `src/*.js`
  changes need a server restart (user does it).

## Architecture

- `server.js` — boots proxy + dashboard in ONE process (shared store + log).
- `src/proxy.js` — forwards traffic, marks the active key FAILED on 401/429/network
  (but does NOT auto-rotate), rewrites every slot→GLM-5.2[1m] on AeroLink, streams
  SSE back. Switch keys manually via the dashboard's Set Active / Rotate Now.
- `src/dashboard.js` — REST API + serves `public/`. Endpoints listed above.
- `src/store.js` — `keys.json` persistence, weekly-cycle reconcile, masking.
- `src/providers.js` — provider registry (base URL, key prefix).
- `src/log.js` — in-memory ring buffer of recent activity.
- `public/` — dashboard UI (index.html, style.css, app.js). `paint()` guards
  repaints so the 2.5s poll doesn't flicker.

## Model lineup (the user's)

- Main: **Opus 4.8** (`opus[1m]` / `claude-opus-4-8`) — passthrough.
- Mid: **Sonnet 4.6** (`claude-sonnet-4-6`) — passthrough.
- Small/fast (Haiku slot): **GLM-5.2** — proxy rewrites any `*haiku*` model →
  `glm-5.2` on AeroLink (override `KEYMUX_GLM_MODEL`).

Opus/Sonnet/Haiku stay real Claude on Freemodel/AgentRouter (no `modelMap`). The
proxy marks any key that rejects GLM as **failed** (red) with a reason, but does
not rotate off it — switch via Set Active / Rotate Now.

## Key features

- Multiple keys/accounts per provider; each key tagged with its `account`.
- **Manual-only rotation.** The active key NEVER changes on its own — not on
  429/401/network errors, not when it's marked failed/exhausted. Switch keys via
  the dashboard's **Set Active** or **Rotate Now**. A failing key stays active
  (and shows red) until you pick another. `markFailed` only flips status for
  display; it doesn't move traffic.
- Weekly-limit cycle: mark a key **Exhausted** (with reset time) → stays benched
  (but still active if it was active) → auto-revived at reset → reset rolls +7
  days. One-time credit keys (AgentRouter, `resetAt: null`) stay benched until
  manually restored.
- Dashboard: active-key spotlight, status (active/standby/failed/exhausted),
  reset countdowns, live log, Set Active / Test (per-model) / Exhausted /
  Restore / Delete / Add / Rotate Now.

## Setup snippet (paste into ~/.claude/settings.json, base URL once)

```json
{ "apiKeyHelper": "echo 'keymux-local'",
  "env": { "ANTHROPIC_API_KEY": "keymux-local",
    "ANTHROPIC_BASE_URL": "http://localhost:7777",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" },
  "model": "opus[1m]" }
```

Repo: https://github.com/SomuG25/KeyMux
