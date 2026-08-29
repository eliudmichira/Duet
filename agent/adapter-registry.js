// ============================================================
//  Duet Agent — Adapter Registry
// ============================================================
// Stores generated adapters in Chrome storage keyed by hostname.
// Provides LRU eviction and lookup by hostname + framework.

const AdapterRegistry = (() => {
  "use strict";

  const STORAGE_KEY = "__duet_adapters";
  const MAX_ADAPTERS = 50;

  // In-memory cache (sync access for content script)
  let _cache = {};
  let _loaded = false;

  // ── Persistence ────────────────────────────────────────────
  async function load() {
    if (_loaded) return;
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY]);
      _cache = data[STORAGE_KEY] || {};
    } catch {
      _cache = {};
    }
    _loaded = true;
  }

  async function save() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: _cache });
    } catch (e) {
      console.warn("[Duet Agent] Registry save failed:", e);
    }
  }

  // ── Core Operations ────────────────────────────────────────
  /**
   * Register a new adapter. Overwrites existing adapter for the same
   * hostname + framework combination.
   * @param {import('./adapter-generator.js').GeneratedAdapter} adapter
   */
  async function register(adapter) {
    await load();
    const key = makeKey(adapter.hostname, adapter.framework);
    _cache[key] = {
      ...adapter,
      registeredAt: Date.now(),
      lastUsed: Date.now(),
      useCount: (_cache[key]?.useCount || 0) + 1
    };

    // LRU eviction: if over limit, remove least recently used
    const keys = Object.keys(_cache);
    if (keys.length > MAX_ADAPTERS) {
      const sorted = keys
        .map(k => ({ key: k, lastUsed: _cache[k].lastUsed || 0 }))
        .sort((a, b) => a.lastUsed - b.lastUsed);
      const toRemove = sorted.slice(0, keys.length - MAX_ADAPTERS);
      for (const { key } of toRemove) {
        delete _cache[key];
      }
    }

    await save();
  }

  /**
   * Find the best adapter for a given hostname.
   * Tries exact hostname match first, then framework match, then partial.
   * @param {string} hostname
   * @param {string} [framework]
   * @returns {Promise<import('./adapter-generator.js').GeneratedAdapter|null}
   */
  async function find(hostname, framework) {
    await load();

    // 1. Exact hostname + framework
    if (framework) {
      const exact = _cache[makeKey(hostname, framework)];
      if (exact) {
        exact.lastUsed = Date.now();
        exact.useCount = (exact.useCount || 0) + 1;
        await save();
        return exact;
      }
    }

    // 2. Any adapter for this hostname
    const hostnameMatch = Object.values(_cache).find(a => a.hostname === hostname);
    if (hostnameMatch) {
      hostnameMatch.lastUsed = Date.now();
      hostnameMatch.useCount = (hostnameMatch.useCount || 0) + 1;
      await save();
      return hostnameMatch;
    }

    // 3. Framework match on different hostname (unlikely but possible)
    if (framework) {
      const frameworkMatch = Object.values(_cache).find(a => a.framework === framework);
      if (frameworkMatch) {
        frameworkMatch.lastUsed = Date.now();
        frameworkMatch.useCount = (frameworkMatch.useCount || 0) + 1;
        await save();
        return frameworkMatch;
      }
    }

    return null;
  }

  /**
   * Remove an adapter by hostname + framework.
   */
  async function remove(hostname, framework) {
    await load();
    const key = makeKey(hostname, framework);
    if (_cache[key]) {
      delete _cache[key];
      await save();
    }
  }

  /**
   * List all registered adapters.
   * @returns {Promise<Array>}
   */
  async function list() {
    await load();
    return Object.values(_cache).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  }

  /**
   * Clear all adapters.
   */
  async function clear() {
    _cache = {};
    await save();
  }

  /**
   * Get stats about the registry.
   */
  async function stats() {
    await load();
    const adapters = Object.values(_cache);
    return {
      total: adapters.length,
      frameworks: [...new Set(adapters.map(a => a.framework))],
      strategies: [...new Set(adapters.map(a => a.strategy))],
      avgConfidence: adapters.length
        ? Math.round(adapters.reduce((s, a) => s + a.confidence, 0) / adapters.length)
        : 0,
      oldestRegistered: adapters.length
        ? Math.min(...adapters.map(a => a.registeredAt || 0))
        : null,
      mostUsed: adapters.length
        ? adapters.reduce((best, a) => (a.useCount || 0) > (best.useCount || 0) ? a : best)
        : null
    };
  }

  // ── Helpers ────────────────────────────────────────────────
  function makeKey(hostname, framework) {
    return `${hostname}::${framework || "unknown"}`;
  }

  return { load, register, find, remove, list, clear, stats };
})();

if (typeof module !== "undefined") module.exports = AdapterRegistry;
