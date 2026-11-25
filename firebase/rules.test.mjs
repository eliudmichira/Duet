// ============================================================
//  Duet — RTDB rules tests (run against the Database Emulator)
// ============================================================
// Replays the writes the extension makes (create, join, sync, tab info,
// reactions, ready check, leave) and a set of attacks, as an unauthenticated
// client over the emulator's REST API. No dependencies.
//
//   cd firebase
//   firebase emulators:exec --only database --project demo-duet "node rules.test.mjs"
//
// Keep it in step with background.js: a new write path there needs a case here.

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9000";
const BASE = `http://${HOST}`, NS = "demo-duet-default-rtdb";
const TS = { ".sv": "timestamp" };
let pass = 0, fail = 0;
async function req(method, path, body) {
  const r = await fetch(`${BASE}/${path}.json?ns=${NS}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.status;
}
async function expect(label, want, method, path, body) {
  const s = await req(method, path, body);
  const ok = want === "ok" ? s === 200 : s === 401;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} [${want}] ${label} (${s})`);
}
const room = (u, extra = {}) => ({ state: { action: "pause", currentTime: 0, updatedBy: u, serverTime: TS }, host: u, created: TS, lastTouch: TS, ...extra });
const meta = { name: "A", url: "https://x.test/v", hostname: "x.test", pageTitle: "t", duration: 100, currentTime: 1, paused: true, lastSeen: TS, emoji: "😀" };

console.log("--- legit flow: room AAAAAA");
await expect("create room", "ok", "PUT", "rooms/AAAAAA", room("u1"));
await expect("create on taken code", "deny", "PUT", "rooms/AAAAAA", room("x"));
await expect("u1 presence", "ok", "PUT", "presence/AAAAAA/u1", { joined: TS });
await expect("u1 meta", "ok", "PUT", "rooms/AAAAAA/meta/u1", meta);
await expect("validateRules force probe set", "ok", "PUT", "rooms/AAAAAA/state/force", true);
await expect("validateRules force probe remove", "ok", "DELETE", "rooms/AAAAAA/state/force");
await expect("u1 state play", "ok", "PUT", "rooms/AAAAAA/state", { action: "play", currentTime: 5, playbackRate: 1, updatedBy: "u1", serverTime: TS });
await expect("immediate second state write (no throttle)", "ok", "PUT", "rooms/AAAAAA/state", { action: "pause", currentTime: 5.1, playbackRate: 1, updatedBy: "u1", serverTime: TS });
await expect("state with force", "ok", "PUT", "rooms/AAAAAA/state", { action: "play", currentTime: 6, playbackRate: 1, updatedBy: "u1", serverTime: TS, force: true });
await expect("lastTouch", "ok", "PUT", "rooms/AAAAAA/lastTouch", TS);
await expect("join: read created", "ok", "GET", "rooms/AAAAAA/created");
await expect("join: read presence", "ok", "GET", "presence/AAAAAA");
await expect("u2 presence", "ok", "PUT", "presence/AAAAAA/u2", { joined: TS });
await expect("u2 meta", "ok", "PUT", "rooms/AAAAAA/meta/u2", meta);
await expect("u2 state", "ok", "PUT", "rooms/AAAAAA/state", { action: "pause", currentTime: 7, updatedBy: "u2", serverTime: TS });
await expect("u2 reaction", "ok", "PUT", "rooms/AAAAAA/reactions/r1", { emoji: "hello there", from: "u2", ts: TS });
await expect("reaction remove", "ok", "DELETE", "rooms/AAAAAA/reactions/r1");
await expect("together start", "ok", "PUT", "rooms/AAAAAA/together", { since: TS, total: 0 });
await expect("together freeze", "ok", "PUT", "rooms/AAAAAA/together", { total: 12.5 });
await expect("readycheck start", "ok", "PUT", "rooms/AAAAAA/readycheck", { id: "abc123", by: "u1", at: TS, ready: { u1: true } });
await expect("readycheck answer", "ok", "PUT", "rooms/AAAAAA/readycheck/ready/u2", true);
await expect("readycheck go", "ok", "PATCH", "rooms/AAAAAA/readycheck", { go: Date.now() + 3000, time: 10 });
await expect("readycheck remove", "ok", "DELETE", "rooms/AAAAAA/readycheck");
await expect("typing on", "ok", "PUT", "rooms/AAAAAA/typing/u2", true);
await expect("typing off", "ok", "DELETE", "rooms/AAAAAA/typing/u2");
await expect("ping", "ok", "PUT", "rooms/AAAAAA/ping/u2", TS);
await expect("paired", "ok", "PUT", "rooms/AAAAAA/paired", true);

