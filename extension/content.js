// ============================================================
//  Duet — Content Script
// ============================================================

(function () {
  if (window.__duetInjected) return;
  window.__duetInjected = true;

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
    isApplyingRemote: false,
    partnerTyping: false,
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

  // Avatar codes (mirror of popup.js's mapping). Stored as compact "av:NN"
  // codes; we resolve them to DiceBear illustrated portraits on demand.
  // Kept in sync with popup.js — if seeds/gradients change there, mirror here.
  const __DUET_AVATAR_BASE = "https://api.dicebear.com/9.x/adventurer/svg?seed=";
  const __DUET_AVATAR_SEEDS = [
    "Mochi","Pepper","Suki","Felix","Luna","Nico","Sasha","Kira","Theo","Ivy","Rio","Juno",
    "Zara","Atlas","Wren","Hugo","Mila","Bo","Indigo","Soren","Nova","Cleo","Otis","Vesper"
  ];
  const __DUET_AVATAR_BG = [
    "ffd5dc,ff9eb8","ffdfbf,ffb37b","ffe5b4,f4c542","c8e6c9,7bc99c",
    "b6e3f4,7ec8e3","c0aede,9d7adf","f8bbd0,e57ea3","d1d4f9,8b9cf2",
    "ffc89a,ff7e5f","a8e6cf,5ec27a","ffeaa7,fdcb6e","fab1a0,e17055",
    "fd79a8,d63384","74b9ff,0984e3","a29bfe,6c5ce7","fdcb6e,f39c12",
    "e17055,c0392b","00b894,00897b","ff7675,d63031","fd79a8,e84393",
    "55efc4,00b894","81ecec,00cec9","ffeaa7,fab1a0","dfe6e9,b2bec3"
  ];
  // ── Twemoji: replace Unicode emoji with Twitter SVG images ──
  const TWEMOJI_CDN = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/";
  function twemojiCodePoints(str) {
    const cps = [];
    for (let i = 0; i < str.length; i++) {
      let cp = str.codePointAt(i);
      if (cp > 0xFFFF) i++; // skip surrogate pair
      cps.push(cp.toString(16));
    }
    return cps.join("-");
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
      const cp = twemojiCodePoints(match);
      // CSP-safe: use img tag with src attribute (no inline styles, no eval)
      return '<img class="twemoji" draggable="false" alt="' + match.replace(/"/g, '&quot;') + '" src="' + TWEMOJI_CDN + cp + '.svg" width="16" height="16">';
    });
  }

  function isAvatarCode(v) { return typeof v === "string" && /^av:\d{2}$/.test(v); }
  function avatarUrl(code) {
    if (!isAvatarCode(code)) return null;
    const idx = parseInt(code.slice(3), 10);
    const seed = __DUET_AVATAR_SEEDS[idx];
    if (!seed) return null;
    const bg = __DUET_AVATAR_BG[idx % __DUET_AVATAR_BG.length];
    return `${__DUET_AVATAR_BASE}${encodeURIComponent(seed)}&backgroundColor=${bg}&backgroundType=gradientLinear`;
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

  function syncBtnDefaultLabel() {
    return `Catch up to ${S.partnerName || "partner"}`;
  }

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
    const btn = $ui("__pp_sync_btn");
    if (!btn || btn.disabled) return; // don't clobber transient states
    btn.textContent = syncBtnDefaultLabel();
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
    v.addEventListener("play",       guard(() => { if (consumeRemoteEvent("play"))    return; sendSync("play");  sendTabInfo(true); }));
    v.addEventListener("pause",      guard(() => { if (consumeRemoteEvent("pause"))   return; sendSync("pause"); sendTabInfo(true); }));
    v.addEventListener("seeked",     guard(() => { if (consumeRemoteEvent("seeked"))  return; sendSync(v.paused ? "pause" : "play"); sendTabInfo(true); }));
    v.addEventListener("ratechange", guard(() => { if (consumeRemoteEvent("ratechange")) return; sendSync(v.paused ? "pause" : "play"); sendTabInfo(true); }));
    v.addEventListener("waiting",    guard(() => {
      if (S.isApplyingRemote || !S.connected) return;
      sendSync("pause");
      // Throttle: only ping the partner once per ~5s so a stuttering stream
      // doesn't spam them.
      const now = Date.now();
      if (now - (window.__duet_lastBufferPing || 0) > 5000) {
        window.__duet_lastBufferPing = now;
        safeSend({ type: "SEND_REACTION", emoji: "⏳ Buffering..." });
      }
    }));
    v.addEventListener("playing",    guard(() => { if (consumeRemoteEvent("playing")) return; sendSync("play");  sendTabInfo(true); }));
    v.addEventListener("timeupdate", guard(() => { sendTabInfo(); }));
    dlog("[Duet] Attached to active video player.");
    render();
    sendTabInfo(true); // immediately push our metadata
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
  function sendSync(action) {
    if (S.isApplyingRemote || !S.connected || !video) return;
    const sig = `${action}|${video.currentTime.toFixed(2)}`;
    const now = Date.now();
    if (sig === lastSentSig && now - lastSentAt < 250) return;
    lastSentSig = sig;
    lastSentAt = now;
    logSyncEvent("LOCAL_SYNC", { action, time: video.currentTime });

    safeSend({
      type: "SYNC_EVENT",
      state: {
        action,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate
      }
    });
  }

  // ── Apply Remote Sync ──────────────────────────────────────
  function applySync(state, serverNow) {
    if (!video) {
      video = findVideo();
      if (!video) return;
    }

    // Reset any in-flight apply window so we don't carry stale expectations.
    endApplyingRemote();
    S.isApplyingRemote = true;
    const expected = new Set();

    let targetTime = state.currentTime;
    if (state.action === "play" && typeof state.serverTime === "number" && typeof serverNow === "number") {
      const elapsed = Math.max(0, (serverNow - state.serverTime) / 1000);
      targetTime = state.currentTime + elapsed;
    }

    // Force-syncs always seek; normal updates only seek when drifting > 1s
    const driftThreshold = state.force ? 0 : 1.0;
    if (Math.abs(video.currentTime - targetTime) > driftThreshold) {
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
    const who = S.partnerName || "Partner";
    showFlash(state.action, state.catchUp ? `Caught up to ${who}`
      : state.force ? `${who} re-synced you` : null);

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

  // When running in a cross-origin iframe (yflix's embed, rapidshare, etc.),
  // location.href is a per-session tokenized URL that differs between viewers
  // even when they're on the same parent page. For partner-match purposes we
  // need the parent page's URL, which both partners actually share.
  //   - same-origin iframe: top.location.href works directly
  //   - cross-origin iframe: top.location.href is blocked. We fall back to
  //     a postMessage handshake with the top frame, then document.referrer,
  //     then our own location as last resort.
  //   - top frame: just location.href
  let topFrameUrl = "";  // populated via postMessage from the top frame
  function getPageUrl() {
    if (isTopFrame) return location.href;
    try { return window.top.location.href; } catch {}
    if (topFrameUrl) return topFrameUrl;
    if (document.referrer) return document.referrer;
    return location.href;
  }
  function getPageHostname() {
    try { return new URL(getPageUrl()).hostname.replace(/^www\./, ""); }
    catch { return location.hostname.replace(/^www\./, ""); }
  }

  // Top frame: respond to URL queries from embedded iframes, AND broadcast our
  // URL down on every history change (so SPA navigations stay in sync).
  // Iframe: ask the parent for its URL on load, then cache replies.
  if (isTopFrame) {
    const broadcastUrl = () => {
      const payload = { __duet_msg: "page-url", url: location.href };
      try {
        const frames = document.querySelectorAll("iframe");
        frames.forEach((f) => { try { f.contentWindow?.postMessage(payload, "*"); } catch {} });
      } catch {}
    };
    window.addEventListener("message", (e) => {
      if (e?.data?.__duet_msg === "request-page-url" && fromDescendantFrame(e)) {
        try { e.source?.postMessage({ __duet_msg: "page-url", url: location.href }, "*"); } catch {}
      }
    });
    // Re-broadcast on SPA navigation
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        broadcastUrl();
      }
    }, 1500);
    // Initial broadcast (after iframes have a chance to mount)
    setTimeout(broadcastUrl, 500);
  } else {
    window.addEventListener("message", (e) => {
      const data = e?.data;
      if (!data || data.__duet_msg !== "page-url" || typeof data.url !== "string") return;
      if (!fromTopFrame(e) || !/^https?:\/\//i.test(data.url)) return;
      if (data.url !== topFrameUrl) {
        topFrameUrl = data.url;
        // Re-publish with the corrected URL right away so the partner card flips fast.
        if (S.connected && video) sendTabInfo(true);
      }
    });
    // Ask the parent on load (covers Referrer-Policy: no-referrer)
    const askParent = () => {
      try { window.parent?.postMessage({ __duet_msg: "request-page-url" }, "*"); } catch {}
    };
    askParent();
    setTimeout(askParent, 1000);
    setTimeout(askParent, 3000);
  }

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
      // Always report the parent page URL so partner-match works even when
      // the player is in a cross-origin embed iframe.
      url: getPageUrl(),
      hostname: getPageHostname(),
      pageTitle: document.title,
      videoTitle: getVideoTitle(),
      duration: isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime,
      paused: video.paused
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
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }

    .layer {
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
      --surface: linear-gradient(180deg, rgba(32,29,44,0.95) 0%, rgba(18,16,26,0.96) 50%, rgba(11,10,16,0.97) 100%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif;
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
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      box-shadow: var(--cast), var(--emboss-rim-soft), var(--emboss-base);
      opacity: 0; transform: translateY(6px);
      transition: opacity .35s ease, transform .35s ease, box-shadow .45s ease;
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
    .status-text {
      flex: 1; min-width: 0;
      color: rgba(244,241,234,0.88);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ping { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
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
      transition: transform .15s ease, box-shadow .25s ease, background .2s, color .2s;
    }
    .icon-key:hover {
      color: var(--text);
      background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.05));
      box-shadow: var(--lift-small), var(--emboss-rim-soft);
      transform: translateY(-1px);
    }
    .icon-key:active { transform: none; box-shadow: var(--recess); }

    .controls {
      display: none; flex-direction: column; gap: 8px;
      padding: 10px 12px 12px;
      border-top: 1px solid var(--border);
    }
    .badge.is-open .controls { display: flex; }

    /* The one Lifted primary in the badge. Small object → -1px travel. */
    .btn-primary {
      width: 100%; border: none; border-radius: 999px;
      padding: 8px 12px;
      font-weight: 700; font-size: 12px; color: #14111c;
      background: linear-gradient(180deg, var(--peach) 0%, var(--coral) 50%, var(--rose) 100%);
      box-shadow: 0 4px 12px rgba(255,138,107,0.35), var(--emboss-rim), var(--emboss-base);
      transition: transform .15s ease, box-shadow .25s ease, opacity .2s;
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
      color: var(--muted); font-weight: 600; font-size: 11.5px;
      transition: color .2s;
    }
    .btn-ghost:hover { color: var(--text); }

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
      transition: transform .15s ease, box-shadow .25s ease, background .2s;
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
      font-size: 11px; color: rgba(244,241,234,0.4); pointer-events: none;
    }

    /* Emoji drawer: Lifted card popping above the badge. */
    .drawer {
      display: none; flex-direction: column; gap: 8px;
      position: absolute; bottom: calc(100% + 8px); right: 0;
      width: 300px; padding: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      box-shadow: 0 14px 30px rgba(0,0,0,0.50), var(--emboss-rim-soft), var(--emboss-base);
    }
    .drawer.is-open { display: flex; }
    .tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab {
      flex-shrink: 0; white-space: nowrap;
      padding: 4px 10px; border-radius: 999px;
      border: 1px solid transparent; background: transparent;
      color: var(--muted); font-size: 11px; font-weight: 600;
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
      max-height: 148px; overflow-y: auto; scrollbar-width: thin;
    }
    .grid .key { height: 34px; font-size: 18px; }
    .grid .empty { grid-column: 1 / -1; text-align: center; color: var(--muted); font-size: 11px; padding: 12px 0; }

    /* Minimized puck: small Lifted pill, same health echo. */
    .puck {
      --cast: var(--lift-small);
      display: none; align-items: center; gap: 7px;
      padding: 7px 12px 7px 10px;
      pointer-events: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 13px;
      cursor: grab; touch-action: none; user-select: none;
      box-shadow: var(--cast), var(--emboss-rim-soft), var(--emboss-base-soft);
      transition: transform .15s ease, box-shadow .25s ease;
    }
    .puck.is-visible { display: inline-flex; }
    .puck:hover { transform: translateY(-1px); }
    .puck[data-health="good"] { --cast: 0 4px 14px rgba(94,226,160,0.25); }
    .puck[data-health="warn"] { --cast: 0 4px 14px rgba(255,200,154,0.30); }
    .puck[data-health="bad"]  { --cast: 0 4px 14px rgba(255,107,122,0.32); }

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
      transition: opacity .4s ease, transform .4s ease;
    }
    .flash.is-visible { opacity: 1; transform: none; }
    .flash[data-action="pause"] { --accent: var(--peach); }
    .flash-icon {
      width: 24px; height: 24px; flex-shrink: 0;
      display: grid; place-items: center; overflow: hidden;
      border-radius: 50%;
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
    }

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
      animation: duet-float 2.6s cubic-bezier(.2,.7,.3,1) forwards;
    }
    .bubble {
      position: fixed; max-width: 70vw; pointer-events: none;
      will-change: transform;
    }
    .bubble.ltr { left: -100%; animation-name: duet-slide-ltr; }
    .bubble.rtl { right: -100%; animation-name: duet-slide-rtl; }
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
      font-size: 0.62em;
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
    @keyframes duet-slide-rtl { from { transform: translateX(0); } to { transform: translateX(-180vw); } }
    @keyframes duet-slide-ltr { from { transform: translateX(0); } to { transform: translateX(180vw); } }

    @media (prefers-reduced-motion: reduce) {
      @keyframes duet-float {
        0% { opacity: 0; transform: none; } 15% { opacity: 1; transform: none; }
        85% { opacity: 1; transform: none; } 100% { opacity: 0; transform: none; }
      }
      @keyframes duet-slide-rtl {
        0% { opacity: 0; transform: none; } 8% { opacity: 1; transform: none; }
        92% { opacity: 1; transform: none; } 100% { opacity: 0; transform: none; }
      }
      @keyframes duet-slide-ltr {
        0% { opacity: 0; transform: none; } 8% { opacity: 1; transform: none; }
        92% { opacity: 1; transform: none; } 100% { opacity: 0; transform: none; }
      }
      .badge, .flash, .toast, .puck, .key, .btn-primary, .icon-key {
        transition-duration: 0.05s !important;
      }
    }
  `;

  let uiHost = null;
  let uiRoot = null;
  let uiLayer = null;
  function ensureUiRoot() {
    if (uiLayer) return uiLayer;
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
    puck.classList.toggle("is-visible", isMinimized && S.connected);
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

  function installBadgeDrag(handle) {
    const DRAG_THRESHOLD = 4;
    let drag = null;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // Don't start drag from an interactive control inside the topbar.
      if (e.target instanceof Element && e.target.closest("button, input, a")) return;
      const overlay = $ui("__duet_overlay");
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      drag = {
        startX: e.clientX, startY: e.clientY,
        origX:  rect.left, origY:  rect.top,
        moved: false, pointerId: e.pointerId
      };
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });

    handle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      handle.style.cursor = "grabbing";
      applyOverlayPosition(drag.origX + dx, drag.origY + dy);
      e.preventDefault();
    });

    const finish = () => {
      if (!drag) return;
      try { handle.releasePointerCapture(drag.pointerId); } catch {}
      handle.style.cursor = "";
      if (drag.moved) {
        const overlay = $ui("__duet_overlay");
        if (overlay) {
          const rect = overlay.getBoundingClientRect();
          try { chrome.storage.local.set({ __duet_badge_pos: { x: rect.left, y: rect.top } }); } catch {}
        }
        // Swallow the synthetic click that would otherwise toggle hover state.
        const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        handle.addEventListener("click", stop, { capture: true, once: true });
      }
      drag = null;
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
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
      el("span", "status-emoji", { id: "__pp_status_emoji" }),
      el("span", "status-text", { id: "__pp_status_text", "aria-live": "polite" }),
      el("span", "ping", { id: "__pp_ping" })
    );
    const minBtn = el("button", "icon-key", { id: "__pp_min_btn", type: "button", title: "Minimize", "aria-label": "Minimize Duet", text: "−" });
    minBtn.addEventListener("click", (e) => { e.stopPropagation(); setMinimized(true); });
    minBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    topbar.appendChild(minBtn);
    installBadgeDrag(topbar);

    // Controls (shown on hover / while typing).
    const controls = el("div", "controls", { id: "__pp_controls" });

    const syncBtn = el("button", "btn-primary", { id: "__pp_sync_btn", type: "button", text: syncBtnDefaultLabel() });
    syncBtn.addEventListener("click", onCatchUpClick);

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

    controls.append(syncBtn, tray, chat);

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
    puck.append(el("span", "dot"), el("span", "status-emoji", { id: "__pp_tray_emoji" }));
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
    if (!video) video = findVideo();
    if (video) {
      preSyncPosition = video.currentTime;
      preSyncTimestamp = Date.now();
    }
    syncBtn.disabled = true;
    const who = S.partnerName || "partner";
    syncBtn.textContent = "Catching up…";
    showFlash("play", `Catching up to ${who}…`);
    const res = await safeSend({ type: "CATCH_UP_TO_PARTNER" });
    // Only claim success when the background actually verified that local
    // playback matches partner's projected position. Drift > 1s gets a
    // distinct "Off by Xs" message instead of a misleading checkmark.
    if (res?.error) {
      showFlash("pause", res.error);
      syncBtn.textContent = "Try again";
    } else if (res?.ok) {
      syncBtn.textContent = "Caught up ✓";
      showUndoButton();
    } else if (typeof res?.drift === "number") {
      syncBtn.textContent = `Off by ${res.drift.toFixed(1)}s`;
      showFlash("pause", `Couldn't fully sync — off by ${res.drift.toFixed(1)}s.`);
    } else {
      syncBtn.textContent = syncBtnDefaultLabel();
    }
    setTimeout(() => {
      syncBtn.disabled = false;
      syncBtn.textContent = syncBtnDefaultLabel();
    }, 2200);
  }

  // Tabbed categories + grid + Recent (shared with the popup picker via the
  // same chrome.storage key). Opens/closes on the "+" key.
  function wireEmojiDrawer(drawer, tabs, grid, moreBtn) {
    let activeTab = "Recent";
    let recentList = [];

    const loadRecents = () => new Promise((resolve) => {
      try {
        chrome.storage.local.get(["__duet_emoji_recents"], (data) => {
          recentList = Array.isArray(data?.__duet_emoji_recents) ? data.__duet_emoji_recents.slice(0, 12) : [];
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

  function badgeStatus() {
    if (S.peerCount < 2) return { emoji: S.partnerEmoji && !isAvatarCode(S.partnerEmoji) ? S.partnerEmoji : "👋", text: "waiting for partner" };
    if (S.partnerTyping)  return { emoji: "💬", text: `${S.partnerName || "partner"} is typing…` };
    switch (S.driftStatus) {
      case "sync":        return { emoji: "💞", text: "in sync" };
      case "warning":     return { emoji: "⏳", text: "slight delay" };
      case "out_of_sync": return { emoji: "⚠️", text: "out of sync" };
      case "mismatch":    return { emoji: "🎬", text: "different video" };
      default:            return { emoji: "📺", text: "waiting for video" };
    }
  }

  function render() {
    if (!frameOwnsBadge) return;
    const overlay = ensureOverlay();
    const badge = $ui("__duet_badge") || buildBadge(overlay);
    const puck = $ui("__pp_tray");

    if (!S.connected) {
      badge.classList.remove("is-visible", "is-open");
      $ui("__pp_emoji_drawer")?.classList.remove("is-open");
      puck?.classList.remove("is-visible");
      return;
    }

    const health = badgeHealth();
    const { emoji, text } = badgeStatus();
    badge.dataset.health = health;
    if (puck) puck.dataset.health = health;

    const emojiHtml = twemojiHtml(emoji);
    const statusEmoji = $ui("__pp_status_emoji");
    if (statusEmoji.dataset.v !== emoji) { statusEmoji.innerHTML = emojiHtml; statusEmoji.dataset.v = emoji; }
    const trayEmoji = $ui("__pp_tray_emoji");
    if (trayEmoji && trayEmoji.dataset.v !== emoji) { trayEmoji.innerHTML = emojiHtml; trayEmoji.dataset.v = emoji; }
    $ui("__pp_status_text").textContent = text;

    const ping = $ui("__pp_ping");
    if (typeof S.lastPingMs === "number") {
      ping.textContent = `${S.lastPingMs}ms`;
      ping.dataset.q = S.lastPingMs < 100 ? "good" : S.lastPingMs < 300 ? "ok" : "bad";
      ping.title = "Round trip to the sync server";
    } else {
      ping.textContent = "";
    }

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
    const undoBtn = el("button", "btn-ghost", { id: "__pp_undo_btn", type: "button", text: "↩ Undo catch-up" });
    undoBtn.addEventListener("click", () => {
      if (!video) video = findVideo();
      if (video && preSyncPosition !== null) {
        video.currentTime = preSyncPosition;
        showFlash("play", `Reverted to ${preSyncPosition.toFixed(1)}s`);
      }
      undoBtn.remove();
      preSyncPosition = null;
      preSyncTimestamp = null;
    });
    const syncBtnEl = $ui("__pp_sync_btn");
    if (syncBtnEl) syncBtnEl.after(undoBtn);
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
    // Lead with partner's avatar (illustrated portrait or emoji fallback) so
    // the flash visually maps to who triggered it.
    const icon = el("span", "flash-icon");
    icon.innerHTML = avatarHtml(S.partnerEmoji, 24) || glyph;
    const text = el("span");
    text.innerHTML = twemojiHtml(label);
    flash.replaceChildren(icon, text);
    flash.classList.add("is-visible");
    clearTimeout(flash.__t);
    flash.__t = setTimeout(() => flash.classList.remove("is-visible"), 2500);
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
      }
      if (!nextConnected) {
        logSyncEvent("DISCONNECT", {});
        if (tabInfoTimer) { clearInterval(tabInfoTimer); tabInfoTimer = null; }
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
      // Compute drift status
      const hasLiveData = (m) =>
        m && typeof m.currentTime === "number" && typeof m.url === "string" &&
        typeof m.lastSeen === "number" && (message.serverNow - m.lastSeen) < 15000;

      if (S.peerCount < 2 || !hasLiveData(message.partner) || !hasLiveData(message.mine)) {
        patch.driftStatus = "waiting";
      } else {
        const norm = u => { try { const url = new URL(u); return url.origin + url.pathname + url.search; } catch { return u; } };
        const mismatch = norm(message.mine.url) !== norm(message.partner.url);
        if (mismatch) {
          patch.driftStatus = "mismatch";
        } else if (message.mine.paused || message.partner.paused) {
          const drift = Math.abs((message.mine.currentTime || 0) - (message.partner.currentTime || 0));
          patch.driftStatus = drift > 1.5 ? "out_of_sync" : "sync";
        } else {
          const project = m => (m.currentTime || 0) + Math.max(0, (message.serverNow - m.lastSeen) / 1000);
          const drift = Math.abs(project(message.mine) - project(message.partner));
          if (drift > 2.0) patch.driftStatus = "out_of_sync";
          else if (drift > 0.8) patch.driftStatus = "warning";
          else patch.driftStatus = "sync";
        }
      }
      setState(patch);
      if (patch.partnerName !== undefined && patch.partnerName !== prevName) refreshSyncBtnLabel();
      
    } else if (message.type === "GET_VIDEO_SNAPSHOT") {
      // Synchronous-ish: respond with current video state for sync-to-me
      if (!video) video = findVideo();
      if (!video) { sendResponse({ hasVideo: false }); return true; }
      sendResponse({
        hasVideo: true,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
        paused: video.paused
      });
      return true;
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
        }
      });
    });
  } catch {}
})();
