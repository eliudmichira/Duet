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

// Joining by code is the quiet path: one row under Create.
$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("join-btn");
  if (btn.disabled) return;
  const code = $("join-code-input").value.trim().toUpperCase();
  if (code.length !== 6) {
    showMsg("main-msg", "error", "Room codes are exactly 6 characters.");
    $("join-code-input").focus();
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="margin:0"></span>`;
  clearMsg("main-msg");

  let res;
  try { res = await chrome.runtime.sendMessage({ type: "JOIN_ROOM", roomCode: code }); } catch (e) {
    res = { error: "Extension not ready. Try again." };
  }
  btn.disabled = false;
  btn.textContent = "→";

  if (res?.error) { showMsg("main-msg", "error", res.error); return; }
  setConnectedState(res.roomCode, 2);
});

$("join-code-input").addEventListener("keydown", (e) => {
  // Enter mid-composition confirms the IME, it isn't a submit.
  if (e.key === "Enter" && (e.isComposing || e.keyCode === 229)) e.preventDefault();
});

// ── Display name (persisted) ──────────────────────────────
(async () => {
  const nameInput = $("name-input");
  if (!nameInput) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_NAME" });
    if (res?.name) nameInput.value = res.name;
  } catch {}
  renderMeSummary();
  let saveTimer = null;
  const persist = () => {
    const v = nameInput.value.trim().slice(0, 32);
    chrome.runtime.sendMessage({ type: "SET_NAME", name: v }).catch(() => {});
  };
  nameInput.addEventListener("input", () => {
    renderMeSummary();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 350);
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !(e.isComposing || e.keyCode === 229)) { persist(); setMeExpanded(false); }
  });
  nameInput.addEventListener("blur", persist);
})();
// ── "You" row ──────────────────────────────────────────────
// Collapsed to one line ("You · [avatar] Alex ✎"); expands to the avatar row
// and name field on tap, and on first run (no name, no avatar yet).
function renderMeSummary() {
  const name = $("name-input").value.trim();
  const nameEl = $("me-name");
  nameEl.textContent = name || "Add your name";
  nameEl.classList.toggle("is-empty", !name);
  renderAvatarInto($("me-avatar"), selectedAvatar);
}
function setMeExpanded(open) {
  $("me-editor").hidden = !open;
  $("me-summary").setAttribute("aria-expanded", String(open));
  // Once collapsed, the one-line summary is how you get back in.
  if (!open) $("me").classList.remove("first-run");
}
$("me-summary").addEventListener("click", () => {
  const open = $("me-editor").hidden;
  setMeExpanded(open);
  if (open) setTimeout(() => $("name-input").focus(), 0);
});

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

// ── Go to / Bring partner here ─────────────────────────────
// One name per action: "Go to Sam" moves you; "Bring Sam here" moves them.
function partnerFirstName() {
  return (partnerMeta && typeof partnerMeta.name === "string" && partnerMeta.name.trim()) || "";
}
const goLabel = () => `Go to ${partnerFirstName() || "partner"}`;
const bringLabel = () => `Bring ${partnerFirstName() || "partner"} here`;
function refreshSyncMeBtnLabel() {
  for (const [id, label] of [["sync-me-btn", goLabel], ["bring-btn", bringLabel]]) {
    const btn = $(id);
    if (btn && !btn.disabled) btn.querySelector("span").textContent = label();
  }
  renderReadyBtn();
}

async function runSyncButton(id, type, busyText, okText, labelFn) {
  const btn = $(id);
  if (!btn || btn.disabled) return;
  const label = btn.querySelector("span");
  btn.disabled = true;
  label.textContent = busyText;
  clearMsg("room-msg");
  let res;
  try { res = await chrome.runtime.sendMessage({ type }); } catch {
    res = { error: "Extension not ready. Try again." };
  }
  // Only claim success when the background verified the two positions match.
  if (res?.navigating) {
    // You were on another video (or none): their page is opening and the
    // background catches up once it loads. Nothing more to do here.
    label.textContent = `Opening ${partnerFirstName() || "their"}'s video…`;
    setTimeout(() => window.close(), 700);
    return;
  } else if (res?.ok) {
    btn.classList.add("success");
    label.textContent = okText;
  } else if (typeof res?.drift === "number") {
    showMsg("room-msg", "warn", `Couldn't fully sync — off by ${res.drift.toFixed(1)}s. Try again.`);
  } else {
    showMsg("room-msg", "error", res?.error || "Couldn't sync.");
  }
  setTimeout(() => {
    btn.classList.remove("success");
    btn.disabled = false;
    label.textContent = labelFn();
  }, res?.ok ? 1800 : 0);
}
$("sync-me-btn").addEventListener("click", () => {
  const who = partnerFirstName() || "partner";
  runSyncButton("sync-me-btn", "CATCH_UP_TO_PARTNER", `Going to ${who}…`, `With ${who} ✓`, goLabel);
});
$("bring-btn").addEventListener("click", () => {
  const who = partnerFirstName() || "partner";
  runSyncButton("bring-btn", "SYNC_TO_ME", `Bringing ${who}…`, `${who} is with you ✓`, bringLabel);
});

