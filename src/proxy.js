// Part 1 — Local proxy server (default port 7777).
// Accepts Anthropic API traffic from Claude Code, forwards it to the active
// provider with the right Authorization header + base URL, and auto-rotates
// keys on 429 / 401.
import express from "express";
import { Readable } from "node:stream";
import { getProvider, buildUpstreamUrl } from "./providers.js";
import { getActiveKey, markUsed, markFailed, reconcile } from "./store.js";
import { addLog } from "./log.js";
import { captureHeaders } from "./capture.js";

// Status codes that mark the active key FAILED (so it shows red in the
// dashboard). The proxy does NOT auto-rotate — switch keys via the dashboard's
// Set Active / Rotate Now.
const ROTATE_ON = new Set([401, 429]);

// Model remapping is PER-PROVIDER, because each provider carries a different
// model catalog. A provider defines its own `modelMap` in providers.js; AeroLink
// maps every slot (Opus/Sonnet/Haiku) → glm-5.2[1m] (it's the one that serves
// GLM). Freemodel has no map, so Opus/Sonnet/Haiku stay real Claude there
// (sending glm-5.2 to Freemodel 400s). A raw glm-5.2* name passes through
// unchanged, so the map is idempotent.
function rewriteModel(bodyBuf, contentType, provider) {
  const map = provider?.modelMap;
  if (!map || map.length === 0) return { buf: bodyBuf, note: "" };
  if (!bodyBuf || !bodyBuf.length) return { buf: bodyBuf, note: "" };
  if (contentType && !String(contentType).includes("application/json")) {
    return { buf: bodyBuf, note: "" };
  }
  try {
    const obj = JSON.parse(bodyBuf.toString("utf8"));
    if (obj && typeof obj.model === "string") {
      for (const m of map) {
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

// Read the .model field out of a buffered JSON request body ("" if absent).
function requestModel(bodyBuf) {
  if (!bodyBuf || !bodyBuf.length) return "";
  try {
    const obj = JSON.parse(bodyBuf.toString("utf8"));
    return obj && typeof obj.model === "string" ? obj.model : "";
  } catch {
    return "";
  }
}

// Was GLM actually sent upstream? True if the client sent glm-* OR the provider's
// modelMap rewrote a Claude slot to glm-* (AeroLink). Used to decide whether a
// 400/403 means "this key doesn't serve GLM" vs a generic auth/limit error.
function isGlmRequest(rawBuf, rewrittenBuf) {
  return /glm-/i.test(requestModel(rawBuf)) || /glm-/i.test(requestModel(rewrittenBuf));
}

// Detect a "this key/provider rejects GLM" failure from the upstream status +
// (peeked) body. Returns a short reason string, or "" if not a GLM rejection.
//   - 400 with Chinese "暂不支持" (model not supported) — tier-locked AeroLink
//   - 403 forbidden on a GLM request — Freemodel blocks GLM entirely
// Note: the body is only peeked on 400/403 (tiny, non-streaming error bodies),
// never on 200 — success streams straight through untouched.
async function detectGlmRejection(upstream, glmSent) {
  if (!glmSent) return "";
  if (upstream.status !== 400 && upstream.status !== 403) return "";
  try {
    const text = (await upstream.text()).slice(0, 400);
    // AeroLink tier-lock: "你请求的模型 ... 暂不支持" (model not supported).
    if (/暂不支持|model.{0,30}not (?:supported|found)|not available/i.test(text)) {
      return "key rejects GLM (tier-locked) — switch to an AeroLink key that serves GLM";
    }
    // Freemodel: "This service is restricted" / forbidden for GLM.
    if (upstream.status === 403) {
      return "provider rejects GLM (use a Claude model or an AeroLink key)";
    }
  } catch {
    /* body unreadable — treat as generic */
  }
  return "";
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

    // Record this real client's header signature so the dashboard health-test
    // can replay it (providers like Freemodel only accept the genuine CLI).
    if (req.method === "POST" && req.path.includes("/messages")) {
      captureHeaders(req.headers);
    }

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

    // Apply this provider's model map. The proxy does NOT auto-rotate on errors
    // — a failed/bad key stays active until you switch via the dashboard.
    const { buf: bodyBuf, note: modelNote } = rewriteModel(
      rawBuf,
      req.headers["content-type"],
      getProvider(key.provider)
    );
    try {
      const { upstream, provider } = await forwardOnce(req, bodyBuf, key);
      const glmSent = isGlmRequest(rawBuf, bodyBuf);

      // GLM-rejection (tier-locked AeroLink 400 / Freemodel 403): the active key
      // can't serve GLM. Mark it failed (red) with a clear reason — but do NOT
      // rotate. The peeked body is returned verbatim so Claude Code sees the real
      // upstream error. The user switches keys via Set Active / Rotate Now.
      if (upstream.status === 400 || upstream.status === 403) {
        const reason = await detectGlmRejection(upstream, glmSent);
        if (reason) {
          markFailed(key.id);
          const errBody = await upstream.text();
          addLog({
            keyLabel: key.label,
            provider: provider.label,
            method: req.method,
            path: req.originalUrl,
            status: upstream.status,
            note: reason,
          });
          res.status(upstream.status);
          res.setHeader("content-type", "application/json");
          return res.send(errBody);
        }
      }

      // Mark the active key failed on rate-limit/auth so it shows red, but do
      // NOT switch keys — surface the response straight back to Claude Code.
      if (ROTATE_ON.has(upstream.status)) {
        markFailed(key.id);
      } else {
        markUsed(key.id);
      }
      addLog({
        keyLabel: key.label,
        provider: provider.label,
        method: req.method,
        path: req.originalUrl,
        status: upstream.status,
        note: modelNote,
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
      // Network-level failure. Mark the key failed but stay on it — no rotation.
      markFailed(key.id);
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
  });

  return app;
}
