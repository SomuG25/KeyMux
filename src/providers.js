// Known providers. base must end with a trailing slash.
export const PROVIDERS = {
  aerolink: {
    id: "aerolink",
    label: "AeroLink",
    base: "https://capi.aerolink.lat/",
    keyPrefix: "aero_live_",
    // AeroLink serves GLM, so the Haiku (small/fast) slot maps to GLM here.
    // Sonnet/Opus pass through as real Claude models.
    modelMap: [{ match: /haiku/i, to: process.env.KEYMUX_HAIKU_MODEL || "glm-5.2" }],
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
