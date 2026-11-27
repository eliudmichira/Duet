// ============================================================
//  Duet — Content Script
// ============================================================

(function () {
  // Keyed by version: the background re-injects this file into tabs that were
  // open when Duet was installed or updated. Same version → already running.
  // Older version → that copy is orphaned (its extension context is gone), so
  // tell it to stand down and take over.
  let DUET_BUILD = "?";
  try { DUET_BUILD = chrome.runtime.getManifest().version; } catch {}
  if (window.__duetInjected === DUET_BUILD) return;
  if (window.__duetInjected) {
    try { document.dispatchEvent(new CustomEvent("duet:superseded")); } catch {}
    try { document.querySelectorAll("duet-ui").forEach(n => n.remove()); } catch {}
  }
  window.__duetInjected = DUET_BUILD;

  // Flip to true while developing if you need the verbose trace.
  const DEBUG = false;
  const dlog = (...args) => { if (DEBUG) console.log(...args); };

  // ── Centralized State Machine ─────────────────────────────
  // All reactive state lives here. Call setState() to update and trigger render.
  const S = {
    // Connection
    connected: false,
    peerCount: 0,
    lastPingMs: null,
    // Sync
    driftStatus: "waiting", // waiting | sync | warning | out_of_sync | mismatch
    driftSeconds: null,     // my position − partner's (s): negative = I'm behind
    isApplyingRemote: false,
    partnerTyping: false,
    bothPaused: false,      // both videos paused (the moment for a ready check)
    // Partners
    partnerName: "",
    partnerEmoji: "",
  };
  let _renderQueued = false;
  function setState(patch) {
    Object.assign(S, patch);
    if (!_renderQueued) {
      _renderQueued = true;
      queueMicrotask(() => { _renderQueued = false; render(); });
    }
  }

  // ── Sync Event Ring Buffer ────────────────────────────────
  // Last 100 events with timestamps for debugging and diagnostics.
  const SYNC_LOG_MAX = 100;
  const syncEventLog = [];
  function logSyncEvent(type, detail) {
    const evt = { t: Date.now(), type, ...detail };
    syncEventLog.push(evt);
    if (syncEventLog.length > SYNC_LOG_MAX) syncEventLog.shift();
    // Forward to background for popup diagnostics
    safeSend({ type: "LOG_SYNC_EVENT", event: evt });
  }

  // Non-reactive state (doesn't trigger render)
  let video = null;
  let expectedRemoteEvents = new Set();
  let applySettleTimer = null;
  let applySafetyTimer = null;
  let lastSentSig = "";
  let lastSentAt = 0;
  let lastTabInfoAt = 0;
  let tabInfoTimer = null;
  let contextInvalid = false;
  let myEmoji = "";
  let agentAdapter = null;
  let agentInitialized = false;
  let srcSwappedAt = 0;          // when the attached video last changed source
  let seekingAt = 0;             // when the attached video last started a seek
  const SEEK_STALL_MS = 3000;    // a `waiting` this soon after a seek is the seek loading
  let typingClearTimer = null;

  // Undo sync: save position before catch-up so user can revert
  let preSyncPosition = null;
  let preSyncTimestamp = null;

  // Load own avatar from storage so self-sent chat bubbles include our portrait.
  try {
    chrome.storage.local.get(["myEmoji"], (data) => {
      if (typeof data?.myEmoji === "string") myEmoji = data.myEmoji;
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.myEmoji) myEmoji = changes.myEmoji.newValue || "";
    });
  } catch {}

  // ── Bundled images (no CDN) ────────────────────────────────
  // Emoji and avatar artwork ships inside the extension (vendor/, generated
  // by tools/vendor-assets.mjs): no third-party requests from people's pages,
  // and nothing for a page's CSP to block. Emoji that aren't bundled render
  // as the system emoji.
  const BUNDLED_EMOJI = globalThis.DUET_TWEMOJI || new Set();
  const AVATAR_COUNT = 24; // av:00 … av:23 — see tools/vendor-assets.mjs
  function assetUrl(path) {
    try { return chrome.runtime.getURL(path); } catch { return null; } // context gone
  }
  // Twemoji file naming: hex code points joined by "-", with U+FE0F dropped
  // unless the sequence has a ZWJ. Must match tools/vendor-assets.mjs.
  function twemojiFile(emoji) {
    const text = emoji.includes("\u200D") ? emoji : emoji.replace(/\uFE0F/g, "");
    return Array.from(text, ch => ch.codePointAt(0).toString(16)).join("-");
  }
  // Every string that reaches innerHTML in the host page must pass through
  // this: partner names, labels, and anything relayed via postMessage are
  // attacker-controllable, and markup injected here runs in the page's origin.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  // Escapes the input, then swaps emoji for Twemoji <img>s. Emoji never
  // contain HTML metacharacters, so escaping first doesn't disturb matching.
  function twemojiHtml(text) {
    if (text == null) return "";
    return escapeHtml(text).replace(/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu, function(match) {
      const file = twemojiFile(match);
      const src = BUNDLED_EMOJI.has(file) ? assetUrl(`vendor/twemoji/${file}.svg`) : null;
      if (!src) return match; // system emoji
      return '<img class="twemoji" draggable="false" alt="' + match + '" src="' + src + '" width="16" height="16">';
    });
  }

  function isAvatarCode(v) { return typeof v === "string" && /^av:\d{2}$/.test(v); }
  function avatarUrl(code) {
    if (!isAvatarCode(code)) return null;
    const idx = parseInt(code.slice(3), 10);
    if (!(idx >= 0 && idx < AVATAR_COUNT)) return null;
    return assetUrl(`vendor/avatars/av-${code.slice(3)}.svg`);
  }
  // Returns an HTML snippet for an avatar — either an <img> for codes, or the
  // raw emoji glyph. `size` is in px. Safe to inline (no user-controlled data).
  function avatarHtml(value, size) {
    const px = size || 16;
    if (isAvatarCode(value)) {
      const url = avatarUrl(value);
      return `<img src="${url}" alt="" style="width:${px}px;height:${px}px;border-radius:50%;display:inline-block;vertical-align:middle;object-fit:cover;flex-shrink:0;">`;
    }
    if (typeof value === "string" && value.length > 0 && value.length <= 4) {
      return `<span style="font-size:${px}px;line-height:1;display:inline-block;vertical-align:middle;">${twemojiHtml(value)}</span>`;
    }
    return "";
  }

  // One name per action: "Go to Sam" moves YOU to them; "Bring Sam here"
  // moves THEM to you. The labels never swap meaning.
  function goToLabel() { return `Go to ${S.partnerName || "partner"}`; }
  function bringLabel() { return `Bring ${S.partnerName || "partner"} here`; }

  // Persist a chosen emoji to the recents list shared with the popup picker
  // (so Recent stays consistent regardless of where you sent the reaction from).
  function recordRecentEmoji(emoji) {
    if (!emoji || typeof emoji !== "string") return;
    try {
      chrome.storage.local.get(["__duet_emoji_recents"], (data) => {
        const cur = Array.isArray(data?.__duet_emoji_recents) ? data.__duet_emoji_recents : [];
        const next = [emoji, ...cur.filter(e => e !== emoji)].slice(0, 12);
        try { chrome.storage.local.set({ __duet_emoji_recents: next }); } catch {}
      });
    } catch {}
  }
  function refreshSyncBtnLabel() {
    const go = $ui("__pp_sync_btn");
    if (go && !go.disabled) go.textContent = goToLabel(); // don't clobber transient states
    const bring = $ui("__pp_bring_btn");
    if (bring && !bring.disabled) bring.textContent = bringLabel();
    renderReady();
  }

  // Returns true if the background is still reachable. If not, marks the page
  // as dead so periodic timers can self-terminate.
  function extAlive() {
    if (contextInvalid) return false;
    try {
      if (!chrome.runtime?.id) { contextInvalid = true; teardown(); return false; }
      return true;
    } catch {
      contextInvalid = true;
      teardown();
      return false;
    }
  }

  // ── Echo suppression ───────────────────────────────────────
  // When we apply a remote state, we trigger seek/play/pause/ratechange on the
  // <video>. Those raise the corresponding events, which our listeners would
  // otherwise treat as fresh user actions and broadcast back. We track which
  // events we *expect* from a remote apply and consume them silently, clearing
  // the flag once they all arrive (with a small grace period for late-firing
  // events like 'playing' on slow streams) or after a 2s safety net.
  function endApplyingRemote() {
    S.isApplyingRemote = false;
    expectedRemoteEvents.clear();
    if (applySettleTimer) { clearTimeout(applySettleTimer); applySettleTimer = null; }
    if (applySafetyTimer) { clearTimeout(applySafetyTimer); applySafetyTimer = null; }
  }
  // Returns true if the event was an expected echo (caller should NOT broadcast).
  function consumeRemoteEvent(name) {
    if (!S.isApplyingRemote) return false;
    if (!expectedRemoteEvents.has(name)) {
      // Still in the apply window but this event wasn't expected — likely a
      // delayed echo (e.g., 'playing' after we already cleared 'play'). Treat
      // it as an echo too, since the user can't realistically have acted yet.
      return true;
    }
    expectedRemoteEvents.delete(name);
    if (expectedRemoteEvents.size === 0) {
      if (applySettleTimer) clearTimeout(applySettleTimer);
      applySettleTimer = setTimeout(endApplyingRemote, 250);
    }
    return true;
  }

  // Wrapper around chrome.runtime.sendMessage that never throws and never rejects.
  // (Raw sendMessage throws SYNCHRONOUSLY on "Extension context invalidated", so
  // .catch() alone isn't enough.)
  function safeSend(msg) {
    if (!extAlive()) return Promise.resolve(null);
    try {
      const p = chrome.runtime.sendMessage(msg);
      return p && typeof p.catch === "function" ? p.catch(() => null) : Promise.resolve(null);
    } catch {
      contextInvalid = true;
      teardown();
      return Promise.resolve(null);
    }
  }

  function teardown() {
    try { observer?.disconnect(); } catch {}
    if (tabInfoTimer) { clearInterval(tabInfoTimer); tabInfoTimer = null; }
    // Hide the UI — extension is gone, anything it claims is stale
    if (uiHost) uiHost.remove();
  }
  // A newer copy of this script was injected (extension updated in place).
  document.addEventListener("duet:superseded", () => { contextInvalid = true; teardown(); });

  // ── Video Detection ────────────────────────────────────────
  function scoreVideo(v) {
    const r = v.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && getComputedStyle(v).visibility !== "hidden";
    if (!visible) return 0;
    const area = r.width * r.height;
    const ready = v.readyState >= 2 ? 1 : 0;
    return area + ready * 1_000_000;
  }
  // Track how many consecutive polls find no video — triggers agent fallback
  let noVideoPolls = 0;
  const AGENT_FALLBACK_THRESHOLD = 3; // after 3 failed polls, try the agent

  function agentLoaded() {
    return typeof DuetAgent !== "undefined" && typeof AdapterRuntime !== "undefined";
  }

  async function tryAgentFallback() {
    if (agentInitialized) return null;
    try {
      agentInitialized = true;
      dlog("[Duet Agent] Standard detection failed, lazy-loading agent modules...");
      // Lazy-load agent scripts via background. Content scripts can't call
      // chrome.tabs, so the background targets this frame from the sender.
      // The modules declare top-level consts, which are shared across this
      // isolated world but are NOT properties of `window` — hence typeof.
      if (!agentLoaded()) {
        await safeSend({ type: "INJECT_AGENT_SCRIPTS" });
      }
      if (!agentLoaded()) {
        dlog("[Duet Agent] Scripts not loaded after injection");
        return null;
      }
      dlog("[Duet Agent] Running agent analysis...");
      const result = await DuetAgent.analyze(location.href, { skipTest: true });
      if (result?.adapter) {
        agentAdapter = result.adapter;
        dlog(`[Duet Agent] Adapter loaded: ${result.adapter.id} (${result.adapter.strategy})`);
        const v = AdapterRuntime.findVideo(agentAdapter);
        if (v) return v;
      }
    } catch (err) {
      dlog("[Duet Agent] Fallback failed:", err);
    }
    return null;
  }

  function findVideo() {
    // Standard detection first
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length) {
      let best = null, bestScore = 0;
      for (const v of videos) {
        const s = scoreVideo(v);
        if (s > bestScore) { best = v; bestScore = s; }
      }
      if (best) {
        noVideoPolls = 0;
        return best;
      }
    }

    // Standard detection found nothing — count consecutive failures
    noVideoPolls++;

    // If we already have an active agent adapter, use it
    if (agentAdapter && agentLoaded()) {
      try {
        const v = AdapterRuntime.findVideo(agentAdapter);
        if (v) return v;
      } catch {}
    }

    // After threshold, trigger async agent fallback
    // Only while in a room: otherwise every video-less page for every user
    // would wake the background and get the agent injected for nothing.
    if (S.connected && noVideoPolls >= AGENT_FALLBACK_THRESHOLD && !agentInitialized) {
      tryAgentFallback().then((v) => {
        if (v && v !== video) attachListeners(v);
      });
    }

    return null;
  }
  function attachListeners(v) {
    if (v.__duetAttached) {
      video = v; // just update pointer if already attached
      return;
    }
    v.__duetAttached = true;
    video = v;
    const guard = (fn) => () => {
      if (video !== v) return; // Drop events from old hidden videos
      try { fn(); } catch { contextInvalid = true; teardown(); }
    };
    // A player that swaps its source (an ad starting or ending, the next
    // episode) fires play/pause/seek at the new media's time. Note the swap
    // so sendSync can hold those events back. `emptied` fires only when
    // media that was already loaded is thrown away, so a first load (lazy
    // players set their src on the user's first click) doesn't count, and it
    // is queued before the new media's play/pause events.
    v.addEventListener("emptied", () => { srcSwappedAt = Date.now(); });
    // A seek always stalls briefly while the new spot loads. That isn't the
    // network struggling, so the `waiting` it causes mustn't pause the
    // partner or tell them we're buffering.
    v.addEventListener("seeking", () => { seekingAt = Date.now(); });
    v.addEventListener("play",       guard(() => { if (consumeRemoteEvent("play"))    return; sendSync("play");  sendTabInfo(true); }));
    v.addEventListener("pause",      guard(() => { if (consumeRemoteEvent("pause"))   return; sendSync("pause"); sendTabInfo(true); }));
    v.addEventListener("seeked",     guard(() => { if (consumeRemoteEvent("seeked"))  return; sendSync(v.paused ? "pause" : "play"); sendTabInfo(true); }));
    v.addEventListener("ratechange", guard(() => { if (consumeRemoteEvent("ratechange")) return; sendSync(v.paused ? "pause" : "play"); sendTabInfo(true); }));
    v.addEventListener("waiting",    guard(() => {
      if (S.isApplyingRemote || !S.connected) return;
      if (v.seeking || Date.now() - seekingAt < SEEK_STALL_MS) return;
      const sent = sendSync("pause");
      if (!sent) return;
      // Only tell the partner we're buffering if the background accepted the
      // pause from this player (not an ad frame or a background tab), and at
      // most once per ~5s so a stuttering stream doesn't spam them.
      sent.then((res) => {
        if (!res?.ok) return;
        const now = Date.now();
        if (now - (window.__duet_lastBufferPing || 0) > 5000) {
          window.__duet_lastBufferPing = now;
          safeSend({ type: "SEND_REACTION", emoji: "⏳ Buffering..." });
        }
      });
    }));
    v.addEventListener("playing",    guard(() => { if (consumeRemoteEvent("playing")) return; sendSync("play");  sendTabInfo(true); }));
    v.addEventListener("timeupdate", guard(() => { sendTabInfo(); }));
    dlog("[Duet] Attached to active video player.");
    render();
    sendTabInfo(true); // immediately push our metadata
  }

  // Find the frame's video *and* attach to it. Assigning `video` directly
  // (as remote commands and snapshots used to) left a video with no
  // listeners, so its local play/pause never reached the partner.
  function ensureVideo() {
    const v = findVideo();
    if (v) attachListeners(v);
    return video;
  }

  // ── MutationObserver: instant video detection (replaces 1.5s polling) ──
  // Watches for DOM changes (new elements, attribute changes, shadow roots)
  // and re-checks for video elements. Falls back to polling if observer fails.
  function startVideoObserver() {
    let debounceTimer = null;
    const check = () => {
      if (!extAlive()) return;
      const best = findVideo();
      if (best && best !== video) attachListeners(best);
    };
    const debouncedCheck = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(check, 150);
    };

    try {
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          // New nodes added — check for video elements
          if (m.type === "childList" && m.addedNodes.length) {
            debouncedCheck();
            return;
          }
          // Attribute changed on a video-like element
          if (m.type === "attributes" && m.target?.tagName === "VIDEO") {
            debouncedCheck();
            return;
          }
        }
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["src", "style", "class"]
      });
      // Initial check (deferred one tick: attaching to a video renders the
      // badge, which reads state declared further down this file) + light
      // polling fallback (10s) for edge cases.
      setTimeout(check, 0);
      setInterval(() => { if (extAlive()) check(); }, 10000);
    } catch {
      // MutationObserver failed — fall back to polling
      setInterval(() => {
        if (!extAlive()) return;
        const best = findVideo();
        if (best && best !== video) attachListeners(best);
      }, 1500);
    }
  }
  startVideoObserver();

  // ── Keyboard shortcuts ─────────────────────────────────────
  // Ctrl+Shift+S = sync partner to me
  // Ctrl+Shift+1-4 = send reactions (😂 💖 🔥 😭)
  document.addEventListener("keydown", (e) => {
    if (!extAlive() || !S.connected) return;
    if (!e.ctrlKey || !e.shiftKey) return;
    const key = e.key;
    if (key === "S" || key === "s") {
      e.preventDefault();
      safeSend({ type: "SYNC_TO_ME" }).then((res) => {
        if (res?.ok) showFlash("play", "Synced partner to you");
        else if (res?.error) showFlash("pause", res.error);
      });
    } else if (key >= "1" && key <= "4") {
      e.preventDefault();
      const reactions = ["😂", "💖", "🔥", "😭"];
      const idx = parseInt(key) - 1;
      if (reactions[idx]) {
        safeSend({ type: "SEND_REACTION", emoji: reactions[idx] });
        spawnReaction(reactions[idx], { fromSelf: true });
        recordRecentEmoji(reactions[idx]);
      }
    }
  }, true);

  // ── Send local action ──────────────────────────────────────
  // Did the user just click or press a key in this frame? Transient user
  // activation lasts a few seconds after a real gesture and can't be faked by
  // page script, so autoplay, ads and scripted players read as false.
  function userActive() {
    try { return !!navigator.userActivation?.isActive; } catch { return false; }
  }
  const SRC_SWAP_GRACE_MS = 3000;

  // `opts.leader`: the ready-check asker recording the agreed play; not a
  // user gesture, but this frame is the controlled one, so it counts.
  // Returns the background's reply (a promise) when sent, else null.
  function sendSync(action, opts = {}) {
    if (S.isApplyingRemote || !S.connected || !video) return null;
    const user = userActive();
    // Just after a source swap the events describe an ad or the next video,
    // not where the partner should be — hold them even if a click caused it.
    if (Date.now() - srcSwappedAt < SRC_SWAP_GRACE_MS && !opts.leader) return null;
    // Without a gesture, a muted video is an autoplay preview or an ad.
    if (!user && !opts.leader && video.muted) return null;
    const sig = `${action}|${video.currentTime.toFixed(2)}`;
    const now = Date.now();
    if (sig === lastSentSig && now - lastSentAt < 250) return null;
    lastSentSig = sig;
    lastSentAt = now;
    logSyncEvent("LOCAL_SYNC", { action, time: video.currentTime, user });

    return safeSend({
      type: "SYNC_EVENT",
      user: user || !!opts.leader,
      state: {
        action,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate
      }
    });
  }

  // ── Apply Remote Sync ──────────────────────────────────────
  function applySync(state, serverNow) {
    if (!video && !ensureVideo()) return;

    // Reset any in-flight apply window so we don't carry stale expectations.
    endApplyingRemote();
    S.isApplyingRemote = true;
    const expected = new Set();

    let targetTime = state.currentTime;
    if (state.action === "play" && typeof state.serverTime === "number" && typeof serverNow === "number") {
      const elapsed = Math.max(0, (serverNow - state.serverTime) / 1000);
      targetTime = state.currentTime + elapsed;
    }

    // Is the partner changing play/pause, or just moving the playhead?
    const actionChanges = state.action === "play" ? video.paused : !video.paused;

    // Force-syncs always seek; normal updates only seek when drifting > 1s
    const driftThreshold = state.force ? 0 : 1.0;
    let jumped = false;
    if (Math.abs(video.currentTime - targetTime) > driftThreshold) {
      jumped = Math.abs(video.currentTime - targetTime) > 2;
      try { video.currentTime = targetTime; expected.add("seeked"); } catch {}
    }

    if (state.playbackRate && Math.abs(video.playbackRate - state.playbackRate) > 0.01) {
      try { video.playbackRate = state.playbackRate; expected.add("ratechange"); } catch {}
    }

    if (state.action === "play" && video.paused) {
      expected.add("play");
      expected.add("playing");
      video.play().catch(() => showFlash("play", "Click the video to start (autoplay blocked)"));
    } else if (state.action === "pause" && !video.paused) {
      expected.add("pause");
      video.pause();
    }

    // A catch-up the user asked for is "you → partner", not something the
    // partner did to you.
    // Play/pause gets the signature flash; a seek says where they jumped to.
    const who = S.partnerName || "Partner";
    if (!state.quiet) {
      showFlash(state.action, state.catchUp ? `Caught up to ${who}`
        : state.force ? `${who} re-synced you`
        : jumped && !actionChanges ? `${who} jumped to ${fmtClock(targetTime)}`
        : null);
    }

    expectedRemoteEvents = expected;
    if (expected.size === 0) {
      // Nothing to wait for — clear immediately so the user isn't suppressed.
      endApplyingRemote();
    } else {
      // Safety net: even if the player never emits the events we expect (slow
      // HLS, buggy embed), don't lock out the user beyond 2 seconds.
      applySafetyTimer = setTimeout(endApplyingRemote, 2000);
    }
  }

  // ── Tab metadata (what am I watching) ──────────────────────
  function getVideoTitle() {
    // YouTube-specific
    const yt = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title.ytd-video-primary-info-renderer");
    if (yt?.textContent?.trim()) return yt.textContent.trim();
    // OpenGraph
    const og = document.querySelector('meta[property="og:title"]')?.content;
    if (og) return og;
    return document.title;
  }

  // Only the top frame publishes tab metadata. Iframes (YouTube recommendations,
  // ad slots, sidecar players, etc.) used to spam TAB_INFO with the same tab.id
  // and overwrite the real player's metadata in Firebase, which made the partner
  // card render with empty/zero progress. If the actual player is in an iframe,
  // we defer to the top frame which still has access to the iframe's own video
  // via the page's DOM (or, for cross-origin iframes, to the iframe's <video>
  // tag scored by `findVideo()`).
  const isTopFrame = (() => {
    try { return window.top === window.self; } catch { return false; }
  })();

  // ── Cross-frame message trust ──────────────────────────────
  // window.postMessage is reachable by every frame on the page (ads included),
  // and we can't tell our own content script in a cross-origin iframe apart
  // from the page that iframe hosts. So: only accept messages from the frame
  // tree we expect, and treat every payload as untrusted text regardless.
  function fromDescendantFrame(e) {
    try { return !!e.source && e.source !== window && e.source.top === window; } catch { return false; }
  }
  function fromTopFrame(e) {
    try { return !!e.source && e.source === window.top; } catch { return false; }
  }
  function sanitizeFlash(data) {
    const action = data.action === "play" ? "play" : "pause";
    const customLabel = typeof data.customLabel === "string" ? data.customLabel.slice(0, 160) : null;
    return { action, customLabel };
  }

  // A player in a cross-origin iframe (yflix's embed, rapidshare, etc.) sits
  // at a per-viewer tokenized URL, so partner matching needs the page both
  // people are on: the tab's URL. Frames no longer ask each other for it.
  // The top frame used to postMessage location.href to every iframe with
  // targetOrigin "*", on every page and every SPA navigation, in a room or
  // not, which handed full URLs (query, #fragment, OAuth tokens) to ad and
  // tracker frames. The background now fills in the tab's URL from
  // sender.tab when this frame reports in (TAB_INFO), so nothing about the
  // page is posted between frames at all.

  function sendTabInfo(force = false) {
    if (!S.connected || !video) return;
    // Only frames with a real, loaded video may publish metadata.
    // Empty ad/sidecar iframes have duration === 0 (or NaN) and are filtered
    // here. Live streams (HLS/DASH) have duration === Infinity, which passes
    // `> 0` so live partners still get to publish.
    if (!isTopFrame && !(video.duration > 0)) return;
    const now = Date.now();
    if (!force && now - lastTabInfoAt < 1000) return;
    lastTabInfoAt = now;

    const info = {
      // This frame's own address; the background swaps in the tab's URL,
      // hostname and title (see TAB_INFO), so an embedded player reports
      // the page both partners share.
      url: location.href,
      hostname: location.hostname.replace(/^www\./, ""),
      pageTitle: document.title,
      videoTitle: getVideoTitle(),
      duration: isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime,
      paused: video.paused,
      // Read by the background to pick the controlled player; never stored
      // (sanitizeMeta keeps only the fields the DB rules allow).
      muted: !!video.muted
    };
    safeSend({ type: "TAB_INFO", info });
  }

  function startTabInfoTimer() {
    if (tabInfoTimer) clearInterval(tabInfoTimer);
    tabInfoTimer = setInterval(sendTabInfo, 1000);
  }
  document.addEventListener("visibilitychange", sendTabInfo);

  // ── Cross-frame badge ownership ────────────────────────────
  // The badge needs exactly one renderer at any time. Default: the TOP frame
  // owns it. When an iframe goes fullscreen (e.g., yflix embeds a player in
  // a rapidshare iframe and the user fullscreens that iframe), the top frame's
  // DOM is hidden — so we hand ownership to the fullscreen iframe so the user
  // can still control sync, chat, and reactions without leaving fullscreen.
  let frameOwnsBadge = isTopFrame;

  function applyBadgeOwnership() {
    const overlay = $ui("__duet_overlay");
    if (frameOwnsBadge) {
      if (overlay) overlay.style.display = "flex";
      // Force a re-render so the badge picks up any state changes that
      // happened while we didn't own it.
      try { render(); } catch {}
    } else if (overlay) {
      overlay.style.display = "none";
    }
  }

  if (isTopFrame) {
    // Top frame: listen for flashes from iframes; broadcast fullscreen state.
    window.addEventListener("message", (e) => {
      const data = e?.data;
      if (!data || !fromDescendantFrame(e)) return;
      if (data.__duet_msg === "flash") {
        const { action, customLabel } = sanitizeFlash(data);
        if (frameOwnsBadge) {
          try { showFlash(action, customLabel); } catch {}
        } else {
          // Forward to whichever iframe currently owns (the fullscreen one).
          const fs = document.fullscreenElement || document.webkitFullscreenElement;
          if (fs && fs.tagName === "IFRAME") {
            try { fs.contentWindow?.postMessage({ __duet_msg: "flash", action, customLabel }, "*"); } catch {}
          }
        }
      }
    });

    function broadcastFullscreenOwnership() {
      const fs = document.fullscreenElement
              || document.webkitFullscreenElement
              || null;
      const fsIsIframe = fs && fs.tagName === "IFRAME";
      // If an iframe is fullscreen, hand ownership to it; tell others to give up.
      document.querySelectorAll("iframe").forEach(f => {
        try {
          f.contentWindow?.postMessage({
            __duet_msg: "badge-owner",
            value: fsIsIframe && f === fs
          }, "*");
        } catch {}
      });
      const newOwnership = !fsIsIframe;
      if (newOwnership !== frameOwnsBadge) {
        frameOwnsBadge = newOwnership;
        applyBadgeOwnership();
      }
    }
    document.addEventListener("fullscreenchange",       broadcastFullscreenOwnership);
    document.addEventListener("webkitfullscreenchange", broadcastFullscreenOwnership);
    // Re-broadcast every few seconds to handle iframes that mounted late.
    setInterval(broadcastFullscreenOwnership, 3000);
  } else {
    // Iframe: listen for ownership grants AND forwarded flashes from top.
    window.addEventListener("message", (e) => {
      const data = e?.data;
      if (!data || !fromTopFrame(e)) return;
      if (data.__duet_msg === "badge-owner") {
        const next = !!data.value;
        if (next !== frameOwnsBadge) {
          frameOwnsBadge = next;
          applyBadgeOwnership();
        }
      } else if (data.__duet_msg === "flash" && frameOwnsBadge) {
        const { action, customLabel } = sanitizeFlash(data);
        try { showFlash(action, customLabel); } catch {}
      }
    });
  }

  // ── UI root (Shadow DOM) ───────────────────────────────────
  // Everything Duet draws on a page lives in one closed shadow root:
  //  - page CSS can't restyle or break it (and vice versa),
  //  - page scripts can't reach in and read the chat,
  //  - toasts, bubbles and the badge share one host, so re-parenting that
  //    host into a fullscreen element brings all of them along.
  // Visual language follows DESIGN.md ("soft-embossed pill"): the badge is a
  // Lifted card whose cast shadow is tinted by sync health, Catch-up is the
  // one Lifted primary, reactions are keys in a Recessed tray, the chat box
  // is a Recessed input.
  const DUET_UI_CSS = `
    :host { all: initial; color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }

    ::selection {
      background: rgba(244, 114, 182, 0.35);
      color: #fff;
    }

    .layer {
      color-scheme: dark;
      accent-color: var(--coral);
      scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
      scrollbar-width: thin;
      --text: #f4f1ea;
      --muted: rgba(244,241,234,0.58);
      --border: rgba(255,255,255,0.09);
      --border-strong: rgba(255,255,255,0.16);
      --peach: #ffc89a; --coral: #ff8a6b; --rose: #f472b6; --violet: #8b5cf6;
      --success: #5ee2a0; --warn: #fcd34d; --danger: #ff6b7a;
      --emboss-rim:        inset 0 1px 0 rgba(255,255,255,0.45);
      --emboss-rim-soft:   inset 0 1px 0 rgba(255,255,255,0.10);
      --emboss-rim-faint:  inset 0 1px 0 rgba(255,255,255,0.06);
      --emboss-base:       inset 0 -2px 4px rgba(0,0,0,0.18);
      --emboss-base-soft:  inset 0 -1px 2px rgba(0,0,0,0.12);
      --lift-small:        0 3px 8px rgba(0,0,0,0.30);
      --lift-small-hi:     0 6px 14px rgba(0,0,0,0.40);
      --recess:            inset 0 1px 2px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.04);
      /* Near-opaque on purpose: surfaces sit over playing video without a
         backdrop blur, which would be re-rendered on every video frame. */
      --surface: linear-gradient(180deg, rgba(32,29,44,0.97) 0%, rgba(18,16,26,0.975) 50%, rgba(11,10,16,0.98) 100%);
      /* Motion tokens (DESIGN.md "Motion"). */
      --ease-out:       cubic-bezier(0.23, 1, 0.32, 1);     /* entrances / exits */
      --ease-overshoot: cubic-bezier(0.3, 1.45, 0.5, 1);    /* the duet mark's click-in */
      --press: transform .15s ease, box-shadow .25s ease;   /* press physics: shadow lags position */
      font-family: "Duet Allo", -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text);
      font-size: 12px; line-height: 1.3; font-weight: 600; letter-spacing: 0.005em;
      -webkit-font-smoothing: antialiased;
    }
    button, input { font: inherit; color: inherit; margin: 0; }
    button { cursor: pointer; }
    button:focus-visible, input:focus-visible {
      outline: 2px solid rgba(139,92,246,0.7); outline-offset: 2px;
    }
    img.twemoji { display: inline-block; width: 1.1em; height: 1.1em; vertical-align: -0.15em; }

    /* ── Stack anchored bottom-right (flash above badge) ── */
    .overlay {
      position: fixed; bottom: 22px; right: 22px;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      pointer-events: none;
    }

    /* ── Badge: Lifted card, cast shadow echoes sync health ── */
    .badge {
      --cast: 0 10px 28px rgba(0,0,0,0.45);
      position: relative;
      display: flex; flex-direction: column;
      width: 264px;
      pointer-events: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--cast), var(--emboss-rim-soft), var(--emboss-base);
      opacity: 0; transform: translateY(6px);
      transition: opacity .25s var(--ease-out), transform .25s var(--ease-out), box-shadow .45s ease;
    }
    .badge.is-visible { opacity: 1; transform: none; }
    .badge[data-health="good"] { --cast: 0 10px 28px rgba(0,0,0,0.40), 0 6px 22px rgba(94,226,160,0.22); }
    .badge[data-health="warn"] { --cast: 0 10px 28px rgba(0,0,0,0.40), 0 6px 22px rgba(255,200,154,0.28); }
    .badge[data-health="bad"]  { --cast: 0 10px 28px rgba(0,0,0,0.40), 0 6px 22px rgba(255,107,122,0.30); }

    .topbar {
      display: flex; align-items: center; gap: 7px;
      padding: 9px 10px 9px 12px;
      cursor: grab; touch-action: none; user-select: none;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--peach);
      box-shadow: 0 0 8px var(--peach), 0 0 0 3px rgba(255,200,154,0.12);
      transition: background .3s, box-shadow .3s;
    }
    [data-health="good"] .dot { background: var(--success); box-shadow: 0 0 8px var(--success), 0 0 0 3px rgba(94,226,160,0.12); }
    [data-health="warn"] .dot { background: var(--warn);    box-shadow: 0 0 8px var(--warn),    0 0 0 3px rgba(252,211,77,0.12); }
    [data-health="bad"]  .dot { background: var(--danger);  box-shadow: 0 0 8px var(--danger),  0 0 0 3px rgba(255,107,122,0.14); }
    .brand {
      font-weight: 700;
      background: linear-gradient(110deg, var(--peach), var(--rose), var(--violet));
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .sep { color: var(--muted); font-weight: 500; }
    .status-emoji { font-size: 13px; line-height: 1; }

    /* Partner's face. Its ring carries sync health (DESIGN.md echoed accent),
       so the plain dot steps aside whenever a face is shown. */
    .av {
      --ring: rgba(255,255,255,0.14);
      width: 20px; height: 20px; flex-shrink: 0;
      display: grid; place-items: center; overflow: hidden;
      border-radius: 50%;
      background: rgba(255,255,255,0.06);
      font-size: 12px; line-height: 1;
      box-shadow: 0 0 0 2px var(--ring);
      transition: box-shadow .3s ease;
    }
    .av img.portrait { width: 100%; height: 100%; object-fit: cover; display: block; }
    .av.mono {
      background: linear-gradient(135deg, var(--peach), var(--rose), var(--violet));
      color: #14111c; font-weight: 800; font-size: 11px;
    }
    .av.plain { background: none; box-shadow: none; font-size: 13px; }
    [data-health="good"] .av { --ring: rgba(94,226,160,0.80); }
    [data-health="warn"] .av { --ring: rgba(252,211,77,0.85); }
    [data-health="bad"]  .av { --ring: rgba(255,107,122,0.85); }
    .badge.has-face .dot { display: none; }
    .av.typing { animation: duet-ring 1.2s ease-in-out infinite; }
    @keyframes duet-ring {
      50% { box-shadow: 0 0 0 3px var(--ring), 0 0 10px var(--ring); }
    }
    .puck .av { width: 28px; height: 28px; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }
    .status-text, .count-num, .log { font-variant-numeric: tabular-nums; }
    .status-text {
      flex: 1; min-width: 0;
      color: rgba(244,241,234,0.88);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ping { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .ping[data-q="good"] { color: var(--success); }
    .ping[data-q="ok"]   { color: var(--warn); }
    .ping[data-q="bad"]  { color: var(--danger); }

    /* Small round key — flat at rest, lifts on hover (DESIGN.md small travel). */
    .icon-key {
      width: 22px; height: 22px; flex-shrink: 0;
      display: grid; place-items: center; padding: 0;
      border: 1px solid transparent; border-radius: 50%;
      background: rgba(255,255,255,0.05);
      color: var(--muted); font-size: 15px; line-height: 1;
      transition: var(--press), background .2s, color .2s;
    }
    .icon-key:hover {
      color: var(--text);
      background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.05));
      box-shadow: var(--lift-small), var(--emboss-rim-soft);
      transform: translateY(-1px);
    }
    .icon-key.close { font-size: 16px; }
    .icon-key.close:hover { color: var(--text); background: rgba(255,107,122,0.18); }
    .icon-key:active { transform: none; box-shadow: var(--recess); }

    .controls {
      display: none; flex-direction: column; gap: 8px;
      padding: 10px 12px 12px;
      border-top: 1px solid var(--border);
    }
    .badge.is-open .controls { display: flex; }
    /* In the default bottom-right spot the badge grows upward, so open the
       controls ABOVE the bar: the bar (and its − / × keys) stays under the
       cursor instead of jumping away on hover. Once dragged, the badge is
       pinned by its top edge and opens downward as before. */
    .overlay:not(.is-placed) .badge { flex-direction: column-reverse; }
    .overlay:not(.is-placed) .controls { border-top: none; border-bottom: 1px solid var(--border); }

    /* The one Lifted primary in the badge. Small object → -1px travel. */
    .btn-primary {
      width: 100%; border: none; border-radius: 999px;
      padding: 8px 12px;
      font-weight: 700; font-size: 12px; color: #14111c;
      background: linear-gradient(180deg, var(--peach) 0%, var(--coral) 50%, var(--rose) 100%);
      box-shadow: 0 4px 12px rgba(255,138,107,0.35), var(--emboss-rim), var(--emboss-base);
      transition: var(--press), opacity .2s;
    }
    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 7px 16px rgba(255,138,107,0.45), inset 0 1px 0 rgba(255,255,255,0.55), var(--emboss-base);
    }
    .btn-primary:active:not(:disabled) {
      transform: none;
      box-shadow: 0 2px 6px rgba(255,138,107,0.30), var(--emboss-rim-soft), var(--emboss-base-soft);
    }
    .btn-primary:disabled { opacity: .75; cursor: default; }

    /* Ghost: no lift — quieter than everything raised. */
    .btn-ghost {
      width: 100%; border: none; background: none; padding: 3px;
      color: var(--muted); font-weight: 600; font-size: 12px;
      transition: color .2s;
    }
    .btn-ghost:hover { color: var(--text); }

    /* Soft: lifted but quiet — the two "who moves" actions sit side by side. */
    .pair { display: flex; gap: 6px; }
    .btn-soft {
      flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 999px;
      padding: 7px 8px;
      font-weight: 700; font-size: 11.5px; color: var(--text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%);
      box-shadow: var(--lift-small), var(--emboss-rim-soft), var(--emboss-base-soft);
      transition: var(--press), border-color .2s;
    }
    .btn-soft:hover:not(:disabled) { transform: translateY(-1px); border-color: rgba(255,255,255,0.18); box-shadow: var(--lift-small-hi), var(--emboss-rim-soft), var(--emboss-base-soft); }
    .btn-soft:active:not(:disabled) { transform: none; box-shadow: var(--recess); }
    .btn-soft:disabled { opacity: .75; cursor: default; }
    /* Context-aware primary (renderPrimary): only one control is raised at a
       time. The ready button drops to the soft look when it isn't the move;
       "Go to" takes the primary look while you're out of sync. */
    .btn-primary.is-quiet:not(.is-waiting) {
      color: var(--text);
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%);
      box-shadow: var(--lift-small), var(--emboss-rim-soft), var(--emboss-base-soft);
    }
    .btn-primary.is-quiet:not(.is-waiting):hover:not(:disabled) {
      border-color: rgba(255,255,255,0.18);
      box-shadow: var(--lift-small-hi), var(--emboss-rim-soft), var(--emboss-base-soft);
    }
    .btn-soft.is-primary {
      color: #14111c; border-color: transparent;
      background: linear-gradient(180deg, var(--peach) 0%, var(--coral) 50%, var(--rose) 100%);
      box-shadow: 0 4px 12px rgba(255,138,107,0.35), var(--emboss-rim), var(--emboss-base);
    }
    .btn-soft.is-primary:hover:not(:disabled) {
      border-color: transparent;
      box-shadow: 0 7px 16px rgba(255,138,107,0.45), inset 0 1px 0 rgba(255,255,255,0.55), var(--emboss-base);
    }
    /* One-tap fix in the bar: a small Lifted pill in the primary recipe. */
    .fix-key {
      flex-shrink: 0; border: none; border-radius: 999px;
      padding: 4px 9px;
      font-weight: 700; font-size: 11px; color: #14111c; white-space: nowrap;
      background: linear-gradient(180deg, var(--peach) 0%, var(--coral) 50%, var(--rose) 100%);
      box-shadow: 0 3px 8px rgba(255,138,107,0.35), var(--emboss-rim), var(--emboss-base-soft);
      transition: var(--press);
    }
    .fix-key[hidden] { display: none; }
    .fix-key:hover { transform: translateY(-1px); box-shadow: 0 5px 12px rgba(255,138,107,0.45), var(--emboss-rim), var(--emboss-base-soft); }
    .fix-key:active { transform: none; box-shadow: 0 1px 4px rgba(255,138,107,0.30), var(--emboss-rim-soft); }
    .fix-key:disabled { opacity: .75; cursor: default; }
    /* Make room for it: the wordmark steps aside while the fix is showing. */
    .badge.has-fix .brand, .badge.has-fix .sep { display: none; }
    .btn-primary.is-waiting {
      color: var(--text);
      background: rgba(0,0,0,0.28);
      box-shadow: var(--recess);
    }

    /* Chat history: recessed well, newest at the bottom. */
    .log {
      display: flex; flex-direction: column; gap: 3px;
      max-height: 104px; overflow-y: auto; overscroll-behavior: contain;
      padding: 6px 8px; border-radius: 10px;
      background: rgba(0,0,0,0.22); box-shadow: var(--recess);
      font-size: 11.5px; font-weight: 500; line-height: 1.35;
      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent;
    }
    .log[hidden] { display: none; }
    .log-row { overflow-wrap: anywhere; }
    .log-who { font-weight: 800; color: var(--peach); margin-right: 5px; }
    .log-row.mine .log-who { color: #c4b5fd; }

    /* Ask card (ready check / follow): Lifted, above the badge. */
    .ask {
      position: relative; overflow: hidden;
      width: 264px; padding: 10px 12px 12px;
      pointer-events: auto;
      background: var(--surface);
      border: 1px solid var(--border); border-radius: 14px;
      box-shadow: 0 10px 26px rgba(0,0,0,0.45), var(--emboss-rim-soft), var(--emboss-base);
      opacity: 0; transform: translateY(6px) scale(0.97);
      transition: opacity .2s var(--ease-out), transform .2s var(--ease-out);
    }
    .ask.is-visible { opacity: 1; transform: none; }
    .ask-text { font-size: 12.5px; font-weight: 600; line-height: 1.35; margin-bottom: 9px; }
    .ask-row { display: flex; gap: 6px; }
    .ask-row .btn-primary { flex: 1; width: auto; }
    .ask-progress {
      position: absolute; left: 0; bottom: 0; height: 2px; width: 100%;
      background: var(--peach); transform-origin: left;
      animation: duet-drain linear forwards;
    }
    @keyframes duet-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }

    /* 3-2-1: one big numeral at a time, centered over the video. */
    .countdown {
      position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: 168px; height: 168px; border-radius: 50%;
      display: grid; place-items: center;
      /* A dark disc so the numeral reads over any frame, bright or dark
         (no backdrop blur: it would re-render every video frame). */
      background: radial-gradient(circle, rgba(12,10,20,0.72) 0%, rgba(12,10,20,0.55) 62%, rgba(12,10,20,0) 72%);
      pointer-events: none;
      transition: opacity .25s var(--ease-out);
    }
    .countdown.is-done { opacity: 0; }
    .count-num {
      display: block;
      font-size: 120px; font-weight: 800; line-height: 1; color: #fff;
      text-shadow: 0 6px 30px rgba(0,0,0,0.6), 0 0 40px rgba(255,138,107,0.45);
      animation: duet-count .5s var(--ease-out) both;
    }
    @keyframes duet-count { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: none; } }

    /* Recessed tray, embossed keys (DESIGN.md "grid-of-buttons"). */
    .tray {
      display: flex; gap: 3px; padding: 3px;
      border-radius: 10px;
      background: rgba(0,0,0,0.28);
      box-shadow: var(--recess);
    }
    .key {
      flex: 1; height: 30px; padding: 0;
      display: grid; place-items: center;
      border: 1px solid transparent; border-radius: 8px;
      background: transparent;
      font-size: 16px; line-height: 1;
      transition: var(--press), background .2s;
    }
    .key:hover {
      background: linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%);
      border-color: var(--border);
      box-shadow: var(--lift-small), var(--emboss-rim-soft), var(--emboss-base-soft);
      transform: translateY(-1px) scale(1.06);
    }
    .key:active { transform: none; background: rgba(0,0,0,0.25); box-shadow: var(--recess); }
    .key.more { flex: 0 0 32px; color: var(--muted); font-size: 15px; font-weight: 700; }
    .key.more[aria-expanded="true"] { color: var(--text); background: rgba(0,0,0,0.25); box-shadow: var(--recess); }

    /* Recessed input. */
    .chat { position: relative; }
    .chat input {
      display: block; width: 100%;
      padding: 8px 28px 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: rgba(0,0,0,0.30);
      box-shadow: var(--recess);
      color: var(--text); font-size: 12px; font-weight: 500;
      outline: none;
      transition: border-color .2s;
    }
    .chat input::placeholder { color: rgba(244,241,234,0.42); }
    .chat input:focus { border-color: rgba(244,114,182,0.55); }
    .chat input.sent { border-color: rgba(94,226,160,0.7); }
    .chat .hint {
      position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
      font-size: 12px; color: rgba(244,241,234,0.4); pointer-events: none;
    }

    /* Emoji drawer: Lifted card popping above the badge. */
    .drawer {
      display: flex; flex-direction: column; gap: 8px;
      position: absolute; bottom: calc(100% + 8px); right: 0;
      width: 300px; padding: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 14px 30px rgba(0,0,0,0.50), var(--emboss-rim-soft), var(--emboss-base);
      /* Grows out of the "+" key that opened it (bottom-right, just below)
         rather than appearing from nowhere. Closed: invisible, inert, and
         out of the tab order; the visibility delay lets the exit finish. */
      transform-origin: calc(100% - 28px) 100%;
      opacity: 0; transform: scale(0.96);
      visibility: hidden; pointer-events: none;
      transition: opacity .14s var(--ease-out), transform .14s var(--ease-out), visibility 0s .14s;
    }
    .drawer.is-open {
      opacity: 1; transform: none;
      visibility: visible; pointer-events: auto;
      transition: opacity .18s var(--ease-out), transform .18s var(--ease-out), visibility 0s;
      @starting-style {
        opacity: 0;
        transform: scale(0.96);
      }
    }
    .tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab {
      flex-shrink: 0; white-space: nowrap;
      padding: 4px 8px; border-radius: 999px;
      border: 1px solid transparent; background: transparent;
      color: var(--muted); font-size: 12px; font-weight: 600;
      transition: color .2s, background .2s, box-shadow .25s;
    }
    .tab:hover { color: var(--text); }
    .tab[aria-selected="true"] {
      color: var(--text);
      background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.05));
      border-color: var(--border);
      box-shadow: var(--lift-small), var(--emboss-rim-soft);
    }
    .grid {
      display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px;
      max-height: 148px; overflow-y: auto;
      scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
      scrollbar-width: thin;
      mask-image: linear-gradient(to bottom, black calc(100% - 20px), transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 20px), transparent 100%);
    }
    .grid .key { height: 34px; font-size: 18px; }
    .grid .empty { grid-column: 1 / -1; text-align: center; color: var(--muted); font-size: 12px; padding: 12px 0; }

    /* Minimized puck: refined circular floating token with health halo */
    .puck {
      --cast: var(--lift-small);
      display: none;
      width: 40px; height: 40px;
      padding: 0;
      position: relative;
      align-items: center; justify-content: center;
      place-items: center;
      pointer-events: auto;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 50%;
      cursor: pointer; touch-action: none; user-select: none;
      box-shadow: var(--cast), var(--emboss-rim-soft), var(--emboss-base-soft);
      transition: transform 0.2s var(--ease-out), box-shadow 0.25s ease, border-color 0.2s ease;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .puck.is-visible { display: flex; }
    .puck:hover {
      transform: scale(1.08) translateY(-1px);
      border-color: rgba(255,255,255,0.28);
      box-shadow: var(--cast), 0 0 0 1px rgba(255,255,255,0.18), var(--emboss-rim);
    }
    .puck:active {
      transform: scale(0.95);
    }
    .puck[data-health="good"] { --cast: 0 4px 18px rgba(94,226,160,0.35); }
    .puck[data-health="warn"] { --cast: 0 4px 18px rgba(252,211,77,0.38); }
    .puck[data-health="bad"]  { --cast: 0 4px 18px rgba(255,107,122,0.42); }
    .puck .av {
      width: 28px; height: 28px;
      font-size: 15px;
      border-radius: 50%;
      box-shadow: 0 0 0 2px var(--ring);
    }
    .puck .dot {
      display: block !important;
      position: absolute;
      bottom: 2px; right: 2px;
      width: 9px; height: 9px;
      border: 2px solid rgba(18, 16, 26, 0.98);
      border-radius: 50%;
      z-index: 2;
    }

    /* Flash: Lifted card, accent-echo by action. */
    .flash {
      --accent: var(--success);
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      font-size: 13px;
      pointer-events: none;
      box-shadow: 0 12px 30px rgba(0,0,0,0.50), 0 4px 18px color-mix(in srgb, var(--accent) 22%, transparent),
                  var(--emboss-rim-soft), var(--emboss-base);
      opacity: 0; transform: translateY(10px) scale(0.96);
      transition: opacity .4s ease, transform .4s ease;   /* exit: unhurried */
    }
    /* Entrance is quick: the duet mark starts animating the moment the flash
       is shown, and a .4s fade hid its first third. */
    .flash.is-visible {
      opacity: 1; transform: none;
      transition: opacity .15s var(--ease-out), transform .25s var(--ease-out);
    }
    .flash[data-action="pause"] { --accent: var(--peach); }
    .flash-icon {
      width: 24px; height: 24px; flex-shrink: 0;
      display: grid; place-items: center; overflow: hidden;
      border-radius: 50%;
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
    }

    /* The duet mark — the logo's two halves clicking together. Plays when
       the partner plays/pauses: pause = two bars slide in from either side,
       play = the triangle's top and bottom halves meet; then a small
       "click" and a ring pulse. */
    .flash-icon.mark {
      position: relative; overflow: visible;
      width: 28px; height: 28px;
      background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.08), rgba(0,0,0,0.35));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10), 0 0 14px rgba(244,114,182,0.25);
    }
    .mark svg { width: 18px; height: 18px; overflow: visible; animation: duet-click .46s ease .3s both; }
    .mark .half { transform-box: fill-box; animation: .42s var(--ease-overshoot) both; }
    .mark[data-shape="pause"] .a { animation-name: duet-from-left; }
    .mark[data-shape="pause"] .b { animation-name: duet-from-right; }
    .mark[data-shape="play"]  .a { animation-name: duet-from-top; }
    .mark[data-shape="play"]  .b { animation-name: duet-from-bottom; }
    .mark::after {
      content: ""; position: absolute; inset: -1px; border-radius: 50%;
      box-shadow: 0 0 0 2px var(--rose);
      opacity: 0; pointer-events: none;
      animation: duet-ring-out .65s ease-out .32s both;
    }
    @keyframes duet-from-left   { from { transform: translateX(-7px); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes duet-from-right  { from { transform: translateX(7px);  opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes duet-from-top    { from { transform: translateY(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes duet-from-bottom { from { transform: translateY(6px);  opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes duet-click { 0%, 100% { transform: scale(1); } 40% { transform: scale(1.18); } }
    /* Hidden until the halves meet (the delay holds the 0% frame). */
    @keyframes duet-ring-out { 0% { opacity: 0; transform: scale(.85); } 8% { opacity: .9; } 100% { opacity: 0; transform: scale(1.7); } }

    /* Toasts: Lifted pills centered at the top. */
    .toast {
      --accent: var(--success);
      position: fixed; left: 50%; top: 60px;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 12.5px; font-weight: 700; white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 12px 28px rgba(0,0,0,0.50), 0 4px 16px color-mix(in srgb, var(--accent) 22%, transparent),
                  var(--emboss-rim-soft), var(--emboss-base-soft);
      opacity: 0; transform: translateX(-50%) translateY(-12px);
      transition: opacity .3s ease, transform .3s ease;
    }
    .toast.is-visible { opacity: 1; transform: translateX(-50%); }
    .toast[data-kind="leave"] { --accent: var(--danger); }
    .toast[data-kind="system"] { --accent: var(--peach); top: 22px; font-weight: 600; }
    .toast .toast-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent); box-shadow: 0 0 8px var(--accent);
    }
    .toast .toast-av { display: inline-flex; width: 18px; height: 18px; border-radius: 50%; overflow: hidden; }

    /* Floating emoji + subtitle-style chat (content, not chrome). */
    .float-emoji {
      position: fixed; bottom: 80px; font-size: 48px; pointer-events: none;
      filter: drop-shadow(0 4px 14px rgba(0,0,0,0.45));
      opacity: 0;
      animation: duet-float 2.6s var(--ease-out) forwards;
    }
    .bubble {
      position: fixed; max-width: 70vw; pointer-events: none;
      will-change: transform;
    }
    /* Anchored at left:0 and moved purely by transform, so a message enters
       the instant it's sent (right edge for partner, left edge for you) and
       travels exactly far enough to leave — translateX(%) is the bubble's
       own width. (Positioning it a full viewport off-screen, as before, hid
       every message for its first ~3s.) */
    .bubble { left: 0; }
    .bubble.ltr { animation-name: duet-slide-ltr; }
    .bubble.rtl { animation-name: duet-slide-rtl; }
    .bubble { animation-timing-function: linear; animation-fill-mode: forwards; }
    .bubble-inner {
      display: inline-flex; align-items: baseline; gap: 0.6em;
      padding: 4px 12px;
      background: rgba(0,0,0,0.42);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      border-radius: 6px;
      pointer-events: auto;
    }
    .bubble.rtl .bubble-inner { font-style: italic; }
    .bubble-who {
      display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
      font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; font-style: normal;
      font-size: max(12px, 0.62em);
      color: var(--who); text-shadow: 0 0 8px color-mix(in srgb, var(--who) 40%, transparent);
    }
    .bubble.ltr { --who: #c4b5fd; }
    .bubble.rtl { --who: var(--peach); }
    .bubble-text {
      font-weight: 800; letter-spacing: 0.005em; white-space: nowrap;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.9), -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
    }
    .bubble:hover { animation-play-state: paused; }

    @keyframes duet-float {
      0%   { opacity: 0; transform: translateY(20px)  scale(0.6) rotate(-8deg); }
      15%  { opacity: 1; transform: translateY(0)     scale(1.1) rotate(2deg); }
      30%  {             transform: translateY(-30px) scale(1)   rotate(-2deg); }
      100% { opacity: 0; transform: translateY(-220px) scale(0.9) rotate(6deg); }
    }
    @keyframes duet-slide-rtl { from { transform: translateX(100vw); } to { transform: translateX(-100%); } }
    @keyframes duet-slide-ltr { from { transform: translateX(-100%); } to { transform: translateX(100vw); } }

    @media (prefers-reduced-motion: reduce) {
      @keyframes duet-float {
        0% { opacity: 0; transform: none; } 15% { opacity: 1; transform: none; }
        85% { opacity: 1; transform: none; } 100% { opacity: 0; transform: none; }
      }
      /* No travel: fade in and out, centred in the lane. */
      .bubble { left: 50%; }
      @keyframes duet-slide-rtl {
        0% { opacity: 0; transform: translateX(-50%); } 8% { opacity: 1; transform: translateX(-50%); }
        92% { opacity: 1; transform: translateX(-50%); } 100% { opacity: 0; transform: translateX(-50%); }
      }
      @keyframes duet-slide-ltr {
        0% { opacity: 0; transform: translateX(-50%); } 8% { opacity: 1; transform: translateX(-50%); }
        92% { opacity: 1; transform: translateX(-50%); } 100% { opacity: 0; transform: translateX(-50%); }
      }
      .badge, .flash, .toast, .puck, .key, .btn-primary, .btn-soft, .icon-key, .drawer, .ask {
        transition-duration: 0.05s !important;
      }
      .ask { transform: none; }
      @keyframes duet-count { from { opacity: 0; } to { opacity: 1; } }
      .drawer { transform: none; }
      .av.typing { animation: none; }
      .mark svg, .mark .half, .mark::after { animation: none !important; }
    }
  `;

  let uiHost = null;
  let uiRoot = null;
  let uiLayer = null;
  // Allo, the UI typeface (vendor/fonts). Chrome ignores @font-face inside a
  // shadow root, so register it on the document instead — from the bytes,
  // not a URL, so a page's font-src CSP can't block it. The family name is
  // Duet-specific so it can't collide with anything the page declares.
  // Failing is fine: the badge falls back to the system UI font.
  let badgeFontRequested = false;
  function loadBadgeFont() {
    if (badgeFontRequested) return;
    badgeFontRequested = true;
    const url = assetUrl("vendor/fonts/AlloVariableFriendly.woff2");
    if (!url || typeof FontFace !== "function" || !document.fonts) return;
    fetch(url)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(buf => new FontFace("Duet Allo", buf, { weight: "100 900", style: "normal" }).load())
      .then(face => document.fonts.add(face))
      .catch(() => {});
  }

  function ensureUiRoot() {
    if (uiLayer) return uiLayer;
    loadBadgeFont();
    uiHost = document.createElement("duet-ui");
    // Inline !important so page CSS (even `* { … }` resets) can't hide or
    // shift the host. Zero-size + fixed: children position against the viewport.
    uiHost.setAttribute("style", [
      "all: initial !important", "display: block !important", "position: fixed !important",
      "top: 0 !important", "left: 0 !important", "width: 0 !important", "height: 0 !important",
      "z-index: 2147483647 !important", "pointer-events: none !important"
    ].join("; "));
    uiRoot = uiHost.attachShadow({ mode: "closed" });
    // Constructable stylesheets aren't subject to the page's style-src CSP;
    // fall back to a <style> element where adopting fails (e.g. Firefox
    // content-script wrappers).
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(DUET_UI_CSS);
      uiRoot.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = DUET_UI_CSS;
      uiRoot.appendChild(style);
    }
    uiLayer = document.createElement("div");
    uiLayer.className = "layer";
    uiRoot.appendChild(uiLayer);
    (document.documentElement || document.body).appendChild(uiHost);
    // If the page is already fullscreen when we mount, move in right away.
    setTimeout(reparentOverlayForFullscreen, 0);
    return uiLayer;
  }
  const $ui = (id) => (uiRoot ? uiRoot.getElementById(id) : null);

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    return node;
  }

  // ── Visual Feedback (overlay + flash) ──────────────────────
  // The overlay (badge + flash) renders only in the frame that currently
  // OWNS the badge — top frame by default, fullscreen iframe when one is.
  function ensureOverlay() {
    if (!frameOwnsBadge) return null;
    let overlay = $ui("__duet_overlay");
    if (overlay) return overlay;
    overlay = el("div", "overlay", { id: "__duet_overlay" });
    ensureUiRoot().appendChild(overlay);
    restoreBadgePosition();
    return overlay;
  }

  // ── Fullscreen visibility ──────────────────────────────────
  // When any element on the page enters fullscreen, only that element's
  // subtree is rendered — our host (which lives at <html> root) goes
  // invisible. Re-parent it into the fullscreen element so the user can
  // still drag the badge, chat, react, and see partner messages without
  // leaving fullscreen. On exit, move it back to the document root.
  function reparentOverlayForFullscreen() {
    if (!uiHost) return;
    const fsEl = document.fullscreenElement
              || document.webkitFullscreenElement
              || document.msFullscreenElement
              || null;
    const wantedParent = fsEl || document.documentElement || document.body;
    if (uiHost.parentNode !== wantedParent) {
      try { wantedParent.appendChild(uiHost); } catch {}
    }
  }
  document.addEventListener("fullscreenchange",       reparentOverlayForFullscreen);
  document.addEventListener("webkitfullscreenchange", reparentOverlayForFullscreen);
  document.addEventListener("msfullscreenchange",     reparentOverlayForFullscreen);
  // Also poll briefly after init so we catch sites that fullscreen *before*
  // our overlay is created (e.g., user reloads in fullscreen mode).
  setTimeout(reparentOverlayForFullscreen, 1000);

  // ── Draggable badge ────────────────────────────────────────
  // Anchors the overlay to top/left at (x, y), clamped inside the viewport
  // with an 8px gutter. Switches `align-items` so children flow downward
  // instead of upward (the default bottom-right anchor stacked flashes
  // above the badge; once dragged we want them stacking below it).
  function applyOverlayPosition(x, y) {
    const overlay = $ui("__duet_overlay");
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    const w = rect.width  || 200;
    const h = rect.height || 60;
    const maxX = Math.max(8, window.innerWidth  - w - 8);
    const maxY = Math.max(8, window.innerHeight - h - 8);
    const cx = Math.max(8, Math.min(maxX, x));
    const cy = Math.max(8, Math.min(maxY, y));
    overlay.style.right  = "auto";
    overlay.style.bottom = "auto";
    overlay.style.left   = cx + "px";
    overlay.style.top    = cy + "px";
    overlay.style.alignItems = "flex-start";
    overlay.classList.add("is-placed");
  }
  function restoreBadgePosition() {
    try {
      chrome.storage.local.get(["__duet_badge_pos", "__duet_minimized"], (data) => {
        const p = data && data.__duet_badge_pos;
        if (p && typeof p.x === "number" && typeof p.y === "number") {
          // Defer one frame so the overlay has measurable size before clamping.
          requestAnimationFrame(() => applyOverlayPosition(p.x, p.y));
        }
        if (data && data.__duet_minimized === true) {
          isMinimized = true;
          applyMinimizedDom();
        }
      });
    } catch {}
  }

  // ── Minimized state ────────────────────────────────────────
  // The badge can collapse into a small "puck" that takes less screen space.
  // State is persisted so it survives reloads.
  let isMinimized = false;
  // Per page, not saved: reloading the tab or opening the popup's
  // "Show controls on this tab" brings the badge back.
  let isDismissed = false;
  function setDismissed(value) {
    value = !!value;
    if (isDismissed === value) return;
    isDismissed = value;
    if (value) {
      $ui("__duet_badge")?.classList.remove("is-visible", "is-open");
      $ui("__pp_emoji_drawer")?.classList.remove("is-open");
      $ui("__pp_tray")?.classList.remove("is-visible");
      showToast("__pp_hidden_toast", "system", [el("span", "", { text: "Duet hidden here — you're still in sync. Open Duet from the toolbar to bring it back." })], 4200);
    } else {
      render();
    }
  }

  function setMinimized(value) {
    if (isMinimized === value) return;
    isMinimized = !!value;
    try { chrome.storage.local.set({ __duet_minimized: isMinimized }); } catch {}
    applyMinimizedDom();
  }
  function applyMinimizedDom() {
    const badge = $ui("__duet_badge");
    const puck  = $ui("__pp_tray");
    if (!badge || !puck) return;
    badge.style.display = isMinimized ? "none" : "";
    puck.classList.toggle("is-visible", isMinimized && S.connected && !isDismissed);
  }
  // Re-clamp on viewport resize so the badge doesn't end up off-screen when
  // the window shrinks or rotates.
  window.addEventListener("resize", () => {
    const overlay = $ui("__duet_overlay");
    if (!overlay || overlay.style.left === "" || overlay.style.left === "auto") return;
    const x = parseFloat(overlay.style.left) || 0;
    const y = parseFloat(overlay.style.top)  || 0;
    applyOverlayPosition(x, y);
  });

  // Drag to move; a tap/click still acts as a tap/click. Movement under the
  // threshold is a shaky click, not a drag. Fingers wobble more than mice.
  const DRAG_THRESHOLD = { mouse: 8, pen: 8, touch: 12 };
  // A mouse fires `click` right after the pointerup that ends a drag; that
  // click must not also expand the puck or press a key in the bar. A finger
  // fires none after it moved, so the guard must never outlive the gesture:
  // it covers only the click that follows within this window, and the next
  // pointerdown always clears it. (A one-shot "swallow the next click"
  // listener used to stay armed after touch drags and eat the next real tap.)
  const DRAG_CLICK_WINDOW_MS = 350;

  function installBadgeDrag(handle) {
    let drag = null;
    let swallowClickUntil = 0;

    handle.addEventListener("click", (e) => {
      if (Date.now() > swallowClickUntil) return;
      swallowClickUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    }, true);

    handle.addEventListener("pointerdown", (e) => {
      swallowClickUntil = 0; // a new gesture: whatever it produces is real
      if (e.button !== 0) return;
      // Don't start drag from an interactive control inside the topbar.
      if (e.target instanceof Element && e.target.closest("button, input, a")) return;
      const overlay = $ui("__duet_overlay");
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      drag = {
        startX: e.clientX, startY: e.clientY,
        origX:  rect.left, origY:  rect.top,
        moved: false, pointerId: e.pointerId,
        threshold: DRAG_THRESHOLD[e.pointerType] ?? DRAG_THRESHOLD.mouse
      };
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });

    handle.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < drag.threshold) return;
      drag.moved = true;
      handle.style.cursor = "grabbing";
      applyOverlayPosition(drag.origX + dx, drag.origY + dy);
      e.preventDefault();
    });

    const finish = (e) => {
      if (!drag || (e && e.pointerId !== drag.pointerId)) return;
      try { handle.releasePointerCapture(drag.pointerId); } catch {}
      handle.style.cursor = "";
      if (drag.moved) {
        const overlay = $ui("__duet_overlay");
        if (overlay) {
          const rect = overlay.getBoundingClientRect();
          try { chrome.storage.local.set({ __duet_badge_pos: { x: rect.left, y: rect.top } }); } catch {}
        }
        // Only a completed drag can be followed by a click; a cancelled
        // gesture never is.
        if (e?.type === "pointerup") swallowClickUntil = Date.now() + DRAG_CLICK_WINDOW_MS;
      }
      drag = null;
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    // Capture can be lost without a pointerup (the element re-rendered, the
    // window lost focus). Without this the badge would keep following the
    // mouse with no button held.
    handle.addEventListener("lostpointercapture", finish);
  }

  // ── Badge ──────────────────────────────────────────────────
  // Built once; render() only updates text, attributes and classes.
  const QUICK_REACTIONS = ["😂", "💖", "🔥", "😭"];
  const EMOJI_PACKS = {
    "Faces":  ["😂","😭","😍","😮","😎","🤩","🥳","🤔","🙄","🥺","😴","😡","🤯","🤡","💀","😅","🤣","😢","😱","🫠"],
    "Love":   ["❤️","💖","💕","💞","💘","💝","💓","💗","💜","🧡","💛","💚","💙","🤍","🖤","💔","✨","💯","🔥","🌹"],
    "Hands":  ["👍","👎","👊","👋","👏","🙌","✌️","🤝","🙏","💪","🤘","🤟","🖖","🖐️","👌","🤙","✊","🫶","🫰","☝️"],
    "Vibes":  ["🎬","🍿","🍕","🍺","🥂","🚀","🌈","☀️","🌙","🎉","🎈","💎","👾","🍔","🍦","🎸","🎮","🎵","🍷","🥶"]
  };

  // Send a reaction, show it locally, and record it in the shared recents.
  function sendEmoji(emoji) {
    safeSend({ type: "SEND_REACTION", emoji });
    spawnReaction(emoji, { fromSelf: true });
    recordRecentEmoji(emoji);
  }

  function buildBadge(overlay) {
    const badge = el("div", "badge", { id: "__duet_badge", role: "region", "aria-label": "Duet" });

    // Top bar: drag handle + live status.
    const topbar = el("div", "topbar", { id: "__pp_topbar" });
    topbar.append(
      el("span", "dot"),
      el("span", "brand", { text: "Duet" }),
      el("span", "sep", { text: "·" }),
      el("span", "av plain", { id: "__pp_avatar" }),
      el("span", "status-text", { id: "__pp_status_text" }),
      // Screen readers hear state changes, not every drift tick.
      el("span", "sr-only", { id: "__pp_status_sr", "aria-live": "polite" }),
      el("span", "ping", { id: "__pp_ping" })
    );
    const minBtn = el("button", "icon-key", { id: "__pp_min_btn", type: "button", title: "Minimize", "aria-label": "Minimize Duet", text: "−" });
    minBtn.addEventListener("click", (e) => { e.stopPropagation(); setMinimized(true); });
    minBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    // ✕ hides Duet's controls on this page only; you stay in the room and
    // sync, reactions and messages keep working. The popup brings it back.
    const closeBtn = el("button", "icon-key close", { id: "__pp_close_btn", type: "button", title: "Hide on this page (you stay in the room)", "aria-label": "Hide Duet on this page", text: "×" });
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); setDismissed(true); });
    closeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    // One-tap fix, right in the bar, while out of sync or on another video,
    // so "11s behind" never needs the controls opened to act on.
    const fixBtn = el("button", "fix-key", { id: "__pp_fix_btn", type: "button", text: "Catch up", hidden: "" });
    fixBtn.addEventListener("click", (e) => { e.stopPropagation(); onCatchUpClick(); });
    fixBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    topbar.append(fixBtn, minBtn, closeBtn);
    installBadgeDrag(topbar);

    // Controls (shown on hover / while typing).
    const controls = el("div", "controls", { id: "__pp_controls" });

    const syncBtn = el("button", "btn-soft", { id: "__pp_sync_btn", type: "button", text: goToLabel(), title: "Jump your video to where your partner is" });
    syncBtn.addEventListener("click", onCatchUpClick);
    const bringBtn = el("button", "btn-soft", { id: "__pp_bring_btn", type: "button", text: bringLabel(), title: "Move your partner's video to where you are" });
    bringBtn.addEventListener("click", onBringClick);
    const pair = el("div", "pair", { role: "group", "aria-label": "Get back in sync" });
    pair.append(syncBtn, bringBtn);

    const readyBtn = el("button", "btn-primary", { id: "__pp_ready_btn", type: "button", text: "Both ready? Count us in" });
    readyBtn.addEventListener("click", onReadyClick);

    const tray = el("div", "tray", { role: "group", "aria-label": "Reactions" });
    for (const emoji of QUICK_REACTIONS) {
      const key = el("button", "key", { type: "button", "aria-label": `Send ${emoji} reaction` });
      key.innerHTML = twemojiHtml(emoji);
      key.addEventListener("click", () => sendEmoji(emoji));
      tray.appendChild(key);
    }
    const moreBtn = el("button", "key more", { id: "__pp_more_emojis", type: "button", title: "More emojis", "aria-label": "Open emoji picker", "aria-expanded": "false", text: "+" });
    tray.appendChild(moreBtn);

    const chat = el("div", "chat");
    const chatInput = el("input", "", {
      id: "__pp_chat_input", type: "text", maxlength: "140", autocomplete: "off", spellcheck: "false",
      placeholder: "Send a message…", "aria-label": "Message your partner"
    });
    chat.append(chatInput, el("span", "hint", { text: "↵" }));

    const log = el("div", "log", { id: "__pp_chat_log", role: "log", "aria-label": "Messages", hidden: "" });

    controls.append(readyBtn, pair, tray, log, chat);

    // Emoji drawer.
    const drawer = el("div", "drawer", { id: "__pp_emoji_drawer" });
    const tabs = el("div", "tabs", { role: "tablist" });
    const grid = el("div", "tray grid", { role: "tabpanel" });
    drawer.append(tabs, grid);
    wireEmojiDrawer(drawer, tabs, grid, moreBtn);

    badge.append(drawer, topbar, controls);
    overlay.appendChild(badge);

    // Hover opens the controls; typing keeps them open.
    badge.addEventListener("mouseenter", () => { if (S.connected) badge.classList.add("is-open"); });
    badge.addEventListener("mouseleave", () => {
      if (badge.dataset.locked === "1" || drawer.classList.contains("is-open")) return;
      badge.classList.remove("is-open");
    });
    wireChatInput(badge, chatInput);

    // Minimized puck: click to expand, drag to move.
    const puck = el("div", "puck", { id: "__pp_tray", title: "Click to expand · drag to move", role: "button", tabindex: "0", "aria-label": "Expand Duet" });
    puck.append(el("span", "dot"), el("span", "av plain", { id: "__pp_tray_av" }));
    installBadgeDrag(puck);
    puck.addEventListener("click", (e) => {
      if (e.defaultPrevented) return; // drag finish swallowed it
      setMinimized(false);
    });
    puck.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMinimized(false); }
    });
    overlay.appendChild(puck);

    return badge;
  }

  async function onCatchUpClick() {
    const syncBtn = $ui("__pp_sync_btn");
    if (!syncBtn || syncBtn.disabled) return;
    // Save current position for undo before syncing
    if (!video) ensureVideo();
    if (video) {
      preSyncPosition = video.currentTime;
      preSyncTimestamp = Date.now();
    }
    syncBtn.disabled = true;
    const who = S.partnerName || "partner";
    syncBtn.textContent = `Going to ${who}…`;
    showFlash("play", `Going to ${who}…`);
    const res = await safeSend({ type: "CATCH_UP_TO_PARTNER" });
    // Only claim success when the background actually verified that local
    // playback matches partner's projected position. Drift > 1s gets a
    // distinct "Off by Xs" message instead of a misleading checkmark.
    if (res?.navigating) {
      // On another video: the background is opening theirs and will catch
      // up once it loads, so this page is about to go away.
      showFlash("play", `Opening ${who}'s video…`);
      syncBtn.textContent = `Opening ${who}'s video…`;
    } else if (res?.error) {
      showFlash("pause", res.error);
      syncBtn.textContent = "Try again";
    } else if (res?.ok) {
      syncBtn.textContent = "Caught up ✓";
      showUndoButton();
    } else if (typeof res?.drift === "number") {
      syncBtn.textContent = `Off by ${res.drift.toFixed(1)}s`;
      showFlash("pause", `Couldn't fully sync — off by ${res.drift.toFixed(1)}s.`);
    } else {
      syncBtn.textContent = goToLabel();
    }
    setTimeout(() => {
      syncBtn.disabled = false;
      syncBtn.textContent = goToLabel();
    }, 2200);
  }

  async function onBringClick() {
    const btn = $ui("__pp_bring_btn");
    if (!btn || btn.disabled) return;
    const who = S.partnerName || "partner";
    btn.disabled = true;
    btn.textContent = `Bringing ${who}…`;
    const res = await safeSend({ type: "SYNC_TO_ME" });
    if (res?.ok) btn.textContent = `${who} is with you ✓`;
    else if (res?.error) { btn.textContent = "Try again"; showFlash("pause", res.error); }
    else btn.textContent = bringLabel();
    setTimeout(() => { btn.disabled = false; btn.textContent = bringLabel(); }, 2200);
  }

  // ── Ready check + countdown ────────────────────────────────
  let readyState = { phase: "none" };
  async function onReadyClick() {
    const btn = $ui("__pp_ready_btn");
    if (!btn || btn.disabled) return;
    const r = readyState;
    let res;
    if (r.phase === "asking" && r.byMe) res = await safeSend({ type: "READY_ANSWER", ready: false });
    else if (r.phase === "asking" && !r.meReady) res = await safeSend({ type: "READY_ANSWER", ready: true });
    else if (r.phase === "none") res = await safeSend({ type: "READY_START" });
    if (res?.error) showFlash("pause", res.error);
  }

  // Which control gets the one raised look (DESIGN.md: one primary action):
  //   a ready check in progress          → the ready button
  //   out of sync / on another video     → "Go to <partner>"
  //   both paused, in step               → the ready check ("Both ready?")
  //   playing in sync, or nothing to do  → none; everything stays quiet
  function primaryAction() {
    if (readyState.phase && readyState.phase !== "none") return "ready";
    if (!S.connected || S.peerCount < 2) return "none";
    if (S.driftStatus === "out_of_sync" || S.driftStatus === "mismatch") return "go";
    if (S.driftStatus === "sync" && S.bothPaused) return "ready";
    return "none";
  }
  function renderPrimary() {
    const p = primaryAction();
    $ui("__pp_ready_btn")?.classList.toggle("is-quiet", p !== "ready");
    $ui("__pp_sync_btn")?.classList.toggle("is-primary", p === "go");
    const fix = $ui("__pp_fix_btn");
    if (fix) {
      const show = S.driftStatus === "out_of_sync" || S.driftStatus === "mismatch";
      fix.hidden = !show || !S.connected || S.peerCount < 2;
      fix.textContent = S.driftStatus === "mismatch" ? "Go there" : "Catch up";
      fix.title = S.driftStatus === "mismatch"
        ? `Open what ${S.partnerName || "your partner"} is watching`
        : `Jump to where ${S.partnerName || "your partner"} is`;
    }
  }

  function renderReady() {
    renderPrimary();
    const btn = $ui("__pp_ready_btn");
    const r = readyState;
    const who = S.partnerName || "your partner";
    if (btn) {
      btn.disabled = r.phase === "go" || (r.phase === "asking" && r.meReady && !r.byMe);
      btn.classList.toggle("is-waiting", r.phase === "asking" && r.byMe);
      btn.textContent =
        r.phase === "go" ? "Starting…" :
        r.phase === "asking" && r.byMe ? `Waiting for ${who}… · Cancel` :
        r.phase === "asking" && !r.meReady ? `${S.partnerName || "Partner"} is ready — I'm ready` :
        r.phase === "asking" ? "Starting…" :
        "Both ready? Count us in";
    }
    // The partner's ask also needs to reach you when the controls are closed.
    if (r.phase === "asking" && !r.byMe && !r.meReady) {
      showAsk("__pp_ready_ask", `${S.partnerName || "Your partner"} is ready to press play.`, [
        { label: "I'm ready", primary: true, onClick: () => safeSend({ type: "READY_ANSWER", ready: true }) },
        { label: "Not yet", onClick: () => safeSend({ type: "READY_ANSWER", ready: false }) }
      ]);
    } else {
      hideAsk("__pp_ready_ask");
    }
  }

  // Small Lifted card above the badge with up to two actions.
  function showAsk(id, text, actions, opts = {}) {
    const overlay = ensureOverlay();
    if (!overlay) return null;
    let card = $ui(id);
    if (!card) {
      card = el("div", "ask", { id, role: "alertdialog", "aria-live": "polite" });
      overlay.prepend(card);
      requestAnimationFrame(() => card.classList.add("is-visible"));
    }
    const msg = el("div", "ask-text", { text });
    const row = el("div", "ask-row");
    for (const a of actions) {
      const b = el("button", a.primary ? "btn-primary" : "btn-soft", { type: "button", text: a.label });
      b.addEventListener("click", () => { hideAsk(id); a.onClick(); });
      row.appendChild(b);
    }
    card.replaceChildren(msg, row);
    if (opts.progressMs) {
      const bar = el("div", "ask-progress");
      bar.style.animationDuration = `${opts.progressMs}ms`;
      card.appendChild(bar);
    }
    return card;
  }
  function hideAsk(id) {
    const card = $ui(id);
    if (!card) return;
    card.classList.remove("is-visible");
    setTimeout(() => card.remove(), 180);
  }

  // Pause both at the agreed spot, count 3-2-1, press play at the same
  // server-clock instant. Every frame gets this: only the controlled frame
  // (`drive`) touches its video, the one owning the badge draws the countdown.
  function runReadyGo(msg) {
    const delay = Math.max(0, Math.min(10000, msg.go - msg.serverNow));
    const startAt = Date.now() + delay;
    const drive = msg.drive !== false;
    if (drive && !video) ensureVideo();
    if (drive && video && typeof msg.time === "number") {
      endApplyingRemote();
      S.isApplyingRemote = true;
      expectedRemoteEvents = new Set();
      if (!video.paused) { expectedRemoteEvents.add("pause"); try { video.pause(); } catch {} }
      if (Math.abs(video.currentTime - msg.time) > 0.05) {
        expectedRemoteEvents.add("seeked");
        try { video.currentTime = msg.time; } catch {}
      }
      applySafetyTimer = setTimeout(endApplyingRemote, Math.min(2000, delay));
      setTimeout(() => {
        applySync({ action: "play", currentTime: msg.time, force: true, quiet: true }, null);
        // The asker records the play in the room state (the partner's apply
        // is a no-op — they're already playing at the same spot).
        if (msg.leader) setTimeout(() => sendSync("play", { leader: true }), 900);
      }, delay);
    }
    if (frameOwnsBadge) showCountdown(startAt);
  }

  function showCountdown(startAt) {
    const layer = ensureUiRoot();
    $ui("__pp_countdown")?.remove();
    const node = el("div", "countdown", { id: "__pp_countdown", role: "status", "aria-live": "assertive" });
    layer.appendChild(node);
    const tick = () => {
      if (!node.isConnected) return;
      const left = startAt - Date.now();
      const n = Math.ceil(left / 1000);
      const label = left <= 0 ? "▶" : String(Math.min(3, n));
      if (node.dataset.v !== label) {
        node.dataset.v = label;
        const num = el("span", "count-num", { text: label });
        node.replaceChildren(num);
      }
      if (left <= -700) { node.classList.add("is-done"); setTimeout(() => node.remove(), 250); return; }
      setTimeout(tick, Math.max(16, Math.min(200, (left % 1000) || 200)));
    };
    tick();
  }

  // ── Follow partner to the next episode ─────────────────────
  let followTimer = null;
  function showFollowPrompt(msg) {
    clearTimeout(followTimer);
    const who = S.partnerName || "Your partner";
    const where = msg.title ? `“${msg.title}”` : "the next video";
    const go = () => { clearTimeout(followTimer); hideAsk("__pp_follow"); safeSend({ type: "FOLLOW_GO", url: msg.url }).then(res => {
      if (res?.error) showFlash("pause", res.error);
    }); };
    const card = showAsk("__pp_follow", `${who} moved on to ${where}. Following in 5s…`, [
      { label: "Go now", primary: true, onClick: go },
      { label: "Stay here", onClick: () => clearTimeout(followTimer) }
    ], { progressMs: 5000 });
    if (!card) return;
    followTimer = setTimeout(go, 5000);
  }

  // ── Chat history ───────────────────────────────────────────
  const CHAT_SHOWN = 30;
  function chatRow(item) {
    const row = el("div", `log-row${item.mine ? " mine" : ""}`);
    row.append(
      el("span", "log-who", { text: item.mine ? "You" : (S.partnerName || "Partner") }),
      el("span", "log-text", { text: item.text })
    );
    return row;
  }
  function renderChatLog(items) {
    const log = $ui("__pp_chat_log");
    if (!log) return;
    log.replaceChildren(...items.slice(-CHAT_SHOWN).map(chatRow));
    log.hidden = items.length === 0;
    log.scrollTop = log.scrollHeight;
  }
  function appendChatLog(item) {
    const log = $ui("__pp_chat_log");
    if (!log) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.appendChild(chatRow(item));
    while (log.childElementCount > CHAT_SHOWN) log.firstElementChild.remove();
    log.hidden = false;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  async function loadChatLog() {
    if (!frameOwnsBadge) return;
    const res = await safeSend({ type: "GET_CHAT" });
    if (Array.isArray(res?.items)) renderChatLog(res.items);
  }

  // Tabbed categories + grid + Recent (shared with the popup picker via the
  // same chrome.storage key). Opens/closes on the "+" key.
  function wireEmojiDrawer(drawer, tabs, grid, moreBtn) {
    let activeTab = "Recent";
    let recentList = [];

    const loadRecents = () => new Promise((resolve) => {
      try {
        chrome.storage.local.get(["__duet_emoji_recents"], (data) => {
          // The key is shared with the popup, which also stores recently
          // picked avatars ("av:NN") there — those aren't reactions.
          recentList = (Array.isArray(data?.__duet_emoji_recents) ? data.__duet_emoji_recents : [])
            .filter((e) => typeof e === "string" && !isAvatarCode(e)).slice(0, 12);
          resolve();
        });
      } catch { resolve(); }
    });

    const renderTabs = () => {
      const names = [];
      if (recentList.length) names.push("Recent");
      names.push(...Object.keys(EMOJI_PACKS));
      if (!names.includes(activeTab)) activeTab = names[0];
      tabs.replaceChildren(...names.map((name) => {
        const b = el("button", "tab", { type: "button", role: "tab", "aria-selected": String(name === activeTab), text: name });
        b.addEventListener("click", () => { activeTab = name; renderTabs(); renderGrid(); });
        return b;
      }));
    };

    const renderGrid = () => {
      const list = activeTab === "Recent" ? recentList : (EMOJI_PACKS[activeTab] || []);
      if (!list.length) {
        grid.replaceChildren(el("div", "empty", { text: "Pick one to get started." }));
        return;
      }
      grid.replaceChildren(...list.map((emoji) => {
        const b = el("button", "key", { type: "button", "aria-label": `Send ${emoji}` });
        b.innerHTML = twemojiHtml(emoji);
        b.addEventListener("click", () => {
          sendEmoji(emoji);
          // Re-render Recent so the picked one moves to the front.
          if (activeTab === "Recent") setTimeout(() => { loadRecents().then(() => { renderTabs(); renderGrid(); }); }, 50);
        });
        return b;
      }));
    };

    moreBtn.addEventListener("click", async () => {
      const open = drawer.classList.contains("is-open");
      if (open) {
        drawer.classList.remove("is-open");
        moreBtn.textContent = "+";
        moreBtn.setAttribute("aria-expanded", "false");
      } else {
        await loadRecents();
        activeTab = recentList.length ? "Recent" : "Faces";
        renderTabs();
        renderGrid();
        drawer.classList.add("is-open");
        moreBtn.textContent = "−";
        moreBtn.setAttribute("aria-expanded", "true");
      }
    });
  }

  // Inline chat — Enter sends via the reaction channel (the popup uses the
  // same path), so the partner sees it as a floating message.
  function wireChatInput(badge, chatInput) {
    // Don't let typing trigger site-level shortcuts (YouTube j/k/l, space, etc.)
    chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter") return;
      if (e.isComposing || e.keyCode === 229) return;
      const text = chatInput.value.trim().slice(0, 140);
      if (!text) return;
      safeSend({ type: "SEND_REACTION", emoji: text });
      spawnReaction(text, { fromSelf: true });
      chatInput.value = "";
      chatInput.classList.add("sent");
      setTimeout(() => chatInput.classList.remove("sent"), 500);
    });
    chatInput.addEventListener("keyup", (e) => e.stopPropagation());
    chatInput.addEventListener("keypress", (e) => e.stopPropagation());
    // Keep the controls open while typing, even if the mouse drifts off.
    chatInput.addEventListener("focus", () => { badge.dataset.locked = "1"; });
    chatInput.addEventListener("blur",  () => { delete badge.dataset.locked; });
    // Typing indicator, throttled.
    let typingThrottle = null;
    chatInput.addEventListener("input", () => {
      if (typingThrottle) return;
      safeSend({ type: "SEND_TYPING" });
      typingThrottle = setTimeout(() => { typingThrottle = null; }, 2000);
    });
  }

  // good | warn | bad | idle — drives the dot colour and the cast-shadow echo.
  function badgeHealth() {
    if (!S.connected || S.peerCount < 2) return "idle";
    switch (S.driftStatus) {
      case "sync":        return "good";
      case "warning":     return "warn";
      case "out_of_sync":
      case "mismatch":    return "bad";
      default:            return "idle";
    }
  }

  // 0:28 · 12:05 · 1:02:09 — a position in the video.
  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  }

  // 1.4s · 12s · 12m 34s · 1h 05m
  function fmtDrift(sec) {
    const a = Math.abs(sec);
    if (a < 10) return `${a.toFixed(1)}s`;
    if (a < 60) return `${Math.round(a)}s`;
    if (a < 3600) return `${Math.floor(a / 60)}m ${String(Math.round(a % 60)).padStart(2, "0")}s`;
    return `${Math.floor(a / 3600)}h ${String(Math.floor((a % 3600) / 60)).padStart(2, "0")}m`;
  }

  // text: short label beside the face; title: the full sentence (tooltip).
  function badgeStatus() {
    // Labels stay short so the bar never truncates them; the tooltip (title)
    // carries the full sentence.
    const who = S.partnerName || "your partner";   // mid-sentence
    const Who = S.partnerName || "Your partner";   // sentence start
    if (S.peerCount < 2) return { face: false, emoji: "👋", text: "waiting…", title: "Waiting for your partner to join" };
    if (S.partnerTyping)  return { face: true, typing: true, text: "typing…", title: `${Who} is typing` };
    const d = S.driftSeconds;
    const gap = typeof d === "number" && Math.abs(d) >= 0.1
      ? { text: `${fmtDrift(d)} ${d < 0 ? "behind" : "ahead"}`,
          title: `You're ${fmtDrift(d)} ${d < 0 ? "behind" : "ahead of"} ${who}` }
      : null;
    switch (S.driftStatus) {
      case "sync":        return { face: true, text: "in sync", title: `In sync with ${who}` };
      case "warning":
      case "out_of_sync": return { face: true, ...(gap || { text: "out of sync", title: `Out of sync with ${who}` }) };
      case "mismatch":    return { face: true, text: "other video", title: `${Who} is watching something else` };
      default:            return { face: true, text: "no video", title: `${Who} is here — waiting for a video` };
    }
  }

  // Fills an avatar slot with the partner's portrait, emoji, or initial —
  // or a plain status emoji when there's no partner to show. Only touches
  // the DOM when what's shown actually changes.
  function setFace(slot, face, fallbackEmoji, typing) {
    if (!slot) return;
    slot.classList.toggle("typing", !!(face && typing));
    const value = S.partnerEmoji;
    const name = (S.partnerName || "").trim();
    let kind, key;
    if (!face)                                                 { kind = "plain";    key = `p:${fallbackEmoji}`; }
    else if (isAvatarCode(value) && avatarUrl(value))          { kind = "portrait"; key = `a:${value}`; }
    else if (typeof value === "string" && value && value.length <= 4) { kind = "emoji"; key = `e:${value}`; }
    else if (name)                                             { kind = "mono";     key = `m:${Array.from(name)[0].toUpperCase()}`; }
    else                                                       { kind = "emoji";    key = "e:👤"; }
    if (slot.dataset.v === key) return;
    slot.dataset.v = key;
    slot.className = `av${kind === "plain" ? " plain" : kind === "mono" ? " mono" : ""}${face && typing ? " typing" : ""}`;
    if (kind === "portrait") {
      const img = el("img", "portrait", { src: avatarUrl(value), alt: name || "Partner", draggable: "false", referrerpolicy: "no-referrer" });
      // Portraits come from a CDN some pages block (CSP) — show the initial
      // instead of a broken-image icon. dataset.v is left alone so render()
      // doesn't keep retrying the same failing URL.
      img.addEventListener("error", () => {
        if (slot.dataset.v !== key) return;
        slot.classList.add("mono");
        if (name) slot.replaceChildren(document.createTextNode(Array.from(name)[0].toUpperCase()));
        else slot.innerHTML = twemojiHtml("👤");
      }, { once: true });
      slot.replaceChildren(img);
    } else if (kind === "mono") {
      slot.replaceChildren(document.createTextNode(key.slice(2)));
    } else {
      slot.innerHTML = twemojiHtml(key.slice(2));
    }
  }

  function render() {
    if (!frameOwnsBadge) return;
    const overlay = ensureOverlay();
    const badge = $ui("__duet_badge") || buildBadge(overlay);
    const puck = $ui("__pp_tray");

    if (!S.connected || isDismissed) {
      badge.classList.remove("is-visible", "is-open");
      $ui("__pp_emoji_drawer")?.classList.remove("is-open");
      puck?.classList.remove("is-visible");
      return;
    }

    const health = badgeHealth();
    const status = badgeStatus();
    badge.dataset.health = health;
    badge.classList.toggle("has-face", status.face);
    if (puck) {
      puck.dataset.health = health;
      puck.classList.toggle("has-face", status.face);
      puck.title = `${status.title} · click to expand`;
    }
    setFace($ui("__pp_avatar"), status.face, status.emoji, status.typing);
    setFace($ui("__pp_tray_av"), status.face, status.emoji, status.typing);
    const statusText = $ui("__pp_status_text");
    statusText.textContent = status.text;
    // Connection speed is for troubleshooting, not the bar: tooltip only.
    statusText.title = typeof S.lastPingMs === "number"
      ? `${status.title} · connection ${S.lastPingMs}ms` : status.title;
    const srKey = `${S.peerCount >= 2}|${S.driftStatus}|${S.partnerTyping}`;
    const sr = $ui("__pp_status_sr");
    if (sr && sr.dataset.k !== srKey) { sr.dataset.k = srKey; sr.textContent = status.title; }

    renderPrimary();
    badge.classList.toggle("has-fix", !$ui("__pp_fix_btn")?.hidden);

    badge.classList.add("is-visible");
    applyMinimizedDom();
  }

  // ── Undo sync ──────────────────────────────────────────────
  // Shows a temporary "Undo" button after a successful catch-up sync.
  // Clicking it seeks the video back to the pre-sync position.
  function showUndoButton() {
    const controls = $ui("__pp_controls");
    if (!controls || preSyncPosition === null) return;

    $ui("__pp_undo_btn")?.remove();
    const undoBtn = el("button", "btn-ghost", { id: "__pp_undo_btn", type: "button", text: "↩ Undo — back to where I was" });
    undoBtn.addEventListener("click", () => {
      if (!video) ensureVideo();
      if (video && preSyncPosition !== null) {
        video.currentTime = preSyncPosition;
        showFlash("play", `Reverted to ${preSyncPosition.toFixed(1)}s`);
      }
      undoBtn.remove();
      preSyncPosition = null;
      preSyncTimestamp = null;
    });
    const pairEl = $ui("__pp_sync_btn")?.parentElement;
    if (pairEl) pairEl.after(undoBtn);
    else controls.appendChild(undoBtn);

    // Auto-remove after 6 seconds
    setTimeout(() => { if (undoBtn.parentNode) undoBtn.remove(); }, 6000);
  }

  function showFlash(action, customLabel) {
    // Render in whichever frame currently owns the badge. If we don't own it,
    // relay up to top — top will either render itself or, if an iframe owns,
    // already gave that iframe the ownership grant so our relay is a no-op
    // there. This avoids double-rendering when ownership shifts during a sync.
    if (!frameOwnsBadge) {
      try {
        window.top.postMessage({ __duet_msg: "flash", action, customLabel }, "*");
      } catch {}
      return;
    }
    const overlay = ensureOverlay();
    let flash = $ui("__duet_flash");
    if (!flash) {
      flash = el("div", "flash", { id: "__duet_flash", role: "status" });
      overlay.insertBefore(flash, overlay.firstChild);
    }
    const isPlay = action === "play";
    flash.dataset.action = isPlay ? "play" : "pause";
    const glyph = isPlay
      ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 1.5v9l8-4.5L3 1.5z" fill="currentColor"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2.5" y="1.5" width="2.5" height="9" rx="0.7" fill="currentColor"/><rect x="7" y="1.5" width="2.5" height="9" rx="0.7" fill="currentColor"/></svg>';
    const who = S.partnerName || "Partner";
    const label = customLabel || (isPlay ? `${who} played` : `${who} paused`);
    let icon;
    if (!customLabel) {
      // Partner played/paused: the signature moment.
      icon = duetMark(isPlay ? "play" : "pause");
    } else {
      // Status/error flashes lead with the partner's avatar (or a glyph).
      icon = el("span", "flash-icon");
      icon.innerHTML = avatarHtml(S.partnerEmoji, 24) || glyph;
    }
    const text = el("span");
    text.innerHTML = twemojiHtml(label);
    flash.replaceChildren(icon, text);
    flash.classList.add("is-visible");
    clearTimeout(flash.__t);
    flash.__t = setTimeout(() => flash.classList.remove("is-visible"), 2500);
  }

  // Two halves in the brand gradient (peach→coral, rose→violet). Elements are
  // rebuilt per flash, so the CSS animations replay every time.
  let markSeq = 0;
  function duetMark(shape) {
    const id = `duet-g${++markSeq}`;
    const halves = shape === "play"
      ? `<path class="half a" d="M7 4.5 L19.5 12 L7 12 Z" fill="url(#${id}a)"/>` +
        `<path class="half b" d="M7 12 L19.5 12 L7 19.5 Z" fill="url(#${id}b)"/>`
      : `<rect class="half a" x="5.5" y="4.5" width="4.6" height="15" rx="1.6" fill="url(#${id}a)"/>` +
        `<rect class="half b" x="13.9" y="4.5" width="4.6" height="15" rx="1.6" fill="url(#${id}b)"/>`;
    const span = el("span", "flash-icon mark", { "data-shape": shape, "aria-hidden": "true" });
    span.innerHTML =
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs>` +
      `<linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc89a"/><stop offset="1" stop-color="#ff8a6b"/></linearGradient>` +
      `<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f472b6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>` +
      `</defs>${halves}</svg>`;
    return span;
  }

  // ── Floating reactions & Chat ──────────────────────────────
  // Heuristic: a payload is a single emoji (or a short emoji combo) when it
  // has no ASCII letters/digits AND is short. Anything else is chat text.
  // This stops "⏳ Buffering..." style strings from being treated as emoji
  // (they have letters → fall through to chat).
  function isEmojiPayload(s) {
    if (typeof s !== "string") return false;
    if (s.length > 8) return false;
    if (/[A-Za-z0-9]/.test(s)) return false;
    return true;
  }

  // System messages are short status updates (buffering, etc.) that should
  // appear as a transient pill, not get drowned in the chat stream.
  function isSystemPayload(s) {
    return typeof s === "string" && /^⏳ Buffering/i.test(s);
  }

  function spawnReaction(payload, opts = {}) {
    const fromSelf = !!opts.fromSelf;
    if (isSystemPayload(payload)) {
      // Don't show your own buffering to yourself — you can already see it.
      if (!fromSelf) showSystemPill(payload);
    } else if (isEmojiPayload(payload)) {
      spawnFloatingEmoji(payload, fromSelf);
    } else {
      spawnChatBubble(payload, fromSelf);
    }
  }

  // Shared by the presence toast and system pill: one element per id,
  // replaced rather than stacked, auto-hidden after `ms`.
  function showToast(id, kind, children, ms) {
    const layer = ensureUiRoot();
    let toast = $ui(id);
    if (!toast) {
      toast = el("div", "toast", { id, role: "status" });
      layer.appendChild(toast);
    }
    toast.dataset.kind = kind;
    toast.replaceChildren(...children);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    clearTimeout(toast.__t);
    toast.__t = setTimeout(() => toast.classList.remove("is-visible"), ms);
  }

  // Toast for partner presence transitions (joined / left).
  function showPresenceToast(text, kind) {
    const av = avatarHtml(S.partnerEmoji, 18);
    let lead;
    if (av) { lead = el("span", "toast-av"); lead.innerHTML = av; }
    else lead = el("span", "toast-dot");
    showToast("__pp_presence_toast", kind === "leave" ? "leave" : "join", [lead, el("span", "", { text })], 2800);
  }

  // Single transient pill for system status (buffering, etc.).
  function showSystemPill(text) {
    const partnerLabel = S.partnerName || "Partner";
    const label = text.replace(/^⏳ Buffering/i, `⏳ ${partnerLabel} is buffering`).replace(/\.{3,}$/, "…");
    showToast("__pp_system_pill", "system", [el("span", "", { text: label })], 3500);
  }

  function spawnFloatingEmoji(emoji, fromSelf) {
    const node = el("div", "float-emoji");
    node.innerHTML = twemojiHtml(emoji);
    const startX = fromSelf
      ? 60 + Math.random() * 30        // self → right-ish (60-90%)
      : 10 + Math.random() * 30;       // partner → left-ish (10-40%)
    node.style.left = `${startX}%`;
    ensureUiRoot().appendChild(node);
    setTimeout(() => node.remove(), 2700);
  }

  // Subtitle-style scrolling chat:
  //  - duration scales with length (~12 chars/sec reading pace),
  //  - direction encodes sender (self → left-to-right, partner → right-to-left),
  //  - lanes stop fast messages from piling up on each other,
  //  - sender prefix + avatar survive washed-out frames,
  //  - hover pauses for re-reading; italic marks the partner.

  // Lane manager: 9 vertical lanes from 10% to 75% in 8.1% steps. A lane is
  // marked busy until its `freeAt` timestamp passes (set to ~55% of slide
  // duration, the point where the message's leading edge has cleared the
  // entry side and a new one can safely start in the same row).
  const __pp_lanes = new Array(9).fill(0); // freeAt timestamps
  function pickLane(durationMs) {
    const now = Date.now();
    const free = [];
    for (let i = 0; i < __pp_lanes.length; i++) {
      if (__pp_lanes[i] <= now) free.push(i);
    }
    let idx;
    if (free.length) {
      idx = free[Math.floor(Math.random() * free.length)];
    } else {
      // All lanes busy — pick the one expiring soonest so we minimize overlap.
      idx = 0;
      for (let i = 1; i < __pp_lanes.length; i++) {
        if (__pp_lanes[i] < __pp_lanes[idx]) idx = i;
      }
    }
    __pp_lanes[idx] = now + Math.floor(durationMs * 0.55);
    return 10 + idx * 8.1; // top% (10..74.8)
  }

  function spawnChatBubble(text, fromSelf) {
    const trimmed = String(text).slice(0, 140);
    const len = trimmed.length;
    // Base 6s + ~80ms per character, clamped to [7s, 22s].
    const durSec = Math.max(7, Math.min(22, 6 + len * 0.08));
    const durationMs = durSec * 1000;

    const node = el("div", `bubble ${fromSelf ? "ltr" : "rtl"}`);
    node.style.top = `${pickLane(durationMs)}%`;
    node.style.fontSize = `${len < 30 ? 28 : len < 70 ? 22 : 18}px`;
    node.style.animationDuration = `${durSec}s`;

    const inner = el("span", "bubble-inner");
    const who = el("span", "bubble-who");
    // Tiny avatar inline with the sender label so attribution survives even
    // on bright frames where color contrast washes out.
    const avatar = avatarHtml(fromSelf ? myEmoji : S.partnerEmoji, 14);
    if (avatar) { const av = el("span"); av.innerHTML = avatar; who.appendChild(av); }
    who.appendChild(el("span", "", { text: fromSelf ? "You" : (S.partnerName || "Partner") }));
    inner.append(who, el("span", "bubble-text", { text: trimmed }));
    node.appendChild(inner);

    ensureUiRoot().appendChild(node);
    setTimeout(() => node.remove(), durationMs + 100);
  }

  // currentDriftStatus → S.driftStatus (state machine)
  
  // ── Message Listener ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "REMOTE_SYNC") {
      logSyncEvent("REMOTE_SYNC", { action: message.state?.action, time: message.state?.currentTime });
      applySync(message.state, message.serverNow);
    } else if (message.type === "CONNECTION_STATUS") {
      const wasConnected = S.connected;
      const prevPeerCount = S.peerCount;
      const nextConnected = !!message.connected;
      const nextPeerCount = message.peerCount || 0;
      setState({ connected: nextConnected, peerCount: nextPeerCount });
      if (nextConnected && !wasConnected) {
        logSyncEvent("CONNECT", {});
        startTabInfoTimer();
        loadChatLog();
      }
      if (!nextConnected) {
        logSyncEvent("DISCONNECT", {});
        if (tabInfoTimer) { clearInterval(tabInfoTimer); tabInfoTimer = null; }
        readyState = { phase: "none" };
        hideAsk("__pp_ready_ask");
        hideAsk("__pp_follow");
        clearTimeout(followTimer);
        renderChatLog([]);
      }
      if (nextConnected) sendTabInfo();
      // Toast on partner presence transitions (owner frame only — every
      // frame gets this message).
      if (wasConnected && frameOwnsBadge) {
        if (prevPeerCount < 2 && nextPeerCount >= 2) {
          showPresenceToast(`${S.partnerName || "Partner"} is here`, "join");
        } else if (prevPeerCount >= 2 && nextPeerCount < 2) {
          showPresenceToast(`${S.partnerName || "Partner"} left the room`, "leave");
        }
      }
    } else if (message.type === "SHOW_REACTION") {
      // Sent to every frame; only the badge owner draws it.
      if (!frameOwnsBadge) return;
      logSyncEvent("REACTION", { emoji: message.emoji, mine: !!message.mine });
      spawnReaction(message.emoji, { fromSelf: !!message.mine });
    } else if (message.type === "SYNC_STATUS") {
      // Cache partner info and compute drift status.
      const prevName = S.partnerName;
      const patch = {};
      if (message.partner && typeof message.partner.name === "string") {
        patch.partnerName = message.partner.name;
      } else if (!message.partner) {
        patch.partnerName = "";
      }
      if (message.partner && typeof message.partner.emoji === "string") {
        patch.partnerEmoji = message.partner.emoji;
      } else if (!message.partner) {
        patch.partnerEmoji = "";
      }
      if (typeof message.ping === "number") patch.lastPingMs = message.ping;
      patch.bothPaused = !!(message.mine?.paused && message.partner?.paused);
      // Compute drift status
      const hasLiveData = (m) =>
        m && typeof m.currentTime === "number" && typeof m.url === "string" &&
        typeof m.lastSeen === "number" && (message.serverNow - m.lastSeen) < 15000;

      patch.driftSeconds = null;
      if (S.peerCount < 2 || !hasLiveData(message.partner) || !hasLiveData(message.mine)) {
        patch.driftStatus = "waiting";
      } else {
        const norm = u => { try { const url = new URL(u); return url.origin + url.pathname + url.search; } catch { return u; } };
        const mismatch = norm(message.mine.url) !== norm(message.partner.url);
        if (mismatch) {
          patch.driftStatus = "mismatch";
        } else if (message.mine.paused || message.partner.paused) {
          patch.driftSeconds = (message.mine.currentTime || 0) - (message.partner.currentTime || 0);
          patch.driftStatus = Math.abs(patch.driftSeconds) > 1.5 ? "out_of_sync" : "sync";
        } else {
          const project = m => (m.currentTime || 0) + Math.max(0, (message.serverNow - m.lastSeen) / 1000);
          patch.driftSeconds = project(message.mine) - project(message.partner);
          const drift = Math.abs(patch.driftSeconds);
          if (drift > 2.0) patch.driftStatus = "out_of_sync";
          else if (drift > 0.8) patch.driftStatus = "warning";
          else patch.driftStatus = "sync";
        }
      }
      setState(patch);
      if (patch.partnerName !== undefined && patch.partnerName !== prevName) refreshSyncBtnLabel();
      
    } else if (message.type === "GET_VIDEO_SNAPSHOT") {
      // Synchronous-ish: respond with current video state for sync-to-me
      if (!video) ensureVideo();
      if (!video) { sendResponse({ hasVideo: false }); return true; }
      sendResponse({
        hasVideo: true,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
        paused: video.paused,
        score: scoreVideo(video) // lets the background prefer the real player over an ad frame
      });
      return true;
    } else if (message.type === "BADGE_HIDDEN?") {
      if (frameOwnsBadge && S.connected) { sendResponse({ hidden: isDismissed }); return true; }
    } else if (message.type === "SHOW_BADGE") {
      if (S.connected) { setMinimized(false); setDismissed(false); }
    } else if (message.type === "READY_STATE") {
      readyState = message;
      if (frameOwnsBadge) renderReady();
    } else if (message.type === "READY_GO") {
      readyState = { phase: "go", id: message.id };
      if (frameOwnsBadge) renderReady();
      runReadyGo(message);
    } else if (message.type === "FOLLOW_PROMPT") {
      if (frameOwnsBadge && S.connected) showFollowPrompt(message);
    } else if (message.type === "CHAT_APPEND") {
      if (frameOwnsBadge && message.item) appendChatLog(message.item);
    } else if (message.type === "TYPING_STATUS") {
      // Partner started or stopped typing
      const typing = !!message.typing;
      setState({ partnerTyping: typing });
      if (typing) {
        clearTimeout(typingClearTimer);
        typingClearTimer = setTimeout(() => { setState({ partnerTyping: false }); }, 4000);
      }
    }
  });

  // ── Invite page bridge ─────────────────────────────────────
  // On Duet's own join page (…/join#CODE) tell the page the extension is
  // installed, report room status, and act on its buttons. Guarded three
  // ways: only the allowlisted invite hosts, only the top frame (no framing
  // tricks), and only real user clicks (`isTrusted` can't be forged by page
  // script). A link alone must never drop someone into a room — whoever is
  // in it would see what they watch.
  const INVITE = globalThis.DUET_INVITE;
  if (isTopFrame && INVITE?.isInvitePage(location.href)) initInviteBridge();

  function initInviteBridge() {
    const post = (msg) => window.postMessage({ __duet_ext: true, ...msg }, location.origin);
    const inviteCode = () => INVITE.parse(location.href);
    let busy = false;
    let pollTimer = null;

    async function report() {
      const status = await safeSend({ type: "GET_STATUS" });
      const p = status?.partner;
      post({
        type: "status",
        code: inviteCode(),
        currentRoom: status?.currentRoom || null,
        peerCount: status?.peerCount || 0,
        partner: p ? {
          name: typeof p.name === "string" ? p.name : "",
          title: (typeof p.videoTitle === "string" && p.videoTitle) || (typeof p.pageTitle === "string" && p.pageTitle) || "",
          hostname: typeof p.hostname === "string" ? p.hostname : "",
          hasVideo: typeof p.url === "string"
        } : null
      });
      return status;
    }

    // After joining, keep the page updated until the partner's video shows up
    // (so it can offer "Open what they're watching"), for up to a minute.
    function pollForPartnerVideo() {
      clearInterval(pollTimer);
      const until = Date.now() + 60000;
      pollTimer = setInterval(async () => {
        const status = await report();
        if (typeof status?.partner?.url === "string" || Date.now() > until) clearInterval(pollTimer);
      }, 1500);
    }

    window.addEventListener("message", (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      if (e.data?.__duet_page && e.data.type === "hello") report();
    });
    window.addEventListener("hashchange", () => report());

    document.addEventListener("click", async (e) => {
      if (!e.isTrusted || busy) return;
      const btn = e.target instanceof Element ? e.target.closest("[data-duet-action]") : null;
      if (!btn) return;
      const action = btn.dataset.duetAction;
      if (action !== "join" && action !== "open-video") return;
      busy = true;
      try {
        if (action === "join") {
          const code = inviteCode();
          if (!code) { post({ type: "error", message: "This invite link doesn't contain a valid room code." }); return; }
          post({ type: "joining" });
          const res = await safeSend({
            type: "JOIN_ROOM", roomCode: code,
            leaveCurrent: btn.dataset.duetLeaveCurrent === "1"
          });
          if (!res) post({ type: "error", message: "Duet didn't respond. Reload the page and try again." });
          else if (res.error) post({ type: "error", message: res.error });
          else { await report(); pollForPartnerVideo(); }
        } else {
          const res = await safeSend({ type: "OPEN_PARTNER_URL", here: true });
          if (res?.error) post({ type: "error", message: res.error });
        }
      } finally {
        busy = false;
      }
    }, true);

    document.documentElement.dataset.duetExtension = "1";
    report();
  }

  // ── Initial status fetch ───────────────────────────────────
  // Check local storage first: when not in a room (the common case) we don't
  // message the background at all, so ordinary page loads never wake the
  // service worker. Joining later reaches us via CONNECTION_STATUS.
  try {
    chrome.storage.local.get(["currentRoom"], (data) => {
      if (!data?.currentRoom) return;
      safeSend({ type: "GET_STATUS" }).then((status) => {
        if (status?.currentRoom) {
          setState({ connected: true, peerCount: status.peerCount || 1 });
          if (typeof status.ping === "number") setState({ lastPingMs: status.ping });
          startTabInfoTimer();
          sendTabInfo();
          if (status.ready) readyState = status.ready;
          // render() builds the badge on the next microtask; fill it after.
          setTimeout(() => { if (frameOwnsBadge) { renderReady(); loadChatLog(); } }, 0);
        }
      });
    });
  } catch {}
})();
