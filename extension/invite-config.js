// ============================================================
//  Duet — Invite links (shared by background, content, popup)
// ============================================================
// An invite link looks like  https://pausepal-a4d71.web.app/join#K7QM2P
// The room code lives in the URL fragment, so it's never sent to the web
// server (no access logs, no referrer leaks).
//
// To move invites to another domain (e.g. a custom one), deploy docs/ there
// and update BASE + HOSTS below. HOSTS must only list domains you control:
// the content script runs its invite handler on exactly these pages.
//
// Attached to globalThis because Firefox loads background scripts as ES
// modules, where a top-level const wouldn't be visible to background.js.

globalThis.DUET_INVITE = (() => {
  const BASE = "https://pausepal-a4d71.web.app/join";
  const HOSTS = ["pausepal-a4d71.web.app", "pausepal-a4d71.firebaseapp.com"];
  const PATHS = ["/join", "/join.html"];
  const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

  const isCode = (s) => typeof s === "string" && CODE_RE.test(s);

  function link(code) {
    return isCode(code) ? `${BASE}#${code}` : null;
  }

  // Is `url` one of our invite pages? (Says nothing about the code.)
  function isInvitePage(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && HOSTS.includes(u.hostname) && PATHS.includes(u.pathname);
    } catch { return false; }
  }

  // Pulls a room code out of an invite link, or accepts a bare code.
  // Returns null for anything else.
  function parse(input) {
    const text = String(input || "").trim();
    const bare = text.toUpperCase();
    if (isCode(bare)) return bare;
    if (!isInvitePage(text)) return null;
    const code = new URL(text).hash.replace(/^#/, "").toUpperCase();
    return isCode(code) ? code : null;
  }

  // Match patterns for chrome.tabs.query (used to reload open invite tabs).
  const TAB_PATTERNS = HOSTS.flatMap(h => PATHS.map(p => `https://${h}${p}*`));

  return Object.freeze({ BASE, HOSTS, isCode, link, isInvitePage, parse, TAB_PATTERNS });
})();
