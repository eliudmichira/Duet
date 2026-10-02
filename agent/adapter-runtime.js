// ============================================================
//  Duet Agent — Adapter Runtime
// ============================================================
// Executes a GeneratedAdapter *as data*, without evaluating its code.
//
// MV3 forbids eval/new Function in content scripts (and AMO rejects them),
// so the generated `adapter.code` string is kept only as a human-readable
// artifact (test panel, registry). At runtime the content script calls
// AdapterRuntime.findVideo(adapter), which interprets the adapter's
// strategy + selectors with the built-in lookups below. Sync wiring
// (listeners, applySync) stays in content.js, which already handles echo
// suppression — the adapter only has to locate the <video>.

const AdapterRuntime = (() => {
  "use strict";

  function scoreVideo(v) {
    const r = v.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return 0;
    if (getComputedStyle(v).visibility === "hidden") return 0;
    return r.width * r.height + (v.readyState >= 2 ? 1e6 : 0);
  }

  function bestVideo(videos) {
    let best = null, bestScore = 0;
    for (const v of videos) {
      const s = scoreVideo(v);
      if (s > bestScore) { best = v; bestScore = s; }
    }
    return best;
  }

  // Collect <video> elements from `root` and every open shadow root beneath it.
  function collectVideos(root, out = [], depth = 0) {
    if (!root || depth > 8) return out;
    out.push(...root.querySelectorAll("video"));
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectVideos(el.shadowRoot, out, depth + 1);
    }
    return out;
  }

  function querySafe(root, selector) {
    if (!selector || typeof selector !== "string") return null;
    try { return root.querySelector(selector); } catch { return null; }
  }

  function videoInside(el) {
    if (!el) return null;
    if (el.tagName === "VIDEO") return el;
    return bestVideo(collectVideos(el)) || bestVideo(collectVideos(el.shadowRoot));
  }

  /**
   * @param {import('./adapter-generator.js').GeneratedAdapter} adapter
   * @param {Document} [doc]
   * @returns {HTMLVideoElement|null}
   */
  function findVideo(adapter, doc = document) {
    if (!adapter) return null;

    // Cross-origin players live in another frame; that frame's own content
    // script (all_frames) handles them, so there's nothing to find here.
    if (adapter.strategy === "cross_origin_iframe") return null;

    // 1. The exact selector the analyzer recorded (light DOM only).
    const direct = querySafe(doc, adapter.videoSelector);
    if (direct?.tagName === "VIDEO" && scoreVideo(direct) > 0) return direct;

    // 2. The detected custom-player container.
    const inPlayer = videoInside(querySafe(doc, adapter.customPlayerElement));
    if (inPlayer) return inPlayer;

    // 3. Deep search, including open shadow roots.
    return bestVideo(collectVideos(doc));
  }

  return { findVideo, collectVideos };
})();

if (typeof module !== "undefined") module.exports = AdapterRuntime;