// ── Ready check ────────────────────────────────────────────
let readyInfo = { phase: "none" };
function renderReadyBtn() {
  const btn = $("ready-btn");
  if (!btn) return;
  const r = readyInfo || { phase: "none" };
  const who = partnerFirstName();
  btn.classList.toggle("is-waiting", r.phase === "asking" && r.byMe);
  btn.disabled = r.phase === "go" || (r.phase === "asking" && r.meReady && !r.byMe);
  btn.textContent =
    r.phase === "go" ? "Starting — watch your video" :
    r.phase === "asking" && r.byMe ? `Waiting for ${who || "partner"}… · Cancel` :
    r.phase === "asking" && !r.meReady ? `${who || "Partner"} is ready — I'm ready too` :
    r.phase === "asking" ? "Starting…" :
    "Both ready? Count us in";
  renderPrimary();
}
$("ready-btn").addEventListener("click", async () => {
  const r = readyInfo || { phase: "none" };
  let msg = null;
  if (r.phase === "none") msg = { type: "READY_START" };
  else if (r.phase === "asking" && r.byMe) msg = { type: "READY_ANSWER", ready: false };
  else if (r.phase === "asking" && !r.meReady) msg = { type: "READY_ANSWER", ready: true };
  if (!msg) return;
  clearMsg("room-msg");
  let res;
  try { res = await chrome.runtime.sendMessage(msg); } catch { res = { error: "Extension not ready. Try again." }; }
  if (res?.error) showMsg("room-msg", "error", res.error);
});

// ── One raised action at a time (DESIGN.md hierarchy rule) ──
//   a ready check in progress            → the ready button
//   out of sync, or on another / no video → "Go to <partner>"
//   both paused, in step                 → the ready check
//   playing in sync                      → nothing raised
function primaryAction() {
  if (readyInfo?.phase && readyInfo.phase !== "none") return "ready";
  if ($("control-row").style.display !== "flex") return "none"; // partner not here
  if (partnerFreshness().state === "gone") return "none";
  if (!myMeta?.url) return "go";
  if (normalizeUrl(myMeta.url) !== normalizeUrl(partnerMeta.url)) return "go";
  const a = projectTime(myMeta), b = projectTime(partnerMeta);
  if (a !== null && b !== null && Math.abs(a - b) > 2) return "go";
  if (myMeta.paused && partnerMeta.paused) return "ready";
  return "none";
}
function renderPrimary() {
  const p = primaryAction();
  $("ready-btn")?.classList.toggle("is-quiet", p !== "ready");
  $("sync-me-btn")?.classList.toggle("is-primary", p === "go");
}

