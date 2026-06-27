// Part 2 — Web dashboard server (default port 7778).
// Serves the UI and a small JSON API to manage the key pool, rotate, and
// run real per-model health tests against a provider.
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getProvider, buildUpstreamUrl, PROVIDERS } from "./providers.js";
import {
  publicState,
  addKey,
  deleteKey,
  setActive,
  rotate,
  getKeyById,
  reconcile,
  markExhausted,
  restoreKey,
  setReset,
} from "./store.js";
import { recentLogs, addLog } from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDashboardApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(join(__dirname, "..", "public")));

  // ---- State ----
  app.get("/api/state", (_req, res) => {
    reconcile(); // revive keys whose weekly reset has arrived before reporting
    res.json({
      ...publicState(),
      providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label })),
      log: recentLogs(20),
    });
  });

  app.get("/api/log", (_req, res) => {
    res.json({ log: recentLogs(20) });
  });

  // ---- Mutations ----
  app.post("/api/keys", (req, res) => {
    try {
      const entry = addKey({
        label: req.body.label,
        account: req.body.account,
        provider: req.body.provider,
        key: req.body.key,
        resetAt: req.body.resetAt,
      });
      res.json({ ok: true, id: entry.id });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Mark a key's weekly limit as exhausted (benched until resetAt).
  app.post("/api/keys/:id/exhaust", (req, res) => {
    const ok = markExhausted(req.params.id, req.body.resetAt);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Bring an exhausted/failed key back into the rotation manually.
  app.post("/api/keys/:id/restore", (req, res) => {
    const ok = restoreKey(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // Update just the weekly reset time on a key.
  app.post("/api/keys/:id/reset", (req, res) => {
    const ok = setReset(req.params.id, req.body.resetAt);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.delete("/api/keys/:id", (req, res) => {
    const ok = deleteKey(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post("/api/keys/:id/activate", (req, res) => {
    const ok = setActive(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post("/api/rotate", (_req, res) => {
    const next = rotate();
    res.json({ ok: !!next, activeKeyId: next?.id ?? null });
  });

  // ---- Real per-model health test ----
  // Fires a tiny 1-token /v1/messages request to the key's provider so you can
  // confirm a specific model actually works on that key.
  app.post("/api/keys/:id/test", async (req, res) => {
    const key = getKeyById(req.params.id);
    if (!key) return res.status(404).json({ ok: false, error: "key not found" });
    const provider = getProvider(key.provider);
    if (!provider) return res.status(400).json({ ok: false, error: "unknown provider" });

    const model = (req.body.model || "claude-opus-4-5").trim();
    const url = buildUpstreamUrl(provider.base, "/v1/messages");
    const started = Date.now();
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key.key}`,
          "x-api-key": key.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const ms = Date.now() - started;
      const ok = upstream.status >= 200 && upstream.status < 300;
      let detail = "";
      if (!ok) {
        const text = await upstream.text();
        detail = text.slice(0, 300);
      }
      addLog({
        keyLabel: key.label,
        provider: provider.label,
        method: "TEST",
        path: model,
        status: upstream.status,
        note: `health test (${ms}ms)`,
      });
      res.json({ ok, status: upstream.status, latencyMs: ms, model, detail });
    } catch (err) {
      const ms = Date.now() - started;
      addLog({
        keyLabel: key.label,
        provider: provider.label,
        method: "TEST",
        path: model,
        status: null,
        note: `health test failed: ${err.message}`,
      });
      res.json({ ok: false, status: null, latencyMs: ms, model, detail: err.message });
    }
  });

  return app;
}
