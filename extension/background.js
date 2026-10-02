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
    "vendor/firebase-database-compat.js",
    "invite-config.js"
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
// The connection is opened lazily — only while this browser is in a room —
// and closed with goOffline() on leave. Every install shares one database,
// and an always-on socket per browser (opened on every page load, since
// content scripts wake the SW) would exhaust the concurrent-connection cap
// for users who aren't even watching anything. While online, the SDK
// reconnects on its own after network drops.
//
// Synchronous on purpose: no await between the `db` check and assignment,
// so concurrent callers can't both run initializeApp().
function initFirebase() {
  if (!db) {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
    db = app.database();
    db.ref(".info/serverTimeOffset").on("value", (snap) => {
      serverTimeOffset = snap.val() || 0;
    });
  }
  db.goOnline();
  return db;
}

function disconnectFirebase() {
  if (db) db.goOffline();
}

const serverNow = () => Date.now() + serverTimeOffset;

// ── Helpers ─────────────────────────────────────────────────
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRoomCode() {
  // 256 is a multiple of 32, so `byte % 32` is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}
const generateUserId = () =>
  "user_" + Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, "0")).join("");

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
  initFirebase();
  // Shared state (myUserId, refs) is only touched once a room is claimed, so a
  // failed create can't disturb a session that's already running.
  const newUserId = generateUserId();

  // Claim a fresh code with a transaction so a collision can never overwrite
  // someone else's live room; on the (rare) clash, draw another code.
  let roomCode = null;
  try {
    for (let attempt = 0; attempt < 5 && !roomCode; attempt++) {
      const candidate = generateRoomCode();
      const res = await withTimeout(db.ref(`rooms/${candidate}`).transaction((cur) => {
        if (cur !== null) return; // taken — abort
        return {
          state: {
            action: "pause", currentTime: 0, updatedBy: newUserId,
            serverTime: firebase.database.ServerValue.TIMESTAMP
          },
          host: newUserId,
          created: firebase.database.ServerValue.TIMESTAMP,
          lastTouch: firebase.database.ServerValue.TIMESTAMP
        };
      }, undefined, false), 12000, "Creating room");
      if (res.committed) roomCode = candidate;
    }
  } catch (err) {
    if (!currentRoom) disconnectFirebase();
    const msg = err?.message || String(err);
    if (/PERMISSION_DENIED/i.test(msg)) {
      return { error: "Firebase rules rejected the room creation. Re-paste the rules from the README." };
    }
    if (/^Timeout/.test(msg)) {
      return { error: "Can't reach Duet's sync server. Check your internet or disable ad-blockers for this extension." };
    }
    return { error: "Couldn't create the room — network issue. Try again." };
  }
  if (!roomCode) {
    if (!currentRoom) disconnectFirebase();
    return { error: "Couldn't find a free room code. Try again." };
  }
  myUserId = newUserId;
  setRoomRefs(roomCode);

  presenceRef.set({ joined: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
  armDisconnectCleanup();

  currentRoom = roomCode;
  attachListeners(roomCode);

  await chrome.storage.local.set({ currentRoom: roomCode, myUserId });
  validateRules().catch(() => {});
  return { roomCode, myUserId, peerCount: 1 };
}

// opts.leaveCurrent: the user confirmed leaving the room they're in (invite
// page "Leave and join"). Without it, joining while in another room fails
// rather than silently abandoning the current session.
async function joinRoom(roomCode, opts = {}) {
  roomCode = String(roomCode || "").toUpperCase().trim();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode)) {
    return { error: "Invalid room code format. Codes are 6 characters, letters + numbers." };
  }
  // Already in this room (e.g. session restored after a SW restart): keep our
  // existing identity instead of registering a second presence entry.
  if (currentRoom === roomCode && myUserId) {
    return { roomCode, myUserId, joined: true };
  }

  initFirebase();
  let exists, presSnap;
  try {
    [exists, presSnap] = await Promise.all([
      roomExists(roomCode, 12000),
      withTimeout(db.ref(`presence/${roomCode}`).get(), 12000, "Looking up room")
    ]);
  } catch (err) {
    if (!currentRoom) disconnectFirebase();
    const msg = err?.message || String(err);
    if (/PERMISSION_DENIED/i.test(msg)) {
      return { error: "Firebase rules are blocking room lookup. Re-paste the rules from the README." };
    }
    return { error: "Couldn't reach Duet's sync server. Check your internet or disable ad-blockers for this extension." };
  }
  if (!exists) {
    if (!currentRoom) disconnectFirebase();
    return { error: "Room not found. Check the code and try again." };
  }

  // Duet is strictly two people. A crashed client's presence can linger until
  // the server notices the dropped socket (up to ~60s), so say so — a user
  // re-joining from a fresh install may just need to wait it out.
  const present = presSnap.exists() ? Object.keys(presSnap.val() || {}).length : 0;
  if (present >= 2) {
    if (!currentRoom) disconnectFirebase();
    return { error: "This room already has two people. If you just left it, wait a minute and try again." };
  }

  // Only leave the current room once the target is known to be joinable.
  if (currentRoom && currentRoom !== roomCode) {
    if (!opts.leaveCurrent) {
      return { error: "You're already in a room. Leave it first.", code: "in_other_room" };
    }
    await leaveRoom();
    initFirebase(); // leaveRoom went offline
  }

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
  armDisconnectCleanup();

  currentRoom = roomCode;
  attachListeners(roomCode);

  await chrome.storage.local.set({ currentRoom: roomCode, myUserId });
  validateRules().catch(() => {});
  return { roomCode, myUserId, joined: true };
}