// ── Chat history ───────────────────────────────────────────
function chatRow(item) {
  const row = document.createElement("div");
  row.className = `chat-row${item.mine ? " mine" : ""}`;
  const who = document.createElement("span");
  who.className = "chat-who";
  who.textContent = item.mine ? "You" : (partnerFirstName() || "Partner");
  const text = document.createElement("span");
  text.textContent = item.text;
  row.append(who, text);
  return row;
}
function renderChatLog(items) {
  const log = $("chat-log");
  log.replaceChildren(...items.slice(-30).map(chatRow));
  log.hidden = items.length === 0;
  log.scrollTop = log.scrollHeight;
}
async function loadChatLog() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_CHAT" });
    if (Array.isArray(res?.items)) renderChatLog(res.items);
  } catch {}
}

// ── Badge hidden with ✕ on the active tab ──────────────────
async function activeTabId() {
  try { return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null; } catch { return null; }
}
async function refreshShowBadge() {
  const btn = $("show-badge-btn");
  const tabId = currentRoomCode ? await activeTabId() : null;
  let hidden = false;
  if (tabId != null) {
    try { hidden = !!(await chrome.tabs.sendMessage(tabId, { type: "BADGE_HIDDEN?" }))?.hidden; } catch {}
  }
  btn.hidden = !hidden;
}
$("show-badge-btn").addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "SHOW_BADGE" }).catch(() => {});
  $("show-badge-btn").hidden = true;
});

// ── Saved rooms ────────────────────────────────────────────
const PAIRS_SHOWN = 3;
async function renderPairs() {
  let pairs = {};
  try { pairs = (await chrome.runtime.sendMessage({ type: "GET_PAIRS" }))?.pairs || {}; } catch {}
  const entries = Object.entries(pairs)
    .sort((a, b) => (b[1]?.lastAt || 0) - (a[1]?.lastAt || 0))
    .slice(0, PAIRS_SHOWN);
  const list = $("pairs-list");
  list.replaceChildren();
  for (const [code, p] of entries) {
    const item = document.createElement("div");
    item.className = "pair-item";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "pair-open";
    const av = document.createElement("span");
    av.className = "pair-av";
    renderAvatarInto(av, p?.emoji || "👤");
    const text = document.createElement("span");
    text.className = "pair-text";
    text.textContent = p?.name ? `Watch with ${p.name}` : "Your saved room";
    const codeEl = document.createElement("span");
    codeEl.className = "pair-code";
    codeEl.textContent = code;
    open.append(av, text, codeEl);
    open.title = `Rejoin room ${code} — same code every time`;
    open.addEventListener("click", async () => {
      open.disabled = true;
      text.textContent = "Opening…";
      clearMsg("main-msg");
      let res;
      try { res = await chrome.runtime.sendMessage({ type: "OPEN_PAIR", code }); } catch { res = { error: "Extension not ready. Try again." }; }
      if (res?.error) {
        open.disabled = false;
        text.textContent = p?.name ? `Watch with ${p.name}` : "Your saved room";
        showMsg("main-msg", "error", res.error);
        return;
      }
      setConnectedState(res.roomCode, res.peerCount || 1);
    });
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "pair-forget";
    forget.textContent = "✕";
    forget.title = "Forget this room";
    forget.setAttribute("aria-label", `Forget ${p?.name ? `room with ${p.name}` : `room ${code}`}`);
    // Forgetting is one click, so it can be taken back: the row becomes an
    // undo strip for a few seconds before the list closes up.
    forget.addEventListener("click", async () => {
      let res = null;
      try { res = await chrome.runtime.sendMessage({ type: "FORGET_PAIR", code }); } catch {}
      const removed = res?.removed;
      if (!removed) { renderPairs(); return; }
      const strip = document.createElement("div");
      strip.className = "pair-undo";
      strip.setAttribute("role", "status");
      const note = document.createElement("span");
      note.textContent = p?.name ? `Forgot your room with ${p.name}` : `Forgot room ${code}`;
      const undo = document.createElement("button");
      undo.type = "button";
      undo.textContent = "Undo";
      let undone = false;
      undo.addEventListener("click", async () => {
        undone = true;
        try { await chrome.runtime.sendMessage({ type: "RESTORE_PAIR", code, pair: removed }); } catch {}
        renderPairs();
      });
      strip.append(note, undo);
      item.replaceChildren(strip);
      undo.focus();
      setTimeout(() => { if (!undone) renderPairs(); }, 6000);
    });
    item.append(open, forget);
    list.appendChild(item);
  }
  $("pairs").hidden = entries.length === 0;
}

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
  if (e.isComposing || e.keyCode === 229) return;
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
// Same as "Go to": open their page, then catch up once it loads. Stays open
// to say why when it can't (no video shared yet, not a web page).
$("open-partner-url").addEventListener("click", async () => {
  clearMsg("room-msg");
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "CATCH_UP_TO_PARTNER" }); } catch { res = { error: "Extension not ready. Try again." }; }
  if (res?.navigating || res?.ok) { window.close(); return; }
  showMsg("room-msg", "error", res?.error || "Couldn't open their video.");
});

