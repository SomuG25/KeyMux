// In-memory ring buffer of recent proxy activity, shared across both servers
// (proxy + dashboard run in the same Node process).
const MAX = 200;
const entries = [];

export function addLog({ keyLabel, provider, method, path, status, note }) {
  entries.unshift({
    ts: new Date().toISOString(),
    keyLabel: keyLabel || "—",
    provider: provider || "—",
    method: method || "—",
    path: path || "—",
    status: status ?? null,
    note: note || "",
  });
  if (entries.length > MAX) entries.length = MAX;
}

export function recentLogs(n = 20) {
  return entries.slice(0, n);
}
