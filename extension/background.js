// ============================================================
//  Duet — Background Service Worker
// ============================================================

// Production builds keep warnings/errors but silence chatty logs. Flip to
// true while developing if you need the verbose trace.
const DEBUG = false;
const dlog = (...args) => { if (DEBUG) console.log(...args); };

// importScripts is used by Chrome MV3 service workers.
// Firefox MV3 uses background.scripts[] in the manifest instead — the build
// script (build-firefox.ps1) strips these lines and injects the vendor files
// via manifest.firefox.json's background.scripts array, so they are already
// loaded before this script runs. The guard below makes background.js safe to
// run in both environments without modification.
if (typeof importScripts === "function") {
  importScripts(
    "vendor/firebase-app-compat.js",
    "vendor/firebase-database-compat.js"
  );
}

// ── Firebase Config ─────────────────────────────────────────
// Hosted-only for v1. Every install talks to the same developer-managed
// Firebase Realtime Database. Per-room write throttling and TTL cleanup
// live in the RTDB rules and a scheduled Cloud Function. The API key is
// restricted to chrome-extension://<this-id>/* via Cloud Console.
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAMT9lZ_CJqMewsosu6yKJ6UcR8nTGSPeA",
  authDomain:        "pausepal-a4d71.firebaseapp.com",
  databaseURL:       "https://pausepal-a4d71-default-rtdb.firebaseio.com",
  projectId:         "pausepal-a4d71",
  messagingSenderId: "870295332520",
  appId:             "1:870295332520:web:caf80b137bc8b50f5f449d"
};

// ── State ───────────────────────────────────────────────────
let db = null;
let currentRoom = null;
let myUserId = null;
let roomRef = null;
let presenceRef = null;
let metaRef = null;
let reactionsRef = null;

let stateListenerOff = null;
let presenceListenerOff = null;
let metaListenerOff = null;
let togListenerOff = null;
let reactionsListenerOff = null;
let typingListenerOff = null;

let serverTimeOffset = 0;
let partnerMeta = null;       // last meta we saw from the partner
let myLastTabInfo = null;     // last meta we wrote ourselves
let myName = "";              // user-set display name, persisted in storage
let myEmoji = "";             // user-set avatar emoji
let lastPeerCount = 0;        // for detecting 1→2 transition (auto-resync trigger)
let togetherInfo = { since: null, total: 0 };  // co-watch timer state

let primaryTabId = null;      // the single active video tab we are tracking
let lastTabInfoTime = 0;      // when we last heard from the primary tab
let primaryPaused = true;     // primary tab's last reported paused state

// ── Diagnostics ─────────────────────────────────────────────
// Surfaces silent failures (rule rejections, missing tab, etc.) to the popup
// so the user can see *why* things aren't working without opening devtools.
const diag = {
  lastWriteOk:    { op: null, at: 0 },
  lastWriteErr:   { op: null, at: 0, message: null, hint: null },
  lastPartnerAt:  0,
  myUserId:       null,
  partnerUserId:  null,
  primaryTabId:   null,
  peerCount:      0,
  ruleHints:      [],
  syncEvents:     []  // ring buffer of recent sync events for diagnostics
};
const SYNC_EVENT_MAX = 50;

function recordOk(op) {
  diag.lastWriteOk = { op, at: Date.now() };
}
function recordErr(op, err) {
  const message = err?.message || String(err);
  const hint = explainFirebaseError(op, message);
  diag.lastWriteErr = { op, at: Date.now(), message, hint };
  if (hint && !diag.ruleHints.includes(hint)) diag.ruleHints.push(hint);
}

// Translate Firebase errors into plain-English fixes the user can act on.
function explainFirebaseError(op, message) {
  if (!message) return null;
  if (message.includes("PERMISSION_DENIED")) {
    if (op === "pushSyncEvent")
      return "Firebase rejected a sync write — your DB rules likely don't allow the `force` field. Re-paste the latest rules from the README and Publish.";
    if (op === "pushTabInfo")
      return "Firebase rejected the tab-info write. Your DB rules may be blocking writes outside `state`. Re-paste the rules from the README.";
    if (op === "pushReaction")
      return "Firebase rejected a reaction. Same root cause — re-paste the rules from the README.";
    return "Firebase rejected the write. Check your Realtime Database rules.";
  }
  if (message.includes("Network") || message.includes("offline"))
    return "Network looks offline. Reconnect and the sync will catch up.";
  return null;
}

// ── Firebase Setup ──────────────────────────────────────────
// Exponential backoff retry for Firebase connection.
// Pattern: 1s → 2s → 4s → 8s → 16s (max), then stays at 16s.
let firebaseRetryAttempt = 0;
const FIREBASE_MAX_RETRY_MS = 16000;

