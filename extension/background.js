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
let readyListenerOff = null;

let serverTimeOffset = 0;
let partnerMeta = null;       // last meta we saw from the partner
let myLastTabInfo = null;     // last meta we wrote ourselves
let myName = "";              // user-set display name, persisted in storage
let myEmoji = "";             // user-set avatar emoji
let lastPeerCount = 0;        // for detecting 1→2 transition (auto-resync trigger)
let togetherInfo = { since: null, total: 0 };  // co-watch timer state

// The controlled player: the one tab + frame whose video drives the room and
// receives the partner's commands. Every other video (autoplay previews in
// other tabs, ad iframes, hero banners) is ignored. Control moves only when
// the user acts on another video, or the current one goes away.
let primaryTabId = null;
let primaryFrameId = null;    // null = frame unknown (send to all frames)
let lastTabInfoTime = 0;      // when we last heard from the primary player

function setPrimary(tabId, frameId) {
  primaryTabId = tabId ?? null;
  primaryFrameId = primaryTabId == null ? null : (frameId ?? null);
  diag.primaryTabId = primaryTabId;
  diag.primaryFrameId = primaryFrameId;
}
function isPrimarySender(sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null || tabId !== primaryTabId) return false;
  return primaryFrameId == null || primaryFrameId === (sender.frameId ?? 0);
}

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
  primaryFrameId: null,
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
// opts.code: re-open a saved room under its old code (a "permanent" room
// whose node was cleaned up). Fails with code "taken" if someone else holds it.
async function createRoom(opts = {}) {
  initFirebase();
  // Shared state (myUserId, refs) is only touched once a room is claimed, so a
  // failed create can't disturb a session that's already running.
  const newUserId = generateUserId();

  // Claim a fresh code with a transaction so a collision can never overwrite
  // someone else's live room; on the (rare) clash, draw another code.
  let roomCode = null;
  try {
    const attempts = opts.code ? 1 : 5;
    for (let attempt = 0; attempt < attempts && !roomCode; attempt++) {
      const candidate = opts.code || generateRoomCode();
      const res = await withTimeout(db.ref(`rooms/${candidate}`).transaction((cur) => {
        if (cur !== null) return; // taken — abort
        const room = {
          state: {
            action: "pause", currentTime: 0, updatedBy: newUserId,
            serverTime: firebase.database.ServerValue.TIMESTAMP
          },
          host: newUserId,
          created: firebase.database.ServerValue.TIMESTAMP,
          lastTouch: firebase.database.ServerValue.TIMESTAMP
        };
        if (opts.code) room.paired = true;
        return room;
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
    if (opts.code) return { error: "That room code is in use.", code: "taken" };
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
      const [presSnap, pairedSnap] = await Promise.all([
        withTimeout(db.ref(`presence/${leavingRoom}`).get(), 5000, "Checking room"),
        withTimeout(db.ref(`rooms/${leavingRoom}/paired`).get(), 5000, "Checking room")
      ]);
      const remaining = presSnap.exists() ? Object.keys(presSnap.val() || {}).length : 0;
      // A saved ("permanent") room outlives the session so the same pair can
      // come back to the same code; only its live check-in goes.
      if (remaining === 0 && leavingRoomRef && pairedSnap.val() === true) {
        await withTimeout(leavingRoomRef.child("readycheck").remove(), 5000, "Leaving room").catch(() => {});
      } else if (remaining === 0 && leavingRoomRef) {
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
  readyCheck = null;
  readyGoHandled = readyGoStarting = null;
  chatLog = []; chatLoadedFor = null;
  pairMarkedFor = null; lastPairWrite = 0; lastPairSig = "";
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

    const prevPartner = partnerMeta;
    partnerMeta = partners[0] || null;
    maybeFollowPartner(prevPartner, partnerMeta);
    rememberPair().catch(() => {});
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
    if (isChatText(r.emoji)) appendChat({ mine: false, text: r.emoji }).catch(() => {});
  });
  reactionsListenerOff = () => reacts.off("child_added", reactsHandler);

  // Ready check ("Both ready?" → 3-2-1 → play)
  const rcRef = db.ref(`rooms/${roomCode}/readycheck`);
  const rcHandler = rcRef.on("value", (snap) => {
    readyCheck = snap.val();
    onReadyCheckChange().catch(() => {});
  });
  readyListenerOff = () => rcRef.off("value", rcHandler);
}

function detachListeners() {
  for (const off of [stateListenerOff, presenceListenerOff, metaListenerOff, togListenerOff, reactionsListenerOff, typingListenerOff, readyListenerOff]) {
    try { off?.(); } catch {}
  }
  stateListenerOff = presenceListenerOff = metaListenerOff = togListenerOff = reactionsListenerOff = typingListenerOff = readyListenerOff = null;
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
  // A ready check can't complete with one person; drop it.
  if (newCount < 2 && prev >= 2 && readyCheck) {
    roomRef?.child("readycheck").remove().catch(() => {});
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
    if (isChatText(emoji)) appendChat({ mine: true, text: emoji }).catch(() => {});
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

// Ask every frame in a tab for its video and return the best one: the
// controlled frame if it still has a video, else a playing one, else the
// largest (so a small ad iframe doesn't beat the real player).
async function getSnapshotFromAnyFrame(tabId, preferFrameId = null) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  const ids = frames.length ? frames.map(f => f.frameId) : [0];
  const results = (await Promise.all(ids.map(frameId =>
    chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_SNAPSHOT" }, { frameId })
      .then(r => ({ frameId, r })).catch(() => null)
  ))).filter(x => x && x.r?.hasVideo);
  if (!results.length) return null;
  const preferred = preferFrameId != null && results.find(x => x.frameId === preferFrameId);
  if (preferred) return preferred;
  const rank = (x) => (x.r.paused ? 0 : 1e12) + (typeof x.r.score === "number" ? x.r.score : 0);
  return results.sort((a, b) => rank(b) - rank(a))[0];
}

// Send to the controlled frame (or the whole tab while its frame is unknown).
// Rejects when the tab is gone so callers can drop a stale primary.
async function sendToPrimary(message) {
  if (primaryTabId == null) throw new Error("no-primary");
  if (primaryFrameId == null) return sendToAllFrames(primaryTabId, message);
  try { await chrome.tabs.get(primaryTabId); } catch { throw new Error("no-tab"); }
  return chrome.tabs.sendMessage(primaryTabId, message, { frameId: primaryFrameId }).catch(() => {});
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

// ── Our story (local-only) ──────────────────────────────────
// A small tally of time actually *watched* together — both playing the same
// video — per partner, shown in the popup ("12h 30m watched together ·
// 6 nights"). Lives in chrome.storage.local on this device only; nothing is
// uploaded. A saved room's tally is keyed by its code (`room:CODE`), so a
// rename doesn't reset it; one-off rooms fall back to the display name.
const STORY_KEY = "__duet_story";
const STORY_TICK_MS = 15000;
const STORY_MAX_PARTNERS = 20;
const STORY_MAX_DAYS = 400;
let storyLastTick = 0;

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function storyPartnerKey(meta) {
  const name = typeof meta?.name === "string" ? meta.name.trim().toLowerCase() : "";
  return name || "__unnamed";
}
function watchingTogether() {
  if (!currentRoom || lastPeerCount < 2 || !partnerMeta || !myLastTabInfo) return false;
  if (partnerMeta.paused || myLastTabInfo.paused) return false;
  if (!urlsMatch(myLastTabInfo.url, partnerMeta.url)) return false;
  const partnerFresh = typeof partnerMeta.lastSeen === "number" && serverNow() - partnerMeta.lastSeen < 15000;
  const mineFresh = Date.now() - lastTabInfoTime < 15000;
  return partnerFresh && mineFresh;
}
async function storyTick() {
  const now = Date.now();
  if (!watchingTogether()) { storyLastTick = 0; return; }
  if (!storyLastTick) { storyLastTick = now; return; }
  // Cap the step so a suspended SW / sleeping laptop can't add phantom hours.
  const add = Math.min(now - storyLastTick, STORY_TICK_MS * 2) / 1000;
  storyLastTick = now;

  const { [STORY_KEY]: stored } = await chrome.storage.local.get(STORY_KEY);
  const story = stored && typeof stored === "object" && stored.partners ? stored : { v: 1, partners: {} };
  const pairs = await getPairs();
  const key = pairs[currentRoom] ? `room:${currentRoom}` : storyPartnerKey(partnerMeta);
  const entry = story.partners[key] || { seconds: 0, days: {} };
  entry.name = typeof partnerMeta.name === "string" ? partnerMeta.name.slice(0, 32) : "";
  entry.seconds = (entry.seconds || 0) + add;
  const day = localDay(now);
  entry.days = entry.days || {};
  entry.days[day] = (entry.days[day] || 0) + add;
  const dayKeys = Object.keys(entry.days).sort();
  for (const old of dayKeys.slice(0, Math.max(0, dayKeys.length - STORY_MAX_DAYS))) delete entry.days[old];
  const title = partnerMeta.videoTitle || partnerMeta.pageTitle;
  if (typeof title === "string" && title) entry.lastTitle = title.slice(0, 256);
  entry.lastAt = now;
  story.partners[key] = entry;
  // Keep the most recent partners only.
  const keys = Object.keys(story.partners).sort((a, b) => (story.partners[b].lastAt || 0) - (story.partners[a].lastAt || 0));
  for (const k of keys.slice(STORY_MAX_PARTNERS)) delete story.partners[k];
  await chrome.storage.local.set({ [STORY_KEY]: story });
}
setInterval(() => { storyTick().catch(() => {}); }, STORY_TICK_MS);

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
    lastPingMs = Date.now() - start;
    lastPingAt = Date.now();
    broadcastPartnerMeta();
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
    const hit = await getSnapshotFromAnyFrame(tabId, tabId === primaryTabId ? primaryFrameId : null);
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

  if (found) setPrimary(found.tabId, found.hit.frameId);
  else setPrimary(null);
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
// Same page ignoring the query: sites rewrite it on load (tracking or
// timestamp parameters), so we use this only right after navigating there.
function samePath(a, b) {
  try { const A = new URL(a), B = new URL(b); return A.origin + A.pathname === B.origin + B.pathname; }
  catch { return false; }
}

// opts.arrived: we just opened the partner's page; never navigate again from
// here (a site that rewrites its URL would otherwise loop).
async function catchUpToPartner(opts = {}) {
  if (!currentRoom) return { error: "Not in a room." };
  if (!partnerMeta || typeof partnerMeta.currentTime !== "number") {
    return { error: "Partner hasn't shared their position yet." };
  }

  // On a different page, seeking to the partner's timestamp would land on a
  // meaningless spot: open their page instead, and catch up once it loads.
  const samePage = urlsMatch(myLastTabInfo?.url, partnerMeta.url) ||
    (opts.arrived && samePath(myLastTabInfo?.url, partnerMeta.url));
  if (myLastTabInfo?.url && partnerMeta.url && !samePage) {
    if (opts.arrived) return { error: "You're on a different page from your partner." };
    const opened = await openPartnerVideo();
    return opened?.error ? opened : { navigating: true };
  }

  const located = await locateVideoTab();
  if (!located) {
    // No video open on our side: open theirs in a new tab (never over
    // whatever page you're on) and catch up when it loads.
    if (partnerMeta.url && !opts.arrived) {
      const opened = await openPartnerVideo(null, { newTab: true });
      return opened?.error ? opened : { navigating: true };
    }
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
    force: true,
    catchUp: true // we asked for this; the content script words its flash accordingly
  };
  await chrome.tabs.sendMessage(targetTabId, { type: "REMOTE_SYNC", state, serverNow: serverNow() },
    { frameId: located.hit.frameId }).catch(() => {});

  // Verify: wait for the seek to settle, then read back local position and
  // compare to partner's *current* projected time (which has advanced).
  await new Promise(r => setTimeout(r, 900));
  const hit = await getSnapshotFromAnyFrame(targetTabId, located.hit.frameId);
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
  const hit2 = (await getSnapshotFromAnyFrame(winnerTabId, hit.frameId).catch(() => null)) || hit;
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

// `message` may be a function of the frameId, for per-frame payloads.
async function sendToAllFrames(tabId, message) {
  const build = typeof message === "function" ? message : () => message;
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  if (!frames.length) {
    return chrome.tabs.sendMessage(tabId, build(null)).catch(() => { throw new Error("no-tab"); });
  }
  await Promise.all(frames.map(f =>
    chrome.tabs.sendMessage(tabId, build(f.frameId), { frameId: f.frameId }).catch(() => {})
  ));
}

// ── Broadcasts to UI ────────────────────────────────────────
function broadcastToVideoTabs(message) {
  if (message.type === "REMOTE_SYNC") {
    // Partner commands only ever reach the controlled player, never every
    // tab and frame (ads, previews). With no player yet (fresh SW, closed
    // tab), find one first; if there is none, the command is dropped.
    const deliver = () => sendToPrimary(message);
    deliver().catch(async () => {
      setPrimary(null);
      try { if (await locateVideoTab()) await deliver(); } catch {}
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
// opts.newTab: open in a new tab instead of reusing the video/active tab.
async function openPartnerVideo(tabId = null, opts = {}) {
  if (!partnerMeta?.url) return { error: "Partner hasn't shared a video yet." };
  // The URL comes from the room's shared DB node — only follow web links.
  let partnerUrl;
  try { partnerUrl = new URL(partnerMeta.url); } catch {}
  if (!partnerUrl || !/^https?:$/.test(partnerUrl.protocol)) {
    return { error: "Partner's link isn't a web page." };
  }

  // Try to redirect the exact tab we've been tracking, fallback to active tab
  let targetTabId = opts.newTab ? null : (tabId || primaryTabId);
  if (!targetTabId && !opts.newTab) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTabId = tabs[0]?.id;
  }

  if (targetTabId) {
    await chrome.tabs.update(targetTabId, { url: partnerUrl.href });
  } else {
    targetTabId = (await chrome.tabs.create({ url: partnerUrl.href })).id;
  }
  // The new page starts at 0:00. Once its video reports in, jump to where
  // the partner is, so following them doesn't leave you out of sync. Its
  // player may sit in a new frame, so the frame is relearned from TAB_INFO.
  setPrimary(targetTabId, null);
  lastTabInfoTime = Date.now();
  pendingArrival = { tabId: targetTabId, url: partnerUrl.href, until: Date.now() + ARRIVAL_WAIT_MS };
  return { ok: true };
}

// Set by openPartnerVideo; cleared once that tab's video reports on the
// partner's page (then we catch up) or after ARRIVAL_WAIT_MS.
let pendingArrival = null;
const ARRIVAL_WAIT_MS = 30000;
function maybeCatchUpOnArrival(sender, info) {
  const p = pendingArrival;
  if (!p) return;
  if (Date.now() > p.until) { pendingArrival = null; return; }
  if (sender.tab?.id !== p.tabId || !(info?.duration > 0)) return;
  if (!partnerMeta?.url || !(samePath(info.url, partnerMeta.url) || samePath(info.url, p.url))) return;
  pendingArrival = null;
  // Give the player a moment to finish its own start-up seek/autoplay.
  setTimeout(() => { catchUpToPartner({ arrived: true }).catch(() => {}); }, 800);
}

// ── Ready check ("Both ready?" → 3-2-1 → play) ──────────────
// rooms/<code>/readycheck = { id, by, at, ready: { uid: true }, go?, time? }.
// Whoever asked waits for the other "ready", then writes `go` (a server-clock
// instant ~3s out) and `time` (where to start). Both sides pause at `time`,
// count down, and press play at `go` — no "3, 2, 1, go" over the phone.
const READY_COUNTDOWN_MS = 3200;
const READY_STALE_MS = 90000;
let readyCheck = null;        // last value of rooms/<code>/readycheck
let readyGoHandled = null;    // id whose countdown we've already dispatched
let readyGoStarting = null;   // id we're writing `go` for (asker only)

function readyView() {
  const rc = readyCheck;
  if (!rc || typeof rc.id !== "string") return { phase: "none" };
  const ready = rc.ready && typeof rc.ready === "object" ? rc.ready : {};
  return {
    phase: typeof rc.go === "number" ? "go" : "asking",
    id: rc.id,
    byMe: rc.by === myUserId,
    meReady: ready[myUserId] === true,
    partnerReady: Object.keys(ready).some(uid => uid !== myUserId)
  };
}

function broadcastReady() {
  const view = readyView();
  const msg = { type: "READY_STATE", ...view };
  if (primaryTabId) sendToAllFrames(primaryTabId, msg).catch(() => {});
  else broadcastToVideoTabs(msg);
  chrome.runtime.sendMessage({ type: "POPUP_READY", ready: view }).catch(() => {});
}

async function onReadyCheckChange() {
  const rc = readyCheck;
  // An ask nobody answered (or a countdown that already ran) is noise.
  if (rc && typeof rc.at === "number" && typeof rc.go !== "number" && serverNow() - rc.at > READY_STALE_MS) {
    if (rc.by === myUserId) roomRef?.child("readycheck").remove().catch(() => {});
    readyCheck = null;
  }
  broadcastReady();
  const cur = readyCheck;
  if (!cur || !roomRef) return;

  if (typeof cur.go === "number") {
    if (readyGoHandled === cur.id) return;
    readyGoHandled = cur.id;
    if (serverNow() - cur.go > 2000) return; // stale countdown from before we joined
    if (primaryTabId == null) await locateVideoTab();
    const tabId = primaryTabId;
    if (tabId != null) {
      // Every frame gets the countdown (the badge may live in another frame),
      // but only the controlled frame touches its video.
      const driveFrame = primaryFrameId;
      sendToAllFrames(tabId, (frameId) => ({
        type: "READY_GO", id: cur.id, go: cur.go, serverNow: serverNow(),
        time: typeof cur.time === "number" ? cur.time : null,
        leader: cur.by === myUserId,
        drive: driveFrame == null || frameId == null || frameId === driveFrame
      })).catch(() => {});
    }
    if (cur.by === myUserId) {
      const id = cur.id;
      setTimeout(() => {
        roomRef?.child("readycheck").transaction(v => (v && v.id === id) ? null : undefined).catch(() => {});
      }, Math.max(0, cur.go - serverNow()) + 3000);
    }
    return;
  }

  const view = readyView();
  if (view.byMe && view.meReady && view.partnerReady && readyGoStarting !== cur.id) {
    readyGoStarting = cur.id;
    const located = await locateVideoTab();
    let time = located ? located.hit.r.currentTime : myLastTabInfo?.currentTime;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time >= 86400) time = 0;
    await roomRef.child("readycheck").update({ go: serverNow() + READY_COUNTDOWN_MS, time }).catch(() => {});
  }
}

async function startReadyCheck() {
  if (!roomRef || !myUserId) return { error: "Not in a room." };
  if (lastPeerCount < 2) return { error: "Your partner isn't here yet." };
  const located = await locateVideoTab();
  if (!located) return { error: "Open your video first, then ask again." };
  const id = Math.random().toString(36).slice(2, 10);
  try {
    await withTimeout(roomRef.child("readycheck").set({
      id, by: myUserId, at: firebase.database.ServerValue.TIMESTAMP,
      ready: { [myUserId]: true }
    }), 8000, "Starting ready check");
    return { ok: true, id };
  } catch (err) {
    recordErr("readycheck", err);
    if (/PERMISSION_DENIED/i.test(err?.message || "")) {
      return { error: "The sync server's rules are out of date — ready checks need the latest database rules." };
    }
    return { error: "Couldn't reach Duet's sync server. Try again." };
  }
}

async function answerReadyCheck(ready) {
  if (!roomRef || !myUserId) return { error: "Not in a room." };
  const ref = roomRef.child("readycheck");
  if (!ready) {
    await ref.remove().catch(() => {});
    return { ok: true };
  }
  if (!readyCheck?.id) return { error: "Nothing to answer — the check was cancelled." };
  if (!(await locateVideoTab())) return { error: "Open your video first." };
  await ref.child(`ready/${myUserId}`).set(true).catch(() => {});
  return { ok: true };
}

// ── Follow to the next episode ─────────────────────────────
// You were both on page A; the partner moved to page B on the same site
// (autoplay, "next episode"). Offer to follow — the content script counts
// down 5s with a "Stay here" escape, then asks for FOLLOW_GO.
function maybeFollowPartner(prev, next) {
  if (!prev || !next || prev.userId !== next.userId) return;
  if (typeof prev.url !== "string" || typeof next.url !== "string") return;
  if (urlsMatch(prev.url, next.url)) return;
  if (!myLastTabInfo?.url || !urlsMatch(myLastTabInfo.url, prev.url)) return;
  if (Date.now() - lastTabInfoTime > 15000 || !primaryTabId) return;
  let a, b;
  try { a = new URL(prev.url); b = new URL(next.url); } catch { return; }
  if (!/^https?:$/.test(b.protocol) || a.hostname !== b.hostname) return;
  // SPA sites update the URL before the title — don't show the old title.
  const prevTitle = prev.videoTitle || prev.pageTitle || "";
  const title = next.videoTitle || next.pageTitle || "";
  sendToAllFrames(primaryTabId, {
    type: "FOLLOW_PROMPT",
    url: next.url,
    title: title && title !== prevTitle ? title.slice(0, 120) : ""
  }).catch(() => {});
}

async function followPartner(url, tabId) {
  if (!partnerMeta?.url || !urlsMatch(partnerMeta.url, url)) {
    return { error: "Your partner moved again — open the popup to catch up." };
  }
  return openPartnerVideo(tabId);
}

// ── Chat history ────────────────────────────────────────────
// Text messages (not emoji reactions or buffering notices) for the current
// room, newest last. Session storage: kept across service-worker restarts,
// gone when the browser closes, never uploaded beyond the 6s relay.
const CHAT_MAX = 50;
const chatArea = chrome.storage.session || chrome.storage.local;
let chatLog = [];
let chatLoadedFor = null;
const chatKey = (code) => `__duet_chat_${code}`;

function isChatText(s) {
  if (typeof s !== "string" || !s.trim()) return false;
  if (/^⏳ Buffering/i.test(s)) return false;
  if (s.length <= 8 && !/[A-Za-z0-9]/.test(s)) return false; // emoji reaction
  return true;
}
async function loadChat() {
  if (!currentRoom) return [];
  if (chatLoadedFor !== currentRoom) {
    const code = currentRoom;
    let items = [];
    try {
      const got = await chatArea.get(chatKey(code));
      if (Array.isArray(got?.[chatKey(code)])) items = got[chatKey(code)];
    } catch {}
    if (currentRoom !== code) return [];
    chatLog = items.slice(-CHAT_MAX);
    chatLoadedFor = code;
  }
  return chatLog;
}
async function appendChat(entry) {
  const code = currentRoom;
  if (!code) return;
  await loadChat();
  if (currentRoom !== code) return;
  const item = { mine: !!entry.mine, text: String(entry.text).slice(0, 140), at: Date.now() };
  chatLog = [...chatLog, item].slice(-CHAT_MAX);
  try { await chatArea.set({ [chatKey(code)]: chatLog }); } catch {}
  broadcastToVideoTabs({ type: "CHAT_APPEND", item });
  chrome.runtime.sendMessage({ type: "POPUP_CHAT", item }).catch(() => {});
}

// ── Saved rooms (one permanent room per partner) ───────────
// Once two people have met in a room, it's remembered here and flagged
// `paired` in the DB, so it survives both leaving (90-day idle cleanup
// instead of 7) and the popup can offer "Watch with Sam" next time.
const PAIRS_KEY = "__duet_pairs";
const PAIRS_MAX = 6;
let pairMarkedFor = null;
let lastPairWrite = 0;
let lastPairSig = "";

async function getPairs() {
  try {
    const { [PAIRS_KEY]: pairs } = await chrome.storage.local.get(PAIRS_KEY);
    return pairs && typeof pairs === "object" ? pairs : {};
  } catch { return {}; }
}

async function rememberPair() {
  const code = currentRoom;
  if (!code || lastPeerCount < 2 || !partnerMeta || !roomRef) return;
  const name = typeof partnerMeta.name === "string" ? partnerMeta.name.trim().slice(0, 32) : "";
  const emoji = typeof partnerMeta.emoji === "string" ? partnerMeta.emoji.slice(0, 16) : "";
  // Meta arrives about once a second; only touch storage when something changed
  // or the entry's "last used" is a minute old.
  const sig = `${code}|${name}|${emoji}`;
  if (sig === lastPairSig && Date.now() - lastPairWrite < 60000) return;
  const pairs = await getPairs();
  const existing = pairs[code];
  if (existing && existing.name === name && existing.emoji === emoji && Date.now() - lastPairWrite < 60000) return;

  if (!existing) {
    // Same partner in a newer room: the newer room replaces the old entry,
    // and their story moves with them.
    for (const [c, p] of Object.entries(pairs)) {
      if (c !== code && name && p?.name && p.name.toLowerCase() === name.toLowerCase()) delete pairs[c];
    }
    try {
      const { __duet_story: story } = await chrome.storage.local.get("__duet_story");
      const fromKey = storyPartnerKey(partnerMeta);
      if (story?.partners?.[fromKey] && !story.partners[`room:${code}`]) {
        story.partners[`room:${code}`] = story.partners[fromKey];
        delete story.partners[fromKey];
        await chrome.storage.local.set({ __duet_story: story });
      }
    } catch {}
  }
  pairs[code] = { name, emoji, lastAt: Date.now(), since: existing?.since || Date.now() };
  const codes = Object.keys(pairs).sort((a, b) => (pairs[b].lastAt || 0) - (pairs[a].lastAt || 0));
  for (const c of codes.slice(PAIRS_MAX)) delete pairs[c];
  lastPairWrite = Date.now();
  lastPairSig = sig;
  try { await chrome.storage.local.set({ [PAIRS_KEY]: pairs }); } catch {}

  if (pairMarkedFor !== code && currentRoom === code) {
    pairMarkedFor = code;
    roomRef.child("paired").set(true).catch(() => { pairMarkedFor = null; });
  }
}

// Returns the removed entry so the popup can offer Undo (RESTORE_PAIR).
async function forgetPair(code) {
  const pairs = await getPairs();
  const removed = pairs[code] || null;
  delete pairs[code];
  try { await chrome.storage.local.set({ [PAIRS_KEY]: pairs }); } catch {}
  return { ok: true, removed };
}

async function restorePair(code, pair) {
  code = String(code || "").toUpperCase().trim();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code) || !pair || typeof pair !== "object") return { error: "Nothing to restore." };
  const pairs = await getPairs();
  pairs[code] = {
    name: typeof pair.name === "string" ? pair.name.slice(0, 32) : "",
    emoji: typeof pair.emoji === "string" ? pair.emoji.slice(0, 16) : "",
    lastAt: typeof pair.lastAt === "number" ? pair.lastAt : Date.now(),
    since: typeof pair.since === "number" ? pair.since : Date.now()
  };
  const codes = Object.keys(pairs).sort((a, b) => (pairs[b].lastAt || 0) - (pairs[a].lastAt || 0));
  for (const c of codes.slice(PAIRS_MAX)) delete pairs[c];
  try { await chrome.storage.local.set({ [PAIRS_KEY]: pairs }); } catch {}
  return { ok: true };
}

// Re-enter a saved room. If it was cleaned up, recreate it under the same
// code so the partner's "Watch with …" button still lands in the same place.
async function openPairedRoom(code) {
  code = String(code || "").toUpperCase().trim();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return { error: "That saved room has an invalid code." };
  if (currentRoom === code) return { roomCode: code, myUserId, joined: true };
  const res = await joinRoom(code, { leaveCurrent: true });
  if (!res?.error || !/not found/i.test(res.error)) return res;
  if (currentRoom) await leaveRoom();
  const made = await createRoom({ code });
  if (made.code === "taken") return joinRoom(code, { leaveCurrent: true }); // partner beat us to it
  return made;
}

// ── Attach to tabs that were open before install/update ────
// Chrome only injects content scripts into pages loaded *after* install, so
// a tab you were already watching in had no Duet at all until refreshed
// (the "Brave doesn't sync" report). Inject the same files now; the content
// script's version guard stops double-injection and retires an orphan from
// the previous version.
async function injectIntoOpenTabs() {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js || [];
  if (!files.length || !chrome.scripting?.executeScript) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(tabs
    .filter(t => t.id != null && !t.discarded && !DUET_INVITE.isInvitePage(t.url || ""))
    .map(t => chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files }).catch(() => {})));
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

        case "SYNC_EVENT": {
          // Only the controlled player speaks for this browser. Another video
          // takes control only when the user acted on it (a click or key
          // press in that frame); autoplay previews, ads and background tabs
          // are dropped without telling the partner anything.
          if (_sender.tab?.id == null) { sendResponse({ ignored: true }); break; }
          if (!isPrimarySender(_sender)) {
            if (!message.user) { sendResponse({ ignored: true }); break; }
            setPrimary(_sender.tab.id, _sender.frameId ?? 0);
            lastTabInfoTime = Date.now();
          }
          const res = await pushSyncEvent(message.state);
          sendResponse(res?.error ? res : { ok: true });
          break;
        }

        case "TAB_INFO":
          if (_sender.tab?.id != null) {
            // Only the controlled player publishes meta; otherwise a paused
            // background tab or an ad iframe overwrites it every second and
            // the partner's card flips to "different video". A video takes
            // over here only when there is no player yet, or the player went
            // quiet (closed, navigated away) and this one is audible in the
            // tab you're looking at. Taking over by user action happens in
            // SYNC_EVENT.
            const primaryQuiet = (Date.now() - lastTabInfoTime) > 5000;
            const audible = !message.info?.muted;
            if (!isPrimarySender(_sender) && audible &&
                (primaryTabId == null || (primaryQuiet && _sender.tab.active))) {
              setPrimary(_sender.tab.id, _sender.frameId ?? 0);
            }
            // Frame not known yet (e.g. just navigated to the partner's page):
            // the first audible video in the tab becomes the player, so a
            // muted ad iframe that reports first doesn't.
            // Exception: the top frame of a page we just opened for you (sites
            // often autoplay muted after a navigation).
            const arriving = pendingArrival?.tabId === _sender.tab.id && (_sender.frameId ?? 0) === 0;
            if (isPrimarySender(_sender) && primaryFrameId == null && (audible || arriving)) {
              setPrimary(primaryTabId, _sender.frameId ?? 0);
            }
            if (isPrimarySender(_sender) && primaryFrameId != null) {
              lastTabInfoTime = Date.now();
              await pushTabInfo(message.info);
              maybeCatchUpOnArrival(_sender, message.info);
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

        case "READY_START":   sendResponse(await startReadyCheck()); break;
        case "READY_ANSWER":  sendResponse(await answerReadyCheck(!!message.ready)); break;
        case "GET_READY":     sendResponse(readyView()); break;
        case "FOLLOW_GO":
          sendResponse(await followPartner(message.url, _sender.tab?.id || null));
          break;
        case "GET_CHAT":      sendResponse({ items: await loadChat() }); break;
        case "GET_PAIRS":     sendResponse({ pairs: await getPairs() }); break;
        case "OPEN_PAIR":     sendResponse(await openPairedRoom(message.code)); break;
        case "FORGET_PAIR":   sendResponse(await forgetPair(message.code)); break;
        case "RESTORE_PAIR":  sendResponse(await restorePair(message.code, message.pair)); break;

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
            ready: readyView(),
            paired: !!(currentRoom && (await getPairs())[currentRoom]),
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
  if (reason === "install" || reason === "update") {
    reloadInviteTabs().catch(() => {});
    injectIntoOpenTabs().catch(() => {});
  }
});
bootstrapQuietly();

// Clear primaryTabId proactively when its tab closes — otherwise SYNC_TO_ME
// keeps targeting a dead tabId and fails until something else reclaims primary.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === primaryTabId) {
    setPrimary(null);
    lastTabInfoTime = 0;
  }
});
