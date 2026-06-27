// Persistent key storage backed by keys.json (in the project folder).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getProvider } from "./providers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = join(__dirname, "..", "keys.json");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
      keys: Array.isArray(parsed.keys) ? parsed.keys.map(normalize) : [],
    };
  } catch (err) {
    console.error("[store] keys.json is corrupt, starting empty:", err.message);
    return structuredClone(DEFAULT_DATA);
  }
}

// Backfill fields added in later versions so old keys.json files keep working.
function normalize(k) {
  return {
    id: k.id,
    label: k.label ?? "Untitled key",
    account: k.account ?? "",
    provider: k.provider,
    key: k.key,
    status: k.status ?? "standby", // standby | failed | exhausted
    lastUsed: k.lastUsed ?? null,
    addedAt: k.addedAt ?? new Date().toISOString(),
    resetAt: k.resetAt ?? null, // absolute ISO time the weekly limit resets
  };
}

function persist() {
  writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

// A key is "usable" if it can serve traffic right now.
function isUsable(k) {
  return k.status !== "failed" && k.status !== "exhausted";
}

// ---------- Reads ----------
export function getKeys() {
  return data.keys;
}
export function getActiveKeyId() {
  return data.activeKeyId;
}
export function getKeyById(id) {
  return data.keys.find((k) => k.id === id) || null;
}
export function getActiveKey() {
  return data.keys.find((k) => k.id === data.activeKeyId) || null;
}

// ---------- Weekly-cycle reconciliation ----------
// Roll any reset times that have passed forward by whole weeks, revive exhausted
// keys whose reset has arrived, and make sure the active key is actually usable.
// Called before every proxy request and every dashboard state read.
export function reconcile() {
  const now = Date.now();
  let changed = false;

  for (const k of data.keys) {
    if (!k.resetAt) continue;
    let t = new Date(k.resetAt).getTime();
    if (Number.isNaN(t)) {
      k.resetAt = null;
      changed = true;
      continue;
    }
    if (t <= now) {
      // Weekly cycle: advance in 7-day steps until the reset is in the future.
      while (t <= now) t += WEEK_MS;
      k.resetAt = new Date(t).toISOString();
      if (k.status === "exhausted") k.status = "standby"; // limit refreshed
      changed = true;
    }
  }

  // If the active key is no longer usable, advance to the next one that is.
  const active = getActiveKey();
  if (!active || !isUsable(active)) {
    const next = pickNextKey(active ? active.id : null);
    if (next) {
      data.activeKeyId = next.id;
      changed = true;
    } else if (!active && data.activeKeyId !== null) {
      data.activeKeyId = null;
      changed = true;
    }
  }

  if (changed) persist();
}

// ---------- Mutations ----------
export function addKey({ label, account, provider, key, resetAt }) {
  if (!getProvider(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  if (!key || !key.trim()) {
    throw new Error("API key is required");
  }
  const entry = {
    id: randomUUID(),
    label: (label || "").trim() || "Untitled key",
    account: (account || "").trim(),
    provider,
    key: key.trim(),
    status: "standby",
    lastUsed: null,
    addedAt: new Date().toISOString(),
    resetAt: resetAt ? new Date(resetAt).toISOString() : null,
  };
  data.keys.push(entry);
  if (!data.activeKeyId) data.activeKeyId = entry.id;
  persist();
  return entry;
}

export function deleteKey(id) {
  const idx = data.keys.findIndex((k) => k.id === id);
  if (idx === -1) return false;
  data.keys.splice(idx, 1);
  if (data.activeKeyId === id) {
    const next = data.keys.find(isUsable) || data.keys[0];
    data.activeKeyId = next ? next.id : null;
  }
  persist();
  return true;
}

export function setActive(id) {
  const key = getKeyById(id);
  if (!key) return false;
  data.activeKeyId = id;
  if (key.status === "failed") key.status = "standby"; // reactivating clears a soft failure
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
  // Don't clobber a known weekly exhaustion with a transient failure.
  if (key.status !== "exhausted") key.status = "failed";
  persist();
}

// Mark a key's weekly limit as used up. It stays benched until resetAt, then
// reconcile() revives it. If resetAt isn't given, fall back to the key's known
// weekly reset, else default to one week out.
export function markExhausted(id, resetAt) {
  const key = getKeyById(id);
  if (!key) return false;
  key.status = "exhausted";
  if (resetAt) {
    key.resetAt = new Date(resetAt).toISOString();
  } else if (!key.resetAt) {
    key.resetAt = new Date(Date.now() + WEEK_MS).toISOString();
  }
  if (data.activeKeyId === id) {
    const next = pickNextKey(id);
    data.activeKeyId = next ? next.id : null;
  }
  persist();
  return true;
}

export function restoreKey(id) {
  const key = getKeyById(id);
  if (!key) return false;
  key.status = "standby";
  persist();
  return true;
}

export function setReset(id, resetAt) {
  const key = getKeyById(id);
  if (!key) return false;
  key.resetAt = resetAt ? new Date(resetAt).toISOString() : null;
  persist();
  return true;
}

// Pick the next usable key after `failedId`. Prefer same provider (keeps model
// compatibility), then any usable key. Never returns a failed/exhausted key.
export function pickNextKey(failedId) {
  const failed = getKeyById(failedId);
  const candidates = data.keys.filter((k) => k.id !== failedId);
  if (candidates.length === 0) return null;

  if (failed) {
    const sameProvider = candidates.find(
      (k) => k.provider === failed.provider && isUsable(k)
    );
    if (sameProvider) return sameProvider;
  }
  return candidates.find(isUsable) || null;
}

export function rotate() {
  reconcile();
  const current = getActiveKeyId();
  const next = pickNextKey(current);
  if (next) {
    data.activeKeyId = next.id;
    persist();
  }
  return next;
}

// Mask a key for display, e.g. aero_live_****R0k / fe_oa_****6d9
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
      account: k.account,
      provider: k.provider,
      masked: maskKey(k.key),
      status: k.id === data.activeKeyId && isUsable(k) ? "active" : k.status,
      lastUsed: k.lastUsed,
      addedAt: k.addedAt,
      resetAt: k.resetAt,
    })),
  };
}
