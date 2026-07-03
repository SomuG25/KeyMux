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
