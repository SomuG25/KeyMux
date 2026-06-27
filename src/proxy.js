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
} from "./store.js";
import { addLog } from "./log.js";

// Status codes that should trigger a rotation + single retry.
const ROTATE_ON = new Set([401, 429]);

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
    const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

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
          note: rotated ? "after rotation" : "",
        });

        res.status(upstream.status);
        upstream.headers.forEach((value, name) => {
          if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) return;
          res.setHeader(name, value);
        });

        if (upstream.body) {
          Readable.fromWeb(upstream.body).pipe(res);
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
