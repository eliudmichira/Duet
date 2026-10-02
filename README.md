# ⏸ Duet — Watch in duet.

**Two screens, one beat.** [duet.watch](https://duet.watch)

A Chrome extension that keeps two people in perfect sync while watching any video online — no screen sharing, no group bloat, just instant pause/play magic between exactly two screens.

---

## How it works

1. Person A installs the extension, creates a room and clicks **Copy invite link**
2. Person B opens the link — one click joins if they have Duet; otherwise the page offers the install and they join right after (the 6-character code still works in the popup too)
3. Either person presses play or pause on any video → the other screen syncs **instantly**

Invite links look like `https://pausepal-a4d71.web.app/join#K7QM2P`. The code sits in the `#` fragment, so it never reaches the web server. Joining always takes a real click on that page — a link alone can't put anyone in a room. The link domain is configured in `extension/invite-config.js`.

A small overlay in the corner shows "Partner paused" or "Partner played" so you always know what happened.

---

## Setup (takes ~10 minutes)

### Step 1 — Create your Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com/)
2. Click **Add project** → name it `duet` → disable Google Analytics → **Create project**
3. Once inside the project:
   - Click **Build** → **Realtime Database** → **Create Database**
   - Choose any region (e.g. `us-central1`) → Start in **locked mode** → **Enable**
4. Click the ⚙ gear icon → **Project settings** → scroll to **Your apps**
5. Click the **</>** (Web) icon → name the app `duet` → **Register app**
6. Copy the `firebaseConfig` object — you'll need these values in a moment

### Step 2 — Set Firebase security rules

In the Firebase Console:
- **Build → Realtime Database → Rules** tab
- Replace everything with the JSON below, then click **Publish**.

These rules forbid listing or scanning the database — you can only read/write a room if you know its 6-character code.

**Recommended (strict)** — validates every field shape and rejects unknown ones. Safe for shared Firebase projects.

```json
{
  "rules": {
    "rooms": {
      ".read": false,
      ".write": false,
      "$roomId": {
        ".read": "$roomId.length === 6",
        ".write": "$roomId.length === 6",
        "state": {
          ".validate": "newData.hasChildren(['action','currentTime','updatedBy'])",
          "action":       { ".validate": "newData.isString() && (newData.val() === 'play' || newData.val() === 'pause')" },
          "currentTime":  { ".validate": "newData.isNumber()" },
          "playbackRate": { ".validate": "newData.isNumber()" },
          "updatedBy":    { ".validate": "newData.isString()" },
          "serverTime":   { ".validate": "newData.isNumber()" },
          "force":        { ".validate": "newData.isBoolean()" },
          "$other":       { ".validate": false }
        },
        "meta": {
          "$userId": {
            "name":        { ".validate": "newData.isString() && newData.val().length <= 32" },
            "emoji":       { ".validate": "newData.isString() && newData.val().length <= 16" },
            "url":         { ".validate": "newData.isString()" },
            "hostname":    { ".validate": "newData.isString()" },
            "pageTitle":   { ".validate": "newData.isString()" },
            "videoTitle":  { ".validate": "newData.isString()" },
            "duration":    { ".validate": "newData.isNumber()" },
            "currentTime": { ".validate": "newData.isNumber()" },
            "paused":      { ".validate": "newData.isBoolean()" },
            "buffering":   { ".validate": "newData.isBoolean()" },
            "lastSeen":    { ".validate": "newData.isNumber()" },
            "$other":      { ".validate": false }
          }
        },
        "reactions": {
          "$reactionId": {
            "emoji": { ".validate": "newData.isString() && newData.val().length <= 140" },
            "from":  { ".validate": "newData.isString()" },
            "ts":    { ".validate": "newData.isNumber()" },
            "$other":{ ".validate": false }
          }
        },
        "together": {
          "since": { ".validate": "newData.isNumber() || newData.val() === null" },
          "total": { ".validate": "newData.isNumber()" }
        },
        "host":    { ".validate": "newData.isString()" },
        "created": { ".validate": "newData.isNumber()" }
      }
    },
    "presence": {
      ".read": false,
      ".write": false,
      "$roomId": {
        ".read": "$roomId.length === 6",
        ".write": "$roomId.length === 6"
      }
    }
  }
}
```

**Permissive (loose)** — easier setup, no field validation. Fine for personal use among trusted partners.

```json
{
  "rules": {
    "rooms": {
      ".read": false,
      ".write": false,
      "$roomId": {
        ".read": "$roomId.length === 6",
        ".write": "$roomId.length === 6"
      }
    },
    "presence": {
      ".read": false,
      ".write": false,
      "$roomId": {
        ".read": "$roomId.length === 6",
        ".write": "$roomId.length === 6"
      }
    }
  }
}
```

### Step 3 — Load the extension in Chrome

1. Open Chrome → go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project
5. Duet should now appear in your extensions bar — pin it!

### Step 4 — Enter your Firebase config

1. Click the Duet extension icon
2. Click **⚙ Config** in the top-right
3. Paste in all the values from your Firebase config:
   - API Key
   - Auth Domain
   - Database URL ← make sure this ends in `.firebaseio.com`
   - Project ID
   - Messaging Sender ID
   - App ID
4. Click **Save & Connect**

Your partner needs to do the same Steps 3 & 4 (using the same Firebase project config).

---

## Usage

### Host (creates the room)
1. Click the Duet icon on any page with a video
2. Click **Create a room**
3. Share the 6-character code with your partner
4. Both open the same video (e.g. same YouTube URL)
5. Press play — they sync!

### Guest (joins the room)
1. Click the Duet icon
2. Type the 6-character code → **Join room**
3. Open the same video as your partner
4. Press play or pause on your end — your partner syncs too!

---

## Works great on

| Site | Notes |
|------|-------|
| YouTube | ✅ Works perfectly |
| Vimeo | ✅ Works perfectly |
| Any site with HTML5 `<video>` | ✅ Works |
| Netflix | ⚠️ Tricky — Netflix fights extensions. May need workarounds |
| Disney+ / Prime | ⚠️ Same as Netflix |

**Tip:** For Netflix/Prime, both users should manually match the timestamp first, then use Duet just for play/pause sync.

---

## File structure

```
extension/
├── manifest.json        # Extension config (Manifest V3)
├── background.js        # Service worker — Firebase, room logic
├── content.js           # Injected into video pages — detects & syncs video
├── popup.html           # Extension popup UI
├── popup.js             # Popup logic
├── firebase-config.js   # Setup reference + DB rules (not loaded by extension)
├── vendor/              # Bundled Firebase SDK (MV3 forbids remote scripts)
│   ├── firebase-app-compat.js
│   └── firebase-database-compat.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How sync works (technical)

```
User A presses pause
  └→ content.js detects pause event
      └→ sends SYNC_EVENT to background.js
          └→ background.js pushes { action: "pause", currentTime: 42.1, timestamp: ... }
             to Firebase Realtime Database → rooms/{roomCode}/state
              └→ Firebase delivers update to User B's background.js
                  └→ background.js sends REMOTE_SYNC to content.js in active tab
                      └→ content.js pauses User B's video at the right time
                          └→ Drift correction: adjusts for network latency
```

**Echo prevention:** Every sync event is tagged with the sender's userId. When Firebase delivers it back to the sender, `background.js` ignores it (checks `updatedBy === myUserId`). The content script also suppresses local play/pause events for ~400 ms while applying a remote one, so `video.play()` doesn't bounce back as a new event.

**Drift correction:** Each event carries `serverTime` (Firebase server timestamp) instead of `Date.now()`. The receiver compares it against its own server-clock-corrected "now" (using `.info/serverTimeOffset`), so latency math is accurate even if the two laptops' wall clocks disagree by minutes.

**Peer presence:** Each user writes a node under `presence/{roomCode}/{userId}` with an `onDisconnect().remove()` handler, so leaving a tab or losing wifi automatically frees the seat. The popup reflects "Waiting for partner" vs "Partner connected" live.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Firebase not configured" | Open ⚙ Config and save your Firebase values |
| "Room not found" | Check the code — it's case-insensitive but must be 6 chars |
| "Room is full" | Each room is strictly 2 users. Create a new room. |
| Videos not syncing | Make sure both users are on the same URL. Reload the tab after joining. |
| Partner's video doesn't react | Check they're in the same room code. Try leaving and re-joining. |
| Extension stops syncing after a while | MV3 service workers idle out. Any video event wakes it instantly; if needed, click the popup once. |
| Autoplay was blocked when partner pressed play | Browsers block programmatic play before any user gesture. Click anywhere on the video once, then it works for the rest of the session. |

---

## Roadmap (nice-to-haves)

- [x] Floating emoji reactions (❤️ 😂 😮 🔥)
- [x] Custom emoji avatars & pack selection
- [ ] Mini text chat without leaving video
- [ ] "Host-only control" mode for one-sided playback
- [ ] Session timer ("watching together for 1h 23m")
- [ ] Firefox support (Manifest V3 is mostly compatible)
- [ ] Local file sync (drag the same file into both browsers)

---

## Built with

- Chrome Extensions Manifest V3
- Firebase Realtime Database (free Spark tier is more than enough for 2 users)
- Vanilla JS — no build step needed

---

*Made with ❤️ for the couples, best friends, and long-distance families who just want to watch a movie together.*
