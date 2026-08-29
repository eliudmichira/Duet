// ============================================================
//  Duet Agent — Site Analyzer
// ============================================================
// Inspects the page DOM and player state to determine the best
// strategy for hooking into the video. Produces a structured
// SiteAnalysis that the AdapterGenerator consumes.

const SiteAnalyzer = (() => {
  "use strict";

  // ── Player Framework Detection ─────────────────────────────
  const FRAMEWORKS = [
    { id: "youtube",      test: (d) => d.querySelector("ytd-player, .html5-video-player, video[src*='googlevideo']") !== null },
    { id: "vimeo",        test: (d) => d.querySelector(".vimeo-player, [data-vimeo-id], .player") !== null },
    { id: "netflix",      test: (d) => d.querySelector(".NFPlayer, .netflix-player, [data-ui-id='player']") !== null },
    { id: "disney_plus",  test: (d) => d.querySelector("[data-testid='btm-media-results'], .btm-media-container") !== null },
    { id: "prime_video",  test: (d) => d.querySelector("[data-testid='tvui-player'], .webPlayerSDKContainer") !== null },
    { id: "hulu",         test: (d) => d.querySelector(".player-container, [data-testid='player']") !== null },
    { id: "hbomax",       test: (d) => d.querySelector(".video-player, [data-testid='video-player']") !== null },
    { id: "peacock",      test: (d) => d.querySelector("[data-testid='player-wrapper'], .nup-player") !== null },
    { id: "twitch",       test: (d) => d.querySelector("[data-a-target='player-overlay-click-handler']") !== null },
    { id: "dailymotion",  test: (d) => d.querySelector(".DailymotionPlayer, [data-testid='player']") !== null },
  ];

  // ── Main Analysis ──────────────────────────────────────────
  /**
   * @param {string} url
   * @param {Object} [opts]
   * @param {HTMLDocument} [opts.doc] - document to analyze (default: current)
   * @returns {Promise<import('./adapter-generator.js').SiteAnalysis>}
   */
  async function analyze(url, opts = {}) {
    const doc = opts.doc || document;
    const hostname = extractHostname(url);

    // 1. Detect video element
    const videoInfo = detectVideo(doc);

    // 2. Detect player framework
    const framework = detectFramework(doc);

    // 3. Detect DOM structure
    const domStructure = analyzeDomStructure(doc, hostname);

    // 4. Detect challenges
    const challenges = detectChallenges(doc, hostname);

    // 5. Detect cross-origin iframes
    const iframes = detectIframes(doc);

    // 6. Score confidence
    const confidence = scoreConfidence(videoInfo, framework, challenges);

    return {
      url,
      hostname,
      hasVideo: videoInfo.found,
      videoSelector: videoInfo.selector,
      framework: framework || "unknown",
      domStructure,
      challenges,
      iframes,
      confidence,
      timestamp: Date.now()
    };
  }

  // ── Video Element Detection ────────────────────────────────
  function detectVideo(doc) {
    // Try each strategy in order of specificity
    const strategies = [
      () => detectInShadowRoot(doc),
      () => detectByVisibility(doc),
      () => detectBySelector(doc),
      () => detectInIframes(doc)
    ];

    for (const strategy of strategies) {
      const result = strategy();
      if (result.found) return result;
    }

    return { found: false, selector: null, strategy: "none", score: 0 };
  }

  function detectInShadowRoot(doc) {
    // Some players (YouTube, custom web components) hide video in shadow DOM
    const candidates = doc.querySelectorAll("*");
    for (const el of candidates) {
      if (el.shadowRoot) {
        const video = el.shadowRoot.querySelector("video");
        if (video) {
          return {
            found: true,
            selector: buildUniqueSelector(video),
            strategy: "shadow_root",
            score: scoreVideo(video)
          };
        }
      }
    }
    return { found: false };
  }

  function detectByVisibility(doc) {
    const videos = Array.from(doc.querySelectorAll("video"));
    if (!videos.length) return { found: false };

    // Score all visible videos
    const scored = videos
      .map(v => ({ video: v, score: scoreVideo(v) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return { found: false };

    const best = scored[0];
    return {
      found: true,
      selector: buildUniqueSelector(best.video),
      strategy: "visibility_score",
      score: best.score,
      totalVideos: videos.length
    };
  }

  function detectBySelector(doc) {
    // Common selectors for video containers
    const selectors = [
      "video.html5-main-video",        // YouTube
      "video[data-testid='video-player']", // Generic
      ".player video",                  // Generic player containers
      "[data-player] video",
      ".video-container video",
      "#player video"
    ];

    for (const sel of selectors) {
      const video = doc.querySelector(sel);
      if (video) {
        return {
          found: true,
          selector: sel,
          strategy: "known_selector",
          score: scoreVideo(video)
        };
      }
    }

    return { found: false };
  }

  function detectInIframes(doc) {
    const iframes = doc.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) continue; // cross-origin, can't inspect
        const video = iframeDoc.querySelector("video");
        if (video) {
          return {
            found: true,
            selector: `iframe[src="${iframe.src}"] video`,
            strategy: "iframe",
            score: scoreVideo(video),
            iframeSrc: iframe.src
          };
        }
      } catch { /* cross-origin */ }
    }
    return { found: false };
  }

  // ── Framework Detection ────────────────────────────────────
  function detectFramework(doc) {
    for (const fw of FRAMEWORKS) {
      if (fw.test(doc)) return fw.id;
    }

    // Heuristic: check for common class patterns
    if (doc.querySelector("video")?.closest("[class*='player']")) return "generic_player";
    return "none";
  }

  // ── DOM Structure Analysis ─────────────────────────────────
  function analyzeDomStructure(doc, hostname) {
    const video = doc.querySelector("video");
    const body = doc.body;

    return {
      hasCustomControls: !!doc.querySelector("[class*='player-controls'], [data-player-controls]"),
      hasFullscreenButton: !!doc.querySelector("[aria-label*='fullscreen'], [class*='fullscreen']"),
      hasTheaterMode: !!doc.querySelector("[class*='theater'], [data-theater]"),
      hasMiniPlayer: !!doc.querySelector("[class*='mini-player'], [class*='pip']"),
      isEmbedded: !!doc.querySelector("iframe[src*='embed']"),
      usesShadowDOM: hasShadowDOM(video),
      bodyClasses: Array.from(body?.classList || []).slice(0, 10),
      videoParentClasses: video ? Array.from(video.parentElement?.classList || []).slice(0, 5) : [],
      customPlayerElement: findCustomPlayerElement(doc, hostname)
    };
  }

  // ── Challenge Detection ────────────────────────────────────
  function detectChallenges(doc, hostname) {
    const challenges = [];

    // DRM detection
    if (isDRMSite(hostname)) {
      challenges.push({
        type: "drm",
        severity: "high",
        description: "Site uses DRM-protected content. Direct DOM manipulation may be blocked."
      });
    }

    // Shadow DOM
    if (hasShadowDOM(doc.querySelector("video"))) {
      challenges.push({
        type: "shadow_dom",
        severity: "medium",
        description: "Video is inside Shadow DOM. Need shadow-piercing selectors."
      });
    }

    // Cross-origin iframes
    const iframes = doc.querySelectorAll("iframe");
    let crossOriginCount = 0;
    for (const iframe of iframes) {
      try {
        iframe.contentDocument; // will throw if cross-origin
      } catch { crossOriginCount++; }
    }
    if (crossOriginCount > 0) {
      challenges.push({
        type: "cross_origin_iframe",
        severity: "medium",
        description: `${crossOriginCount} cross-origin iframe(s) detected. May need runtime.lastError handling.`
      });
    }

    // Custom player API (no standard video events)
    const customPlayer = findCustomPlayerElement(doc, hostname);
    if (customPlayer) {
      challenges.push({
        type: "custom_player",
        severity: "medium",
        description: `Custom player detected: ${customPlayer}. May need API-based hooks.`
      });
    }

    // Aggressive ad blocking
    if (doc.querySelector("[id*='ad'], [class*='ad-container'], [data-ad]")) {
      challenges.push({
        type: "ads",
        severity: "low",
        description: "Ad containers detected. Video element may be temporarily swapped during ads."
      });
    }

    // Autoplay restrictions
    challenges.push({
      type: "autoplay",
      severity: "low",
      description: "Browser autoplay policy may block programmatic play() without user gesture."
    });

    return challenges;
  }

  // ── Iframe Detection ───────────────────────────────────────
  function detectIframes(doc) {
    const iframes = doc.querySelectorAll("iframe");
    const results = [];

    for (const iframe of iframes) {
      let accessible = false;
      try {
        iframe.contentDocument;
        accessible = true;
      } catch { /* cross-origin */ }

      results.push({
        src: iframe.src || "about:blank",
        accessible,
        hasVideo: accessible ? !!iframe.contentDocument?.querySelector("video") : false,
        isFullscreenable: !!iframe.closest("[class*='fullscreen'], [data-fullscreen]")
      });
    }

    return results;
  }

  // ── Confidence Scoring ─────────────────────────────────────
  function scoreConfidence(videoInfo, framework, challenges) {
    let score = 0;

    // Video found is essential
    if (!videoInfo.found) return 0;

    // Base score from video detection
    score += Math.min(40, videoInfo.score / 25000);

    // Framework bonus
    if (framework && framework !== "none") {
      score += 20; // known framework = more predictable
    }

    // Challenge penalties
    const highSeverity = challenges.filter(c => c.severity === "high").length;
    const medSeverity = challenges.filter(c => c.severity === "medium").length;
    score -= highSeverity * 25;
    score -= medSeverity * 10;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ── Helpers ────────────────────────────────────────────────
  function scoreVideo(v) {
    if (!v) return 0;
    const r = v.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 &&
      getComputedStyle(v).visibility !== "hidden" &&
      getComputedStyle(v).display !== "none";
    if (!visible) return 0;
    const area = r.width * r.height;
    const ready = v.readyState >= 2 ? 1 : 0;
    return area + ready * 1_000_000;
  }

  function buildUniqueSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.className && typeof el.className === "string") {
      const classes = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith("__"));
      if (classes.length) return `video.${classes[0]}`;
    }
    // Fallback: nth-child
    const parent = el.parentElement;
    if (!parent) return "video";
    const idx = Array.from(parent.children).indexOf(el) + 1;
    return `${buildParentPath(parent)} > video:nth-child(${idx})`;
  }

  function buildParentPath(el) {
    if (el.id) return `#${el.id}`;
    if (el.tagName === "BODY") return "body";
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const idx = Array.from(parent.children).indexOf(el) + 1;
    return `${buildParentPath(parent)} > ${el.tagName.toLowerCase()}:nth-child(${idx})`;
  }

  function extractHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return url; }
  }

  function hasShadowDOM(el) {
    if (!el) return false;
    let node = el;
    while (node) {
      if (node.getRootNode()?.host) return true;
      node = node.parentElement;
    }
    return false;
  }

  function findCustomPlayerElement(doc, hostname) {
    const patterns = [
      { match: /youtube/i,     sel: "ytd-player" },
      { match: /vimeo/i,       sel: ".vue-player" },
      { match: /netflix/i,     sel: ".NFPlayer" },
      { match: /disney/i,      sel: ".btm-media-container" },
      { match: /prime/i,       sel: ".webPlayerSDKContainer" },
      { match: /hulu/i,        sel: ".player-container" },
      { match: /twitch/i,      sel: "[data-a-target='player']" },
    ];

    for (const p of patterns) {
      if (p.match.test(hostname)) {
        const el = doc.querySelector(p.sel);
        if (el) return p.sel;
      }
    }
    return null;
  }

  function isDRMSite(hostname) {
    const drmHosts = [
      "netflix.com", "disneyplus.com", "primevideo.com",
      "max.com", "peacocktv.com", "hulu.com",
      "hbomax.com", "paramountplus.com", "apple.com/tv"
    ];
    return drmHosts.some(h => hostname.includes(h));
  }

  return { analyze };
})();

// Export for module systems or leave as global
if (typeof module !== "undefined") module.exports = SiteAnalyzer;