// ── State Helpers ──────────────────────────────────────────
function setConnectedState(roomCode, peerCount) {
  currentRoomCode = roomCode;
  renderCodeCells(roomCode);
  setMeExpanded(false);
  $("view-disconnected").style.display = "none";
  $("view-connected").style.display = "block";
  $("status").hidden = false;
  $("footer").hidden = true; // room view needs the height
  $("status-dot").classList.add("connected");
  $("status-text").textContent = `Live · Room ${roomCode}`;
  clearMsg("main-msg");
  updatePeerHint(peerCount);
  loadChatLog();
  refreshShowBadge();
}

// The start screen has no status pill: "Not connected" said nothing useful.
function setDisconnectedState() {
  currentRoomCode = null;
  partnerMeta = null;
  myMeta = null;
  readyInfo = { phase: "none" };
  renderCodeCells(null);
  $("view-disconnected").style.display = "block";
  $("view-connected").style.display = "none";
  $("status").hidden = true;
  $("footer").hidden = false;
  $("status-dot").classList.remove("connected");
  clearMsg("room-msg");
  renderChatLog([]);
  renderPairs();
}

function updatePeerHint(count) {
  const el = $("peer-hint");
  // The code is only needed until the partner arrives; after that the card
  // collapses (status pill still shows the room) and the popup fits Chrome's
  // 600px height without scrolling. It comes back if they leave.
  $("room-card").hidden = count >= 2;
  // With the partner here, the partner card and the "Live" pill say it all.
  el.hidden = count >= 2;
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
    $("together-row").style.display = "block";
    renderStory();
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
  host.replaceChildren();
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
    el.replaceChildren();
    const img = document.createElement("img");
    img.src = avatarUrl(value);
    img.alt = "";
    img.draggable = false;
    el.appendChild(img);
    el.classList.add("visible");
  } else if (value && typeof value === "string" && value.length > 0 && value.length <= 4) {
    el.replaceChildren();
    el.textContent = value;
    el.classList.add("visible");
    el.style.display = "inline-flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.fontSize = "11px";
  } else {
    el.replaceChildren();
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
    renderPrimary();
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
  renderPrimary();
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
    const who = (lastPartnerName() || "Your partner");
    $("trouble-text").textContent = `${who}'s video tab isn't reporting — ask them to refresh it`;
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

function lastPartnerName() {
  return (partnerMeta && typeof partnerMeta.name === "string" && partnerMeta.name.trim()) || "";
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
    const prevName = partnerMeta?.name;
    partnerMeta = msg.partner;
    myMeta = msg.mine;
    renderPartnerCard();
    if (partnerMeta?.name !== prevName) renderStory();
  } else if (msg.type === "POPUP_READY") {
    readyInfo = msg.ready || { phase: "none" };
    renderReadyBtn();
  } else if (msg.type === "POPUP_CHAT") {
    if (currentRoomCode && msg.item) {
      const log = $("chat-log");
      log.appendChild(chatRow(msg.item));
      while (log.childElementCount > 30) log.firstElementChild.remove();
      log.hidden = false;
      log.scrollTop = log.scrollHeight;
    }
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

// ── Our story ──────────────────────────────────────────────
// History with this partner, from the local tally background.js keeps
// (time both of you were playing the same video, per partner name).
const STORY_KEY = "__duet_story";
function fmtStoryTime(sec) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
async function renderStory() {
  const name = (partnerMeta && typeof partnerMeta.name === "string" && partnerMeta.name.trim()) || "";
  $("story-name").textContent = name || "your partner";
  let entry = null;
  try {
    // Saved rooms keep their tally under the room code, so renames don't
    // reset it (see background.js storyTick).
    const { [STORY_KEY]: story, __duet_pairs: pairs } = await chrome.storage.local.get([STORY_KEY, "__duet_pairs"]);
    const key = currentRoomCode && pairs?.[currentRoomCode] ? `room:${currentRoomCode}` : (name.toLowerCase() || "__unnamed");
    entry = story?.partners?.[key] || null;
  } catch {}
  const seconds = entry?.seconds || 0;
  const nights = entry?.days ? Object.keys(entry.days).length : 0;
  $("story-stats").textContent = seconds < 60
    ? "Your story starts tonight."
    : `${fmtStoryTime(seconds)} watched together · ${nights} ${nights === 1 ? "night" : "nights"}`;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORY_KEY] || changes.__duet_pairs) && currentRoomCode) renderStory();
});

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

