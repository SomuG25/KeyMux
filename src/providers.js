// Known providers. base must end with a trailing slash.
export const PROVIDERS = {
  aerolink: {
    id: "aerolink",
    label: "AeroLink",
    base: "https://capi.aerolink.lat/",
    keyPrefix: "aero_live_",
    // AeroLink serves GLM + Fable. Mappings (first match wins):
    //  - Sonnet (1M) → Fable 5  (regular Sonnet passes through as real Claude)
    //  - Haiku       → GLM-5.2
    //  - Opus / plain Sonnet    → unchanged (real Claude)
    modelMap: [
      { match: /sonnet/i, requires1m: true, to: process.env.KEYMUX_SONNET1M_MODEL || "claude-fable-5" },
      { match: /haiku/i, to: process.env.KEYMUX_GLM_MODEL || "glm-5.2" },
    ],
  },
  freemodel: {
    id: "freemodel",
    label: "Freemodel",
    base: "https://cc.freemodel.dev/",
    keyPrefix: "fe_oa_",
    // Freemodel only serves Claude model names — no rewrites (glm-5.2 would 400).
  },
  agentrouter: {
    id: "agentrouter",
    label: "AgentRouter",
    base: "https://agentrouter.org/",
    keyPrefix: "sk-",
    oneTimeCredit: true, // one-time credit pool, no weekly reset
  },
  zenmux: {
    id: "zenmux",
    label: "ZenMux",
    base: "https://zenmux.ai/api/anthropic/",
    keyPrefix: "sk-ai-v1-",
    oneTimeCredit: true, // balance-based, no weekly reset
    // ZenMux exposes free Anthropic models under -free ids. Route:
    //  - Sonnet (1M) → free Fable 5   - Sonnet (regular) → free Sonnet 5
    //  - any explicit fable → free Fable 5
    // (Requires a positive ZenMux balance — even "free" models need it.)
    modelMap: [
      { match: /sonnet/i, requires1m: true, to: "anthropic/claude-fable-5-free" },
      { match: /sonnet/i, to: "anthropic/claude-sonnet-5-free" },
      { match: /fable/i, to: "anthropic/claude-fable-5-free" },
    ],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    base: "https://openrouter.ai/api/",
    keyPrefix: "sk-or-v1-",
    oneTimeCredit: true,
    // Keep this profile intentionally limited to its two requested models:
    // Kimi K3 is primary; Haiku-class work uses GLM-5.2.
    modelMap: [
      { match: /opus|sonnet|fable/i, to: "moonshotai/kimi-k3" },
      { match: /haiku/i, to: "z-ai/glm-5.2" },
    ],
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    base: "https://api.moonshot.ai/anthropic/",
    keyPrefix: "sk-",
    oneTimeCredit: true,
    // The verified Anthropic-compatible model identifier is Kimi K3.
    modelMap: [{ match: /opus|sonnet|haiku|fable/i, to: "kimi-k3" }],
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || null;
}

// Join a provider base URL with an incoming request path, avoiding double slashes.
export function buildUpstreamUrl(base, reqPath) {
  const b = base.replace(/\/+$/, "");
  const p = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  return b + p;
}
