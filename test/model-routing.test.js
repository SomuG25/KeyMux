import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../src/providers.js";
import { rewriteModel } from "../src/proxy.js";

const OX_ALPHA = "stealth/ox-alpha";

function routeOpenRouter(model, is1m = false) {
  const body = Buffer.from(JSON.stringify({ model, messages: [] }));
  const result = rewriteModel(body, "application/json", PROVIDERS.openrouter, is1m);
  return { body: JSON.parse(result.buf.toString("utf8")), note: result.note };
}

test("OpenRouter force-routes every main, subagent, and explicit model to Ox Alpha", () => {
  const requestedModels = [
    "opus[1m]",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-fable-5",
    "moonshotai/kimi-k3",
    "z-ai/glm-5.2",
    "some-future-subagent-model",
    "stealth/other-model",
    "",
  ];

  for (const requested of requestedModels) {
    const routed = routeOpenRouter(requested, requested.includes("[1m]"));
    assert.equal(routed.body.model, OX_ALPHA, `${requested || "<empty>"} escaped forced routing`);
    assert.match(routed.note, /\(forced\)$/);
  }
});

test("OpenRouter forced routing preserves the rest of the request body", () => {
  const input = {
    model: "arbitrary-subagent-model",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "ping" }],
  };
  const result = rewriteModel(
    Buffer.from(JSON.stringify(input)),
    "application/json",
    PROVIDERS.openrouter,
    false
  );
  const output = JSON.parse(result.buf.toString("utf8"));

  assert.deepEqual(output, { ...input, model: OX_ALPHA });
});
