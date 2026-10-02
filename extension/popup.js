// ============================================================
//  Duet — Popup Script
// ============================================================

const $ = id => document.getElementById(id);

let currentRoomCode = null;
let myMeta = null;
let partnerMeta = null;
let togetherInfo = { since: null, total: 0 };
let serverClockOffset = 0;
let togetherTicker = null;
let lastDiag = null;

// ── Create / Join / Leave ──────────────────────────────────
$("create-btn").addEventListener("click", async () => {
  setBtnLoading("create-btn", "Creating…");
  clearMsg("main-msg");

  let res;
  try { res = await chrome.runtime.sendMessage({ type: "CREATE_ROOM" }); } catch (e) {
    res = { error: "Extension not ready. Try again." };
  }
  setBtnLabel("create-btn", "Create a room");

  if (res?.error) { showMsg("main-msg", "error", res.error); return; }
  setConnectedState(res.roomCode, res.peerCount || 1);
});

$("join-btn").addEventListener("click", async () => {
  const code = $("join-code-input").value.trim().toUpperCase();
  if (code.length !== 6) {
    showMsg("main-msg", "error", "Room codes are exactly 6 characters.");
    return;
  }

  setBtnLoading("join-btn", "Joining…");
  clearMsg("main-msg");

  let res;
  try { res = await chrome.runtime.sendMessage({ type: "JOIN_ROOM", roomCode: code }); } catch (e) {
    res = { error: "Extension not ready. Try again." };
  }
  setBtnLabel("join-btn", "Join room");

  if (res?.error) { showMsg("main-msg", "error", res.error); return; }
  setConnectedState(res.roomCode, 2);
});

$("join-code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join-btn").click();
});

// ── Display name (persisted) ──────────────────────────────
(async () => {
  const nameInput = $("name-input");
  if (!nameInput) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_NAME" });
    if (res?.name) nameInput.value = res.name;
  } catch {}
  let saveTimer = null;
  const persist = () => {
    const v = nameInput.value.trim().slice(0, 32);
    chrome.runtime.sendMessage({ type: "SET_NAME", name: v }).catch(() => {});
  };
  nameInput.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 350);
  });
  nameInput.addEventListener("blur", persist);
})();
// Pasting a whole invite link into the code box should just work; the
// field's maxlength would otherwise keep only "HTTPS:".
$("join-code-input").addEventListener("paste", (e) => {
  const code = DUET_INVITE.parse(e.clipboardData?.getData("text") || "");
  if (!code) return;
  e.preventDefault();
  e.target.value = code;
});
$("join-code-input").addEventListener("input", (e) => {
  const cleaned = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
  if (cleaned !== e.target.value) e.target.value = cleaned;
});

$("trouble-link").addEventListener("click", () => {
  const panel = $("trouble");
  panel.hidden = !panel.hidden;
  $("trouble-link").setAttribute("aria-expanded", String(!panel.hidden));
});

$("leave-btn").addEventListener("click", async () => {
  try { await chrome.runtime.sendMessage({ type: "LEAVE_ROOM" }); } catch {}
  setDisconnectedState();
});

// The invite link is the main way in: one click for someone who already has
// Duet, and an install page for someone who doesn't. The bare code stays
// available for reading out loud.
function wireCopyButton(id, label, getText) {
  const btn = $(id);
  btn.addEventListener("click", async () => {
    const text = getText();
    if (!text) return;
    let ok = true;
    try { await navigator.clipboard.writeText(text); } catch { ok = false; }
    btn.textContent = ok ? "✓ Copied to clipboard" : "Couldn't copy — select it manually";
    btn.classList.toggle("copied", ok);
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove("copied");
    }, 1800);
  });
}
wireCopyButton("copy-link-btn", "Copy invite link", () => DUET_INVITE.link(currentRoomCode));
wireCopyButton("copy-code-btn", "Copy code only", () => currentRoomCode);

// ── Catch up to partner ────────────────────────────────────
function syncMeBtnLabel() {
  const name = (partnerMeta && typeof partnerMeta.name === "string" && partnerMeta.name.trim())
    ? partnerMeta.name.trim()
    : "";
  return name ? `Catch up to ${name}` : "Catch up to partner";
}
function refreshSyncMeBtnLabel() {
  const btn = $("sync-me-btn");
  if (!btn || btn.disabled) return; // don't overwrite Catching up…/Caught up ✓
  const label = btn.querySelector("span");
  if (label) label.textContent = syncMeBtnLabel();
}