async function initFirebase() {
  if (db) return true;
  await Promise.all(firebase.apps.map(app => app.delete()));
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.database();

  db.ref(".info/serverTimeOffset").on("value", (snap) => {
    serverTimeOffset = snap.val() || 0;
  });

  // Monitor connection state for automatic reconnection
  db.ref(".info/connected").on("value", (snap) => {
    if (snap.val() === false) {
      // Disconnected — schedule retry with backoff
      firebaseRetryAttempt++;
      const delay = Math.min(FIREBASE_MAX_RETRY_MS, 1000 * Math.pow(2, firebaseRetryAttempt));
      dlog(`[Duet] Firebase disconnected, retrying in ${delay}ms (attempt ${firebaseRetryAttempt})`);
      setTimeout(() => {
        if (!db) {
          initFirebase().catch(() => {});
        }
      }, delay);
    } else {
      // Connected — reset backoff
      if (firebaseRetryAttempt > 0) {
        dlog("[Duet] Firebase reconnected");
        firebaseRetryAttempt = 0;
      }
    }
  });

  return true;
}

const serverNow = () => Date.now() + serverTimeOffset;

// ── Helpers ─────────────────────────────────────────────────
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  return code;
}
const generateUserId = () => "user_" + Math.random().toString(36).slice(2, 10);

// Reject a promise after `ms` if it hasn't settled. Used to give the popup a
// real error instead of hanging forever when Firebase is unreachable (offline,
// uBlock blocking firebaseio.com, regional firewall, slow cold SW, etc.).
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ── Room Management ─────────────────────────────────────────
async function createRoom() {
  try {
    await withTimeout(initFirebase(), 10000, "Connecting to Firebase");
  } catch (err) {
    return { error: "Can't reach Duet's sync server. Check your internet or disable ad-blockers for this extension." };
  }

  const roomCode = generateRoomCode();
  myUserId = generateUserId();

  setRoomRefs(roomCode);

  try {
    await withTimeout(roomRef.set({
      state: {
        action: "pause", currentTime: 0, updatedBy: myUserId,
        serverTime: firebase.database.ServerValue.TIMESTAMP
      },
      host: myUserId,
      created: firebase.database.ServerValue.TIMESTAMP
    }), 12000, "Creating room");
  } catch (err) {
    const msg = err?.message || String(err);
    if (/PERMISSION_DENIED/i.test(msg)) {
      return { error: "Firebase rules rejected the room creation. Re-paste the rules from the README." };
    }
    return { error: "Couldn't create the room — network issue. Try again." };
  }

  await presenceRef.set({ joined: firebase.database.ServerValue.TIMESTAMP });
  presenceRef.onDisconnect().remove();
  metaRef.onDisconnect().remove();

  currentRoom = roomCode;
  attachListeners(roomCode);

  await chrome.storage.local.set({ currentRoom: roomCode, myUserId });
  validateRules().catch(() => {});
  return { roomCode, myUserId, peerCount: 1 };
}

async function joinRoom(roomCode) {
  try {
    await withTimeout(doBootstrap(), 10000, "Connecting to Firebase");
  } catch (err) {
    return { error: "Can't reach Duet's sync server. Check your internet or disable ad-blockers for this extension." };
  }
  roomCode = roomCode.toUpperCase().trim();
  if (!/^[A-Z2-9]{6}$/.test(roomCode)) {
    return { error: "Invalid room code format. Codes are 6 characters, letters + numbers." };
  }

  let snap;
  try {
    snap = await withTimeout(db.ref(`rooms/${roomCode}`).get(), 12000, "Looking up room");
  } catch (err) {
    const msg = err?.message || String(err);
    if (/PERMISSION_DENIED/i.test(msg)) {
      return { error: "Firebase rules are blocking room lookup. Re-paste the rules from the README." };
    }
    return { error: "Couldn't reach Firebase to check the room. Network issue or Firebase is blocked on this network." };
  }
  if (!snap.exists()) return { error: "Room not found. Check the code and try again." };

  // Note: We removed the strict 'memberCount >= 2' rejection here.
  // If the service worker crashes, Firebase can leave a 'ghost' connection for ~60s.
  // We want to allow the user to rejoin their own room without being blocked by their own ghost!

  myUserId = generateUserId();
  setRoomRefs(roomCode);

  try {
    await withTimeout(
      presenceRef.set({ joined: firebase.database.ServerValue.TIMESTAMP }),
      10000,
      "Joining room"
    );
  } catch (err) {
    const msg = err?.message || String(err);
    if (/PERMISSION_DENIED/i.test(msg)) {
      return { error: "Firebase rules rejected the join. Re-paste the rules from the README." };
    }
    return { error: "Couldn't register your presence — network issue. Try again." };
  }
  presenceRef.onDisconnect().remove();
  metaRef.onDisconnect().remove();

  currentRoom = roomCode;
  attachListeners(roomCode);

  await chrome.storage.local.set({ currentRoom: roomCode, myUserId });
  validateRules().catch(() => {});
  return { roomCode, myUserId, joined: true };
}

function setRoomRefs(roomCode) {
  roomRef      = db.ref(`rooms/${roomCode}`);
  presenceRef  = db.ref(`presence/${roomCode}/${myUserId}`);
  metaRef      = db.ref(`rooms/${roomCode}/meta/${myUserId}`);
  reactionsRef = db.ref(`rooms/${roomCode}/reactions`);
}

