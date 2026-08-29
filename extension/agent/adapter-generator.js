// ============================================================
//  Duet Agent — Adapter Generator
// ============================================================
// Takes a SiteAnalysis and generates a working adapter that
// conforms to DuetWatch's sync contract. The adapter hooks into
// the site's video player and exposes the standard interface:
//   - findVideo()
//   - attachListeners(video, sendSync)
//   - applySync(state, serverNow)
//   - getMetadata()
//
// Each adapter is a self-contained JS module that can be
// evaluated in any content-script context.

/**
 * @typedef {Object} SiteAnalysis
 * @property {string} url
 * @property {string} hostname
 * @property {boolean} hasVideo
 * @property {string|null} videoSelector
 * @property {string} framework
 * @property {Object} domStructure
 * @property {Array<{type:string, severity:string, description:string}>} challenges
 * @property {Array<{src:string, accessible:boolean, hasVideo:boolean}>} iframes
 * @property {number} confidence - 0-100
 */

/**
 * @typedef {Object} GeneratedAdapter
 * @property {string} id - unique adapter ID
 * @property {string} hostname - site this adapter targets
 * @property {string} framework - detected player framework
 * @property {string} code - the adapter JS source
 * @property {number} confidence - generation confidence
 * @property {string} strategy - which template was used
 * @property {string[]} hooks - which events/APIs the adapter hooks
 * @property {number} generatedAt - timestamp
 * @property {number} version - adapter version
 */