$("sync-me-btn").addEventListener("click", async () => {
  const btn = $("sync-me-btn");
  const label = btn.querySelector("span");
  btn.disabled = true;
  label.textContent = "Catching up…";

  let res;
  try { res = await chrome.runtime.sendMessage({ type: "CATCH_UP_TO_PARTNER" }); } catch (e) {
    res = { error: "Extension not ready. Try again." };
  }

  // Only declare "Caught up ✓" when the background actually verified that
  // your local video position now matches the partner's projected time
  // (drift < 1s) AND playback state matches.
  if (res?.ok) {
    btn.classList.add("success");
    label.textContent = "Caught up ✓";
    setTimeout(() => {
      btn.classList.remove("success");
      btn.disabled = false;
      label.textContent = syncMeBtnLabel();
    }, 1800);
  } else if (typeof res?.drift === "number") {
    btn.disabled = false;
    label.textContent = syncMeBtnLabel();
    showMsg("main-msg", "warn", `Couldn't fully sync — off by ${res.drift.toFixed(1)}s. Try again.`);
  } else {
    btn.disabled = false;
    label.textContent = syncMeBtnLabel();
    showMsg("main-msg", "error", res?.error || "Couldn't catch up.");
  }
});

// ── Reactions ──────────────────────────────────────────────
async function sendReactionLocalAndRemote(payload) {
  // Push to partner via Firebase
  chrome.runtime.sendMessage({ type: "SEND_REACTION", emoji: payload }).catch(() => {});
  // Also spawn it locally on the active tab so the sender gets visual feedback.
  // The `mine: true` flag tells the content script to render it as self-styled
  // (right-aligned, violet accent) instead of partner-styled.
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "SHOW_REACTION", emoji: payload, mine: true }).catch(() => {});
    }
  } catch {}
}

$("reactions-tray").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-emoji]");
  if (!btn) return;
  sendReactionLocalAndRemote(btn.dataset.emoji);
  btn.classList.remove("flash");
  void btn.offsetWidth;
  btn.classList.add("flash");
});

const MAX_CHAT_LEN = 140;
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const raw = $("chat-input").value.trim();
  if (!raw) return;
  const text = raw.slice(0, MAX_CHAT_LEN);
  sendReactionLocalAndRemote(text);
  $("chat-input").value = "";
  // Subtle confirmation flash on the input border
  const inp = $("chat-input");
  inp.style.borderColor = "var(--success)";
  setTimeout(() => { inp.style.borderColor = ""; }, 600);
});

$("chat-input").addEventListener("input", (e) => {
  if (e.target.value.length > MAX_CHAT_LEN) {
    e.target.value = e.target.value.slice(0, MAX_CHAT_LEN);
  }
});

// ── Open partner's URL ─────────────────────────────────────
$("open-partner-url").addEventListener("click", async () => {
  try { await chrome.runtime.sendMessage({ type: "OPEN_PARTNER_URL" }); } catch {}
  window.close();
});

// ── State Helpers ──────────────────────────────────────────
function setConnectedState(roomCode, peerCount) {
  currentRoomCode = roomCode;
  renderCodeCells(roomCode);
  $("view-disconnected").style.display = "none";
  $("view-connected").style.display = "block";
  $("status-dot").classList.add("connected");
  $("status-text").textContent = `Live · Room ${roomCode}`;
  updatePeerHint(peerCount);
}

function setDisconnectedState() {
  currentRoomCode = null;
  partnerMeta = null;
  myMeta = null;
  renderCodeCells(null);
  $("view-disconnected").style.display = "block";
  $("view-connected").style.display = "none";
  $("status-dot").classList.remove("connected");
  $("status-text").textContent = "Not connected";
}

function updatePeerHint(count) {
  const el = $("peer-hint");
  // The code is only needed until the partner arrives; after that the card
  // collapses (status pill still shows the room) and the popup fits Chrome's
  // 600px height without scrolling. It comes back if they leave.
  $("room-card").hidden = count >= 2;
  if (count >= 2) {
    // Once partner data lands, renderPartnerCard() will reflect "in sync".
    // Until then we just acknowledge they joined — don't overclaim.
    const live = partnerFreshness().state !== "gone";
    const msg = live
      ? "Partner is here · play or pause to sync"
      : "Partner connected · waiting for their video…";
    el.innerHTML = `<span class="peer-dot connected"></span><span>${msg}</span>`;
    el.classList.add("ready");
    $("control-row").style.display = "flex";
    $("together-row").style.display = "inline-flex";
    $("chat-bar").style.display = "block";
  } else {
    el.innerHTML = `<span class="peer-dot"></span><span>Waiting for partner to join…</span>`;
    el.classList.remove("ready");
    $("control-row").style.display = "none";
    $("partner-card").style.display = "none";
    $("together-row").style.display = "none";
    $("chat-bar").style.display = "none";
  }
}