async function leaveRoom() {
  // Capture refs before we null them so the empty-room cleanup below can use them.
  const leavingRoom = currentRoom;
  const leavingRoomRef = roomRef;

  try { if (presenceRef) await presenceRef.remove(); } catch {}
  try { if (metaRef)     await metaRef.remove();     } catch {}

  // If we were the last peer, clean up the whole room so abandoned rooms
  // don't accumulate in the DB. We re-check presence after our own removal:
  // if it's empty (or nonexistent), remove `rooms/<code>`.
  if (leavingRoom && db) {
    try {
      const presSnap = await db.ref(`presence/${leavingRoom}`).get();
      const remaining = presSnap.exists() ? Object.keys(presSnap.val() || {}).length : 0;
      if (remaining === 0 && leavingRoomRef) {
        await leavingRoomRef.remove().catch(() => {});
      }
    } catch {}
  }

  detachListeners();
  roomRef = presenceRef = metaRef = reactionsRef = null;
  currentRoom = myUserId = null;
  partnerMeta = null;
  myLastTabInfo = null;
  lastPeerCount = 0;
  togetherInfo = { since: null, total: 0 };
  diag.lastWriteOk    = { op: null, at: 0 };
  diag.lastWriteErr   = { op: null, at: 0, message: null, hint: null };
  diag.lastPartnerAt  = 0;
  diag.partnerUserId  = null;
  diag.peerCount      = 0;
  diag.ruleHints      = [];
  rulesValidated      = false;
  await chrome.storage.local.remove(["currentRoom", "myUserId"]);
  broadcastConnection(false, 0);
  return { left: true };
}