// Every real room has `created` (set once, at creation). Checking just that
// leaf avoids downloading the whole room, and isn't fooled by a node that a
// straggling client's ping/typing write recreated after the room was deleted.
function roomExists(roomCode, ms) {
  return withTimeout(db.ref(`rooms/${roomCode}/created`).get(), ms, "Looking up room")
    .then(snap => snap.exists());
}

function setRoomRefs(roomCode) {
  roomRef      = db.ref(`rooms/${roomCode}`);
  presenceRef  = db.ref(`presence/${roomCode}/${myUserId}`);
  metaRef      = db.ref(`rooms/${roomCode}/meta/${myUserId}`);
  reactionsRef = db.ref(`rooms/${roomCode}/reactions`);
}

// Per-user nodes the server should drop if this client vanishes without
// calling leaveRoom (SW killed, browser closed, network lost).
function myEphemeralRefs() {
  return [
    presenceRef,
    metaRef,
    roomRef.child(`typing/${myUserId}`),
    roomRef.child(`ping/${myUserId}`)
  ];
}
function armDisconnectCleanup() {
  for (const ref of myEphemeralRefs()) ref.onDisconnect().remove();
}

async function leaveRoom() {
  // Capture refs before we null them so the empty-room cleanup below can use them.
  const leavingRoom = currentRoom;
  const leavingRoomRef = roomRef;

  // RTDB write promises only settle on a server ack, so offline these would
  // hang Leave forever. Bound them; the onDisconnect handlers armed on join
  // remove the same nodes server-side once we go offline below.
  let reachable = true;
  if (roomRef && myUserId) {
    await withTimeout(
      Promise.all(myEphemeralRefs().map(ref => ref.remove().catch(() => {}))),
      5000, "Leaving room"
    ).catch(() => { reachable = false; });
  }

  // If we were the last peer, clean up the whole room so abandoned rooms
  // don't accumulate in the DB. We re-check presence after our own removal:
  // if it's empty (or nonexistent), remove `rooms/<code>`. Skipped when the
  // server just proved unreachable — the idle-room cleanup catches it later.
  if (leavingRoom && db && reachable) {
    try {
      const presSnap = await withTimeout(db.ref(`presence/${leavingRoom}`).get(), 5000, "Checking room");
      const remaining = presSnap.exists() ? Object.keys(presSnap.val() || {}).length : 0;
      if (remaining === 0 && leavingRoomRef) {
        await withTimeout(leavingRoomRef.remove(), 5000, "Removing room").catch(() => {});
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
  // Not in a room → no reason to hold a connection to the shared database.
  disconnectFirebase();
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

// ── Video tab lookup ────────────────────────────────────────
// Finds the tab to act on for Sync-to-me / Catch-up, and only ever returns a
// tab that actually reports a <video>: tracked primary tab → active tab → any
// tab (preferring one that's playing). Adopts the winner as primary, and drops
// a stale primary along the way so the next click doesn't fail the same way.
async function locateVideoTab() {
  const probe = async (tabId) => {
    if (!tabId) return null;
    try { await chrome.tabs.get(tabId); } catch { return null; }
    const hit = await getSnapshotFromAnyFrame(tabId);
    return hit ? { tabId, hit } : null;
  };

  let found = await probe(primaryTabId);
  if (!found) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== primaryTabId) found = await probe(active?.id);
  }
  if (!found) {
    const tabs = await chrome.tabs.query({});
    const hits = (await Promise.all(tabs.map(t => probe(t.id)))).filter(Boolean);
    found = hits.find(h => !h.hit.r.paused) || hits[0] || null;
  }

  primaryTabId = found ? found.tabId : null;
  diag.primaryTabId = primaryTabId;
  return found;
}

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

  const located = await locateVideoTab();
  if (!located) {
    return { error: "No video tab found. Open the video and try again." };
  }
  const targetTabId = located.tabId;

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

  const located = await locateVideoTab();
  if (!located) return { error: "No video found. Open the video tab and press play once, then try again." };
  const { tabId: winnerTabId, hit } = located;
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
// `tabId`: navigate this tab (the invite page asking for itself) instead of
// the tracked video tab.
async function openPartnerVideo(tabId = null) {
  if (!partnerMeta?.url) return { error: "Partner hasn't shared a video yet." };
  // The URL comes from the room's shared DB node — only follow web links.
  let partnerUrl;
  try { partnerUrl = new URL(partnerMeta.url); } catch {}
  if (!partnerUrl || !/^https?:$/.test(partnerUrl.protocol)) {
    return { error: "Partner's link isn't a web page." };
  }

  // Try to redirect the exact tab we've been tracking, fallback to active tab
  let targetTabId = tabId || primaryTabId;
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
      // Wait for session restore before processing ANY message. A failed
      // restore must not take every handler down with it — it retries on the
      // next message.
      await doBootstrap().catch((err) => console.warn("[Duet] bootstrap:", err?.message || err));

      switch (message.type) {
        case "CREATE_ROOM":   sendResponse(await createRoom()); break;
        case "JOIN_ROOM":
          sendResponse(await joinRoom(message.roomCode, { leaveCurrent: !!message.leaveCurrent }));
          break;
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
          sendResponse(await openPartnerVideo(message.here ? _sender.tab?.id : null));
          break;

        case "GET_STATUS": {
          // The presence listener keeps lastPeerCount current; a fresh read
          // is only a refinement, so offline it falls back instead of failing.
          let peerCount = currentRoom ? lastPeerCount : 0;
          if (currentRoom && db) {
            try {
              const snap = await withTimeout(db.ref(`presence/${currentRoom}`).get(), 3000, "Reading presence");
              peerCount = snap.exists() ? Object.keys(snap.val()).length : 0;
            } catch {}
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

// Restores profile + room from storage. Every message handler awaits this, so
// it must never hang or stay failed: its only network step is a bounded
// room-existence check, and a rejection clears the cache so the next message
// retries instead of every handler failing until the SW is recycled.
function doBootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapInner().catch((err) => {
      bootstrapPromise = null; // let the next message retry
      throw err;
    });
  }
  return bootstrapPromise;
}

async function bootstrapInner() {
  const stored = await chrome.storage.local.get(["myName", "myEmoji", "currentRoom", "myUserId"]);
  if (typeof stored.myName === "string") myName = stored.myName.slice(0, 32);
  if (typeof stored.myEmoji === "string") myEmoji = stored.myEmoji;

  // No room → stay disconnected. This is the common case on every SW wake.
  if (!stored.currentRoom || !stored.myUserId || currentRoom) return;

  // The room may have been deleted while we were away (partner left last,
  // idle cleanup). Check before writing anything — our own presence/ping
  // writes would otherwise recreate the node. Bounded wait: a network
  // failure means "unknown", and we resume optimistically (the SDK queues
  // writes until it reconnects), so this can delay but never wedge startup.
  initFirebase();
  let exists = true;
  try { exists = await roomExists(stored.currentRoom, 4000); } catch {}
  if (currentRoom) return; // a create/join finished first
  if (!exists) {
    dlog(`[Duet] Stored room ${stored.currentRoom} no longer exists`);
    await chrome.storage.local.remove(["currentRoom", "myUserId"]);
    disconnectFirebase();
    return;
  }

  // Rejoin with the same identity so we don't leave a ghost presence entry.
  currentRoom = stored.currentRoom;
  myUserId = stored.myUserId;
  setRoomRefs(currentRoom);
  presenceRef.set({ joined: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
  armDisconnectCleanup();
  attachListeners(currentRoom);
  validateRules().catch(() => {});
  dlog(`[Duet] Restored session: room ${currentRoom}`);
}

const bootstrapQuietly = () => { doBootstrap().catch(() => {}); };
chrome.runtime.onStartup.addListener(bootstrapQuietly);
chrome.runtime.onInstalled.addListener(bootstrapQuietly);

// Content scripts aren't injected into tabs that were already open when the
// extension was installed. Someone who followed an invite link, hit
// "Install", and came back would see a page that can't find the extension —
// reload any open invite pages so they pick it up and can join.
async function reloadInviteTabs() {
  const tabs = await chrome.tabs.query({ url: DUET_INVITE.TAB_PATTERNS });
  await Promise.all(tabs.map(t => chrome.tabs.reload(t.id).catch(() => {})));
}
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install" || reason === "update") reloadInviteTabs().catch(() => {});
});
bootstrapQuietly();

// Clear primaryTabId proactively when its tab closes — otherwise SYNC_TO_ME
// keeps targeting a dead tabId and fails until something else reclaims primary.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === primaryTabId) {
    primaryTabId = null;
    diag.primaryTabId = null;
    lastTabInfoTime = 0;
  }
});
