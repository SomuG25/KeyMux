# 🔑 KeyMux

A local **proxy + web dashboard** that rotates your Claude Code API keys across
multiple providers (**AeroLink** and **Freemodel**) — so you set your base URL
**once** and never touch `~/.claude/settings.json` again.

KeyMux sits between Claude Code and the real providers. Point Claude Code at
`http://localhost:7777`, manage all your keys from a dark, polished dashboard at
`http://localhost:7778`, and switch keys yourself whenever you like — KeyMux
never rotates on its own, so the active key only changes when you tell it to.

```
┌──────────────┐      ┌───────────────────────┐      ┌──────────────────────┐
│ Claude Code  │ ───► │  KeyMux proxy :7777   │ ───► │ AeroLink / Freemodel │
└──────────────┘      │  • uses active key    │      └──────────────────────┘
                      │  • marks failed keys  │
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
  time. Mark a key **Exhausted** when its weekly cap is spent — KeyMux benches it
  until its reset arrives, then automatically brings it back and rolls the reset
  forward 7 days for the next cycle. (Benching never changes the active key —
  switch that yourself.)
- **Manual-only rotation.** The active key is **never** switched automatically.
  On `429` / `401` / network errors KeyMux marks the key **Failed** (red) and
  surfaces the error straight back to Claude Code — it stays active until you
  pick another. Use **Set Active** or **Rotate Now** in the dashboard to move
  traffic. Same-provider-first ordering when you do rotate.
- **Live dashboard** — currently active key (masked), full pool with
  Active / Standby / Failed / Exhausted status, glowing indicators, account tags,
  reset countdowns, last-used times, and a live activity log (last 20 requests).
- **Per-model health test.** Fire a tiny 1-token request to confirm a specific
  model (e.g. `opus[1m]`, `claude-sonnet-4-6`, `glm-5.2`) actually works on a given key.
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

All traffic now flows through KeyMux. Watch the live log light up. When the active
key rate-limits or errors, it turns red — switch to another via **Set Active** or
**Rotate Now** in the dashboard (KeyMux won't move traffic on its own).

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
- 🔴 **Failed** — last request returned `401`/`429` or errored. The key stays
  active and keeps receiving traffic until you switch — KeyMux does **not**
  auto-rotate off it. Re-activating or testing it clears the failure.
- 🔵 **Exhausted** — weekly limit spent. Skipped during rotation and
  auto-revived when its reset time arrives (reset then rolls forward 7 days).

### Weekly cycles

Each key carries its own `resetAt` timestamp. KeyMux runs a reconciliation on
every request and dashboard refresh that:

1. Revives any **exhausted** key whose reset time has passed.
2. Rolls a passed reset forward in 7-day steps so the countdown always points at
   the *next* weekly reset.
3. Marks a key **failed** (display only) when its requests error — it does **not**
   move the active key. Switch keys yourself via Set Active / Rotate Now.

So you can mark a key exhausted the moment its weekly `$70` cap is gone and forget
about it — it comes back online by itself a week later. (The active pointer only
ever moves when you move it, or when the active key is deleted.)

---

## Configuration

| Env var               | Default | Description           |
| --------------------- | ------- | --------------------- |
| `KEYMUX_PROXY_PORT`   | `7777`  | Proxy listen port.    |
| `KEYMUX_DASH_PORT`    | `7778`  | Dashboard listen port.|

Providers are defined in [`src/providers.js`](src/providers.js):

| Provider    | Base URL                      | Key prefix   | Limit model        |
| ----------- | ----------------------------- | ------------ | ------------------ |
| AeroLink    | `https://capi.aerolink.lat/`  | `aero_live_` | weekly reset       |
| Freemodel   | `https://cc.freemodel.dev/`   | `fe_oa_`     | weekly reset       |
| AgentRouter | `https://agentrouter.org/`    | `sk-`        | one-time credits   |
| OpenRouter | `https://openrouter.ai/api/`   | `sk-or-v1-`  | one-time credits   |
| Kimi       | `https://api.moonshot.ai/anthropic/` | `sk-`  | one-time credits   |

Add more providers by adding an entry there.

> **Providers must speak the Anthropic API** (`POST /v1/messages`), since that's
> what Claude Code sends. The providers listed above expose compatible endpoints. OpenAI-only
> gateways (e.g. BluesMinds) return `503 model_not_found` and aren't supported —
> they'd need a request/response/SSE translation layer.