// ── Listeners ───────────────────────────────────────────────
function attachListeners(roomCode) {
  detachListeners();

  // Video state
  const stateRef = db.ref(`rooms/${roomCode}/state`);
  const stateHandler = stateRef.on("value", (snap) => {
    const state = snap.val();
    if (!state || state.updatedBy === myUserId) return;
    broadcastToVideoTabs({ type: "REMOTE_SYNC", state, serverNow: serverNow() });
  });
  stateListenerOff = () => stateRef.off("value", stateHandler);

  // Presence
  const presRef = db.ref(`presence/${roomCode}`);
  const presHandler = presRef.on("value", (snap) => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    handlePeerCountChange(count);
    broadcastConnection(true, count);
  });
  presenceListenerOff = () => presRef.off("value", presHandler);

  // Watch-time counter (shared across both clients)
  const togRef = db.ref(`rooms/${roomCode}/together`);
  const togHandler = togRef.on("value", (snap) => {
    togetherInfo = snap.val() || { since: null, total: 0 };
    chrome.runtime.sendMessage({ type: "POPUP_TOGETHER", together: togetherInfo, serverNow: serverNow() }).catch(() => {});
  });
  togListenerOff = () => togRef.off("value", togHandler);

  // Partner metadata (what they're watching)
  const meta = db.ref(`rooms/${roomCode}/meta`);
  const metaHandler = meta.on("value", (snap) => {
    const all = snap.val() || {};
    const partners = Object.entries(all)
      .filter(([uid]) => uid !== myUserId)
      .map(p => ({ userId: p[0], ...p[1] }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

    partnerMeta = partners[0] || null;
    if (partnerMeta) {
      diag.lastPartnerAt = Date.now();
      diag.partnerUserId = partnerMeta.userId;
    } else {
      diag.partnerUserId = null;
    }
    broadcastPartnerMeta();
  });
  metaListenerOff = () => meta.off("value", metaHandler);

  // Typing indicator
  const typingRef = db.ref(`rooms/${roomCode}/typing`);
  const typingHandler = typingRef.on("value", (snap) => {
    const data = snap.val() || {};
    const partnerTyping = Object.entries(data)
      .filter(([uid]) => uid !== myUserId)
      .some(([_, v]) => v === true);
    broadcastToVideoTabs({ type: "TYPING_STATUS", typing: partnerTyping });
  });
  typingListenerOff = () => typingRef.off("value", typingHandler);

  // Reactions
  const reacts = db.ref(`rooms/${roomCode}/reactions`);
  const reactsHandler = reacts.on("child_added", (snap) => {
    const r = snap.val();
    if (!r || r.from === myUserId) return;
    // Drop reactions that arrived from before we joined
    if (typeof r.ts !== "number" || serverNow() - r.ts > 8000) return;
    broadcastToVideoTabs({ type: "SHOW_REACTION", emoji: r.emoji });
  });
  reactionsListenerOff = () => reacts.off("child_added", reactsHandler);
}

function detachListeners() {
  for (const off of [stateListenerOff, presenceListenerOff, metaListenerOff, togListenerOff, reactionsListenerOff, typingListenerOff]) {
    try { off?.(); } catch {}
  }
  stateListenerOff = presenceListenerOff = metaListenerOff = togListenerOff = reactionsListenerOff = typingListenerOff = null;
}

// ── Peer-count transitions (auto-resync + together-timer) ──
function handlePeerCountChange(newCount) {
  const prev = lastPeerCount;
  lastPeerCount = newCount;
  diag.peerCount = newCount;

  // Partner just arrived → push my current state so they snap to me
  // (only the *existing* user fires this; freshly-joined users had prev=0)
  if (prev === 1 && newCount === 2) {
    setTimeout(() => { syncToMe().catch(() => {}); }, 1200);
  }

  // Together timer: start when room first reaches 2; freeze when it drops below 2
  const togRef = db.ref(`rooms/${currentRoom}/together`);
  if (newCount >= 2 && prev < 2) {
    // Set "since" only if not already set (race-safe via transaction)
    togRef.transaction((cur) => {
      const t = cur || { since: null, total: 0 };
      if (!t.since) t.since = firebase.database.ServerValue.TIMESTAMP;
      return t;
    });
  } else if (newCount < 2 && prev >= 2) {
    // Accumulate elapsed into total, clear "since"
    togRef.transaction((cur) => {
      const t = cur || { since: null, total: 0 };
      if (t.since && typeof t.since === "number") {
        const elapsed = Math.max(0, (serverNow() - t.since) / 1000);
        t.total = (t.total || 0) + elapsed;
      }
      t.since = null;
      return t;
    });
  }
}

// ── Pushes to Firebase ──────────────────────────────────────
// Returns { ok } or { error, code }. The caller decides whether to surface.
async function pushSyncEvent(state, opts = {}) {
  if (!roomRef || !myUserId) return { error: "Not in a room." };
  // Only include `force` when true — RTDB rules whitelist state keys; `force: false`
  // still counts as an extra key and rejects the whole write with $other: false.
  const payload = {
    ...state,
    updatedBy: myUserId,
    serverTime: firebase.database.ServerValue.TIMESTAMP
  };
  if (opts.force) payload.force = true;
  try {
    await roomRef.child("state").set(payload);
    // Stamp room-level activity so the scheduled cleanup function can age out
    // truly idle rooms (best-effort; failure is harmless).
    roomRef.child("lastTouch").set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
    recordOk("pushSyncEvent");
    return { ok: true };
  } catch (err) {
    const msg = err?.message || String(err);
    const denied = /PERMISSION_DENIED/i.test(msg);
    if (denied && payload.force) {
      delete payload.force;
      try {
        await roomRef.child("state").set(payload);
        roomRef.child("lastTouch").set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
        recordOk("pushSyncEvent");
        // Surface the rule-mismatch as a one-time hint, not an error
        const hint = "Your Firebase rules don't allow `force`. Sync still works (via drift threshold), but add the `force` rule from the README for instant snaps.";
        if (!diag.ruleHints.includes(hint)) diag.ruleHints.push(hint);
        return { ok: true, degraded: "no-force-rule" };
      } catch (err2) {
        recordErr("pushSyncEvent", err2);
        console.warn("[Duet] pushSyncEvent retry:", err2?.message || err2);
        return { error: "Firebase rejected the write. Check your RTDB rules.", code: "permission_denied" };
      }
    }
    recordErr("pushSyncEvent", err);
    console.warn("[Duet] pushSyncEvent:", msg);
    return { error: denied ? "Firebase rejected the write." : "Network error." , code: denied ? "permission_denied" : "network" };
  }
}

// Shape a TAB_INFO payload to fit the RTDB `meta` rules exactly. One
// over-long string (a 300-char page title, a tokenized 2KB URL) or an unknown
// key rejects the *whole* write, silently freezing the partner card.
const META_STRING_LIMITS = { url: 1024, hostname: 253, pageTitle: 256, videoTitle: 256, name: 32, emoji: 16 };
function sanitizeMeta(info) {
  const out = {};
  for (const [key, max] of Object.entries(META_STRING_LIMITS)) {
    if (typeof info[key] === "string") out[key] = info[key].slice(0, max);
  }
  for (const key of ["duration", "currentTime"]) {
    const v = info[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 86400) out[key] = v;
  }
  if (typeof info.paused === "boolean") out.paused = info.paused;
  return out;
}

async function pushTabInfo(info) {
  if (!metaRef) return;
  // Stamp our display name and emoji so the partner can label our actions.
  let named = { ...info };
  if (myName) named.name = myName;
  if (myEmoji) named.emoji = myEmoji;
  named = sanitizeMeta(named);
  myLastTabInfo = { ...named, lastSeen: serverNow() };
  try {
    await metaRef.set({
      ...named,
      lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
    recordOk("pushTabInfo");
  } catch (err) {
    recordErr("pushTabInfo", err);
  }
}

async function pushReaction(emoji) {
  if (!reactionsRef || !myUserId) return;
  const ref = reactionsRef.push();
  try {
    // Server timestamp, not Date.now(): receivers compare against their own
    // serverNow(), so a skewed local clock can't make reactions look stale.
    await ref.set({ emoji, from: myUserId, ts: firebase.database.ServerValue.TIMESTAMP });
    recordOk("pushReaction");
    // Survives SW death: server removes it ~6s later regardless of our lifetime.
    setTimeout(() => ref.remove().catch(() => {}), 6000);
    // Self-prune anything older than 10s on every write so leaks can't pile up
    // even if a previous SW died before its setTimeout fired.
    pruneStaleReactions().catch(() => {});
  } catch (err) {
    recordErr("pushReaction", err);
  }
}

async function pruneStaleReactions() {
  if (!reactionsRef) return;
  const cutoff = serverNow() - 10000;
  const snap = await reactionsRef.once("value");
  if (!snap.exists()) return;
  const all = snap.val() || {};
  const removals = [];
  for (const [key, r] of Object.entries(all)) {
    if (!r || typeof r.ts !== "number" || r.ts < cutoff) {
      removals.push(reactionsRef.child(key).remove().catch(() => {}));
    }
  }
  await Promise.all(removals);
}

// Ask every frame in a tab and return the first response with a video.
async function getSnapshotFromAnyFrame(tabId) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  const ids = frames.length ? frames.map(f => f.frameId) : [0];
  const results = await Promise.all(ids.map(frameId =>
    chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_SNAPSHOT" }, { frameId })
      .then(r => ({ frameId, r })).catch(() => null)
  ));
  return results.find(x => x && x.r?.hasVideo) || null;
}

// ── Rule validation ─────────────────────────────────────────
// Probes the `force` field on `state` to detect a common rule/code mismatch
// *before* the user hits a real sync failure. Only safe when alone in the room
// (a partner's listener would fire on the probe and trigger a phantom sync).
let rulesValidated = false;
async function validateRules() {
  if (rulesValidated || !roomRef || !myUserId) return;

  // Only probe when alone — otherwise the partner sees a state write and reacts.
  try {
    const presSnap = await db.ref(`presence/${currentRoom}`).get();
    const peers = presSnap.exists() ? Object.keys(presSnap.val()).length : 0;
    if (peers > 1) return;
  } catch { return; }

  const forceRef = roomRef.child("state/force");
  try {
    await forceRef.set(true);
    await forceRef.remove().catch(() => {});
    rulesValidated = true;
  } catch (err) {
    const msg = err?.message || String(err);
    if (/PERMISSION_DENIED/i.test(msg)) {
      const hint = "Your Firebase rules don't whitelist `force` — add the `force` line from the README under `state` and Publish. Sync still works via the drift fallback until then.";
      if (!diag.ruleHints.includes(hint)) diag.ruleHints.push(hint);
      rulesValidated = true; // don't keep probing; we have our answer
    } else {
      recordErr("validateRules", err);
    }
  }
}

// ── Connection quality (ping measurement) ─────────────────
let lastPingMs = null;
let lastPingAt = 0;
const PING_INTERVAL_MS = 5000;

async function measurePing() {
  if (!db || !currentRoom) return;
  const pingRef = db.ref(`rooms/${currentRoom}/ping/${myUserId}`);
  const start = Date.now();
  try {
    await pingRef.set(firebase.database.ServerValue.TIMESTAMP);
    const snap = await pingRef.once("value");
    lastPingMs = Date.now() - start;
    lastPingAt = Date.now();
  } catch {
    lastPingMs = null;
  }
}

// Measure ping periodically when in a room
setInterval(() => { if (currentRoom && db) measurePing().catch(() => {}); }, PING_INTERVAL_MS);

// ── Catch up to partner ─────────────────────────────────────
// Seeks our local video to wherever the partner currently is. After the seek
// we VERIFY by re-reading the local video's currentTime and comparing to
// partner's projected position — only returns `ok: true` when actual drift
// is under 1s. Caller can show "Caught up ✓" only when verified.
const SYNC_DRIFT_OK = 1.0; // seconds — anything under this counts as "in sync"

function projectedPartnerTime() {
  if (!partnerMeta || typeof partnerMeta.currentTime !== "number") return null;
  if (partnerMeta.paused) return partnerMeta.currentTime;
  const ts = typeof partnerMeta.lastSeen === "number" ? partnerMeta.lastSeen : serverNow();
  return partnerMeta.currentTime + Math.max(0, (serverNow() - ts) / 1000);
}

function urlsMatch(a, b) {
  if (!a || !b) return false;
  try {
    const A = new URL(a), B = new URL(b);
    return (A.origin + A.pathname + A.search) === (B.origin + B.pathname + B.search);
  } catch { return a === b; }
}

async function catchUpToPartner() {
  if (!currentRoom) return { error: "Not in a room." };
  if (!partnerMeta || typeof partnerMeta.currentTime !== "number") {
    return { error: "Partner hasn't shared their position yet." };
  }

  // Refuse if we're on a different page — seeking to partner's timestamp on
  // a different video would land us at a meaningless spot.
  if (myLastTabInfo?.url && partnerMeta.url && !urlsMatch(myLastTabInfo.url, partnerMeta.url)) {
    return { error: "You're on a different page. Open partner's page first." };
  }

  // Pick a tab to seek. Same cascade as syncToMe so it just works.
  const tried = new Set();
  const tryTab = async (tabId) => {
    if (!tabId || tried.has(tabId)) return null;
    tried.add(tabId);
    try { await chrome.tabs.get(tabId); } catch { return null; }
    return tabId;
  };
  let targetTabId = await tryTab(primaryTabId);
  if (!targetTabId) {
    primaryTabId = null; diag.primaryTabId = null;
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTabId = await tryTab(active[0]?.id);
  }
  if (!targetTabId) {
    const all = await chrome.tabs.query({});
    for (const t of all) {
      const id = await tryTab(t.id);
      if (id) { targetTabId = id; primaryTabId = id; diag.primaryTabId = id; break; }
    }
  }
  if (!targetTabId) {
    return { error: "No video tab found. Open the video and try again." };
  }

  // Build the payload applySync expects. lastSeen → serverTime so the content
  // script projects partner's playing position forward to "now".
  const state = {
    action: partnerMeta.paused ? "pause" : "play",
    currentTime: partnerMeta.currentTime,
    playbackRate: typeof partnerMeta.playbackRate === "number" ? partnerMeta.playbackRate : 1,
    serverTime: typeof partnerMeta.lastSeen === "number" ? partnerMeta.lastSeen : serverNow(),
    force: true
  };
  await sendToAllFrames(targetTabId, { type: "REMOTE_SYNC", state, serverNow: serverNow() });

  // Verify: wait for the seek to settle, then read back local position and
  // compare to partner's *current* projected time (which has advanced).
  await new Promise(r => setTimeout(r, 900));
  const hit = await getSnapshotFromAnyFrame(targetTabId);
  if (!hit) {
    return { ok: false, error: "Seeked, but couldn't verify (video may need a click first)." };
  }
  const localNow = hit.r.currentTime;
  const partnerNow = projectedPartnerTime();
  if (partnerNow === null) {
    return { ok: true, drift: 0, verified: false, at: localNow };
  }
  // Action mismatch (we tried to play but autoplay was blocked, etc.) is also
  // a sync failure even if timestamps line up.
  const wantPlaying = !partnerMeta.paused;
  const actuallyPlaying = !hit.r.paused;
  const playStateOk = wantPlaying === actuallyPlaying;

  const drift = Math.abs(localNow - partnerNow);
  const inSync = drift < SYNC_DRIFT_OK && playStateOk;
  return {
    ok: inSync,
    verified: true,
    drift: Number(drift.toFixed(2)),
    at: localNow,
    playStateOk,
    error: inSync ? undefined : (!playStateOk
      ? "Couldn't start playback — click the video to allow autoplay."
      : `Off by ${drift.toFixed(1)}s. Try again in a moment.`)
  };
}

// ── Force-sync to me ────────────────────────────────────────
// Asks the active video tab for its current state, then pushes with force=true.
// Tries: tracked primary tab → active tab → any tab with a playing video → any
// tab with a video. Drops a stale primaryTabId along the way so the next click
// doesn't keep failing for the same reason.
async function syncToMe() {
  if (!roomRef) return { error: "Not in a room." };

  const tried = new Set();
  let winnerTabId = null;
  const trySnapshot = async (tabId) => {
    if (!tabId || tried.has(tabId)) return null;
    tried.add(tabId);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return null;
    } catch { return null; }
    const snap = await getSnapshotFromAnyFrame(tabId);
    if (snap) winnerTabId = tabId;
    return snap;
  };

  let hit = await trySnapshot(primaryTabId);

  // Primary tab is stale or videoless — clear it and try the active tab next.
  if (!hit && primaryTabId) {
    primaryTabId = null;
    diag.primaryTabId = null;
  }

  if (!hit) {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    hit = await trySnapshot(activeTabs[0]?.id);
  }

  // Last resort: scan every tab for a video, preferring one that's playing.
  if (!hit) {
    const allTabs = await chrome.tabs.query({});
    const candidates = [];
    for (const tab of allTabs) {
      const found = await trySnapshot(tab.id);
      if (found) candidates.push({ tabId: tab.id, snap: found });
    }
    const playing = candidates.find(c => !c.snap.r.paused);
    hit = (playing || candidates[0])?.snap || null;
    if (hit) {
      const winner = playing || candidates[0];
      primaryTabId = winner.tabId;
      winnerTabId = winner.tabId;
      diag.primaryTabId = primaryTabId;
    }
  }

  if (!hit) return { error: "No video found. Open the video tab and press play once, then try again." };
  const snapshot = hit.r;

  const writeAt = serverNow();
  const result = await pushSyncEvent({
    action: snapshot.paused ? "pause" : "play",
    currentTime: snapshot.currentTime,
    playbackRate: snapshot.playbackRate
  }, { force: true });

  if (result?.error) return result;

  // Verify: wait for partner to apply + their next 1s meta publish, then
  // compare positions. Only report "Synced ✓" when partner actually caught up.
  // We require their lastSeen to be NEWER than our write timestamp (proves
  // they published after applying) and their projected position to match ours.
  await new Promise(r => setTimeout(r, 1800));

  // Re-snapshot ourselves so the comparison is against current local time
  // (partner had ~1.8s to apply; our video kept playing during that window).
  const hit2 = await getSnapshotFromAnyFrame(winnerTabId).catch?.(() => null) || hit;
  const localNow = (hit2?.r?.currentTime ?? snapshot.currentTime);

  if (!partnerMeta || typeof partnerMeta.currentTime !== "number") {
    return { ok: true, verified: false, degraded: result?.degraded, at: localNow,
             error: undefined };
  }
  const partnerLastSeen = typeof partnerMeta.lastSeen === "number" ? partnerMeta.lastSeen : 0;
  const partnerPublishedSinceWrite = partnerLastSeen > writeAt;
  const partnerNow = projectedPartnerTime();
  const drift = (partnerNow === null) ? null : Math.abs(localNow - partnerNow);
  const inSync = drift !== null && drift < SYNC_DRIFT_OK && partnerPublishedSinceWrite;
  return {
    ok: inSync,
    verified: partnerPublishedSinceWrite,
    drift: drift === null ? null : Number(drift.toFixed(2)),
    at: localNow,
    degraded: result?.degraded,
    error: inSync ? undefined : (!partnerPublishedSinceWrite
      ? "Partner hasn't confirmed yet — they may be loading or paused."
      : `Partner is ${drift.toFixed(1)}s off. Try again.`)
  };
}

async function sendToAllFrames(tabId, message) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  if (!frames.length) {
    return chrome.tabs.sendMessage(tabId, message).catch(() => { throw new Error("no-tab"); });
  }
  await Promise.all(frames.map(f =>
    chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }).catch(() => {})
  ));
}

