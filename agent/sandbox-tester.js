// ============================================================
//  Duet Agent — Adapter Tester
// ============================================================
// Checks a generated adapter WITHOUT executing its code.
//
// The extension never runs `adapter.code`: Manifest V3 (and the Chrome Web
// Store / AMO policies) forbid executing code that isn't part of the
// package, and the extension CSP blocks string evaluation anyway. At
// runtime AdapterRuntime interprets the adapter's data (strategy +
// selectors). So that is exactly what gets tested here:
//   1. the adapter record is well-formed and its strategy is supported,
//   2. the `code` string (a human-readable artifact) has the expected shape,
//   3. optionally, on a same-origin page, AdapterRuntime finds a <video>
//      with the adapter's selectors and the video reports usable metadata.

const SandboxTester = (() => {
  "use strict";

  const TEST_TIMEOUT_MS = 8000;
  const STRATEGIES = new Set(["generic_html5", "shadow_dom", "cross_origin_iframe", "custom_player", "framework_specific"]);
  const REQUIRED_FUNCTIONS = ["findVideo", "attachListeners", "applySync", "getMetadata"];

  function runtime() {
    return typeof AdapterRuntime !== "undefined" ? AdapterRuntime : null;
  }

  // ── Static checks (no network, no execution) ───────────────
  /**
   * @param {string} code - the adapter's generated source text
   * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
   */
  function validate(code) {
    const errors = [];
    const warnings = [];
    if (typeof code !== "string" || !code.trim()) {
      return { ok: false, errors: ["Adapter has no code text"], warnings };
    }

    for (const fn of REQUIRED_FUNCTIONS) {
      if (!code.includes(fn)) errors.push(`Missing required function: ${fn}`);
    }
    if (!code.includes("__duetAdapter")) {
      errors.push("Adapter does not expose window.__duetAdapter");
    }
    const balance = bracketBalance(code);
    if (balance) warnings.push(`Unbalanced ${balance} in adapter text`);

    if (/\beval\s*\(|\bFunction\s*\(/.test(code)) {
      warnings.push("Adapter text builds code from strings — it is never executed, but keep generated text free of it");
    }
    if (code.includes("innerHTML") && code.includes("user")) {
      warnings.push("Adapter uses innerHTML with user data — potential XSS risk");
    }
    if (code.includes("document.write")) {
      warnings.push("Adapter uses document.write — may break page");
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  // Cheap structural sanity check on the text (ignores strings and comments
  // only roughly; it is a hint, not a parser).
  function bracketBalance(code) {
    const pairs = { "(": ")", "[": "]", "{": "}" };
    const closing = new Set(Object.values(pairs));
    const stack = [];
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, "\"\"");
    for (const ch of stripped) {
      if (pairs[ch]) stack.push(pairs[ch]);
      else if (closing.has(ch) && stack.pop() !== ch) return "brackets";
    }
    return stack.length ? "brackets" : "";
  }

  /** Checks the data AdapterRuntime actually uses. */
  function validateRecord(adapter) {
    const errors = [];
    if (!adapter || typeof adapter !== "object") return ["Adapter is not an object"];
    if (!STRATEGIES.has(adapter.strategy)) errors.push(`Unknown strategy: ${adapter.strategy}`);
    for (const key of ["videoSelector", "customPlayerElement"]) {
      const sel = adapter[key];
      if (sel == null) continue;
      if (typeof sel !== "string") { errors.push(`${key} is not a string`); continue; }
      try { document.createDocumentFragment().querySelector(sel); }
      catch { errors.push(`${key} is not a valid CSS selector: ${sel}`); }
    }
    return errors;
  }

  // ── Live check on a page ───────────────────────────────────
  /**
   * Loads `testUrl` in a hidden iframe and lets AdapterRuntime look for the
   * video with the adapter's selectors. Only same-origin pages can be
   * inspected; for others the result says so instead of guessing.
   */
  async function test(adapter, testUrl) {
    const startTime = Date.now();
    const result = {
      adapterId: adapter?.id,
      hostname: adapter?.hostname,
      testUrl,
      passed: false,
      checks: {},
      errors: [],
      warnings: [],
      duration: 0,
      timestamp: Date.now()
    };

    const v = validate(adapter?.code);
    result.checks.code = v.ok;
    result.errors.push(...v.errors, ...validateRecord(adapter));
    result.warnings.push(...v.warnings);
    result.checks.adapterLoaded = result.errors.length === 0;

    const rt = runtime();
    if (!rt) {
      result.warnings.push("AdapterRuntime not loaded — live check skipped");
    } else if (result.checks.adapterLoaded && testUrl) {
      const live = await inspectPage(adapter, testUrl, rt);
      result.checks.sandbox = live;
      if (live.error) result.errors.push(live.error);
      if (live.crossOrigin) result.warnings.push("Page is cross-origin — live check skipped");
      if (live.videoFound !== undefined) {
        result.checks.findVideo = live.videoFound;
        if (!live.videoFound) result.warnings.push("findVideo found no <video> — it may not be loaded yet");
      }
      if (live.metadataValid !== undefined) result.checks.getMetadata = live.metadataValid;
    }

    result.passed = result.checks.adapterLoaded && result.errors.length === 0;
    result.duration = Date.now() - startTime;
    return result;
  }

  function inspectPage(adapter, testUrl, rt) {
    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      // No allow-scripts: the page's own scripts don't need to run for a
      // selector check, and nothing of ours runs inside it either.
      iframe.sandbox = "allow-same-origin";
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:640px;height:360px;border:0;opacity:0;pointer-events:none;";

      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        iframe.remove();
        resolve(r);
      };
      const timer = setTimeout(() => done({ loaded: false, error: "Page did not load in time" }), TEST_TIMEOUT_MS);

      iframe.onload = () => {
        let doc = null;
        try { doc = iframe.contentDocument; } catch {}
        if (!doc) return done({ loaded: true, crossOrigin: true });
        const video = rt.findVideo(adapter, doc);
        done({
          loaded: true,
          videoFound: !!video,
          metadataValid: !!video && typeof video.currentTime === "number" && typeof video.paused === "boolean"
        });
      };
      iframe.onerror = () => done({ loaded: false, error: "Failed to load test URL" });
      iframe.src = testUrl;
      (document.body || document.documentElement).appendChild(iframe);
    });
  }

  return { test, validate, validateRecord };
})();

if (typeof module !== "undefined") module.exports = SandboxTester;
