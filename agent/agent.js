// ============================================================
//  Duet Agent — Universal Sync Agent
// ============================================================
// The main orchestrator. Given a URL, it:
//   1. Checks the adapter registry for a cached adapter
//   2. Analyzes the site's DOM/player architecture
//   3. Generates a working sync adapter
//   4. Tests the adapter in a sandbox
//   5. Stores the adapter for future use
//
// This module is loaded by content.js when standard video
// detection fails, providing an automated fallback that works
// on sites with custom players, shadow DOM, DRM, etc.

const DuetAgent = (() => {
  "use strict";

  let _initialized = false;
  let _activeAdapter = null;
  let _analysisResult = null;

  // ── Initialization ─────────────────────────────────────────
  async function init() {
    if (_initialized) return;
    await AdapterRegistry.load();
    _initialized = true;
  }

  // ── Full Analysis Pipeline ─────────────────────────────────
  /**
   * Analyze a URL and generate an adapter if needed.
   * This is the main entry point for the agent.
   *
   * @param {string} url - The page URL to analyze
   * @param {Object} [opts]
   * @param {HTMLDocument} [opts.doc] - Document to analyze
   * @param {boolean} [opts.forceRefresh] - Skip cache, re-analyze
   * @returns {Promise<AgentResult>}
   */
  async function analyze(url, opts = {}) {
    await init();

    const hostname = extractHostname(url);
    const startTime = Date.now();

    // 1. Check registry for cached adapter
    if (!opts.forceRefresh) {
      const cached = await AdapterRegistry.find(hostname);
      if (cached) {
        _activeAdapter = cached;
        return {
          success: true,
          source: "registry_cache",
          adapter: cached,
          analysis: null,
          tests: null,
          duration: Date.now() - startTime
        };
      }
    }

    // 2. Analyze the site
    const analysis = await SiteAnalyzer.analyze(url, { doc: opts.doc });
    _analysisResult = analysis;

    // 3. If no video found, report failure
    if (!analysis.hasVideo) {
      return {
        success: false,
        source: "analysis",
        reason: "no_video_found",
        analysis,
        adapter: null,
        tests: null,
        duration: Date.now() - startTime
      };
  }

    // 4. Generate adapter
    const adapter = AdapterGenerator.generate(analysis);

    // 5. Validate adapter code
    const validation = SandboxTester.validate(adapter.code);
    if (!validation.ok) {
      return {
        success: false,
        source: "validation",
        reason: "invalid_adapter",
        errors: validation.errors,
        warnings: validation.warnings,
        analysis,
        adapter,
        tests: null,
        duration: Date.now() - startTime
      };
    }

    // 6. Test in sandbox (if URL provided)
    let testResult = null;
    if (url && !opts.skipTest) {
      try {
        testResult = await SandboxTester.test(adapter, url);
      } catch (err) {
        testResult = { passed: false, error: err.message };
      }
    }

    // 7. Store adapter if it passes validation (and ideally tests)
    if (validation.ok) {
      await AdapterRegistry.register(adapter);
      _activeAdapter = adapter;
    }

    return {
      success: validation.ok && (!testResult || testResult.passed),
      source: "generated",
      adapter,
      analysis,
      tests: testResult,
      validation,
      duration: Date.now() - startTime
    };
  }

  // ── Integration with Content Script ────────────────────────
  /**
   * Modify the page's content script behavior to use the agent's adapter.
   * This patches the standard DuetWatch video detection to fall back
   * to the generated adapter when standard detection fails.
   *
   * @param {string} url - Current page URL
   * @returns {Promise<boolean>} - true if an adapter was applied
   */
  async function integrate(url) {
    await init();

    const hostname = extractHostname(url);
    const adapter = await AdapterRegistry.find(hostname);

    if (!adapter) return false;

    // The adapter is available — content.js should check for it
    _activeAdapter = adapter;
    return true;
  }

  // ── Get Current Adapter ────────────────────────────────────
  function getActiveAdapter() {
    return _activeAdapter;
  }

  function getAnalysis() {
    return _analysisResult;
  }

  // ── Adapter Lookup (for content.js) ────────────────────────
  /**
   * Called by content.js to get an adapter for the current page.
   * Returns the adapter code to inject, or null if none available.
   *
   * @param {string} hostname
   * @returns {Promise<import('./adapter-generator.js').GeneratedAdapter|null>}
   */
  async function getAdapterForHostname(hostname) {
    await init();
    return AdapterRegistry.find(hostname);
  }

  // ── Fallback for Standard Detection ────────────────────────
  /**
   * Called when DuetWatch's standard findVideo() returns null.
   * Runs the full agent pipeline to find/create an adapter.
   *
   * @param {string} url - Current page URL
   * @returns {Promise<{adapter: GeneratedAdapter|null, video: HTMLVideoElement|null}>}
   */
  async function fallbackFindVideo(url) {
    const result = await analyze(url, { skipTest: true });

    if (!result.success || !result.adapter) {
      return { adapter: null, video: null };
    }

    // Try to use the adapter's findVideo
    try {
      // The adapter is a self-contained module that exposes window.__duetAdapter
      // We need to evaluate it in the current page context
      const adapterCode = result.adapter.code;

      // Check if already loaded
      if (window.__duetAdapter?.id === result.adapter.id) {
        const video = window.__duetAdapter.findVideo();
        return { adapter: result.adapter, video };
      }

      // Inject the adapter
      eval(adapterCode);

      if (window.__duetAdapter) {
        const video = window.__duetAdapter.findVideo();
        return { adapter: result.adapter, video };
      }
    } catch (err) {
      console.warn("[Duet Agent] Adapter injection failed:", err);
    }

    return { adapter: result.adapter, video: null };
  }

  // ── Cleanup ────────────────────────────────────────────────
  function reset() {
    _activeAdapter = null;
    _analysisResult = null;
  }

  // ── Helpers ────────────────────────────────────────────────
  function extractHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return url; }
  }

  return {
    init,
    analyze,
    integrate,
    getActiveAdapter,
    getAnalysis,
    getAdapterForHostname,
    fallbackFindVideo,
    reset
  };
})();

if (typeof module !== "undefined") module.exports = DuetAgent;