// ── Broadcasts to UI ────────────────────────────────────────
function broadcastToVideoTabs(message) {
  if (message.type === "REMOTE_SYNC" && primaryTabId) {
    // Prevent background tabs from acting on remote syncs.
    // Send to ALL frames so cross-origin embed iframes (yflix, etc.) receive it.
    sendToAllFrames(primaryTabId, message).catch(() => {
      primaryTabId = null; // Tab probably closed
    });
    return;
  }

  // General broadcasts (reactions, connection status) go to all video tabs
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      sendToAllFrames(tab.id, message).catch(() => {});
    }
  });
}
function broadcastConnection(connected, peerCount) {
  broadcastToVideoTabs({ type: "CONNECTION_STATUS", connected, peerCount, room: currentRoom });
  chrome.runtime.sendMessage({ type: "POPUP_PEER_COUNT", peerCount }).catch(() => {});
}
function broadcastPartnerMeta() {
  chrome.runtime.sendMessage({ type: "POPUP_PARTNER_META", partner: partnerMeta, mine: myLastTabInfo }).catch(() => {});
  // Send status down to content scripts so the in-video badge knows the actual drift
  broadcastToVideoTabs({ type: "SYNC_STATUS", partner: partnerMeta, mine: myLastTabInfo, serverNow: serverNow(), ping: lastPingMs });
}

