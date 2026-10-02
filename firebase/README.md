# Duet — Firebase backend

This folder holds the Realtime Database rules and the scheduled cleanup
function that runs on the developer-managed Firebase project.

## Deploying

```bash
cd firebase
npm install --prefix functions
firebase deploy --only database,functions --project pausepal-a4d71
```

## Files

- `database.rules.json` — RTDB security rules. Includes:
  - Read/write require a 6-character room code (no enumeration).
  - 75ms write floor per room (rate-limit per partner pair).
  - Hard caps on every string field (URL ≤ 1024, title ≤ 256, etc.).
  - Numeric ranges on `currentTime`/`duration` (rejects garbage seek targets).
  - `$other: false` on every schema branch (rejects unknown fields).
- `functions/index.js` — Scheduled function. Runs daily, deletes rooms idle
  for 7+ days plus their corresponding presence records. It queries
  `rooms` by `lastTouch`, so it depends on the `.indexOn` in the rules —
  deploy rules before (or with) functions.
- `firebase.json` — Project config glue.

## Operational notes

- Billing alerts: set in Google Cloud Console → Billing → Budgets & alerts.
  Thresholds at 50/75/90/100/200% of $10/mo.
- API key restriction: Cloud Console → APIs & Services → Credentials →
  restrict to `chrome-extension://<extension-id>/*` once the extension has
  a stable Web Store ID.
- Plan: the scheduled cleanup function needs **Blaze** (Cloud Scheduler isn't
  available on Spark). A daily run fits inside Blaze's free allowances.
- Connections: the extension only opens a database connection while the
  browser is in a room, and closes it on leave. So connection count tracks
  people actively in rooms, not installs. Spark caps RTDB at 100 concurrent
  connections (~50 pairs); Blaze raises that to 200k per database.
- Egress: each in-room client publishes its position about once a second
  and pings every 5s — rough estimate 5–10 MB per pair per hour.
