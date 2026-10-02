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
  // Regex matches emoji: BMP emoticons, supplemental symbols, modifier bases,
  // flags, ZWJ sequences. Covers ~99% of common emoji.
  const __EMOJI_RE = /(?:\u200d\ufe0f?|[\ufe0e\ufe0f])?|(?:\ud83c[\udde6-\uddff]){2}|\ud83c[\uddfa\uddf8]|\ud83d[\udc68\udc69\udc41\udc6b\udc6c\udc6d\udc6e\udc6f\udc70\udc71\udc72\udc73\udc74\udc75\udc76\udc77\udc78\udc7f\udc80\udc81\udc82\udc83\udc84\udc85\udc86\udc87\udc88\udc89\udc8a\udc8b\udc8c\udc8d\udc8e\udc8f\udc90\udc91\udc92\udc93\udc94\udc95\udc96\udc97\udc98\udc99\udc9a\udc9b\udc9c\udc9d\udc9e\udc9f\udca0\udca1\udca2\udca3\udca4\udca5\udca6\udca7\udca8\udca9\udcaa\udcab\udcac\udcad\udcae\udcaf\udcb0\udcb1\udcb2\udcb3\udcb4\udcb5\udcb6\udcb7\udcb8\udcb9\udcba\udcbb\udcbc\udcbd\udcbe\udcbf\udcc0\udcc1\udcc2\udcc3\udcc4\udcc5\udcc6\udcc7\udcc8\udcc9\udcca\udccb\udccc\udccd\udcce\udccf\udcd0\udcd1\udcd2\udcd3\udcd4\udcd5\udcd6\udcd7\udcd8\udcd9\udcda\udcdb\udcdc\udcdd\udcde\udcdf\udce0\udce1\udce2\udce3\udce4\udce5\udce6\udce7\udce8\udce9\udcea\udceb\udcec\udced\udcee\udcef\udcf0\udcf1\udcf2\udcf3\udcf4\udcf5\udcf6\udcf7\udcf8\udcf9\udcfa\udcfb\udcfc\udcfd\udcfe\udcff|\ud83d[\ude00-\ude4f]|\ud83d[\ude80-\udeff]|\ud83e[\udd00-\uddef\uddf0-\uddff]|\u2702-\u27b0]|\u24c2\ud83c[\udc04\udccf\udde6-\uddff\ude02-\ude0a\ude10-\ude12\ude15-\ude2c\ude2e-\ude35\ude37-\ude3a\ude50-\ude51\udf00-\udfff]|\u2600-\u26ff|\u2700-\u27bf|\ufe0f|\u200d|\u2934-\u2935|\u25aa-\u25ab|\u25b6|\u25c0|\u25fb-\u25fe|\u2b05-\u2b07|\u2b1b-\u2b1c|\u2b50|\u2b55|\u3030|\u303d|\u3297|\u3299|\ud83c[\udc00-\udfff]/g;
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
      return '<img class="twemoji" draggable="false" alt="' + match.replace(/"/g, '&quot;') + '" src="' + TWEMOJI_CDN + cp + '.svg" width="16" height="16" style="display:inline-block;width:1.1em;height:1.1em;vertical-align:-0.15em;">';
    });
  }
  // DOM-safe version for non-innerHTML contexts
  function twemojiReplace(parentEl) {
    if (!parentEl) return;
    const walker = document.createTreeWalker(parentEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.textContent;
      if (!text || !/\p{Emoji_Presentation}|\p{Emoji}\uFE0F/u.test(text)) continue;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      const re = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        const img = document.createElement("img");
        img.className = "twemoji";
        img.alt = m[0];
        img.draggable = false;
        img.width = 16; img.height = 16;
        img.style.cssText = "display:inline-block;width:1.1em;height:1.1em;vertical-align:-0.15em;";
        img.src = TWEMOJI_CDN + twemojiCodePoints(m[0]) + ".svg";
        frag.appendChild(img);
        lastIdx = re.lastIndex;
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  function isEmojiOnly(str) {
    return typeof str === "string" && /^\s*(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\s)+\s*$/u.test(str);
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
    const btn = document.getElementById("__pp_sync_btn");
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
    // Hide the badge — extension is gone, anything it claims is stale
    const badge = document.getElementById("__duet_badge");
    if (badge) badge.style.opacity = "0";
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
      // Initial check + light polling fallback (10s) for edge cases
      check();
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

    showFlash(state.action, state.force ? `${S.partnerName || "Partner"} re-synced you` : null);

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
    const overlay = document.getElementById("__duet_overlay");
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

  // ── Visual Feedback (overlay + flash) ──────────────────────
  // The overlay (badge + flash) renders only in the frame that currently
  // OWNS the badge — top frame by default, fullscreen iframe when one is.
  function ensureOverlay() {
    if (!frameOwnsBadge) return null;
    let overlay = document.getElementById("__duet_overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "__duet_overlay";
    overlay.style.cssText = `
      position: fixed; bottom: 22px; right: 22px; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      pointer-events: none; display: flex; flex-direction: column;
      align-items: flex-end; gap: 8px;
    `;
    (document.documentElement || document.body).appendChild(overlay);
    restoreBadgePosition();
    // If the user is already in fullscreen when we mount, re-parent right away
    // so the badge appears inside the fullscreen subtree.
    setTimeout(reparentOverlayForFullscreen, 0);
    return overlay;
  }

  // ── Fullscreen visibility ──────────────────────────────────
  // When any element on the page enters fullscreen, only that element's
  // subtree is rendered — our overlay (which lives at <html> root) goes
  // invisible. Re-parent it into the fullscreen element so the user can
  // still drag it, send chat messages, and react without leaving fullscreen.
  // On exit, move it back to the document root.
  function reparentOverlayForFullscreen() {
    if (!frameOwnsBadge) return;
    const overlay = document.getElementById("__duet_overlay");
    if (!overlay) return;
    const fsEl = document.fullscreenElement
              || document.webkitFullscreenElement
              || document.msFullscreenElement
              || null;
    const wantedParent = fsEl || document.documentElement || document.body;
    if (overlay.parentNode !== wantedParent) {
      try { wantedParent.appendChild(overlay); } catch {}
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
    const overlay = document.getElementById("__duet_overlay");
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
  // The badge can collapse into a small circular "tray" puck that takes
  // less screen space. State is persisted so it survives reloads.
  let isMinimized = false;
  function setMinimized(value) {
    if (isMinimized === value) return;
    isMinimized = !!value;
    try { chrome.storage.local.set({ __duet_minimized: isMinimized }); } catch {}
    applyMinimizedDom();
  }
  function applyMinimizedDom() {
    const badge = document.getElementById("__duet_badge");
    const tray  = document.getElementById("__pp_tray");
    if (!badge || !tray) return;
    if (isMinimized) {
      badge.style.display = "none";
      tray.style.display = "inline-flex";
    } else {
      badge.style.display = "flex";
      tray.style.display = "none";
    }
  }
  // Re-clamp on viewport resize so the badge doesn't end up off-screen when
  // the window shrinks or rotates.
  window.addEventListener("resize", () => {
    const overlay = document.getElementById("__duet_overlay");
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
      const overlay = document.getElementById("__duet_overlay");
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

    const finish = (e) => {
      if (!drag) return;
      try { handle.releasePointerCapture(drag.pointerId); } catch {}
      handle.style.cursor = "grab";
      if (drag.moved) {
        const overlay = document.getElementById("__duet_overlay");
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

  function render() {
    if (!frameOwnsBadge) return;
    const overlay = ensureOverlay();
    let badge = document.getElementById("__duet_badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "__duet_badge";
      badge.style.cssText = `
        position: relative;
        background: linear-gradient(135deg, rgba(15,13,24,0.92), rgba(8,7,13,0.94));
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 16px;
        color: #f4f1ea; font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em;
        box-shadow: 0 10px 28px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04) inset;
        transition: opacity 0.35s, transform 0.35s;
        opacity: 0; transform: translateY(6px);
        display: flex; flex-direction: column; pointer-events: auto;
      `;
      
      const topBar = document.createElement("div");
      topBar.id = "__pp_topbar";
      topBar.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 7px 14px 7px 11px; cursor: grab; touch-action: none; user-select: none;";
      badge.appendChild(topBar);

      // Drag the whole overlay by its top bar. Position is persisted to
      // chrome.storage so the badge stays where the user put it across loads.
      installBadgeDrag(topBar);

      const controls = document.createElement("div");
      controls.id = "__pp_controls";
      controls.style.cssText = "display: none; flex-direction: column; gap: 8px; padding: 0 14px 12px 14px;";
      
      controls.innerHTML = `
        <div style="height: 1px; background: rgba(255,255,255,0.1); width: 100%; margin-bottom: 2px;"></div>
        <button id="__pp_sync_btn" aria-label="Sync partner to my current timestamp" style="background: rgba(255,255,255,0.1); border: none; color: white; border-radius: 6px; padding: 6px; font-weight: 600; cursor: pointer; transition: background 0.2s; font-size: 11px;">${escapeHtml(syncBtnDefaultLabel())}</button>
        <div style="display: flex; gap: 6px; align-items: center;">
          ${['😂', '💖', '🔥', '😭'].map(e => `<button class="__pp_re_btn" data-emoji="${e}" aria-label="Send ${e} reaction" style="background: rgba(255,255,255,0.05); border: none; border-radius: 6px; cursor: pointer; font-size: 15px; padding: 4px 6px; transition: background 0.2s; flex: 1;">${twemojiHtml(e)}</button>`).join('')}
          <button id="__pp_more_emojis" title="More emojis" aria-label="Open full emoji picker" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 700; padding: 4px 8px; color: rgba(244,241,234,0.7); flex-shrink: 0;">+</button>
        </div>
        <div style="position: relative;">
          <input id="__pp_chat_input" type="text" aria-label="Type a message to send to your partner" placeholder="Send a message…" maxlength="140" autocomplete="off" spellcheck="false" style="width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 6px 26px 6px 8px; color: #f4f1ea; font-family: inherit; font-size: 11px; outline: none; transition: border-color 0.2s;" />
          <span id="__pp_chat_hint" style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 9px; color: rgba(244,241,234,0.4); pointer-events: none;">↵</span>
        </div>
      `;

      // Floating emoji picker — sibling of the badge, absolutely positioned
      // so it pops *above* the badge instead of inflating its height. Keeps
      // the badge itself compact.
      const emojiPopover = document.createElement("div");
      emojiPopover.id = "__pp_emoji_drawer";
      emojiPopover.style.cssText = `
        display: none; position: absolute; bottom: calc(100% + 8px); right: 0;
        flex-direction: column; gap: 6px;
        background: linear-gradient(135deg, rgba(15,13,24,0.96), rgba(8,7,13,0.98));
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 12px; padding: 8px;
        box-shadow: 0 14px 30px rgba(0,0,0,0.5);
        width: 240px; pointer-events: auto;
      `;
      emojiPopover.innerHTML = `
        <div id="__pp_emoji_tabs" style="display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;"></div>
        <div id="__pp_emoji_grid" style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 3px; max-height: 140px; overflow-y: auto; scrollbar-width: thin;"></div>
      `;
      badge.appendChild(emojiPopover);
      badge.appendChild(controls);

      // Interactions
      badge.addEventListener('mouseenter', () => { if(S.connected) controls.style.display = 'flex'; });
      badge.addEventListener('mouseleave', () => {
        // Don't collapse while the chat input is focused
        if (controls.dataset.locked === '1') return;
        controls.style.display = 'none';
      });

      const syncBtn = controls.querySelector('#__pp_sync_btn');
      syncBtn.addEventListener('mouseenter', () => syncBtn.style.background = 'rgba(255,255,255,0.2)');
      syncBtn.addEventListener('mouseleave', () => syncBtn.style.background = 'rgba(255,255,255,0.1)');
      syncBtn.addEventListener('click', async () => {
        if (syncBtn.disabled) return;
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
          // Show undo button for 5s after successful sync
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
      });

      // Helper to send a reaction + show locally + record in shared recents.
      const sendEmoji = (emoji) => {
        safeSend({ type: "SEND_REACTION", emoji });
        spawnReaction(emoji, { fromSelf: true });
        recordRecentEmoji(emoji);
      };

      controls.querySelectorAll('.__pp_re_btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(255,255,255,0.15)');
        btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(255,255,255,0.05)');
        btn.addEventListener('click', (e) => {
          const emoji = e.target.dataset.emoji || e.target.textContent;
          sendEmoji(emoji);
        });
      });

      // ── Expanded emoji picker drawer ───────────────────────
      // Tabbed categories + scrollable grid + Recent (synced with the popup
      // via shared chrome.storage key). Opens/closes on the "+" button.
      const emojiDrawer = badge.querySelector('#__pp_emoji_drawer');
      const emojiTabs   = badge.querySelector('#__pp_emoji_tabs');
      const emojiGrid   = badge.querySelector('#__pp_emoji_grid');
      const moreBtn     = controls.querySelector('#__pp_more_emojis');

      const EMOJI_PACKS = {
        "Faces":  ["😂","😭","😍","😮","😎","🤩","🥳","🤔","🙄","🥺","😴","😡","🤯","🤡","💀","😴","😅","🤣","😢","😱"],
        "Love":   ["❤️","💖","💕","💞","💘","💝","💓","💗","💜","🧡","💛","💚","💙","🤍","🖤","💔","✨","💯","🔥","🌹"],
        "Hands":  ["👍","👎","👊","👋","👏","🙌","✌️","🤝","🙏","💪","🤘","🤟","🖖","🖐️","👌","🤙","✊","🫶","🫰","☝️"],
        "Vibes":  ["🎬","🍿","🍕","🍺","🥂","🚀","🌈","☀️","🌙","🎉","🎈","💎","👾","🍔","🍦","🎸","🎮","🎵","🍷","🥶"]
      };

      let activeTab = "Recent";
      let recentList = [];

      const renderTabs = () => {
        emojiTabs.innerHTML = "";
        const tabs = [];
        if (recentList.length) tabs.push("Recent");
        tabs.push(...Object.keys(EMOJI_PACKS));
        if (!tabs.includes(activeTab)) activeTab = tabs[0];
        for (const tab of tabs) {
          const b = document.createElement("button");
          b.textContent = tab;
          b.style.cssText = `
            background: ${tab === activeTab ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.04)"};
            border: 1px solid ${tab === activeTab ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)"};
            color: ${tab === activeTab ? "#f4f1ea" : "rgba(244,241,234,0.55)"};
            border-radius: 999px; padding: 3px 10px; font-size: 10px; font-weight: 600;
            cursor: pointer; flex-shrink: 0; white-space: nowrap; transition: all 0.15s;
          `;
          b.addEventListener("click", () => { activeTab = tab; renderTabs(); renderGrid(); });
          emojiTabs.appendChild(b);
        }
      };

      const renderGrid = () => {
        emojiGrid.innerHTML = "";
        const list = activeTab === "Recent" ? recentList : (EMOJI_PACKS[activeTab] || []);
        if (!list.length) {
          const empty = document.createElement("div");
          empty.textContent = "Pick one to get started.";
          empty.style.cssText = "grid-column: 1/-1; text-align:center; color: rgba(244,241,234,0.4); font-size:10px; padding: 12px 0;";
          emojiGrid.appendChild(empty);
          return;
        }
        for (const emoji of list) {
          const b = document.createElement("button");
          b.innerHTML = twemojiHtml(emoji);
          b.style.cssText = `
            background: none; border: none; cursor: pointer;
            font-size: 18px; padding: 4px; border-radius: 6px;
            display: grid; place-items: center; aspect-ratio: 1;
            transition: background 0.15s, transform 0.1s;
          `;
          b.addEventListener("mouseenter", () => { b.style.background = "rgba(255,255,255,0.10)"; b.style.transform = "scale(1.18)"; });
          b.addEventListener("mouseleave", () => { b.style.background = "none"; b.style.transform = "scale(1)"; });
          b.addEventListener("click", () => {
            sendEmoji(emoji);
            // Re-render the Recent tab so the picked one moves to the front.
            if (activeTab === "Recent") setTimeout(() => { loadRecents().then(() => { renderTabs(); renderGrid(); }); }, 50);
          });
          emojiGrid.appendChild(b);
        }
      };

      const loadRecents = () => new Promise((resolve) => {
        try {
          chrome.storage.local.get(["__duet_emoji_recents"], (data) => {
            recentList = Array.isArray(data?.__duet_emoji_recents) ? data.__duet_emoji_recents.slice(0, 12) : [];
            resolve();
          });
        } catch { resolve(); }
      });

      moreBtn.addEventListener("mouseenter", () => moreBtn.style.background = "rgba(255,255,255,0.12)");
      moreBtn.addEventListener("mouseleave", () => moreBtn.style.background = "rgba(255,255,255,0.05)");
      moreBtn.addEventListener("click", async () => {
        const open = emojiDrawer.style.display !== "none";
        if (open) {
          emojiDrawer.style.display = "none";
          moreBtn.textContent = "+";
        } else {
          await loadRecents();
          activeTab = recentList.length ? "Recent" : "Faces";
          renderTabs();
          renderGrid();
          emojiDrawer.style.display = "flex";
          moreBtn.textContent = "−";
        }
      });

      // Inline chat — Enter sends a message via the existing reaction channel
      // (popup uses the same path), so partner sees it as a floating message.
      const chatInput = controls.querySelector('#__pp_chat_input');
      if (chatInput) {
        chatInput.addEventListener('focus', () => { chatInput.style.borderColor = 'rgba(244,114,182,0.5)'; });
        chatInput.addEventListener('blur',  () => { chatInput.style.borderColor = 'rgba(255,255,255,0.1)'; });
        // Don't let typing trigger site-level shortcuts (YouTube j/k/l, space, etc.)
        chatInput.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const text = chatInput.value.trim().slice(0, 140);
            if (!text) return;
            safeSend({ type: "SEND_REACTION", emoji: text });
            spawnReaction(text, { fromSelf: true });
            chatInput.value = '';
            chatInput.style.borderColor = '#5ee2a0';
            setTimeout(() => { chatInput.style.borderColor = 'rgba(244,114,182,0.5)'; }, 500);
          }
        });
        // Keep the controls panel open while typing, even if the mouse drifts off.
        chatInput.addEventListener('focus', () => { controls.dataset.locked = '1'; });
        chatInput.addEventListener('blur',  () => { delete controls.dataset.locked; });
        // Send typing indicator while user is typing
        let typingThrottle = null;
        chatInput.addEventListener('input', () => {
          if (!typingThrottle) {
            safeSend({ type: 'SEND_TYPING' });
            typingThrottle = setTimeout(() => { typingThrottle = null; }, 2000);
          }
        });
      }

      overlay.appendChild(badge);

      // ── Minimized tray chip ────────────────────────────────
      // A small circular puck that takes the badge's place when minimized.
      // Click to expand back. Drag-able by the same handle. Holds the same
      // status emoji + dot so the user knows sync state at a glance.
      const tray = document.createElement("div");
      tray.id = "__pp_tray";
      tray.style.cssText = `
        display: none; align-items: center; gap: 6px;
        background: linear-gradient(135deg, rgba(15,13,24,0.95), rgba(8,7,13,0.97));
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        padding: 6px 12px 6px 10px;
        color: #f4f1ea; font-size: 12px; font-weight: 700;
        cursor: grab; pointer-events: auto; user-select: none;
        touch-action: none;
        box-shadow: 0 8px 22px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04) inset;
      `;
      tray.title = "Click to expand · drag to move";
      overlay.appendChild(tray);
      installBadgeDrag(tray);
      // Click (without drag) expands the badge back.
      tray.addEventListener("click", (e) => {
        if (e.defaultPrevented) return; // drag finish swallowed it
        setMinimized(false);
      });
    }
    
    if (S.connected) {
      let color = "#ffc89a";
      let text = "waiting for partner";
      let emoji = S.partnerEmoji || "👋";

      if (S.peerCount >= 2) {
        if (S.driftStatus === "sync")           { color = "#5ee2a0"; text = S.partnerTyping ? "typing…" : "in sync";           emoji = S.partnerTyping ? "💬" : "💞"; }
        else if (S.driftStatus === "warning")   { color = "#fcd34d"; text = S.partnerTyping ? "typing…" : "slight delay";     emoji = S.partnerTyping ? "💬" : "⏳"; }
        else if (S.driftStatus === "out_of_sync") { color = "#ef4444"; text = S.partnerTyping ? "typing…" : "out of sync";    emoji = S.partnerTyping ? "💬" : "⚠️"; }
        else if (S.driftStatus === "mismatch")  { color = "#ef4444"; text = S.partnerTyping ? "typing…" : "different video"; emoji = S.partnerTyping ? "💬" : "🎬"; }
        else                                          { color = "#ffc89a"; text = S.partnerTyping ? "typing…" : "waiting for video"; emoji = S.partnerTyping ? "💬" : "📺"; }
      }

      // Connection quality: color-code ping
      let pingText = "";
      if (typeof S.lastPingMs === "number") {
        const pingColor = S.lastPingMs < 100 ? "#5ee2a0" : S.lastPingMs < 300 ? "#fcd34d" : "#ef4444";
        pingText = `<span style="color:${pingColor};font-size:9px;font-weight:500;margin-left:2px;">${S.lastPingMs}ms</span>`;
      }

      const topbar = document.getElementById("__pp_topbar");
      topbar.innerHTML = `
        <span style="width:7px;height:7px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color}, 0 0 0 3px ${color}1f;display:inline-block;transition:all 0.3s;"></span>
        <span style="background:linear-gradient(110deg,#ffc89a,#f472b6,#8b5cf6);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:700">Duet</span>
        <span style="color:rgba(244,241,234,0.55);font-weight:500">·</span>
        <span style="font-size:12px;line-height:1;">${twemojiHtml(emoji)}</span>
        <span style="color:rgba(244,241,234,0.85);transition:color 0.3s;flex:1;">${text}</span>
        ${pingText}
        <button id="__pp_min_btn" title="Minimize to tray" style="background:rgba(255,255,255,0.06);border:none;color:rgba(244,241,234,0.7);width:18px;height:18px;border-radius:50%;cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center;padding:0;margin-left:4px;">−</button>
      `;
      const minBtn = topbar.querySelector("#__pp_min_btn");
      if (minBtn) {
        minBtn.addEventListener("click", (e) => { e.stopPropagation(); setMinimized(true); });
        // Stop pointerdown so the drag handler doesn't claim the click.
        minBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      }

      // Render tray content (collapsed view) with the same status info.
      const tray = document.getElementById("__pp_tray");
      if (tray) {
        tray.innerHTML = `
          <span style="width:8px;height:8px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};display:inline-block;"></span>
          <span style="font-size:14px;line-height:1;">${twemojiHtml(emoji)}</span>
        `;
      }
      applyMinimizedDom();
      badge.style.opacity = isMinimized ? "0" : "1";
      badge.style.transform = "translateY(0)";
    } else {
      badge.style.opacity = "0";
      badge.style.transform = "translateY(6px)";
      const tray = document.getElementById("__pp_tray");
      if (tray) tray.style.display = "none";
      const ctrl = document.getElementById("__pp_controls");
      if (ctrl) ctrl.style.display = 'none';
    }
  }

  // ── Undo sync ──────────────────────────────────────────────
  // Shows a temporary "Undo" button after a successful catch-up sync.
  // Clicking it seeks the video back to the pre-sync position.
  function showUndoButton() {
    const controls = document.getElementById("__pp_controls");
    if (!controls || preSyncPosition === null) return;

    // Remove any existing undo button first
    const existing = document.getElementById("__pp_undo_btn");
    if (existing) existing.remove();

    const undoBtn = document.createElement("button");
    undoBtn.id = "__pp_undo_btn";
    undoBtn.textContent = "↩ Undo sync";
    undoBtn.style.cssText = "background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; border-radius: 6px; padding: 5px; font-weight: 600; cursor: pointer; transition: background 0.2s; font-size: 11px; width: 100%;";
    undoBtn.addEventListener("mouseenter", () => { undoBtn.style.background = "rgba(239,68,68,0.25)"; });
    undoBtn.addEventListener("mouseleave", () => { undoBtn.style.background = "rgba(239,68,68,0.15)"; });
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

    // Insert after the sync button
    const syncBtnEl = controls.querySelector("#__pp_sync_btn");
    if (syncBtnEl && syncBtnEl.nextSibling) {
      controls.insertBefore(undoBtn, syncBtnEl.nextSibling);
    } else {
      controls.appendChild(undoBtn);
    }

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
    let flash = document.getElementById("__duet_flash");
    if (!flash) {
      flash = document.createElement("div");
      flash.id = "__duet_flash";
      flash.style.cssText = `
        background: linear-gradient(135deg, rgba(15,13,24,0.94), rgba(8,7,13,0.96));
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 14px;
        color: #f4f1ea;
        font-size: 13px; font-weight: 600;
        padding: 10px 14px;
        display: flex; align-items: center; gap: 10px;
        pointer-events: none;
        box-shadow: 0 14px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset;
        transition: opacity 0.4s ease, transform 0.4s ease;
        opacity: 0; transform: translateY(10px) scale(0.96);
      `;
      overlay.insertBefore(flash, overlay.firstChild);
    }
    const isPlay = action === "play";
    const accent = isPlay ? "#5ee2a0" : "#ffc89a";
    const glyph = isPlay
      ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 1.5v9l8-4.5L3 1.5z" fill="currentColor"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2.5" y="1.5" width="2.5" height="9" rx="0.7" fill="currentColor"/><rect x="7" y="1.5" width="2.5" height="9" rx="0.7" fill="currentColor"/></svg>';
    const who = S.partnerName || "Partner";
    const label = customLabel || (isPlay ? `${who} played` : `${who} paused`);
    // Lead with partner's avatar (illustrated portrait or emoji fallback) so
    // the flash visually maps to who triggered it.
    const avatarMarkup = avatarHtml(S.partnerEmoji, 22);
    const iconMarkup = avatarMarkup
      ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;overflow:hidden;flex-shrink:0;box-shadow:0 0 0 1px rgba(255,255,255,0.10);">${avatarMarkup}</span>`
      : `<span style="display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:${accent}1a;color:${accent};box-shadow:0 0 0 1px ${accent}33 inset">${glyph}</span>`;
    flash.innerHTML = `${iconMarkup}<span>${twemojiHtml(label)}</span>`;
    flash.style.opacity = "1";
    flash.style.transform = "translateY(0) scale(1)";
    clearTimeout(flash.__t);
    flash.__t = setTimeout(() => {
      flash.style.opacity = "0";
      flash.style.transform = "translateY(10px) scale(0.96)";
    }, 2500);
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

  // Toast for partner presence transitions (joined / left). Slides in from
  // top, dwells ~2.5s, slides out. Replaces any existing presence toast so
  // rapid join→leave→join doesn't pile up.
  let __pp_presenceToastTimer = null;
  function showPresenceToast(text, kind) {
    let toast = document.getElementById("__pp_presence_toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__pp_presence_toast";
      toast.style.cssText = `
        position: fixed; left: 50%; top: 60px; transform: translateX(-50%) translateY(-12px);
        z-index: 2147483647; pointer-events: none;
        background: linear-gradient(135deg, rgba(15,13,24,0.96), rgba(8,7,13,0.98));
        backdrop-filter: blur(14px) saturate(1.4);
        -webkit-backdrop-filter: blur(14px) saturate(1.4);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        padding: 8px 16px;
        color: #f4f1ea;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
        font-size: 12px; font-weight: 700;
        display: inline-flex; align-items: center; gap: 8px;
        box-shadow: 0 14px 30px rgba(0,0,0,0.5);
        opacity: 0;
        transition: opacity 0.3s, transform 0.3s;
      `;
      (document.documentElement || document.body).appendChild(toast);
    }
    const accent = kind === "leave" ? "#ff6b7a" : "#5ee2a0";
    const dot = `<span style="width:8px;height:8px;border-radius:50%;background:${accent};box-shadow:0 0 8px ${accent};display:inline-block;"></span>`;
    const av = avatarHtml(S.partnerEmoji, 18);
    toast.innerHTML = `${av ? `<span style="display:inline-flex;width:18px;height:18px;border-radius:50%;overflow:hidden;">${av}</span>` : dot}<span>${escapeHtml(text)}</span>`;
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(0)";
    });
    if (__pp_presenceToastTimer) clearTimeout(__pp_presenceToastTimer);
    __pp_presenceToastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%) translateY(-12px)";
    }, 2800);
  }

  // Single transient pill near the badge for system status (buffering, etc.).
  // Replaces an existing pill rather than stacking, so spamming "waiting" events
  // doesn't pile up on screen. Auto-dismisses after 3.5s.
  let __pp_systemPillTimer = null;
  function showSystemPill(text) {
    let pill = document.getElementById("__pp_system_pill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "__pp_system_pill";
      pill.style.cssText = `
        position: fixed; left: 50%; top: 22px; transform: translateX(-50%);
        z-index: 2147483647; pointer-events: none;
        background: linear-gradient(135deg, rgba(15,13,24,0.94), rgba(8,7,13,0.96));
        backdrop-filter: blur(14px) saturate(1.4);
        -webkit-backdrop-filter: blur(14px) saturate(1.4);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        padding: 7px 14px;
        color: #f4f1ea;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
        font-size: 12px; font-weight: 600;
        box-shadow: 0 10px 24px rgba(0,0,0,0.4);
        opacity: 0;
        transition: opacity 0.25s, transform 0.25s;
      `;
      (document.documentElement || document.body).appendChild(pill);
    }
    const partnerLabel = S.partnerName ? `${S.partnerName}` : "Partner";
    pill.textContent = text.replace(/^⏳ Buffering/i, `⏳ ${partnerLabel} is buffering`).replace(/\.{3,}$/, "…");
    requestAnimationFrame(() => {
      pill.style.opacity = "1";
      pill.style.transform = "translateX(-50%) translateY(0)";
    });
    if (__pp_systemPillTimer) clearTimeout(__pp_systemPillTimer);
    __pp_systemPillTimer = setTimeout(() => {
      pill.style.opacity = "0";
      pill.style.transform = "translateX(-50%) translateY(-6px)";
    }, 3500);
  }

  function spawnFloatingEmoji(emoji, fromSelf) {
    const node = document.createElement("div");
    node.innerHTML = twemojiHtml(emoji);
    const startX = fromSelf
      ? 60 + Math.random() * 30        // self → right-ish (60-90%)
      : 10 + Math.random() * 30;       // partner → left-ish (10-40%)
    node.style.cssText = `
      position: fixed; left: ${startX}%; bottom: 80px; font-size: 48px;
      z-index: 2147483647; pointer-events: none;
      filter: drop-shadow(0 4px 14px rgba(0,0,0,0.45));
      animation: __pp_float 2.6s cubic-bezier(.2,.7,.3,1) forwards; opacity: 0;
    `;
    (document.documentElement || document.body).appendChild(node);
    setTimeout(() => node.remove(), 2700);
  }

  // Subtitle-style scrolling chat. Improvements over the original:
  //  1) Duration scales with message length (~12 chars/sec) so short and long
  //     messages all travel at a comfortable reading pace.
  //  2) Direction encodes sender: self → left-to-right, partner → right-to-left.
  //  3) Lane reservation prevents messages from piling up on each other when
  //     they come fast.
  //  4) Sender prefix ("You ·" / "Alice ·") survives even on washed-out video.
  //  5) Subtle blurred dark strip keeps text legible over bright frames
  //     without becoming a bubble.
  //  6) Hover-to-pause for re-reading.
  //  7) Italic for partner / upright for self adds typographic attribution.

  // Lane manager: 9 vertical lanes from 10% to 75% in 8.1% steps. A lane is
  // marked busy until its `freeAt` timestamp passes (set to ~50% of slide
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

    // (1) Reading-paced duration. Base 6s + ~80ms per character (≈12 chars/sec
    //     visible). Clamp to [7s, 22s] so 1-char messages still register and
    //     140-char messages don't camp the screen.
    const durSec = Math.max(7, Math.min(22, 6 + len * 0.08));
    const durationMs = durSec * 1000;

    // (3) Lane.
    const topY = pickLane(durationMs);

    // (2) Direction.
    const direction = fromSelf ? "ltr" : "rtl";

    // Adapt font-size to length so very long messages still fit on one line
    const fontSize = len < 30 ? 28 : len < 70 ? 22 : 18;
    const accent = fromSelf ? "#c4b5fd" : "#ffc89a"; // violet vs peach

    // (4) Sender prefix.
    const who = fromSelf ? "You" : (S.partnerName || "Partner");

    const node = document.createElement("div");
    // (6) Hover-to-pause needs pointer events on, but the wrapper is a strip
    //     of arbitrary width — only its inner content is interactive.
    node.style.cssText = `
      position: fixed; top: ${topY}%; z-index: 2147483647;
      max-width: 70vw; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      font-size: ${fontSize}px;
      animation: __pp_slide_${direction} ${durSec}s linear forwards;
      will-change: transform;
      ${direction === "ltr" ? "left: -100%;" : "right: -100%;"}
    `;

    // (5) Subtle backdrop strip. Padding + faint dark blur for legibility,
    //     no border or shadow that screams "card".
    const inner = document.createElement("span");
    inner.style.cssText = `
      display: inline-flex; align-items: baseline; gap: 0.6em;
      padding: 4px 12px;
      background: rgba(0,0,0,0.42);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      border-radius: 6px;
      pointer-events: auto;
      ${fromSelf ? "" : "font-style: italic;"}  /* (7) typographic attribution */
    `;

    const senderEl = document.createElement("span");
    senderEl.style.cssText = `
      font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
      font-size: 0.62em; color: ${accent};
      text-shadow: 0 0 8px ${accent}66;
      flex-shrink: 0; font-style: normal;
      display: inline-flex; align-items: center; gap: 5px;
    `;
    // Tiny avatar inline with the sender label so attribution survives even
    // on bright frames where color contrast washes out.
    const avatarVal = fromSelf ? myEmoji : S.partnerEmoji;
    senderEl.innerHTML = `${avatarHtml(avatarVal, 14) || ""}<span>${escapeHtml(who)}</span>`;

    const textEl = document.createElement("span");
    textEl.textContent = trimmed;
    textEl.style.cssText = `
      font-weight: 800; letter-spacing: 0.005em;
      color: #f4f1ea; white-space: nowrap;
      text-shadow:
        2px 2px 4px rgba(0,0,0,0.9),
        -1px -1px 0 #000, 1px -1px 0 #000,
        -1px 1px 0 #000, 1px 1px 0 #000;
    `;

    inner.appendChild(senderEl);
    inner.appendChild(textEl);
    node.appendChild(inner);

    // (6) Hover-to-pause.
    inner.addEventListener("mouseenter", () => { node.style.animationPlayState = "paused"; });
    inner.addEventListener("mouseleave", () => { node.style.animationPlayState = "running"; });

    (document.documentElement || document.body).appendChild(node);
    setTimeout(() => node.remove(), durationMs + 100);
  }

  // Inject keyframes + bubble styles once
  (function injectReactionStyles() {
    if (document.getElementById("__pp_styles")) return;
    const s = document.createElement("style");
    s.id = "__pp_styles";
    s.textContent = `
      @keyframes __pp_float {
        0%   { opacity: 0; transform: translateY(20px)  scale(0.6) rotate(-8deg); }
        15%  { opacity: 1; transform: translateY(0)     scale(1.1) rotate(2deg); }
        30%  {              transform: translateY(-30px) scale(1)   rotate(-2deg); }
        100% { opacity: 0; transform: translateY(-220px) scale(0.9) rotate(6deg); }
      }
      /* Right-to-left (partner): enters from right edge, exits left. */
      @keyframes __pp_slide_rtl {
        0%   { transform: translateX(0); }
        100% { transform: translateX(-180vw); }
      }
      /* Left-to-right (self): enters from left edge, exits right. */
      @keyframes __pp_slide_ltr {
        0%   { transform: translateX(0); }
        100% { transform: translateX(180vw); }
      }
      /* Hide scrollbar for emoji picker */
      #__pp_controls > div:nth-child(3)::-webkit-scrollbar { display: none; }

      /* ── Reduced-motion ─────────────────────────────────── */
      @media (prefers-reduced-motion: reduce) {
        /* Floating emoji: skip travel, just fade in/out in place */
        @keyframes __pp_float {
          0%   { opacity: 0; transform: none; }
          15%  { opacity: 1; transform: none; }
          85%  { opacity: 1; transform: none; }
          100% { opacity: 0; transform: none; }
        }
        /* Chat slides: cross-fade instead of scrolling */
        @keyframes __pp_slide_rtl {
          0%   { opacity: 0; transform: none; }
          8%   { opacity: 1; transform: none; }
          92%  { opacity: 1; transform: none; }
          100% { opacity: 0; transform: none; }
        }
        @keyframes __pp_slide_ltr {
          0%   { opacity: 0; transform: none; }
          8%   { opacity: 1; transform: none; }
          92%  { opacity: 1; transform: none; }
          100% { opacity: 0; transform: none; }
        }
        /* Badge & flash entrance / exit: near-instant */
        #__duet_badge,
        #__duet_flash,
        #__pp_presence_toast,
        #__pp_system_pill {
          transition-duration: 0.05s !important;
          animation-duration: 0.05s !important;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  })();

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
      // Toast on partner presence transitions.
      if (wasConnected) {
        if (prevPeerCount < 2 && nextPeerCount >= 2) {
          showPresenceToast(`${S.partnerName || "Partner"} is here`, "join");
        } else if (prevPeerCount >= 2 && nextPeerCount < 2) {
          showPresenceToast(`${S.partnerName || "Partner"} left the room`, "leave");
        }
      }
    } else if (message.type === "SHOW_REACTION") {
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
