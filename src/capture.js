// Shares the header signature of the last REAL Claude Code request across the
// proxy and dashboard (same process). The health-test replays these captured
// headers so it looks like the genuine client — some providers (Freemodel)
// reject anything that isn't the official Claude Code CLI.
let lastHeaders = null; // sanitized: no auth/host/length
let capturedAt = null;

// Headers that are per-key or per-connection — never replay these.
const SKIP = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "connection",
  "accept-encoding",
]);

export function captureHeaders(reqHeaders) {
  const h = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    if (SKIP.has(name.toLowerCase())) continue;
    h[name] = value;
  }
  // Only keep it if it actually looks like Claude Code (has a user-agent).
  if (h["user-agent"]) {
    lastHeaders = h;
    capturedAt = new Date().toISOString();
  }
}

export function getCapturedHeaders() {
  return lastHeaders;
}

export function captureInfo() {
  return { captured: !!lastHeaders, capturedAt };
}
