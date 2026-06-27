// Persistent key storage backed by keys.json (in the project folder).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getProvider } from "./providers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = join(__dirname, "..", "keys.json");

const DEFAULT_DATA = { activeKeyId: null, keys: [] };

let data = load();

function load() {
  if (!existsSync(KEYS_FILE)) {
    return structuredClone(DEFAULT_DATA);
  }
  try {
    const parsed = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
    return {
      activeKeyId: parsed.activeKeyId ?? null,
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
    };
  } catch (err) {
    console.error("[store] keys.json is corrupt, starting empty:", err.message);
    return structuredClone(DEFAULT_DATA);
  }
}

function persist() {
  writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

export function getKeys() {
  return data.keys;
}

export function getActiveKeyId() {
  return data.activeKeyId;
}

export function getActiveKey() {
  return data.keys.find((k) => k.id === data.activeKeyId) || null;
}

export function getKeyById(id) {
  return data.keys.find((k) => k.id === id) || null;
}

export function addKey({ label, provider, key }) {
  if (!getProvider(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  if (!key || !key.trim()) {
    throw new Error("API key is required");
  }
  const entry = {
    id: randomUUID(),
    label: (label || "").trim() || "Untitled key",
    provider,
    key: key.trim(),
    status: "standby", // standby | failed (active is derived from activeKeyId)
    lastUsed: null,
    addedAt: new Date().toISOString(),
  };
  data.keys.push(entry);
  // First key added becomes active automatically.
  if (!data.activeKeyId) data.activeKeyId = entry.id;
  persist();
  return entry;
}

export function deleteKey(id) {
  const idx = data.keys.findIndex((k) => k.id === id);
  if (idx === -1) return false;
  data.keys.splice(idx, 1);
  if (data.activeKeyId === id) {
    // Promote the next non-failed key, else the first remaining, else none.
    const next = data.keys.find((k) => k.status !== "failed") || data.keys[0];
    data.activeKeyId = next ? next.id : null;
  }
  persist();
  return true;
}

export function setActive(id) {
  const key = getKeyById(id);
  if (!key) return false;
  data.activeKeyId = id;
  // Reactivating a key clears a previous failure.
  if (key.status === "failed") key.status = "standby";
  persist();
  return true;
}

export function markUsed(id) {
  const key = getKeyById(id);
  if (!key) return;
  key.lastUsed = new Date().toISOString();
  if (key.status === "failed") key.status = "standby";
  persist();
}

export function markFailed(id) {
  const key = getKeyById(id);
  if (!key) return;
  key.status = "failed";
  persist();
}

// Pick the next key to rotate to after `failedId` failed.
// Strategy: prefer a non-failed key from the SAME provider, then any non-failed
// key, then (as a last resort) any other key at all.
export function pickNextKey(failedId) {
  const failed = getKeyById(failedId);
  const candidates = data.keys.filter((k) => k.id !== failedId);
  if (candidates.length === 0) return null;

  if (failed) {
    const sameProvider = candidates.find(
      (k) => k.provider === failed.provider && k.status !== "failed"
    );
    if (sameProvider) return sameProvider;
  }
  const anyHealthy = candidates.find((k) => k.status !== "failed");
  if (anyHealthy) return anyHealthy;

  return candidates[0]; // everything is failed; try something anyway
}

export function rotate() {
  const current = getActiveKeyId();
  const next = pickNextKey(current);
  if (next) {
    data.activeKeyId = next.id;
    if (next.status === "failed") next.status = "standby";
    persist();
  }
  return next;
}

// Mask a key for display, e.g. aero_live_****R0k
export function maskKey(key) {
  if (!key) return "";
  const tail = key.slice(-3);
  const prefixMatch = key.match(/^[a-z]+_[a-z]+_/i) || key.match(/^[a-z]+_/i);
  const prefix = prefixMatch ? prefixMatch[0] : key.slice(0, 4);
  return `${prefix}****${tail}`;
}

// Public view of the pool (keys masked, no raw secrets leaked to the UI).
export function publicState() {
  return {
    activeKeyId: data.activeKeyId,
    keys: data.keys.map((k) => ({
      id: k.id,
      label: k.label,
      provider: k.provider,
      masked: maskKey(k.key),
      status: k.id === data.activeKeyId && k.status !== "failed" ? "active" : k.status,
      lastUsed: k.lastUsed,
      addedAt: k.addedAt,
    })),
  };
}
