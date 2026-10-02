// ============================================================
//  Duet — Scheduled Cleanup (Cloud Functions)
// ============================================================
//
// Deletes rooms and presence records that haven't been touched in 7 days.
// Keeps storage bounded so abandoned rooms can't accumulate forever.
//
// Deploy (rules first — the query below needs the `.indexOn: lastTouch`
// index they define, or the server refuses to filter and the Admin SDK
// would download the entire `rooms` tree instead):
//   cd firebase
//   firebase deploy --only database,functions
//
// Billing: scheduled functions require the Blaze (pay-as-you-go) plan, since
// they run on Cloud Scheduler. One run a day stays well inside Blaze's free
// allowances, so expected cost is $0 — but the project must be on Blaze.

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BATCH = 500;                            // rooms fetched per query
const MAX_BATCHES = 40;                       // ≤ 20k rooms per run

// Same fallback chain clients use: rooms created by older clients may lack
// `lastTouch` until their first sync event.
function lastActivity(room) {
  return room.lastTouch || room.state?.serverTime || room.created || 0;
}

exports.cleanupIdleRooms = functions.pubsub
  .schedule("every 24 hours")
  .timeZone("Etc/UTC")
  .onRun(async () => {
    const db = admin.database();
    const cutoff = Date.now() - MAX_IDLE_MS;
    let scanned = 0;
    let deleted = 0;

    // Only rooms whose lastTouch is old — or missing, since nulls sort first —
    // are read; active rooms are never downloaded. Page with a (lastTouch,
    // key) cursor so rooms that are skipped (no lastTouch yet, but recent
    // `created`) aren't re-read forever.
    let cursor = null;
    for (let i = 0; i < MAX_BATCHES; i++) {
      let query = db.ref("rooms").orderByChild("lastTouch");
      if (cursor) query = query.startAfter(cursor.value, cursor.key);
      const snap = await query.endAt(cutoff).limitToFirst(BATCH).once("value");

      const updates = {};
      let count = 0;
      snap.forEach((roomSnap) => {
        count++;
        cursor = { value: roomSnap.child("lastTouch").val(), key: roomSnap.key };
        if (lastActivity(roomSnap.val() || {}) < cutoff) {
          updates[`rooms/${roomSnap.key}`] = null;
          updates[`presence/${roomSnap.key}`] = null;
          deleted++;
        }
      });
      scanned += count;
      if (Object.keys(updates).length) await db.ref().update(updates);
      if (count < BATCH) break;
    }

    functions.logger.info(`Duet cleanup: scanned ${scanned} idle-candidate rooms, deleted ${deleted}.`);
    return null;
  });