// ── Open partner's URL ──────────────────────────────────────
async function openPartnerVideo() {
  if (!partnerMeta?.url) return { error: "Partner hasn't shared a video yet." };
  // The URL comes from the room's shared DB node — only follow web links.
  let partnerUrl;
  try { partnerUrl = new URL(partnerMeta.url); } catch {}
  if (!partnerUrl || !/^https?:$/.test(partnerUrl.protocol)) {
    return { error: "Partner's link isn't a web page." };
  }

  // Try to redirect the exact tab we've been tracking, fallback to active tab
  let targetTabId = primaryTabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTabId = tabs[0]?.id;
  }

  if (targetTabId) {
    await chrome.tabs.update(targetTabId, { url: partnerUrl.href });
  } else {
    await chrome.tabs.create({ url: partnerUrl.href });
  }
  return { ok: true };
}

// ── Message Router ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      await doBootstrap(); // Wait for session restore before processing ANY message

      switch (message.type) {
        case "CREATE_ROOM":   sendResponse(await createRoom()); break;
        case "JOIN_ROOM":     sendResponse(await joinRoom(message.roomCode)); break;
        case "LEAVE_ROOM":    sendResponse(await leaveRoom()); break;
        case "GET_NAME":      sendResponse({ name: myName }); break;
        case "SET_NAME": {
          const next = String(message.name || "").trim().slice(0, 32);
          myName = next;
          try { await chrome.storage.local.set({ myName }); } catch {}
          // Re-publish meta immediately so the partner sees the new name.
          if (myLastTabInfo && metaRef) {
            const { lastSeen, ...rest } = myLastTabInfo;
            pushTabInfo(rest).catch(() => {});
          }
          sendResponse({ ok: true, name: myName });
          break;
        }

        case "SET_EMOJI": {
          const next = String(message.emoji || "").trim();
          myEmoji = next;
          try { await chrome.storage.local.set({ myEmoji }); } catch {}
          if (myLastTabInfo && metaRef) {
            const { lastSeen, ...rest } = myLastTabInfo;
            pushTabInfo(rest).catch(() => {});
          }
          sendResponse({ ok: true, emoji: myEmoji });
          break;
        }

        case "SYNC_EVENT":
          if (_sender.tab?.id) {
            primaryTabId = _sender.tab.id; // Manual interaction steals control
            diag.primaryTabId = primaryTabId;
          }
          await pushSyncEvent(message.state);
          sendResponse({ ok: true });
          break;

        case "TAB_INFO":
          if (_sender.tab?.id) {
            // Content script only sends TAB_INFO from the top frame, so per-tab
            // dedup is already implicit. Track which tab is the active video tab
            // so SYNC_TO_ME and OPEN_PARTNER_URL target the right place. Prefer
            // the tab whose video is currently playing; otherwise keep what we have.
            // Only the primary tab may publish meta — otherwise a paused
            // background tab overwrites the playing one every second and the
            // partner's card flips to "different video". A tab takes over when
            // there's no primary, the primary went quiet, or it's playing
            // while the primary is paused.
            const senderTabId = _sender.tab.id;
            const incomingPlaying = !message.info?.paused;
            const primaryQuiet = (Date.now() - lastTabInfoTime) > 5000;
            if (senderTabId !== primaryTabId &&
                (!primaryTabId || primaryQuiet || (incomingPlaying && primaryPaused))) {
              primaryTabId = senderTabId;
              diag.primaryTabId = primaryTabId;
            }
            if (senderTabId === primaryTabId) {
              lastTabInfoTime = Date.now();
              primaryPaused = !incomingPlaying;
              await pushTabInfo(message.info);
            }
          }
          sendResponse({ ok: true });
          break;

        case "SEND_REACTION":
          await pushReaction(message.emoji);
          sendResponse({ ok: true });
          break;

        case "SYNC_TO_ME":
          sendResponse(await syncToMe());
          break;

        case "CATCH_UP_TO_PARTNER":
          sendResponse(await catchUpToPartner());
          break;

        case "OPEN_PARTNER_URL":
          sendResponse(await openPartnerVideo());
          break;

        case "GET_STATUS": {
          let peerCount = 0;
          if (currentRoom && db) {
            const snap = await db.ref(`presence/${currentRoom}`).get();
            peerCount = snap.exists() ? Object.keys(snap.val()).length : 0;
          }
          diag.myUserId = myUserId;
          diag.peerCount = peerCount;
          sendResponse({
            currentRoom, myUserId,
            connected: !!currentRoom,
            peerCount,
            partner: partnerMeta,
            mine: myLastTabInfo,
            together: togetherInfo,
            serverNow: serverNow(),
            ping: lastPingMs,
            diag
          });
          break;
        }

        case "SEND_TYPING": {
          // Broadcast typing indicator to partner
          if (roomRef && myUserId) {
            db.ref(`rooms/${currentRoom}/typing/${myUserId}`).set(true).catch(() => {});
            // Auto-clear after 3 seconds
            setTimeout(() => {
              if (roomRef) db.ref(`rooms/${currentRoom}/typing/${myUserId}`).remove().catch(() => {});
            }, 3000);
          }
          sendResponse({ ok: true });
          break;
        }

        case "PING":
          sendResponse({ ok: true });
          break;

        case "LOG_SYNC_EVENT": {
          const evt = message.event;
          if (evt) {
            diag.syncEvents.push(evt);
            if (diag.syncEvents.length > SYNC_EVENT_MAX) diag.syncEvents.shift();
          }
          sendResponse({ ok: true });
          break;
        }

        case "INJECT_AGENT_SCRIPTS": {
          // Lazy-load agent modules into the requesting frame on demand, so
          // the agent JS isn't loaded on every page. Target comes from the
          // sender, never the message body. One frame only: the modules declare
          // top-level consts, so re-injecting into a frame that already has
          // them throws.
          const tabId = _sender.tab?.id;
          if (!tabId) { sendResponse({ error: "No sender tab" }); break; }
          try {
            await chrome.scripting.executeScript({
              target: { tabId, frameIds: [_sender.frameId ?? 0] },
              files: [
                "agent/adapter-runtime.js",
                "agent/site-analyzer.js",
                "agent/adapter-generator.js",
                "agent/adapter-registry.js",
                "agent/sandbox-tester.js",
                "agent/agent.js"
              ]
            });
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ error: err?.message || String(err) });
          }
          break;
        }

        default:
          sendResponse({ error: "Unknown message type" });
      }
    } catch (err) {
      console.error("[Duet] handler error:", err);
      sendResponse({ error: err?.message || String(err) });
    }
  })();
  return true;
});

