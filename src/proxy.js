// Part 1 — Local proxy server (default port 7777).
// Accepts Anthropic API traffic from Claude Code, forwards it to the active
// provider with the right Authorization header + base URL, and auto-rotates
// keys on 429 / 401.
import express from "express";
import { Readable } from "node:stream";
import { getProvider, buildUpstreamUrl } from "./providers.js";
import {
  getActiveKey,
  pickNextKey,
  setActive,
  markUsed,
  markFailed,
  reconcile,
} from "./store.js";
import { addLog } from "./log.js";

// Status codes that should trigger a rotation + single retry.
const ROTATE_ON = new Set([401, 429]);

// Model remapping. Claude Code sends Anthropic model names; we rewrite some of
// them to third-party models before forwarding (applies to every provider/key):
//   - Haiku  (small/fast background model) → GLM      (KEYMUX_HAIKU_MODEL)
//   - Sonnet (the 1M-context slot we repurpose) → DeepSeek (KEYMUX_SONNET_MODEL)
// Opus is the main model and passes through untouched. First match wins.
const MODEL_MAP = [
  { match: /haiku/i, to: process.env.KEYMUX_HAIKU_MODEL || "glm-5.2" },
  { match: /sonnet/i, to: process.env.KEYMUX_SONNET_MODEL || "deepseek-v4-pro" },
];

// If the JSON body's `model` matches a mapping, swap it. Returns the (possibly
// rewritten) body buffer plus a note for the activity log.
function rewriteModel(bodyBuf, contentType) {
  if (!bodyBuf || !bodyBuf.length) return { buf: bodyBuf, note: "" };
  if (contentType && !String(contentType).includes("application/json")) {
    return { buf: bodyBuf, note: "" };
  }
  try {
    const obj = JSON.parse(bodyBuf.toString("utf8"));
    if (obj && typeof obj.model === "string") {
      for (const m of MODEL_MAP) {
        if (m.match.test(obj.model)) {
          const from = obj.model;
          obj.model = m.to;
          return { buf: Buffer.from(JSON.stringify(obj)), note: `model ${from} → ${m.to}` };
        }
      }
    }
  } catch {
    /* not JSON or unparseable — forward unchanged */
  }
  return { buf: bodyBuf, note: "" };
}

// Hop-by-hop / auth headers we must NOT forward upstream verbatim.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "authorization",
  "x-api-key",
  "accept-encoding", // avoid compressed upstream bodies we'd have to re-encode
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

function buildHeaders(req, key, provider) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  // Providers use standard Anthropic Bearer auth. Send both common forms so the
  // upstream is happy regardless of which it reads.
  headers["authorization"] = `Bearer ${key.key}`;
  headers["x-api-key"] = key.key;
  return headers;
}

async function forwardOnce(req, bodyBuf, key) {
  const provider = getProvider(key.provider);
  if (!provider) throw new Error(`Unknown provider for key: ${key.provider}`);

  const url = buildUpstreamUrl(provider.base, req.originalUrl);
  const init = {
    method: req.method,
    headers: buildHeaders(req, key, provider),
  };
  if (!["GET", "HEAD"].includes(req.method) && bodyBuf && bodyBuf.length) {
    init.body = bodyBuf;
  }
  const upstream = await fetch(url, init);
  return { upstream, provider };
}

export function createProxyApp() {
  const app = express();

  // Buffer the raw body so we can replay it on a retry. 50mb covers large
  // tool-result / file payloads.
  app.use(express.raw({ type: () => true, limit: "50mb" }));

  app.all("/*", async (req, res) => {
    const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Map Haiku-class requests to GLM before forwarding (applies to every key).
    const { buf: bodyBuf, note: modelNote } = rewriteModel(rawBuf, req.headers["content-type"]);

    // Revive any keys whose weekly reset arrived, and ensure the active key is
    // actually usable (auto-advance past exhausted/failed keys).
    reconcile();

    let key = getActiveKey();
    if (!key) {
      addLog({
        method: req.method,
        path: req.originalUrl,
        status: 503,
        note: "no active key configured",
      });
      return res
        .status(503)
        .json({ error: { type: "keymux_error", message: "No active key. Add one in the KeyMux dashboard (http://localhost:7778)." } });
    }

    let attempt = 0;
    let rotated = false;
    while (true) {
      attempt++;
      try {
        const { upstream, provider } = await forwardOnce(req, bodyBuf, key);

        if (ROTATE_ON.has(upstream.status) && attempt === 1) {
          // Mark this key failed and rotate to the next candidate, then retry once.
          markFailed(key.id);
          addLog({
            keyLabel: key.label,
            provider: provider.label,
            method: req.method,
            path: req.originalUrl,
            status: upstream.status,
            note: "rotating (rate-limit/auth)",
          });
          const next = pickNextKey(key.id);
          if (next && next.id !== key.id) {
            setActive(next.id);
            key = next;
            rotated = true;
            continue; // retry with the new key
          }
          // No alternative key — fall through and return this response.
        }

        // Success (or a non-rotatable error, or retry exhausted): stream it back.
        markUsed(key.id);
        addLog({
          keyLabel: key.label,
          provider: provider.label,
          method: req.method,
          path: req.originalUrl,
          status: upstream.status,
          note: [rotated ? "after rotation" : "", modelNote].filter(Boolean).join(" · "),
        });

        res.status(upstream.status);
        upstream.headers.forEach((value, name) => {
          if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) return;
          res.setHeader(name, value);
        });

        if (upstream.body) {
          const nodeStream = Readable.fromWeb(upstream.body);
          // If the upstream stream breaks mid-response (e.g. the network drops),
          // it emits 'error'. Without a listener Node would crash the whole
          // process — so handle it: log it and tear down this response only.
          nodeStream.on("error", (err) => {
            addLog({
              keyLabel: key.label,
              provider: provider.label,
              method: req.method,
              path: req.originalUrl,
              status: null,
              note: `stream interrupted: ${err.message}`,
            });
            if (!res.destroyed) res.destroy(err);
          });
          // If Claude Code hangs up, stop pulling from upstream.
          res.on("close", () => nodeStream.destroy());
          nodeStream.pipe(res);
        } else {
          res.end();
        }
        return;
      } catch (err) {
        // Network-level failure. Rotate + retry once, then give up.
        if (attempt === 1) {
          markFailed(key.id);
          addLog({
            keyLabel: key.label,
            provider: getProvider(key.provider)?.label,
            method: req.method,
            path: req.originalUrl,
            status: null,
            note: `network error: ${err.message} — rotating`,
          });
          const next = pickNextKey(key.id);
          if (next && next.id !== key.id) {
            setActive(next.id);
            key = next;
            rotated = true;
            continue;
          }
        }
        addLog({
          keyLabel: key.label,
          provider: getProvider(key.provider)?.label,
          method: req.method,
          path: req.originalUrl,
          status: 502,
          note: `upstream unreachable: ${err.message}`,
        });
        return res
          .status(502)
          .json({ error: { type: "keymux_error", message: `Upstream unreachable: ${err.message}` } });
      }
    }
  });

  return app;
}