function renderCodeCells(code) {
  const host = $("room-code-display");
  host.innerHTML = "";
  const chars = (code || "------").padEnd(6, "-").split("").slice(0, 6);
  for (const ch of chars) {
    const cell = document.createElement("span");
    cell.textContent = ch;
    if (ch !== "-") cell.classList.add("filled");
    host.appendChild(cell);
  }
}

// ── Partner card ───────────────────────────────────────────
// Three-state freshness model:
//   live  (<15s)   → full card, no warning
//   stale (15-30s) → full card, "connection slow" hint
//   gone  (>30s)   → pending card; if last known state was paused, show
//                    "Paused at 12:34 · 5m ago" instead of generic waiting
// 6s was too tight — Chrome throttles background-tab timers aggressively, so
// a partner who tabbed away or hit a network blip would flip to "Waiting…"
// even though they're still watching.
function partnerFreshness() {
  if (!partnerMeta) return { state: "gone", ageSec: null };
  if (typeof partnerMeta.currentTime !== "number") return { state: "gone", ageSec: null };
  if (typeof partnerMeta.url !== "string") return { state: "gone", ageSec: null };
  if (typeof partnerMeta.lastSeen !== "number") return { state: "gone", ageSec: null };
  const ageMs = (Date.now() + serverClockOffset) - partnerMeta.lastSeen;
  const ageSec = Math.max(0, Math.round(ageMs / 1000));
  if (ageMs < 15000) return { state: "live", ageSec };
  if (ageMs < 30000) return { state: "stale", ageSec };
  return { state: "gone", ageSec };
}

function renderPartnerAvatar() {
  const el = $("partner-avatar");
  if (!el) return;
  const value = partnerMeta?.emoji;
  if (value && isAvatarCode(value)) {
    el.innerHTML = "";
    const img = document.createElement("img");
    img.src = avatarUrl(value);
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);
    el.classList.add("visible");
  } else if (value && typeof value === "string" && value.length > 0 && value.length <= 4) {
    el.innerHTML = "";
    el.textContent = value;
    el.classList.add("visible");
    el.style.display = "inline-flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.fontSize = "11px";
  } else {
    el.innerHTML = "";
    el.classList.remove("visible");
  }
}

function renderPartnerCard() {
  const card = $("partner-card");
  const peerHere = $("control-row").style.display === "flex"; // proxy for peerCount >= 2
  const fresh = partnerFreshness();
  const isLive = fresh.state !== "gone";

  // Hide the card entirely when there's no second peer.
  if (!peerHere) { card.style.display = "none"; return; }

  // Show the card whenever 2 peers are present, but render a *pending* state
  // until the partner publishes their first valid TAB_INFO.
  card.style.display = "block";
  card.classList.toggle("pending", !isLive);

  if (!isLive) {
    const labelEl = $("partner-label-text");
    const partnerName = (partnerMeta && typeof partnerMeta.name === "string" && partnerMeta.name.trim())
      ? partnerMeta.name.trim() : "";
    if (labelEl) labelEl.textContent = partnerName ? `${partnerName} is watching` : "Partner is watching";
    renderPartnerAvatar();

    // If we have a last-known snapshot AND they were paused, show *that*
    // instead of the generic waiting message — staleness while paused is
    // expected (their tab is throttled), and the position info is still useful.
    const havePaused = partnerMeta && partnerMeta.paused === true && typeof partnerMeta.currentTime === "number";
    if (havePaused) {
      $("partner-host").textContent = partnerMeta.hostname || "—";
      $("partner-title").textContent = `Paused at ${fmtTime(partnerMeta.currentTime)} · ${fmtAgo(fresh.ageSec)}`;
      const dur = partnerMeta.duration || 0;
      const pct = dur > 0 ? Math.min(100, (partnerMeta.currentTime / dur) * 100) : 0;
      $("partner-time-fill").style.width = pct + "%";
      $("partner-time-text").textContent = dur > 0
        ? `${fmtTime(partnerMeta.currentTime)} / ${fmtTime(dur)}`
        : fmtTime(partnerMeta.currentTime);
    } else {
      $("partner-host").textContent = "—";
      $("partner-title").textContent = "Waiting for partner's video…";
      $("partner-time-fill").style.width = "0%";
      $("partner-time-text").textContent = "—:— / —:—";
    }
    $("partner-mismatch").style.display = "none";
    renderDrift(true); // hide drift pill while pending
    return;
  }

  // Stale (15-30s) — show data but flag the slowness so the user knows the
  // numbers below might be a few seconds behind reality.
  const hostText = partnerMeta.hostname || "—";
  $("partner-host").textContent = fresh.state === "stale"
    ? `${hostText} · connection slow…`
    : hostText;
  $("partner-title").textContent = partnerMeta.videoTitle || partnerMeta.pageTitle || "Untitled video";
  // Personalize the label if the partner has set a name.
  const labelEl = $("partner-label-text");
  if (labelEl) {
    const name = (typeof partnerMeta.name === "string" && partnerMeta.name.trim()) ? partnerMeta.name.trim() : "";
    labelEl.textContent = name ? `${name} is watching` : "Partner is watching";
  }
  renderPartnerAvatar();
  refreshSyncMeBtnLabel();

  const cur = partnerMeta.currentTime || 0;
  const dur = partnerMeta.duration || 0;
  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
  $("partner-time-fill").style.width = `${pct}%`;
  $("partner-time-text").textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;

  // Mismatch warning only when we have valid URLs on both sides.
  const mismatch = myMeta && myMeta.url && partnerMeta.url &&
    normalizeUrl(myMeta.url) !== normalizeUrl(partnerMeta.url);
  $("partner-mismatch").style.display = mismatch ? "flex" : "none";

  renderDrift(mismatch);
}