// ── Illustrated avatars ────────────────────────────────────
// Stored as compact codes "av:00".."av:23" so they fit inside the 16-char
// `meta.emoji` Firebase rule. The portraits ship with the extension
// (vendor/avatars/, generated by tools/vendor-assets.mjs — the seed and
// gradient for each index live there).
const AVATAR_COUNT = 24;
const AVATAR_CODES = Array.from({ length: AVATAR_COUNT }, (_, i) => `av:${String(i).padStart(2, "0")}`);
function isAvatarCode(v) { return typeof v === "string" && /^av:\d{2}$/.test(v); }
function avatarUrl(code) {
  if (!isAvatarCode(code)) return null;
  const idx = parseInt(code.slice(3), 10);
  if (!(idx >= 0 && idx < AVATAR_COUNT)) return null;
  return `vendor/avatars/av-${code.slice(3)}.svg`;
}
// Renders an avatar value (illustrated code OR legacy emoji OR empty) into a
// target element. For avatar codes we inject an <img>; for emoji we set text.
function renderAvatarInto(el, value, sizePx) {
  if (!el) return;
  el.replaceChildren();
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
  host.replaceChildren();
  // Avatar mode: a single "Avatars" pack of illustrated portraits.
  // Reaction mode: emoji packs + Recent (if any).
  let cats = [];
  if (pickerMode === "avatar") {
    if (recentEmojis.some(isAvatarCode)) cats.push("Recent");
    cats.push("Avatars");
  } else {
    if (recentEmojis.some((e) => !isAvatarCode(e))) cats.push("Recent");
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
  host.replaceChildren();

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
    // Recents hold avatars too; as a reaction an avatar would be sent as
    // the literal text "av:NN".
    list = recentEmojis.filter((e) => !isAvatarCode(e));
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
  renderAvatarInto($("me-avatar"), selectedAvatar);
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
  row.replaceChildren();
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
    // First run: open the editor so setting a name is the obvious first step,
    // without the "Add your name" summary row repeating it above.
    if (!data.myName && !data.myEmoji) {
      $("me").classList.add("first-run");
      setMeExpanded(true);
    }
  } catch {}

  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (status?.currentRoom) {
      setConnectedState(status.currentRoom, status.peerCount || 1);
      partnerMeta = status.partner;
      myMeta = status.mine;
      togetherInfo = status.together || { since: null, total: 0 };
      readyInfo = status.ready || { phase: "none" };
      if (typeof status.serverNow === "number") serverClockOffset = status.serverNow - Date.now();
      renderPartnerCard();
      renderReadyBtn();
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
