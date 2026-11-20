# Chrome Web Store Submission — Duet

Everything you need to fill out the Web Store dashboard. Copy/paste-friendly.

---

## Item details

### Name
Duet — Watch videos together, in sync

### Short summary (132 chars max)
Pause, play, and seek stay in lockstep across two screens. Watch together on any HTML5 video site. Free, fast, and private.

### Detailed description
**Watch movies, episodes, and YouTube together when you can't be in the same room.**

Duet syncs play, pause, and seek between exactly two browsers in real time, so you and one other person can hit play once and stay together for the whole show — no screen sharing, no group calls, no buffering one side ahead of the other.

**How it works**
1. Install Duet on both browsers.
2. One person clicks *Create a room* and sends the invite link (or reads out the 6-character code).
3. The other person opens the link. They're in.
4. Both open the same video. Press play. You're in sync.

Next time, your room is saved: click *Watch with Sam* and you're back in the same room.

No accounts, no logins, no setup beyond installing the extension.

**Features**
- Real-time play, pause, and seek sync, with drift correction
- "Both ready?" — a 3-2-1 countdown that starts both videos at the same instant
- Follows your partner to the next episode automatically (with a "Stay here" option)
- "Go to Sam" / "Bring Sam here" — get back together in one click
- A small badge on the video with chat, message history and emoji reactions — hide it with ✕ any time
- Saved room per partner, and "Our story": how long you've watched together
- Works on YouTube, Vimeo, and any site with an HTML5 `<video>` element

**Privacy**
No analytics, no ad SDKs, no accounts. Sync traffic goes through one hosted database and only while you're in a room. Messages are deleted within seconds. Idle rooms are deleted after 7 days (90 for a saved room). Full privacy policy: https://pausepal-a4d71.web.app/privacy

**Limits**
- Strictly 2 people per room.
- Some DRM-heavy sites (Netflix, Disney+, Prime) fight every extension; sync of play/pause works there but seeking can be flaky. Free YouTube and any site with an unprotected `<video>` works perfectly.

### Category
Entertainment

### Language
English

---

## Permissions justifications

The Web Store review form asks you to justify each permission and the
single-purpose of the extension. Use these answers verbatim.

### Single purpose
> Duet synchronizes play, pause, and seek events for two specific users watching the same video on any HTML5 video page, so they can watch in lockstep across two screens.

### `storage`
> Used to keep the user's display name and avatar, current room code, saved rooms, badge position, and a local "watched together" tally across browser sessions; session storage keeps the current room's chat history until the browser closes. None of this storage is uploaded.

### `tabs`
> Used to identify which tab contains the active video player so that sync events from the Firebase realtime database are routed to the correct tab. Used only after the user has created or joined a room.

### `scripting`
> Required by Manifest V3 to inject the sync logic into video pages: into tabs that were already open when Duet is installed or updated (so they sync without a refresh), and into the specific frame that holds the player when it lives in a cross-origin iframe (common on embed-based video sites).

### `webNavigation`
> Required to enumerate frames within the active video tab so that sync messages reach the specific frame containing the `<video>` element. Many video sites embed their player inside a cross-origin iframe; without `webNavigation` the extension cannot route a play/pause message to that frame.

### `host_permissions: <all_urls>`
> Duet works on any website that contains an HTML5 `<video>` element — there is no way to enumerate every such site ahead of time, so the extension needs access to all URLs. It only attaches sync logic when a `<video>` is detected, and it only transmits anything when the user has explicitly created or joined a room.

### `remote code` use
> The extension bundles the Firebase JavaScript SDK locally (under `vendor/`). It does not execute remote code. The only remote endpoint contacted is the developer-managed Firebase Realtime Database used to deliver sync events between the two partners in a room.

### Data collection disclosure
Tick these in the dashboard's "Privacy practices" tab:
- ☑ Personally identifiable information (display name the user chooses)
- ☑ Web history (URL and title of the page the user is watching, transmitted only while inside a room and only to the other partner)
- ☑ User communications (chat messages and reactions typed into Duet, delivered only to the partner)

For each, the disclosure should say:
> Transmitted only while the user is actively inside a sync room, only to a developer-managed Firebase Realtime Database, and only for the purpose of delivering sync events to the user's partner. Not sold, not transferred to any third party, not analyzed or retained by the extension developer. Messages are deleted about 6 seconds after delivery; names and page info are removed when the user leaves; idle rooms are deleted after 7 days (90 days for a room saved by its two members).

---

## Required assets

- ☐ Icon 128×128 (already in `extension/icons/icon128.png`)
- ☑ Screenshots and promo images: `store-assets/` (1280×800 ×5, small
  tile 440×280, marquee 1400×560). Upload in numeric order.
- (Original plan) At least one screenshot (up to 5), 1280×800 or 640×400. Suggested shots:
  1. The popup start screen ("Watch with Sam" saved room + Create a room)
  2. The popup in a room, partner card populated
  3. A video page with the Duet badge in the corner
  4. The "Both ready?" prompt / 3-2-1 countdown over the video
  5. The badge opened: chat history, reactions, Go to / Bring buttons
- ☑ Small promo tile 440×280 — `store-assets/promo-small-440x280.png`

---

## Privacy policy URL
`docs/privacy.html` is served by Firebase Hosting (`firebase deploy --only hosting`):
> `https://pausepal-a4d71.web.app/privacy`

Re-deploy hosting after any privacy change so the live page matches the extension.

---

## Pre-submission checklist

- [ ] Bumped version in `extension/manifest.json` (must be greater than any previously-uploaded version)
- [ ] `DEBUG = false` in both `background.js` and `content.js`
- [ ] No leftover `console.log` calls in non-vendor code
- [ ] `PRIVACY.md` hosted on a real public URL
- [ ] **Deployed `firebase/database.rules.json`** to the production Firebase project (`firebase deploy --only database`)
- [ ] **Deployed `firebase/functions/`** (the daily cleanup function) (`firebase deploy --only functions`)
- [ ] **Locked the Firebase API key** in Cloud Console → Credentials to `chrome-extension://<extension-id>/*` once the listing has a stable ID
- [ ] **Billing alerts set** at 50/75/90/100/200% of $10/month in Cloud Console → Billing → Budgets
- [ ] Tested create → join → play → pause → seek across two browsers / profiles
- [ ] Tested join with an invalid 6-char code (should show a clean error)
- [ ] Tested with network throttled / Firebase blocked (should show "Can't reach Duet's sync server")
- [ ] Zipped only the `extension/` folder for upload, not the repo root
- [ ] Source code published on GitHub if you want the "Open source" badge on the listing

---

## Expected review time

- First-time submission with `<all_urls>` and `webNavigation`: **5–10 business days**, sometimes longer if a reviewer wants clarification.
- Subsequent updates without permission changes: **1–3 business days**.

If rejected, the most common reasons for Duet specifically would be:
- Permission justifications too vague — use the wording above verbatim.
- Privacy policy missing or doesn't match the data the extension actually touches — `PRIVACY.md` already matches.
- Single-purpose unclear — keep the single-purpose statement above as-is.
- **Dynamically generated code** — resolved: nothing in the package
  evaluates code strings. The agent's adapter tester checks generated
  adapters as data (`agent/sandbox-tester.js`), the same way
  `agent/adapter-runtime.js` runs them. Keep it that way: a single `eval`
  or `new Function` (including in a vendored library) is enough to get
  flagged.