// ── Drift indicator ────────────────────────────────────────
function projectTime(meta) {
  // Returns the meta's currentTime advanced by the wall-clock seconds
  // since `lastSeen`, but only if it was playing. Pauseed → use as-is.
  if (!meta) return null;
  const baseTime = typeof meta.currentTime === "number" ? meta.currentTime : null;
  if (baseTime === null) return null;
  if (meta.paused) return baseTime;
  const ts = typeof meta.lastSeen === "number" ? meta.lastSeen : null;
  if (ts === null) return baseTime;
  const nowServer = Date.now() + serverClockOffset;
  return baseTime + Math.max(0, (nowServer - ts) / 1000);
}

function renderDrift(hideBecauseMismatch) {
  const pill = $("drift-pill");
  if (!pill) return;

  // Hide if we don't have both sides, or videos don't match, or either side is paused
  if (hideBecauseMismatch || !myMeta || !partnerMeta || myMeta.paused || partnerMeta.paused) {
    pill.style.display = "none";
    return;
  }

  const a = projectTime(myMeta);
  const b = projectTime(partnerMeta);
  if (a === null || b === null) { pill.style.display = "none"; return; }

  const drift = Math.abs(a - b);
  pill.style.display = "inline-flex";
  $("drift-text").textContent = drift < 10 ? `±${drift.toFixed(1)}s` : `±${Math.round(drift)}s`;

  pill.classList.remove("warn", "bad");
  if (drift > 2.0)      pill.classList.add("bad");
  else if (drift > 0.7) pill.classList.add("warn");
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return url.origin + url.pathname + url.search;
  } catch { return u; }
}

