// Known providers. base must end with a trailing slash.
export const PROVIDERS = {
  aerolink: {
    id: "aerolink",
    label: "AeroLink",
    base: "https://capi.aerolink.lat/",
    keyPrefix: "aero_live_",
  },
  freemodel: {
    id: "freemodel",
    label: "Freemodel",
    base: "https://cc.freemodel.dev/",
    keyPrefix: "fe_oa_",
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
