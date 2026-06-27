// KeyMux dashboard — vanilla JS, polls /api/state and renders the pool + log.
const $ = (sel) => document.querySelector(sel);

const PROVIDER_LABELS = { aerolink: "AeroLink", freemodel: "Freemodel" };
let providers = [];
let testKeyId = null;

// ---------- Fetch helpers ----------
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  return res.json().catch(() => ({}));
}

// ---------- Rendering ----------
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtRelative(iso) {
  if (!iso) return "never used";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function renderActive(state) {
  const active = state.keys.find((k) => k.id === state.activeKeyId);
  const body = $("#activeBody");
  if (!active) {
    body.innerHTML = `<div class="active-empty">No active key — add one to get started.</div>`;
    return;
  }
  const provider = PROVIDER_LABELS[active.provider] || active.provider;
  body.innerHTML = `
    <div class="active-key-main">
      <div>
        <div class="active-key-name">${escapeHtml(active.label)}</div>
        <div class="active-mask">${escapeHtml(active.masked)}</div>
      </div>
    </div>
    <div class="active-meta">
      <div class="provider-chip">● ${escapeHtml(provider)}</div>
      <div style="margin-top:8px">last used ${fmtRelative(active.lastUsed)}</div>
    </div>`;
}

function renderKeys(state) {
  const list = $("#keyList");
  $("#keyCount").textContent = state.keys.length;
  if (state.keys.length === 0) {
    list.innerHTML = `<div class="empty-state">No keys yet. Click “+ Add Key” to add your first provider key.</div>`;
    return;
  }
  list.innerHTML = state.keys
    .map((k) => {
      const provider = PROVIDER_LABELS[k.provider] || k.provider;
      const isActive = k.status === "active";
      return `
      <div class="key-card ${k.status}">
        <div class="key-info">
          <div class="key-top">
            <span class="key-name">${escapeHtml(k.label)}</span>
            <span class="status ${k.status}"><span class="led"></span>${k.status}</span>
          </div>
          <div class="key-sub">${escapeHtml(k.masked)} · ${escapeHtml(provider)}</div>
          <div class="key-meta">last used ${fmtRelative(k.lastUsed)}</div>
        </div>
        <div class="key-actions">
          ${isActive ? "" : `<button class="icon-btn go" data-act="activate" data-id="${k.id}">Set Active</button>`}
          <button class="icon-btn" data-act="test" data-id="${k.id}" data-label="${escapeAttr(k.label)}">Test</button>
          <button class="icon-btn danger" data-act="delete" data-id="${k.id}">Delete</button>
        </div>
      </div>`;
    })
    .join("");
}

function renderLog(log) {
  const list = $("#logList");
  if (!log || log.length === 0) {
    list.innerHTML = `<div class="empty-state">Waiting for proxy activity…</div>`;
    return;
  }
  list.innerHTML = log
    .map((e) => {
      const cls = statusClass(e.status);
      const statusText = e.status === null ? "—" : e.status;
      const main = `<b>${escapeHtml(e.method)}</b> ${escapeHtml(truncate(e.path, 26))} · ${escapeHtml(e.keyLabel)}${e.note ? ` · <span style="color:var(--faint)">${escapeHtml(e.note)}</span>` : ""}`;
      return `
      <div class="log-row">
        <span class="log-time">${fmtTime(e.ts)}</span>
        <span class="log-main">${main}</span>
        <span class="log-status ${cls}">${statusText}</span>
      </div>`;
    })
    .join("");
}

function statusClass(status) {
  if (status === null) return "none";
  if (status >= 200 && status < 300) return "ok";
  if (status === 429 || (status >= 300 && status < 400)) return "warn";
  return "err";
}

// ---------- Refresh loop ----------
async function refresh() {
  try {
    const state = await api("/api/state");
    if (state.providers) {
      providers = state.providers;
      populateProviderSelect();
    }
    renderActive(state);
    renderKeys(state);
    renderLog(state.log);
  } catch (err) {
    /* server momentarily unavailable; next tick retries */
  }
}

function populateProviderSelect() {
  const sel = $("#providerSelect");
  if (sel.options.length === providers.length && sel.options.length > 0) return;
  sel.innerHTML = providers.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
}

// ---------- Actions (event delegation) ----------
$("#keyList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const { act, id, label } = btn.dataset;
  if (act === "activate") {
    await api(`/api/keys/${id}/activate`, { method: "POST" });
    refresh();
  } else if (act === "delete") {
    if (confirm("Delete this key from the pool?")) {
      await api(`/api/keys/${id}`, { method: "DELETE" });
      refresh();
    }
  } else if (act === "test") {
    openTest(id, label);
  }
});

$("#rotateBtn").addEventListener("click", async () => {
  await api("/api/rotate", { method: "POST" });
  refresh();
});

// ---------- Add Key modal ----------
const modal = $("#modal");
const openModal = () => { $("#formError").textContent = ""; $("#addForm").reset(); modal.classList.add("open"); };
const closeModal = () => modal.classList.remove("open");
$("#addBtn").addEventListener("click", openModal);
$("#modalClose").addEventListener("click", closeModal);
$("#cancelBtn").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    label: fd.get("label"),
    provider: fd.get("provider"),
    key: fd.get("key"),
  };
  const res = await api("/api/keys", { method: "POST", body: JSON.stringify(payload) });
  if (res.ok) {
    closeModal();
    refresh();
  } else {
    $("#formError").textContent = res.error || "Failed to add key.";
  }
});

// ---------- Test modal ----------
const testModal = $("#testModal");
function openTest(id, label) {
  testKeyId = id;
  $("#testKeyName").textContent = `Testing: ${label}`;
  $("#testResult").innerHTML = "";
  testModal.classList.add("open");
}
const closeTest = () => testModal.classList.remove("open");
$("#testClose").addEventListener("click", closeTest);
testModal.addEventListener("click", (e) => { if (e.target === testModal) closeTest(); });

$("#runTestBtn").addEventListener("click", async () => {
  const model = $("#testModel").value.trim();
  const result = $("#testResult");
  result.innerHTML = `<div class="res-line"><span class="spinner"></span> Testing <b>${escapeHtml(model)}</b>…</div>`;
  const res = await api(`/api/keys/${testKeyId}/test`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
  const cls = res.ok ? "ok" : "err";
  const icon = res.ok ? "✓" : "✕";
  const statusTxt = res.status === null ? "no response" : `HTTP ${res.status}`;
  result.innerHTML = `
    <div class="res-line ${cls}">${icon} ${statusTxt} · ${res.latencyMs}ms · ${escapeHtml(res.model)}</div>
    ${res.detail ? `<div class="res-detail">${escapeHtml(res.detail)}</div>` : ""}`;
  refresh();
});

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
function truncate(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// Keyboard: Esc closes modals
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); closeTest(); }
});

// Kick off
refresh();
setInterval(refresh, 2500);
