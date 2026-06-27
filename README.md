# 🔑 KeyMux

A local **proxy + web dashboard** that rotates your Claude Code API keys across
multiple providers (**AeroLink** and **Freemodel**) — so you set your base URL
**once** and never touch `~/.claude/settings.json` again.

KeyMux sits between Claude Code and the real providers. Point Claude Code at
`http://localhost:7777`, manage all your keys from a dark, polished dashboard at
`http://localhost:7778`, and let KeyMux automatically rotate to the next key when
one hits a rate limit (`429`) or auth error (`401`).

```
┌──────────────┐      ┌───────────────────────┐      ┌──────────────────────┐
│ Claude Code  │ ───► │  KeyMux proxy :7777   │ ───► │ AeroLink / Freemodel │
└──────────────┘      │  • picks active key   │      └──────────────────────┘
                      │  • rotates on 429/401 │
                      │  • logs every request │      ┌──────────────────────┐
                      └───────────┬───────────┘ ◄─── │   Dashboard :7778    │
                                  │   shared store    │  add / test / rotate │
                                  └───────────────────┴──────────────────────┘
```

---

## Features

- **One-time setup.** Set `ANTHROPIC_BASE_URL` to `http://localhost:7777` once.
- **Multiple keys & accounts per provider.** Pool as many AeroLink / Freemodel
  keys as you like, each tagged with the **account** it came from.
- **Weekly-limit tracking with auto-revive.** Each key has its own weekly reset
  time. Mark a key **Exhausted** when its weekly cap is spent — KeyMux benches
  it (and skips it during rotation) until its reset arrives, then automatically
  brings it back and rolls the reset forward 7 days for the next cycle.
- **Automatic rotation** on `429` / `401` / network errors — retries the request
  once on the next **usable** key, preferring the **same provider first** (keeps
  model compatibility intact), then any healthy key. Exhausted keys are skipped.
- **Live dashboard** — currently active key (masked), full pool with
  Active / Standby / Failed / Exhausted status, glowing indicators, account tags,
  reset countdowns, last-used times, and a live activity log (last 20 requests).
- **Per-model health test.** Fire a tiny 1-token request to confirm a specific
  model (e.g. `claude-opus-4-5`, `glm-4.6`) actually works on a given key.
- **No secrets in the browser.** Keys are masked (`aero_live_****R0k`); raw keys
  never leave the server.

---

## Requirements

- **Node.js 18+** (uses built-in `fetch`). Node 20/22/24 all fine.

---

## Setup

```bash
git clone https://github.com/SomuG25/KeyMux.git
cd KeyMux
npm install
npm start
```

On start, KeyMux prints the exact `settings.json` snippet to paste. Then:

### 1. Add your keys

Open **http://localhost:7778**, click **+ Add Key**, and add your provider keys:

| Field            | Example                          |
| ---------------- | -------------------------------- |
| Label            | `Aero aaplaclass007`             |
| Account          | `aaplaclass007`                  |
| Provider         | `AeroLink` or `Freemodel`        |
| API Key          | `aero_live_…` / `fe_oa_…`        |
| Weekly resets at | *(optional)* when this key's weekly limit refreshes |

The first key you add becomes active automatically.

### 2. Point Claude Code at KeyMux

Paste this into `~/.claude/settings.json` (this is also printed on `npm start`):

```json
{
  "apiKeyHelper": "echo 'keymux-local'",
  "env": {
    "ANTHROPIC_API_KEY": "keymux-local",
    "ANTHROPIC_BASE_URL": "http://localhost:7777",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": { "allow": [], "deny": [] },
  "model": "opus[1m]",
  "skipDangerousModePermissionPrompt": true
}
```

> The `ANTHROPIC_API_KEY` value is just a placeholder (`keymux-local`) — the real
> per-provider key is injected by the proxy. You never edit this file again;
> swap keys from the dashboard instead.

### 3. Use Claude Code as normal

All traffic now flows through KeyMux. Watch the live log light up, and let it
rotate keys for you when one rate-limits.

---

## Dashboard guide

| Control            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| **Set Active**     | Make that key the one the proxy forwards through.                   |
| **Test**           | Send a real 1-token request for a chosen model; shows status + latency. |
| **Exhausted**      | Bench a key whose weekly limit is spent, until a reset time you set. |
| **Restore**        | Bring an exhausted key back into rotation early.                    |
| **Delete**         | Remove a key from the pool.                                         |
| **+ Add Key**      | Add a new key (label, account, provider, key, optional reset).      |
| **Rotate Now**     | Manually switch to the next usable key (same-provider-first).       |

**Status meanings**

- 🟢 **Active** — the key the proxy is currently using.
- 🟡 **Standby** — healthy, waiting in the pool.
- 🔴 **Failed** — last request returned `401`/`429` or errored. Re-activating or
  testing it clears the failure.
- 🔵 **Exhausted** — weekly limit spent. Skipped during rotation and
  auto-revived when its reset time arrives (reset then rolls forward 7 days).

### Weekly cycles

Each key carries its own `resetAt` timestamp. KeyMux runs a reconciliation on
every request and dashboard refresh that:

1. Revives any **exhausted** key whose reset time has passed.
2. Rolls a passed reset forward in 7-day steps so the countdown always points at
   the *next* weekly reset.
3. Auto-advances the active key if it becomes exhausted/failed.

So you can mark a key exhausted the moment its weekly `$70` cap is gone and forget
about it — it comes back online by itself a week later.

---

## Configuration

| Env var               | Default | Description           |
| --------------------- | ------- | --------------------- |
| `KEYMUX_PROXY_PORT`   | `7777`  | Proxy listen port.    |
| `KEYMUX_DASH_PORT`    | `7778`  | Dashboard listen port.|

Providers are defined in [`src/providers.js`](src/providers.js):

| Provider  | Base URL                      | Key prefix   |
| --------- | ----------------------------- | ------------ |
| AeroLink  | `https://capi.aerolink.lat/`  | `aero_live_` |
| Freemodel | `https://cc.freemodel.dev/`   | `fe_oa_`     |

Add more providers by adding an entry there.

---

## How it works

- **Proxy** (`src/proxy.js`) buffers each request body (so it can replay on a
  retry), forwards it to the active provider with `Authorization: Bearer <key>`
  (and `x-api-key`), and streams the response straight back (SSE-friendly).
- On `429` / `401` / network error it marks the key **failed**, picks the next
  key (same provider first), switches the active key, and **retries once**.
- **Store** (`src/store.js`) persists the pool to `keys.json`. The active key,
  statuses, and last-used times survive restarts.
- **Log** (`src/log.js`) is an in-memory ring buffer shared by both servers.

---

## Security note

KeyMux is a **local, single-user tool** — it binds to localhost and stores keys
in plaintext `keys.json` (gitignored). Don't expose port 7777/7778 to a network
you don't trust. Be aware that third-party proxies terminate TLS and can see
your prompts; only route traffic you're comfortable sending through them.

---

## License

[MIT](LICENSE)