// ── Bootstrap ───────────────────────────────────────────────
let bootstrapPromise = null;

function doBootstrap() {
  if (!bootstrapPromise) bootstrapPromise = bootstrapInner();
  return bootstrapPromise;
}

async function bootstrapInner() {
  // Load display name and emoji early so any subsequent meta write includes it.
  try {
    const n = await chrome.storage.local.get(["myName", "myEmoji"]);
    if (typeof n.myName === "string") myName = n.myName.slice(0, 32);
    if (typeof n.myEmoji === "string") myEmoji = n.myEmoji;
  } catch {}

  try {
    await initFirebase();
  } catch {
    return;
  }

  const stored = await chrome.storage.local.get(["currentRoom", "myUserId"]);
  if (!stored.currentRoom) return;

  const exists = (await db.ref(`rooms/${stored.currentRoom}`).get()).exists();
  if (!exists) {
    await chrome.storage.local.remove(["currentRoom", "myUserId"]);
    return;
  }

  currentRoom = stored.currentRoom;
  myUserId = stored.myUserId;
  setRoomRefs(currentRoom);
  await presenceRef.set({ joined: firebase.database.ServerValue.TIMESTAMP });
  presenceRef.onDisconnect().remove();
  metaRef.onDisconnect().remove();
  attachListeners(currentRoom);
  validateRules().catch(() => {});
  dlog(`[Duet] Restored session: room ${currentRoom}`);
}

chrome.runtime.onStartup.addListener(doBootstrap);
chrome.runtime.onInstalled.addListener(doBootstrap);
doBootstrap();

// Clear primaryTabId proactively when its tab closes — otherwise SYNC_TO_ME
// keeps targeting a dead tabId and fails until something else reclaims primary.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === primaryTabId) {
    primaryTabId = null;
    diag.primaryTabId = null;
    lastTabInfoTime = 0;
  }
});
