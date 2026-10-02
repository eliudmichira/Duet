// ============================================================
//  Duet — Invite page (join.html#CODE)
// ============================================================
// This page only renders state. The Duet extension's content script does the
// joining: it announces itself, posts room status here, and acts on clicks
// of [data-duet-action] buttons — but only real user clicks, so a link (or
// a script on this page) can never join a room on someone's behalf.
//
// Everything that comes from the extension about the partner (name, video
// title) is set with textContent, never as HTML.

(() => {
  "use strict";

  // TODO: replace with the real store listings once published.
  const CHROME_STORE_URL  = "https://chrome.google.com/webstore";
  const FIREFOX_STORE_URL = "https://addons.mozilla.org/firefox/search/?q=Duet";

  const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  const $ = (id) => document.getElementById(id);

  const code = () => {
    const c = location.hash.replace(/^#/, "").trim().toUpperCase();
    return CODE_RE.test(c) ? c : null;
  };

  let heardFromExtension = false;
  let lastStatus = null;

  function show(state) {
    for (const s of ["checking", "invalid", "install", "ready", "joined"]) {
      $(`state-${s}`).hidden = s !== state;
    }
  }

  function showError(message) {
    const el = $("error");
    el.textContent = message || "";
    el.hidden = !message;
  }

  function renderCodeCells() {
    const c = code() || "";
    for (const host of document.querySelectorAll("[data-code-cells]")) {
      host.replaceChildren(...c.split("").map((ch) => {
        const cell = document.createElement("span");
        cell.textContent = ch;
        return cell;
      }));
    }
  }

  function renderInstall() {
    const isFirefox = /firefox/i.test(navigator.userAgent);
    const isMobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
    const primary = $("install-primary");
    const secondary = $("install-secondary");
    primary.textContent = isFirefox ? "Add Duet to Firefox" : "Add Duet to Chrome";
    primary.href = isFirefox ? FIREFOX_STORE_URL : CHROME_STORE_URL;
    secondary.textContent = isFirefox ? "Using Chrome or Edge?" : "Using Firefox?";
    secondary.href = isFirefox ? CHROME_STORE_URL : FIREFOX_STORE_URL;
    $("mobile-note").hidden = !isMobile;
    $("install-note").hidden = isMobile;
    show("install");
  }

  function renderStatus(status) {
    lastStatus = status;
    const c = code();
    if (!c) { show("invalid"); return; }

    if (status.currentRoom === c) {
      renderJoined(status);
      return;
    }

    const btn = $("join-btn");
    btn.disabled = false;
    const note = $("switch-note");
    if (status.currentRoom) {
      // Already in a different room: joining means leaving it — say so, and
      // let the extension know the user agreed when they click.
      btn.textContent = "Leave current room and join";
      btn.dataset.duetLeaveCurrent = "1";
      note.textContent = `You're in room ${status.currentRoom} right now. Joining this one will leave it.`;
      note.hidden = false;
    } else {
      btn.textContent = "Join room";
      delete btn.dataset.duetLeaveCurrent;
      note.hidden = true;
    }
    show("ready");
  }

  function renderJoined(status) {
    const p = status.partner;
    const name = (p && p.name) || "Your partner";
    const lede = $("joined-lede");
    const card = $("now-watching");
    const open = $("open-actions");

    if (status.peerCount < 2) {
      lede.textContent = "Waiting for your partner to join…";
    } else if (!p || !p.hasVideo) {
      lede.textContent = `${name} is here. Waiting for them to start a video…`;
    } else {
      lede.textContent = "Open the same video and you'll stay in sync.";
    }

    if (p && p.hasVideo && status.peerCount >= 2) {
      $("now-who").textContent = p.hostname ? `${name} is watching on ${p.hostname}` : `${name} is watching`;
      $("now-title").textContent = p.title || "A video";
      $("now-title").title = p.title || "";
      card.hidden = false;
      open.hidden = false;
    } else {
      card.hidden = true;
      open.hidden = true;
    }
    show("joined");
  }

  // ── Messages from the extension's content script ───────────
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.__duet_ext !== true) return;
    heardFromExtension = true;

    if (msg.type === "status") {
      showError(null);
      renderStatus(msg);
    } else if (msg.type === "joining") {
      showError(null);
      const btn = $("join-btn");
      btn.disabled = true;
      btn.textContent = "Joining…";
    } else if (msg.type === "error") {
      showError(typeof msg.message === "string" ? msg.message : "Something went wrong. Try again.");
      if (lastStatus) renderStatus(lastStatus);
    }
  });

  window.addEventListener("hashchange", () => {
    renderCodeCells();
    if (!code()) show("invalid");
    else if (lastStatus) renderStatus(lastStatus);
  });

  // ── Boot ───────────────────────────────────────────────────
  renderCodeCells();
  if (!code()) {
    show("invalid");
    return;
  }

  // The content script announces itself on load; ask too, in case this
  // script ran after its first message.
  window.postMessage({ __duet_page: true, type: "hello" }, location.origin);
  setTimeout(() => {
    if (!heardFromExtension && document.documentElement.dataset.duetExtension !== "1") renderInstall();
  }, 1500);
})();