// ── Diagnostics rendering ──────────────────────────────────
function renderDiag(d) {
  if (!d) return;
  lastDiag = d;

  const now = Date.now();
  const sinceWrite   = d.lastWriteOk?.at  ? Math.round((now - d.lastWriteOk.at)  / 1000) : null;
  const sinceErr     = d.lastWriteErr?.at ? Math.round((now - d.lastWriteErr.at) / 1000) : null;
  const sincePartner = d.lastPartnerAt    ? Math.round((now - d.lastPartnerAt)   / 1000) : null;

  // Health: error in last 30s → red. Stale partner > 10s with peers → amber. Else green.
  const errFresh   = sinceErr !== null && sinceErr < 30;
  const partnerStale = d.peerCount >= 2 && (sincePartner === null || sincePartner > 10);

  const pill = $("diag-pill");
  const label = $("diag-label");
  const link = $("trouble-link");
  pill.classList.remove("warn", "err");
  link.classList.remove("warn", "err");
  if (errFresh) {
    pill.classList.add("err");
    label.textContent = "Diagnostics · error";
    link.classList.add("err");
    $("trouble-text").textContent = "Sync problem — see details";
  } else if (partnerStale) {
    pill.classList.add("warn");
    label.textContent = "Diagnostics · partner stale";
    link.classList.add("warn");
    $("trouble-text").textContent = "Partner seems stuck — see details";
  } else {
    label.textContent = "Diagnostics · healthy";
    $("trouble-text").textContent = "Having trouble?";
  }

  // Banner: surface the most actionable hint
  const banner = $("diag-banner");
  const hint = (d.ruleHints && d.ruleHints.length) ? d.ruleHints[d.ruleHints.length - 1] : null;
  if (errFresh && d.lastWriteErr?.hint) {
    banner.textContent = d.lastWriteErr.hint;
    banner.className = "diag-banner";
    banner.style.display = "block";
  } else if (hint) {
    banner.textContent = hint;
    banner.className = "diag-banner warn";
    banner.style.display = "block";
  } else {
    banner.style.display = "none";
  }

  $("diag-last-ok").textContent  = d.lastWriteOk?.op  ? `${d.lastWriteOk.op} · ${fmtAgo(sinceWrite)}` : "—";
  $("diag-last-err").textContent = d.lastWriteErr?.op ? `${d.lastWriteErr.op} · ${fmtAgo(sinceErr)}`  : "—";
  $("diag-partner-at").textContent = sincePartner !== null ? fmtAgo(sincePartner) : "—";
  $("diag-peers").textContent = String(d.peerCount || 0);
  $("diag-me").textContent     = d.myUserId      || "—";
  $("diag-them").textContent   = d.partnerUserId || "—";
  $("diag-tab").textContent    = d.primaryTabId  != null ? `tab ${d.primaryTabId}` : "—";

  // Sync event timeline
  const timeline = $("sync-timeline");
  if (timeline && d.syncEvents && d.syncEvents.length) {
    const lines = d.syncEvents.slice(-20).map(e => {
      const ago = Math.round((now - e.t) / 1000);
      const timeStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago/60)}m ago`;
      const color = e.type.includes("ERROR") || e.type === "DISCONNECT" ? "#ef4444"
        : e.type === "REMOTE_SYNC" ? "#60a5fa"
        : e.type === "LOCAL_SYNC" ? "#5ee2a0"
        : e.type === "CONNECT" ? "#a78bfa"
        : "rgba(244,241,234,0.5)";
      const detail = e.action ? ` [${e.action}${e.time != null ? ` @${e.time.toFixed(1)}s` : ""}]` : "";
      return `<div style="color:${color};padding:1px 0;">${e.type}${detail} <span style="color:rgba(244,241,234,0.3);">${timeStr}</span></div>`;
    });
    timeline.innerHTML = lines.join("");
    timeline.scrollTop = timeline.scrollHeight;
  } else if (timeline) {
    timeline.innerHTML = '<div style="color:rgba(244,241,234,0.3);padding:4px 0;">No sync events yet</div>';
  }
}

function fmtAgo(sec) {
  if (sec === null || sec === undefined) return "—";
  if (sec < 1)   return "just now";
  if (sec < 60)  return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = n => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── Live updates from background ───────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "POPUP_PEER_COUNT") {
    if (currentRoomCode) updatePeerHint(msg.peerCount);
  } else if (msg.type === "POPUP_PARTNER_META") {
    partnerMeta = msg.partner;
    myMeta = msg.mine;
    renderPartnerCard();
  } else if (msg.type === "POPUP_TOGETHER") {
    togetherInfo = msg.together || { since: null, total: 0 };
    if (typeof msg.serverNow === "number") serverClockOffset = msg.serverNow - Date.now();
    renderTogether();
  }
});

// ── Together-time counter ──────────────────────────────────
function currentSeconds() {
  const total = togetherInfo.total || 0;
  if (togetherInfo.since && typeof togetherInfo.since === "number") {
    const now = Date.now() + serverClockOffset;
    return total + Math.max(0, (now - togetherInfo.since) / 1000);
  }
  return total;
}

function renderTogether() {
  const el = $("together-text");
  if (!el) return;
  el.textContent = fmtTogether(currentSeconds());
}

function fmtTogether(sec) {
  sec = Math.floor(sec);
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

// Tick the counter + drift every second while popup is open
function startTogetherTicker() {
  if (togetherTicker) clearInterval(togetherTicker);
  togetherTicker = setInterval(() => {
    renderTogether();
    renderPartnerCard();
    if (currentRoomCode) {
      const ready = $("peer-hint").classList.contains("ready");
      if (ready) updatePeerHint(2);
    }
    if (lastDiag) renderDiag(lastDiag); // re-tick "Xs ago" labels
  }, 1000);
}

// ── Helpers ────────────────────────────────────────────────
function showMsg(id, type, text) {
  const el = $(id);
  el.className = `msg ${type}`;
  el.textContent = text;
}
function clearMsg(id) { const el = $(id); el.className = "msg"; el.textContent = ""; }
function setBtnLoading(id, label) {
  const btn = $(id);
  btn.innerHTML = `<span class="spinner"></span> ${label}`;
  btn.disabled = true;
}
function setBtnLabel(id, label) {
  const btn = $(id);
  btn.textContent = label;
  btn.disabled = false;
}

// ── Emoji Picker & Avatar ──────────────────────────────────
const EMOJI_PACKS = {
  "Expressive": ["😂", "😮", "😭", "😍", "💀", "🤔", "🥳", "😡", "🙄", "🥺", "🤡", "💩", "😴", "😎", "🤩", "🤯"],
  "Love & Hearts": ["❤️", "💖", "✨", "🔥", "💯", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "❣️", "💕", "💞"],
  "Hands": ["👍", "👊", "👋", "👏", "🙌", "✌️", "🤝", "🙏", "💪", "🤘", "🤟", "🖖", "🖐️", "👌", "🤙", "✍️"],
  "Vibes": ["🎬", "🍿", "🍕", "🍺", "🚀", "🌈", "☀️", "🌙", "🎉", "🎈", "💎", "👾", "🍔", "🍦", "🎸", "🎮"]
};

// ── Illustrated avatars (Disney+/Peacock style) ────────────
// Stored as compact codes "av:00".."av:23" so they fit inside the 16-char
// `meta.emoji` Firebase rule without rule changes. The popup translates
// the code into a DiceBear adventurer SVG URL for display.
const AVATAR_BASE = "https://api.dicebear.com/9.x/adventurer/svg?seed=";
const AVATAR_SEEDS = [
  "Mochi", "Pepper", "Suki", "Felix", "Luna", "Nico",
  "Sasha", "Kira", "Theo", "Ivy", "Rio", "Juno",
  "Zara", "Atlas", "Wren", "Hugo", "Mila", "Bo",
  "Indigo", "Soren", "Nova", "Cleo", "Otis", "Vesper"
];
// Distinct gradient backgrounds per avatar so each tile has its own vibe —
// inspired by streaming-service avatar palettes (peach, coral, mint, lavender,
// sky, sunshine, rose). Each entry is "startHex,endHex" — DiceBear renders
// it as a linear gradient.
const AVATAR_BG_GRADIENTS = [
  "ffd5dc,ff9eb8", "ffdfbf,ffb37b", "ffe5b4,f4c542", "c8e6c9,7bc99c",
  "b6e3f4,7ec8e3", "c0aede,9d7adf", "f8bbd0,e57ea3", "d1d4f9,8b9cf2",
  "ffc89a,ff7e5f", "a8e6cf,5ec27a", "ffeaa7,fdcb6e", "fab1a0,e17055",
  "fd79a8,d63384", "74b9ff,0984e3", "a29bfe,6c5ce7", "fdcb6e,f39c12",
  "e17055,c0392b", "00b894,00897b", "ff7675,d63031", "fd79a8,e84393",
  "55efc4,00b894", "81ecec,00cec9", "ffeaa7,fab1a0", "dfe6e9,b2bec3"
];
const AVATAR_CODES = AVATAR_SEEDS.map((_, i) => `av:${String(i).padStart(2, "0")}`);
function isAvatarCode(v) { return typeof v === "string" && /^av:\d{2}$/.test(v); }
function avatarUrl(code) {
  if (!isAvatarCode(code)) return null;
  const idx = parseInt(code.slice(3), 10);
  const seed = AVATAR_SEEDS[idx];
  if (!seed) return null;
  const bg = AVATAR_BG_GRADIENTS[idx % AVATAR_BG_GRADIENTS.length];
  return `${AVATAR_BASE}${encodeURIComponent(seed)}&backgroundColor=${bg}&backgroundType=gradientLinear`;
}
// Renders an avatar value (illustrated code OR legacy emoji OR empty) into a
// target element. For avatar codes we inject an <img>; for emoji we set text.
function renderAvatarInto(el, value, sizePx) {
  if (!el) return;
  el.innerHTML = "";
  el.classList.remove("has-img");
  if (isAvatarCode(value)) {
    const img = document.createElement("img");
    img.src = avatarUrl(value);
    img.alt = "";
    img.draggable = false;
    img.style.cssText = `width:${sizePx || "100%"};height:${sizePx || "100%"};border-radius:inherit;display:block;object-fit:cover;`;
    el.appendChild(img);
    el.classList.add("has-img");
  } else {
    el.textContent = value || DEFAULT_AVATAR;
  }
}

const DEFAULT_AVATAR = "👋";
const RECENTS_KEY = "__duet_emoji_recents";
const RECENTS_MAX = 12;

let currentEmojiPack = "Expressive";
let selectedAvatar = DEFAULT_AVATAR;
let pickerMode = "avatar";    // "avatar" or "reaction"
let recentEmojis = [];        // last picks, newest first
let searchQuery = "";

function allEmojis() {
  const seen = new Set();
  const out = [];
  for (const arr of Object.values(EMOJI_PACKS)) {
    for (const e of arr) { if (!seen.has(e)) { seen.add(e); out.push(e); } }
  }
  return out;
}

function openEmojiPicker(mode) {
  pickerMode = mode;
  searchQuery = "";
  const search = $("emoji-search");
  if (search) search.value = "";
  // Title hints at what the choice does
  const title = $("emoji-drawer-title");
  if (title) title.textContent = mode === "avatar" ? "Pick your avatar" : "Pick your vibe";
  // Reset chip is only meaningful for avatar mode
  const reset = $("emoji-reset-chip");
  if (reset) reset.style.display = mode === "avatar" ? "" : "none";
  // If recents exist, default to that pack; otherwise first real pack
  const hasRelevantRecents = mode === "avatar"
    ? recentEmojis.some(isAvatarCode)
    : recentEmojis.length > 0;
  if (hasRelevantRecents) {
    currentEmojiPack = "Recent";
  } else {
    currentEmojiPack = mode === "avatar" ? "Avatars" : Object.keys(EMOJI_PACKS)[0];
  }
  $("emoji-drawer").classList.add("active");
  $("emoji-backdrop")?.classList.add("active");
  renderEmojiCategories();
  renderEmojiGrid();
  // Focus search after the drawer finishes its slide-in animation
  setTimeout(() => search?.focus(), 100);
}

function closeEmojiPicker() {
  $("emoji-drawer").classList.remove("active");
  $("emoji-backdrop")?.classList.remove("active");
}

function renderEmojiCategories() {
  const host = $("emoji-categories");
  if (!host) return;
  host.innerHTML = "";
  // Avatar mode: a single "Avatars" pack of illustrated portraits.
  // Reaction mode: emoji packs + Recent (if any).
  let cats = [];
  if (pickerMode === "avatar") {
    if (recentEmojis.some(isAvatarCode)) cats.push("Recent");
    cats.push("Avatars");
  } else {
    if (recentEmojis.length) cats.push("Recent");
    cats.push(...Object.keys(EMOJI_PACKS));
  }
  if (!cats.includes(currentEmojiPack)) currentEmojiPack = cats[0];
  cats.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = `emoji-cat-btn ${cat === currentEmojiPack ? "active" : ""}`;
    btn.textContent = cat;
    btn.onclick = () => {
      currentEmojiPack = cat;
      searchQuery = "";
      const s = $("emoji-search"); if (s) s.value = "";
      renderEmojiCategories();
      renderEmojiGrid();
    };
    host.appendChild(btn);
  });
}

function renderEmojiGrid() {
  const host = $("emoji-grid");
  if (!host) return;
  host.innerHTML = "";

  let list;
  if (pickerMode === "avatar") {
    if (currentEmojiPack === "Recent") {
      list = recentEmojis.filter(isAvatarCode);
    } else {
      list = AVATAR_CODES;
    }
  } else if (searchQuery) {
    list = allEmojis();
  } else if (currentEmojiPack === "Recent") {
    list = recentEmojis;
  } else {
    list = EMOJI_PACKS[currentEmojiPack] || [];
  }

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "emoji-empty";
    empty.textContent = pickerMode === "avatar" ? "No avatars yet." : "No emojis here yet.";
    host.appendChild(empty);
    return;
  }

  list.forEach(value => {
    const btn = document.createElement("button");
    btn.className = "emoji-item";
    if (isAvatarCode(value)) {
      btn.classList.add("avatar-item");
      const img = document.createElement("img");
      img.src = avatarUrl(value);
      img.alt = "";
      img.draggable = false;
      btn.appendChild(img);
    } else {
      btn.textContent = value;
    }
    btn.onclick = () => {
      if (pickerMode === "avatar") {
        setAvatar(value);
      } else {
        sendReactionLocalAndRemote(value);
      }
      pushRecent(value);
      closeEmojiPicker();
    };
    host.appendChild(btn);
  });
}

async function pushRecent(emoji) {
  recentEmojis = [emoji, ...recentEmojis.filter(e => e !== emoji)].slice(0, RECENTS_MAX);
  try { await chrome.storage.local.set({ [RECENTS_KEY]: recentEmojis }); } catch {}
}

function refreshAvatarBtnState() {
  const btn = $("avatar-picker-btn");
  if (!btn) return;
  const isDefault = !selectedAvatar || selectedAvatar === DEFAULT_AVATAR;
  btn.classList.toggle("is-default", isDefault);
  btn.classList.toggle("is-set", !isDefault);
  btn.title = isDefault ? "Pick your avatar" : `Avatar: ${selectedAvatar} — click to change`;
  refreshQuickAvatars();
}

async function setAvatar(value, opts = {}) {
  const isReset = !value || value === DEFAULT_AVATAR;
  selectedAvatar = isReset ? DEFAULT_AVATAR : value;
  const btn = $("avatar-picker-btn");
  if (btn) {
    renderAvatarInto(btn, selectedAvatar);
    if (!opts.silent) {
      btn.classList.remove("just-set");
      void btn.offsetWidth; // restart the pop animation
      btn.classList.add("just-set");
    }
  }
  const logo = $("my-avatar-logo");
  if (logo) renderAvatarInto(logo, selectedAvatar);
  $("logo-mark")?.classList.toggle("has-avatar", !isReset);
  refreshAvatarBtnState();
  try {
    // SET_EMOJI with empty string clears server-side too. The field is named
    // "emoji" historically, but its value is now any avatar identifier
    // (illustrated `av:NN` code or legacy emoji char).
    await chrome.runtime.sendMessage({ type: "SET_EMOJI", emoji: isReset ? "" : selectedAvatar });
  } catch {}
}

// Build the quick-pick row dynamically: 7 illustrated portraits + the "More" chip.
const QUICK_PICK_CODES = ["av:00", "av:01", "av:02", "av:03", "av:04", "av:05", "av:06"];
function buildQuickAvatars() {
  const row = $("quick-avatars");
  if (!row) return;
  row.innerHTML = "";
  for (const code of QUICK_PICK_CODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-avatar";
    btn.dataset.avatar = code;
    const img = document.createElement("img");
    img.src = avatarUrl(code);
    img.alt = "";
    img.draggable = false;
    btn.appendChild(img);
    row.appendChild(btn);
  }
  const more = document.createElement("button");
  more.type = "button";
  more.className = "quick-avatar more";
  more.id = "quick-avatar-more";
  more.title = "More avatars";
  more.textContent = "+";
  row.appendChild(more);
}

function refreshQuickAvatars() {
  const row = $("quick-avatars");
  if (!row) return;
  row.querySelectorAll(".quick-avatar").forEach(btn => {
    if (btn.classList.contains("more")) return;
    btn.classList.toggle("selected", btn.dataset.avatar === selectedAvatar);
  });
}

// One-tap avatar from the row above the name input.
$("quick-avatars")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".quick-avatar");
  if (!btn) return;
  if (btn.classList.contains("more")) {
    openEmojiPicker("avatar");
    return;
  }
  const code = btn.dataset.avatar;
  if (!code) return;
  setAvatar(code);
  pushRecent(code);
});

// Listeners
$("avatar-picker-btn")?.addEventListener("click", () => openEmojiPicker("avatar"));
$("logo-mark")?.addEventListener("click", () => openEmojiPicker("avatar"));
$("open-emoji-picker-btn")?.addEventListener("click", () => openEmojiPicker("reaction"));
$("emoji-drawer-close")?.addEventListener("click", closeEmojiPicker);
$("emoji-backdrop")?.addEventListener("click", closeEmojiPicker);
$("emoji-reset-chip")?.addEventListener("click", () => {
  setAvatar("");
  closeEmojiPicker();
});

// ESC closes the drawer; debounced search re-renders the grid.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("emoji-drawer")?.classList.contains("active")) {
    closeEmojiPicker();
  }
});
let __searchDebounce = null;
$("emoji-search")?.addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  clearTimeout(__searchDebounce);
  __searchDebounce = setTimeout(renderEmojiGrid, 80);
});

// Initialize quick-pick row, categories + load recents
(async () => {
  try {
    const data = await chrome.storage.local.get([RECENTS_KEY]);
    if (Array.isArray(data?.[RECENTS_KEY])) recentEmojis = data[RECENTS_KEY].slice(0, RECENTS_MAX);
  } catch {}
  buildQuickAvatars();
  renderEmojiCategories();
  refreshAvatarBtnState();
})();

// ── Init ───────────────────────────────────────────────────
(async () => {
  // Load saved avatar and name
  try {
    const data = await chrome.storage.local.get(["myName", "myEmoji"]);
    if (data.myEmoji) {
      setAvatar(data.myEmoji, { silent: true });
    } else {
      refreshAvatarBtnState(); // mark .is-default for the pulse hint
    }
  } catch {}

  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (status?.currentRoom) {
      setConnectedState(status.currentRoom, status.peerCount || 1);
      partnerMeta = status.partner;
      myMeta = status.mine;
      togetherInfo = status.together || { since: null, total: 0 };
      if (typeof status.serverNow === "number") serverClockOffset = status.serverNow - Date.now();
      renderPartnerCard();
      renderTogether();
      if (status.diag) renderDiag(status.diag);
      startTogetherTicker();
    } else {
      setDisconnectedState();
    }
  } catch {
    setDisconnectedState();
  }

  // Periodically poll while popup is open so the partner card and diag stay fresh
  setInterval(async () => {
    if (!currentRoomCode) return;
    try {
      const s = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      if (s?.currentRoom) {
        partnerMeta = s.partner;
        myMeta = s.mine;
        // Keep the server-clock offset fresh so freshness checks don't drift
        // when the user's local clock isn't ticking exactly with the server.
        if (typeof s.serverNow === "number") serverClockOffset = s.serverNow - Date.now();
        if (s.diag) renderDiag(s.diag);
        renderPartnerCard();
      }
    } catch {
      // Background script may be restarting - silently skip this tick
    }
  }, 2000);
})();
