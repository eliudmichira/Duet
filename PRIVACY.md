# Duet — Privacy Policy

_Last updated: 2026-05-11_

Duet is a browser extension that synchronizes play, pause, and seek events
for two people watching the same video. This document describes exactly
what data the extension touches, where it goes, and how long it lives.

## Short version

- Duet sends a small amount of session data through a developer-managed
  Firebase Realtime Database when you are inside a room.
- That data is the minimum needed for sync: the URL and title of the page
  you're on, the current playback timestamp, your chosen display name, and
  any reactions or short messages you send to your partner.
- Rooms auto-expire after 7 days of inactivity. The database isn't logged,
  exported, analyzed, or shared with any third party.
- There are no analytics SDKs, no advertising SDKs, and no telemetry.

## What gets transmitted, and when

The extension transmits **nothing** until you click **Create a room** or
**Join room** in the popup. After that, while you remain in a room:

| Data | Purpose |
|---|---|
| The 6-character room code | Identifies the room you and your partner share |
| URL of the page with the active video | So both sides can detect they're on the same page and so the popup can show what your partner is watching |
| Hostname and page title | Shown in the partner card |
| Active video's `currentTime`, `duration`, `paused`, `playbackRate` | Drives the actual sync |
| Display name and avatar emoji you choose | Labels your actions to your partner ("Alice paused") |
| Reactions and short chat messages you send | Delivered to your partner; auto-deleted from the database 6 seconds after they're sent |
| A randomly generated user ID for the current session | Lets us tell your events apart from your partner's |

The extension does **not** read or transmit form contents, passwords,
autofill data, bookmarks, history from other tabs, or anything from the
page outside of the active `<video>` element and the page's URL/title.

## Where data is stored

All transmitted data is written to a Firebase Realtime Database hosted in
Google Cloud (US-Central region) and managed by Duet's developer. Access
to the project is restricted to the developer; the database is not
publicly browsable.

Within the database, all data lives under the room code. Lifetime:

- **Presence records** (the "who is currently in the room" flag) are
  deleted automatically when you close the tab or disconnect, typically
  within 60 seconds.
- **Reactions and chat messages** are deleted automatically about 6
  seconds after they're sent.
- **Room state** (last-known playback position, partner metadata) is
  retained while at least one partner is active. A scheduled cleanup job
  deletes rooms that have been idle for 7 days, along with any associated
  presence records.

The developer does not analyze, export, or sell the contents of the
database. The data is read by Firebase's realtime infrastructure solely
to deliver each side's events to the other side.

## What the extension stores locally on your computer

Inside your browser's `chrome.storage.local`:

- The display name and avatar emoji you chose
- The room code and user ID of your current session (so the extension
  can rejoin after a reload)
- The position of the floating badge on screen and whether you've
  minimized it
- A small diagnostic record of the last few writes (for debugging)
- "Our story" totals: for each partner display name, how long the two of
  you played the same video at the same time, which days you did, and the
  last title — shown in the popup as e.g. "12h 30m watched together ·
  6 nights"

These never leave your computer. They are removed when you uninstall
the extension.

## Permissions, in plain English

- **`storage`** — Save your display name and current room locally so you
  don't have to retype them.
- **`tabs`** — Identify which tab the video is in so play/pause events go
  to the right place.
- **`scripting`** + **`webNavigation`** — Inject the sync logic into every
  frame of a video page (some sites put the player in a cross-origin
  iframe) and route messages to the correct frame.
- **`<all_urls>`** — Duet works on any site with an HTML5 `<video>`
  element. This permission is required to detect a video regardless of
  the site you're on. The extension reads only the video's playback
  state, the page URL, and the page title.

## Third parties

- **Google Firebase / Google Cloud Platform.** All sync traffic flows
  through a Firebase Realtime Database hosted on Google's infrastructure.
  Your usage of Duet is therefore also subject to Google's privacy
  practices for Firebase. See <https://firebase.google.com/support/privacy>.
- **No analytics, advertising, error reporting, or telemetry SDKs** are
  bundled with Duet.
- **No image services.** Emoji and avatar artwork ships inside the
  extension, so pages you watch on make no requests to emoji or avatar
  servers on Duet's behalf.

## Children

Duet is not directed at children under 13 and does not knowingly collect
data from them.

## Changes

If this policy changes in a material way, the new version will ship in a
release of the extension and be visible in the GitHub repository. The
"Last updated" date at the top will move.

## Contact

For questions about this policy, open an issue on the Duet GitHub
repository.
