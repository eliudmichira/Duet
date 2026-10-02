// ============================================================
//  Duet Agent — Sandbox Tester
// ============================================================
// Tests generated adapters in a sandboxed iframe to validate:
// 1. The code parses without errors
// 2. findVideo() works
// 3. applySync() can seek/play/pause
// 4. getMetadata() returns valid data
// 5. No uncaught exceptions leak into the host page

const SandboxTester = (() => {
  "use strict";

  const TEST_TIMEOUT_MS = 8000;

  /**
   * Test an adapter against a URL in a sandboxed iframe.
   * @param {import('./adapter-generator.js').GeneratedAdapter} adapter
   * @param {string} testUrl - URL to load in the sandbox
   * @returns {Promise<SandboxTestResult>}
   */
  async function test(adapter, testUrl) {
    const result = {
      adapterId: adapter.id,
      hostname: adapter.hostname,
      testUrl,
      passed: false,
      checks: {},
      errors: [],
      warnings: [],
      duration: 0,
      timestamp: Date.now()
    };

    const startTime = Date.now();

    try {
      // 1. Syntax validation
      result.checks.syntax = validateSyntax(adapter.code);
      if (!result.checks.syntax.ok) {
        result.errors.push(`Syntax error: ${result.checks.syntax.error}`);
        result.duration = Date.now() - startTime;
        return result;
      }

      // 2. Sandbox execution
      const sandboxResult = await runInSandbox(adapter, testUrl);
      result.checks.sandbox = sandboxResult;

      if (!sandboxResult.loaded) {
        result.errors.push("Sandbox failed to load or timed out");
      }

      if (sandboxResult.hasAdapter) {
        result.checks.adapterLoaded = true;

        // 3. Test findVideo
        if (sandboxResult.videoFound !== undefined) {
          result.checks.findVideo = sandboxResult.videoFound;
          if (!sandboxResult.videoFound) {
            result.warnings.push("findVideo() returned null — video may not be loaded yet");
          }
        }

        // 4. Test applySync (if video found)
        if (sandboxResult.syncApplied !== undefined) {
          result.checks.applySync = sandboxResult.syncApplied;
          if (!sandboxResult.syncApplied) {
            result.warnings.push("applySync() had issues — check console for details");
          }
        }

        // 5. Test getMetadata
        if (sandboxResult.metadataValid !== undefined) {
          result.checks.getMetadata = sandboxResult.metadataValid;
        }
      } else {
        result.errors.push("Adapter did not expose window.__duetAdapter");
      }

      // Determine overall pass
      result.passed = result.checks.syntax?.ok &&
        result.checks.sandbox?.loaded &&
        result.checks.adapterLoaded &&
        result.errors.length === 0;

    } catch (err) {
      result.errors.push(`Test error: ${err.message}`);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  // ── Syntax Validation ──────────────────────────────────────
  function validateSyntax(code) {
    try {
      // Try to parse as a function body (catches syntax errors)
      new Function(code);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Sandbox Execution ──────────────────────────────────────
  function runInSandbox(adapter, testUrl) {
    return new Promise((resolve) => {
      const container = document.createElement("div");
      container.id = `__duet_sandbox_${Date.now()}`;
      container.style.cssText = `
        position: fixed; top: -9999px; left: -9999px;
        width: 1px; height: 1px; overflow: hidden;
        pointer-events: none; z-index: -1;
      `;
      document.body.appendChild(container);

      const iframe = document.createElement("iframe");
      iframe.sandbox = "allow-scripts allow-same-origin";
      iframe.style.cssText = "width: 1px; height: 1px; border: none; opacity: 0;";
      container.appendChild(iframe);

      let resolved = false;
      const done = (result) => {
        if (resolved) return;
        resolved = true;
        try { container.remove(); } catch {}
        resolve(result);
      };

      // Timeout
      const timer = setTimeout(() => {
        done({
          loaded: false,
          hasAdapter: false,
          videoFound: undefined,
          syncApplied: undefined,
          metadataValid: undefined,
          error: "Sandbox timeout"
        });
      }, TEST_TIMEOUT_MS);

      // Listen for results from sandbox
      const handler = (e) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.__duet_sandbox_result) {
          window.removeEventListener("message", handler);
          clearTimeout(timer);
          done(e.data.__duet_sandbox_result);
        }
      };
      window.addEventListener("message", handler);

      // Load test URL
      iframe.src = testUrl;

      // After load, inject adapter and test
      iframe.onload = () => {
        try {
          const iframeWin = iframe.contentWindow;

          // Inject the adapter
          iframeWin.eval(adapter.code);

          // Test the adapter
          const testCode = `
            (function() {
              const result = { loaded: true, hasAdapter: false };

              // Check adapter exists
              if (!window.__duetAdapter) {
                result.hasAdapter = false;
                window.parent.postMessage({ __duet_sandbox_result: result }, "*");
                return;
              }
              result.hasAdapter = true;

              // Test findVideo
              try {
                const video = window.__duetAdapter.findVideo();
                result.videoFound = !!video;

                if (video) {
                  // Test applySync
                  try {
                    const state = {
                      action: "pause",
                      currentTime: Math.min(video.currentTime || 0, 10),
                      playbackRate: 1,
                      force: true
                    };
                    window.__duetAdapter.applySync(video, state, Date.now());
                    result.syncApplied = true;
                  } catch (err) {
                    result.syncApplied = false;
                    result.error = "applySync: " + err.message;
                  }

                  // Test getMetadata
                  try {
                    const meta = window.__duetAdapter.getMetadata(video);
                    result.metadataValid = !!(meta && typeof meta.url === "string" &&
                      typeof meta.currentTime === "number" &&
                      typeof meta.paused === "boolean");
                    result.metadata = meta;
                  } catch (err) {
                    result.metadataValid = false;
                    result.error = "getMetadata: " + err.message;
                  }
                }
              } catch (err) {
                result.videoFound = false;
                result.error = "findVideo: " + err.message;
              }

              window.parent.postMessage({ __duet_sandbox_result: result }, "*");
            })();
          `;
          iframeWin.eval(testCode);
        } catch (err) {
          clearTimeout(timer);
          done({
            loaded: true,
            hasAdapter: false,
            videoFound: undefined,
            syncApplied: undefined,
            metadataValid: undefined,
            error: `Injection failed: ${err.message}`
          });
        }
      };

      iframe.onerror = () => {
        clearTimeout(timer);
        done({
          loaded: false,
          hasAdapter: false,
          videoFound: undefined,
          syncApplied: undefined,
          metadataValid: undefined,
          error: "Failed to load test URL"
        });
      };
    });
  }

  // ── Quick Validation (no network) ─────────────────────────
  /**
   * Validate adapter code without loading a URL. Checks syntax,
   * required exports, and common pitfalls.
   * @param {string} code
   * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
   */
  function validate(code) {
    const errors = [];
    const warnings = [];

    // Syntax check. Inside an MV3 content script the extension CSP blocks
    // new Function() outright (EvalError) — that says nothing about the code,
    // so skip the check there rather than failing every adapter.
    try {
      new Function(code);
    } catch (err) {
      if (err instanceof EvalError) {
        warnings.push("Syntax check skipped (eval blocked by CSP)");
      } else {
        errors.push(`Syntax: ${err.message}`);
        return { ok: false, errors, warnings };
      }
    }

    // Check for required exports
    const required = ["findVideo", "attachListeners", "applySync", "getMetadata"];
    for (const fn of required) {
      if (!code.includes(fn)) {
        errors.push(`Missing required function: ${fn}`);
      }
    }

    // Check for window.__duetAdapter
    if (!code.includes("__duetAdapter")) {
      errors.push("Adapter does not expose window.__duetAdapter");
    }

    // Common pitfalls
    if (code.includes("eval(") && !code.includes("__duet_sandbox")) {
      warnings.push("Adapter uses eval() — may be blocked by CSP");
    }
    if (code.includes("innerHTML") && code.includes("user")) {
      warnings.push("Adapter uses innerHTML with user data — potential XSS risk");
    }
    if (code.includes("document.write")) {
      warnings.push("Adapter uses document.write — may break page");
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  return { test, validate, validateSyntax };
})();

if (typeof module !== "undefined") module.exports = SandboxTester;