console.log("--- attacks on AAAAAA");
await expect("state from non-member", "deny", "PUT", "rooms/AAAAAA/state", { action: "play", currentTime: 1, updatedBy: "ghost", serverTime: TS });
await expect("state with forged serverTime", "deny", "PUT", "rooms/AAAAAA/state", { action: "play", currentTime: 1, updatedBy: "u1", serverTime: 1 });
await expect("meta for non-member", "deny", "PUT", "rooms/AAAAAA/meta/ghost", meta);
await expect("typing for non-member", "deny", "PUT", "rooms/AAAAAA/typing/ghost", true);
await expect("reaction from non-member", "deny", "PUT", "rooms/AAAAAA/reactions/r2", { emoji: "x", from: "ghost", ts: TS });
await expect("reaction with old ts", "deny", "PUT", "rooms/AAAAAA/reactions/r3", { emoji: "x", from: "u1", ts: 1 });
await expect("readycheck by non-member", "deny", "PUT", "rooms/AAAAAA/readycheck", { id: "z", by: "ghost", at: TS });
await expect("overwrite created", "deny", "PUT", "rooms/AAAAAA/created", 1);
await expect("overwrite host", "deny", "PUT", "rooms/AAAAAA/host", "ghost");
await expect("unpair", "deny", "PUT", "rooms/AAAAAA/paired", false);
await expect("overwrite whole room", "deny", "PUT", "rooms/AAAAAA", room("ghost"));
await expect("delete room with people present", "deny", "DELETE", "rooms/AAAAAA");
await expect("unknown key", "deny", "PUT", "rooms/AAAAAA/junk", 1);
await expect("list rooms", "deny", "GET", "rooms");
await expect("ping in missing room", "deny", "PUT", "rooms/ZZZZZZ/ping/u1", TS);
await expect("presence in missing room", "deny", "PUT", "presence/ZZZZZZ/u1", { joined: TS });
await expect("create room w/o created", "deny", "PUT", "rooms/YYYYYY", { host: "u9" });

console.log("--- leaving paired room AAAAAA");
for (const p of ["presence/AAAAAA/u2", "rooms/AAAAAA/meta/u2", "rooms/AAAAAA/typing/u2", "rooms/AAAAAA/ping/u2"]) await expect(`u2 leave ${p}`, "ok", "DELETE", p);
for (const p of ["presence/AAAAAA/u1", "rooms/AAAAAA/meta/u1", "rooms/AAAAAA/typing/u1", "rooms/AAAAAA/ping/u1"]) await expect(`u1 leave ${p}`, "ok", "DELETE", p);
await expect("delete paired room (client never does this)", "deny", "DELETE", "rooms/AAAAAA");
await expect("paired leave clears readycheck", "ok", "DELETE", "rooms/AAAAAA/readycheck");

console.log("--- one-off room BBBBBB");
await expect("create", "ok", "PUT", "rooms/BBBBBB", room("u3"));
await expect("presence", "ok", "PUT", "presence/BBBBBB/u3", { joined: TS });
await expect("leave presence", "ok", "DELETE", "presence/BBBBBB/u3");
await expect("last one out deletes room", "ok", "DELETE", "rooms/BBBBBB");
await expect("late onDisconnect remove after room gone", "ok", "DELETE", "rooms/BBBBBB/typing/u3");
await expect("late reaction remove after room gone", "ok", "DELETE", "rooms/BBBBBB/reactions/r1");
await expect("straggler ping can't recreate room", "deny", "PUT", "rooms/BBBBBB/ping/u3", TS);
await expect("re-create freed code (saved room)", "ok", "PUT", "rooms/BBBBBB", room("u4", { paired: true }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