**One-time-credit providers** (AgentRouter) have no weekly reset, so their keys
carry no `resetAt`. If you mark one **Exhausted**, it stays benched until you
**Restore** or delete it — there's no weekly clock to auto-revive it (unlike
AeroLink/Freemodel). AgentRouter blocks non-coding / NSFW traffic and may ban the key.

---

## Model mapping (per-provider)

Model support differs per provider, so rewrites are **per-provider** (defined as
`modelMap` in [`src/providers.js`](src/providers.js)). This avoids `400`s from
sending a model a provider doesn't carry. The swap is shown in the activity log.

By default **only the Haiku slot maps to GLM-5.2 on AeroLink** (the cheap
small/fast model). Providers without a `modelMap` pass Claude model names through;
OpenRouter and Kimi apply their mappings below.

| Claude Code model | On **AeroLink**        | On **Freemodel**     | Why |
| ----------------- | ---------------------- | -------------------- | --- |
| `*opus*`          | *(unchanged)*          | *(unchanged)*        | your main model stays real Claude Opus |
| `*sonnet*`        | *(real Sonnet)*        | *(real Sonnet)*      | Sonnet stays real Claude everywhere |
| `*haiku*`         | → **`glm-5.2`**        | *(real Haiku)*       | only AeroLink serves GLM; Freemodel would `400` on `glm-5.2` |

| Claude Code model | On **OpenRouter** | On **Kimi** |
| ----------------- | ----------------- | ----------- |
| **Any model name** (main, subagent, or internal) | → **`stealth/ox-alpha`** *(forced)* | Claude slots → **`kimi-k3`** |

Override the AeroLink GLM target with `KEYMUX_GLM_MODEL`. OpenRouter's Ox Alpha
target is deliberately fixed: selecting any model in Claude Code, including a
subagent model, is rewritten to `stealth/ox-alpha`. Add a `modelMap` to another
provider in `providers.js` to selectively remap models for that provider only.

> ⚠️ **Never set Claude Code's `model` to a raw `glm-*` name.** Select a Claude
> slot instead so KeyMux applies the active provider's safe mapping. AeroLink
> routes Haiku to GLM-5.2, OpenRouter force-routes every model to Ox Alpha, and Kimi
> routes every slot to K3. If the active key rejects GLM, the proxy marks it **failed** (red)
> with a reason and surfaces the error — it does **not** rotate off it.

> **Note:** KeyMux can't rename the labels in Claude Code's `/model` picker
> (those are Claude Code's). It only remaps what each slot routes to, per provider.

## How it works

- **Proxy** (`src/proxy.js`) buffers each request body (so it can replay on a
  retry), applies the active provider's model map (e.g. AeroLink Haiku→GLM), forwards to the
  active provider with `Authorization: Bearer <key>` (and `x-api-key`), and
  streams the response straight back (SSE-friendly).
- On `429` / `401` / network error it marks the key **failed** (red in the
  dashboard) but does **not** rotate — the active key stays put and the error is
  returned to Claude Code. Switch keys yourself via Set Active / Rotate Now.
- **Store** (`src/store.js`) persists the pool to `keys.json`. The active key,
  statuses, and last-used times survive restarts.
- **Log** (`src/log.js`) is an in-memory ring buffer shared by both servers.

---

## Share with your team / friends

KeyMux runs one shared key pool, so several people can point their Claude Code at
**your** KeyMux and transparently share the rotation, model mapping, and logs.

**Same network (LAN).** The servers listen on all interfaces, so a friend on the
same Wi-Fi just sets their `~/.claude/settings.json` `ANTHROPIC_BASE_URL` to your
machine's LAN IP:

```json
"ANTHROPIC_BASE_URL": "http://192.168.1.42:7777"
```

(Find your IP with `ipconfig`. They can also open `http://192.168.1.42:7778` to
watch the dashboard.) Every request they make shows up in your **Live Activity**
log with the key/provider/model used — so all traffic across everyone is visible
in one place.

**Different network.** Expose the proxy port with a tunnel and share the URL:

```bash
npx cloudflared tunnel --url http://localhost:7777    # or: ngrok http 7777
```

Each user sets `ANTHROPIC_BASE_URL` to the tunnel URL. (Tunnel `:7778` separately
if you want them to see the dashboard.)

## Security note

KeyMux stores keys in plaintext `keys.json` (gitignored) and has **no
authentication** — anyone who can reach port 7777 uses your keys, and anyone who
can reach 7778 can add/delete them. So only share it with people you trust, and
prefer a LAN or an authenticated tunnel over exposing it to the open internet.
Also note third-party proxies terminate TLS and can see your prompts; only route
traffic you're comfortable sending through them.

---

## License

[MIT](LICENSE)