const AdapterGenerator = (() => {
  "use strict";

  let _adapterCounter = 0;
  function nextId() {
    return `adapter_${Date.now()}_${++_adapterCounter}`;
  }

  // ── Main Entry Point ───────────────────────────────────────
  /**
   * @param {SiteAnalysis} analysis
   * @returns {GeneratedAdapter}
   */
  function generate(analysis) {
    const strategy = selectStrategy(analysis);
    const code = buildAdapter(analysis, strategy);

    return {
      id: nextId(),
      hostname: analysis.hostname,
      framework: analysis.framework,
      code,
      confidence: analysis.confidence,
      strategy: strategy.name,
      hooks: strategy.hooks,
      generatedAt: Date.now(),
      version: 1
    };
  }

  // ── Strategy Selection ─────────────────────────────────────
  function selectStrategy(analysis) {
    // Priority order: framework-specific > shadow DOM > iframe > generic
    if (analysis.framework !== "none" && analysis.framework !== "unknown") {
      return STRATEGIES.frameworkSpecific;
    }

    const hasShadow = analysis.domStructure?.usesShadowDOM;
    if (hasShadow) {
      return STRATEGIES.shadowDom;
    }

    const hasCrossOrigin = analysis.iframes?.some(f => !f.accessible);
    if (hasCrossOrigin) {
      return STRATEGIES.crossOriginIframe;
    }

    const hasCustom = analysis.domStructure?.customPlayerElement;
    if (hasCustom) {
      return STRATEGIES.customPlayer;
    }

    return STRATEGIES.genericHtml5;
  }

  // ── Adapter Builder ────────────────────────────────────────
  function buildAdapter(analysis, strategy) {
    const template = strategy.template;
    return template(analysis);
  }

  // ── Strategy Definitions ───────────────────────────────────
  const STRATEGIES = {
    // ── Generic HTML5 Video ─────────────────────────────────
    genericHtml5: {
      name: "generic_html5",
      hooks: ["play", "pause", "seeked", "ratechange", "waiting", "playing", "timeupdate"],
      template: (analysis) => `
// Duet Adapter — Generic HTML5 Video
// Generated for: ${analysis.hostname}
// Strategy: ${analysis.strategy || "generic"}
(function() {
  "use strict";

  const ADAPTER_ID = "${analysis.hostname}_generic_${Date.now()}";
  const VIDEO_SELECTOR = ${JSON.stringify(analysis.videoSelector || "video")};

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;

    // If we have a specific selector, try it first
    if (VIDEO_SELECTOR && VIDEO_SELECTOR !== "video") {
      try {
        const specific = document.querySelector(VIDEO_SELECTOR);
        if (specific && specific.tagName === "VIDEO") return specific;
      } catch {}
    }

    // Score-based selection (matches DuetWatch's approach)
    let best = null, bestScore = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 &&
        getComputedStyle(v).visibility !== "hidden";
      if (!visible) continue;
      const area = r.width * r.height;
      const ready = v.readyState >= 2 ? 1e6 : 0;
      const score = area + ready;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  function attachListeners(video, sendSync) {
    if (video._duetAdapterAttached) return;
    video._duetAdapterAttached = true;

    const guard = (fn) => () => { try { fn(); } catch {} };

    video.addEventListener("play",       guard(() => sendSync("play")));
    video.addEventListener("pause",      guard(() => sendSync("pause")));
    video.addEventListener("seeked",     guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("ratechange", guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("waiting",    guard(() => { if (!video._duetRemoteApply) sendSync("pause"); }));
    video.addEventListener("playing",    guard(() => sendSync("play")));
  }

  function applySync(video, state, serverNow) {
    if (!video) return;

    let targetTime = state.currentTime;
    if (state.action === "play" && typeof state.serverTime === "number" && typeof serverNow === "number") {
      const elapsed = Math.max(0, (serverNow - state.serverTime) / 1000);
      targetTime = state.currentTime + elapsed;
    }

    const driftThreshold = state.force ? 0 : 1.0;
    if (Math.abs(video.currentTime - targetTime) > driftThreshold) {
      try { video.currentTime = targetTime; } catch {}
    }

    if (state.playbackRate && Math.abs(video.playbackRate - state.playbackRate) > 0.01) {
      try { video.playbackRate = state.playbackRate; } catch {}
    }

    video._duetRemoteApply = true;
    if (state.action === "play" && video.paused) {
      video.play().catch(() => {});
    } else if (state.action === "pause" && !video.paused) {
      video.pause();
    }
    setTimeout(() => { video._duetRemoteApply = false; }, 500);
  }

  function getMetadata(video) {
    if (!video) return null;
    return {
      url: location.href,
      hostname: location.hostname.replace(/^www\\./, ""),
      pageTitle: document.title,
      videoTitle: document.querySelector('meta[property="og:title"]')?.content || document.title,
      duration: isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime,
      paused: video.paused
    };
  }

  // Expose to DuetWatch content script
  window.__duetAdapter = {
    id: ADAPTER_ID,
    findVideo,
    attachListeners,
    applySync,
    getMetadata
  };
})();`
    },

    // ── Shadow DOM ──────────────────────────────────────────
    shadowDom: {
      name: "shadow_dom",
      hooks: ["play", "pause", "seeked", "ratechange", "waiting", "playing", "timeupdate", "shadow_root"],
      template: (analysis) => `
// Duet Adapter — Shadow DOM Player
// Generated for: ${analysis.hostname}
// Strategy: shadow_dom traversal
(function() {
  "use strict";

  const ADAPTER_ID = "${analysis.hostname}_shadow_${Date.now()}";

  function findVideoInShadow(root) {
    if (!root) return null;
    // Check this root
    const direct = root.querySelector("video");
    if (direct) return direct;
    // Recurse into shadow roots
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) {
        const found = findVideoInShadow(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function findVideo() {
    return findVideoInShadow(document);
  }

  function attachListeners(video, sendSync) {
    if (video._duetAdapterAttached) return;
    video._duetAdapterAttached = true;

    const guard = (fn) => () => { try { fn(); } catch {} };

    video.addEventListener("play",       guard(() => sendSync("play")));
    video.addEventListener("pause",      guard(() => sendSync("pause")));
    video.addEventListener("seeked",     guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("ratechange", guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("waiting",    guard(() => { if (!video._duetRemoteApply) sendSync("pause"); }));
    video.addEventListener("playing",    guard(() => sendSync("play")));
  }

  function applySync(video, state, serverNow) {
    if (!video) return;

    let targetTime = state.currentTime;
    if (state.action === "play" && typeof state.serverTime === "number" && typeof serverNow === "number") {
      targetTime = state.currentTime + Math.max(0, (serverNow - state.serverTime) / 1000);
    }

    if (Math.abs(video.currentTime - targetTime) > (state.force ? 0 : 1.0)) {
      try { video.currentTime = targetTime; } catch {}
    }
    if (state.playbackRate && Math.abs(video.playbackRate - state.playbackRate) > 0.01) {
      try { video.playbackRate = state.playbackRate; } catch {}
    }

    video._duetRemoteApply = true;
    if (state.action === "play" && video.paused) video.play().catch(() => {});
    else if (state.action === "pause" && !video.paused) video.pause();
    setTimeout(() => { video._duetRemoteApply = false; }, 500);
  }

  function getMetadata(video) {
    if (!video) return null;
    return {
      url: location.href,
      hostname: location.hostname.replace(/^www\\./, ""),
      pageTitle: document.title,
      videoTitle: document.title,
      duration: isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime,
      paused: video.paused
    };
  }

  window.__duetAdapter = { id: ADAPTER_ID, findVideo, attachListeners, applySync, getMetadata };
})();`
    },

    // ── Cross-Origin Iframe ─────────────────────────────────
    crossOriginIframe: {
      name: "cross_origin_iframe",
      hooks: ["play", "pause", "seeked", "ratechange", "postmessage"],
      template: (analysis) => `
// Duet Adapter — Cross-Origin Iframe Player
// Generated for: ${analysis.hostname}
// Strategy: postMessage bridge between parent and iframe
(function() {
  "use strict";

  const ADAPTER_ID = "${analysis.hostname}_iframe_${Date.now()}";
  const isTopFrame = window.top === window.self;

  // In the iframe: detect video and relay state to parent
  if (!isTopFrame) {
    function findVideo() {
      const videos = Array.from(document.querySelectorAll("video"));
      let best = null, bestScore = 0;
      for (const v of videos) {
        const r = v.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0;
        if (!visible) continue;
        const score = r.width * r.height + (v.readyState >= 2 ? 1e6 : 0);
        if (score > bestScore) { best = v; bestScore = score; }
      }
      return best;
    }

    function relayState(video) {
      if (!video) return;
      const state = {
        currentTime: video.currentTime,
        duration: isFinite(video.duration) ? video.duration : 0,
        paused: video.paused,
        playbackRate: video.playbackRate,
        readyState: video.readyState
      };
      window.parent?.postMessage({ __duet_iframe_state: state }, "*");
    }

    let lastRelay = 0;
    function attachListeners(video, sendSync) {
      if (video._duetAttached) return;
      video._duetAttached = true;

      const guard = (fn) => () => { try { fn(); } catch {} };

      video.addEventListener("play",       guard(() => { sendSync("play");  relayState(video); }));
      video.addEventListener("pause",      guard(() => { sendSync("pause"); relayState(video); }));
      video.addEventListener("seeked",     guard(() => { sendSync(video.paused ? "pause" : "play"); relayState(video); }));
      video.addEventListener("ratechange", guard(() => { sendSync(video.paused ? "pause" : "play"); }));
      video.addEventListener("timeupdate", guard(() => {
        const now = Date.now();
        if (now - lastRelay > 1000) { lastRelay = now; relayState(video); }
      }));
    }

    // Listen for remote sync from parent
    window.addEventListener("message", (e) => {
      if (e.data?.__duet_remote_sync) {
        const { action, currentTime, playbackRate, serverTime } = e.data.__duet_remote_sync;
        const video = findVideo();
        if (!video) return;

        let targetTime = currentTime;
        if (action === "play" && typeof serverTime === "number") {
          targetTime = currentTime + Math.max(0, (Date.now() - serverTime) / 1000);
        }

        if (Math.abs(video.currentTime - targetTime) > 0.5) {
          try { video.currentTime = targetTime; } catch {}
        }
        video._duetRemoteApply = true;
        if (action === "play" && video.paused) video.play().catch(() => {});
        else if (action === "pause" && !video.paused) video.pause();
        setTimeout(() => { video._duetRemoteApply = false; }, 500);
      }
    });

    function getMetadata(video) {
      if (!video) return null;
      return {
        url: location.href,
        hostname: location.hostname.replace(/^www\\./, ""),
        pageTitle: document.title,
        videoTitle: document.title,
        duration: isFinite(video.duration) ? video.duration : 0,
        currentTime: video.currentTime,
        paused: video.paused
      };
    }

    window.__duetAdapter = { id: ADAPTER_ID, findVideo, attachListeners, applySync: () => {}, getMetadata };
  }

  // In the top frame: listen for iframe state, relay remote sync down
  if (isTopFrame) {
    let iframeState = null;
    window.addEventListener("message", (e) => {
      if (e.data?.__duet_iframe_state) {
        iframeState = e.data.__duet_iframe_state;
      }
    });

    // Expose adapter that wraps iframe state
    window.__duetAdapter = {
      id: ADAPTER_ID,
      findVideo: () => null, // video is in iframe
      attachListeners: () => {},
      applySync: (video, state, serverNow) => {
        // Relay to iframe
        document.querySelectorAll("iframe").forEach(iframe => {
          try {
            iframe.contentWindow?.postMessage({
              __duet_remote_sync: { ...state, serverTime: serverNow }
            }, "*");
          } catch {}
        });
      },
      getMetadata: () => iframeState ? {
        url: location.href,
        hostname: location.hostname.replace(/^www\\./, ""),
        pageTitle: document.title,
        videoTitle: document.title,
        duration: iframeState.duration || 0,
        currentTime: iframeState.currentTime || 0,
        paused: iframeState.paused
      } : null
    };
  }
})();`
    },

    // ── Custom Player API ───────────────────────────────────
    customPlayer: {
      name: "custom_player",
      hooks: ["play", "pause", "seeked", "ratechange", "custom_api"],
      template: (analysis) => `
// Duet Adapter — Custom Player API
// Generated for: ${analysis.hostname}
// Strategy: hook into custom player element + fallback to <video>
(function() {
  "use strict";

  const ADAPTER_ID = "${analysis.hostname}_custom_${Date.now()}";

  function findVideo() {
    // Try the custom player's own video reference first
    const playerEl = document.querySelector("${analysis.domStructure?.customPlayerElement || '[class*=player]'}");
    if (playerEl) {
      // Some custom players store a reference
      if (playerEl.video) return playerEl.video;
      if (playerEl.player?.video) return playerEl.player.video;
      if (playerEl.getVideo) return playerEl.getVideo();
      // Try finding video within the player element
      const inner = playerEl.querySelector("video");
      if (inner) return inner;
    }

    // Fallback: any visible video
    const videos = Array.from(document.querySelectorAll("video"));
    let best = null, bestScore = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      if (!visible) continue;
      const score = r.width * r.height + (v.readyState >= 2 ? 1e6 : 0);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  function attachListeners(video, sendSync) {
    if (video._duetAdapterAttached) return;
    video._duetAdapterAttached = true;

    const guard = (fn) => () => { try { fn(); } catch {} };

    video.addEventListener("play",       guard(() => sendSync("play")));
    video.addEventListener("pause",      guard(() => sendSync("pause")));
    video.addEventListener("seeked",     guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("ratechange", guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("waiting",    guard(() => { if (!video._duetRemoteApply) sendSync("pause"); }));
    video.addEventListener("playing",    guard(() => sendSync("play")));

    // Also try to hook custom player events
    const playerEl = document.querySelector("${analysis.domStructure?.customPlayerElement || '[class*=player]'}");
    if (playerEl && playerEl.on) {
      try {
        playerEl.on("play",    guard(() => sendSync("play")));
        playerEl.on("pause",   guard(() => sendSync("pause")));
        playerEl.on("seeked",  guard(() => sendSync(video.paused ? "pause" : "play")));
      } catch {}
    }
  }

  function applySync(video, state, serverNow) {
    if (!video) return;

    let targetTime = state.currentTime;
    if (state.action === "play" && typeof state.serverTime === "number" && typeof serverNow === "number") {
      targetTime = state.currentTime + Math.max(0, (serverNow - state.serverTime) / 1000);
    }

    if (Math.abs(video.currentTime - targetTime) > (state.force ? 0 : 1.0)) {
      try { video.currentTime = targetTime; } catch {}
    }
    if (state.playbackRate && Math.abs(video.playbackRate - state.playbackRate) > 0.01) {
      try { video.playbackRate = state.playbackRate; } catch {}
    }

    video._duetRemoteApply = true;
    if (state.action === "play" && video.paused) video.play().catch(() => {});
    else if (state.action === "pause" && !video.paused) video.pause();
    setTimeout(() => { video._duetRemoteApply = false; }, 500);
  }

  function getMetadata(video) {
    if (!video) return null;
    return {
      url: location.href,
      hostname: location.hostname.replace(/^www\\./, ""),
      pageTitle: document.title,
      videoTitle: document.querySelector('meta[property="og:title"]')?.content || document.title,
      duration: isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime,
      paused: video.paused
    };
  }

  window.__duetAdapter = { id: ADAPTER_ID, findVideo, attachListeners, applySync, getMetadata };
})();`
    },

    // ── Framework-Specific ──────────────────────────────────
    frameworkSpecific: {
      name: "framework_specific",
      hooks: ["play", "pause", "seeked", "ratechange", "framework_api"],
      template: (analysis) => `
// Duet Adapter — ${analysis.framework} Player
// Generated for: ${analysis.hostname}
// Framework: ${analysis.framework}
(function() {
  "use strict";

  const ADAPTER_ID = "${analysis.hostname}_${analysis.framework}_${Date.now()}";
  const FRAMEWORK = "${analysis.framework}";

  function findVideo() {
    // Framework-specific video detection
    ${frameworkSpecificDetection(analysis.framework)}
  }

  function attachListeners(video, sendSync) {
    if (video._duetAdapterAttached) return;
    video._duetAdapterAttached = true;

    const guard = (fn) => () => { try { fn(); } catch {} };

    video.addEventListener("play",       guard(() => sendSync("play")));
    video.addEventListener("pause",      guard(() => sendSync("pause")));
    video.addEventListener("seeked",     guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("ratechange", guard(() => sendSync(video.paused ? "pause" : "play")));
    video.addEventListener("waiting",    guard(() => { if (!video._duetRemoteApply) sendSync("pause"); }));
    video.addEventListener("playing",    guard(() => sendSync("play")));
  }

  function applySync(video, state, serverNow) {
    if (!video) return;

    let targetTime = state.currentTime;
    if (state.action === "play" && typeof state.serverTime === "number" && typeof serverNow === "number") {
      targetTime = state.currentTime + Math.max(0, (serverNow - state.serverTime) / 1000);
    }

    if (Math.abs(video.currentTime - targetTime) > (state.force ? 0 : 1.0)) {
      try { video.currentTime = targetTime; } catch {}
    }
    if (state.playbackRate && Math.abs(video.playbackRate - state.playbackRate) > 0.01) {
      try { video.playbackRate = state.playbackRate; } catch {}
    }

    video._duetRemoteApply = true;
    if (state.action === "play" && video.paused) video.play().catch(() => {});
    else if (state.action === "pause" && !video.paused) video.pause();
    setTimeout(() => { video._duetRemoteApply = false; }, 500);
  }

  function getMetadata(video) {
    if (!video) return null;
    return {
      url: location.href,
      hostname: location.hostname.replace(/^www\\./, ""),
      pageTitle: document.title,
      videoTitle: document.querySelector('meta[property="og:title"]')?.content || document.title,
      duration: isFinite(video.duration) ? video.duration : 0,
      currentTime: video.currentTime,
      paused: video.paused
    };
  }

  window.__duetAdapter = { id: ADAPTER_ID, findVideo, attachListeners, applySync, getMetadata };
})();`
    }
  };

  // ── Framework-Specific Video Detection Code ────────────────
  function frameworkSpecificDetection(framework) {
    switch (framework) {
      case "youtube":
        return `
    // YouTube: video is in the player API or shadow DOM
    const ytPlayer = document.querySelector("ytd-player")?.player;
    if (ytPlayer?.getVideoUrl) {
      // YouTube player API available — get the video element
      const video = document.querySelector("video.html5-main-video") ||
                    document.querySelector("video[src*='googlevideo']");
      if (video) return video;
    }
    // Fallback: any visible video
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find(v => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && v.readyState >= 1;
    }) || videos[0] || null;`;

      case "vimeo":
        return `
    // Vimeo: check for player container
    const vimeoPlayer = document.querySelector(".vue-player, [data-vimeo-id]");
    if (vimeoPlayer) {
      const video = vimeoPlayer.querySelector("video");
      if (video) return video;
    }
    return document.querySelector("video") || null;`;

      case "netflix":
        return `
    // Netflix: player is heavily locked down
    // Try to find any video element (DRM may prevent direct control)
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find(v => {
      const r = v.getBoundingClientRect();
      return r.width > 100 && r.height > 100;
    }) || videos[0] || null;`;

      case "disney_plus":
        return `
    // Disney+: custom player with DRM
    const container = document.querySelector(".btm-media-container, [data-testid='btm-media-results']");
    if (container) {
      const video = container.querySelector("video");
      if (video) return video;
    }
    return document.querySelector("video") || null;`;

      case "prime_video":
        return `
    // Prime Video: web player SDK container
    const sdk = document.querySelector(".webPlayerSDKContainer, [data-testid='tvui-player']");
    if (sdk) {
      const video = sdk.querySelector("video");
      if (video) return video;
    }
    return document.querySelector("video") || null;`;

      default:
        return `
    return document.querySelector("video") || null;`;
    }
  }

  return { generate, STRATEGIES };
})();

// Export for module systems or leave as global
if (typeof module !== "undefined") module.exports = AdapterGenerator;
