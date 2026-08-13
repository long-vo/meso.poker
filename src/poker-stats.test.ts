/**
 * Tests for the stats module: the pure half — window filter, liveness rule,
 * bearer check — takes a record and a clock reading, and the storage half runs
 * against a throwaway in-memory KV.
 *
 * The storage tests exist because the interesting bugs live there and none of
 * the pure functions can see them: a room's sockets can be split across isolates
 * on Deno Deploy, and each isolate runs its own cleanup timer. `writeRoomActivity`
 * and `writeRoomClosed` take their handle and clock explicitly so those races can
 * be played out exactly, with no sleeping and no shared KV singleton.
 */
import {
  bearerMatches,
  inWindow,
  isLive,
  type RoomRecord,
  toPublicRoom,
  writeRoomActivity,
  writeRoomClosed,
} from "./poker-stats.ts";

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ?? "assertEquals"}: got ${a}, want ${b}`);
}

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function record(over: Partial<RoomRecord> = {}): RoomRecord {
  return {
    code: "QK7M",
    createdAt: NOW - 30 * MINUTE,
    destroyedAt: null,
    lastSeenAt: NOW,
    participants: 3,
    peakParticipants: 5,
    ...over,
  };
}

/* --------------------------------- isLive --------------------------------- */

Deno.test("isLive: a freshly refreshed, unclosed room is live", () => {
  assertEquals(isLive(record(), NOW), true);
});

Deno.test("isLive: a closed room is not live even if just refreshed", () => {
  assertEquals(isLive(record({ destroyedAt: NOW - MINUTE, lastSeenAt: NOW }), NOW), false);
});

Deno.test("isLive: survives two missed heartbeats, dies after three", () => {
  // The heartbeat is 30s and the cutoff 95s, so 60s stale is still live.
  assertEquals(isLive(record({ lastSeenAt: NOW - 60_000 }), NOW), true);
  assertEquals(isLive(record({ lastSeenAt: NOW - 96_000 }), NOW), false);
});

Deno.test("isLive: a killed process ages out instead of staying live forever", () => {
  // No cleanup ran, so destroyedAt is still null — freshness is what saves us.
  assertEquals(isLive(record({ destroyedAt: null, lastSeenAt: NOW - DAY }), NOW), false);
});

/* -------------------------------- inWindow -------------------------------- */

Deno.test("inWindow: keeps a room created inside the 7 days", () => {
  assertEquals(
    inWindow(record({ createdAt: NOW - 6 * DAY, lastSeenAt: NOW - 6 * DAY }), NOW),
    true,
  );
});

Deno.test("inWindow: drops a room created before the window", () => {
  assertEquals(
    inWindow(record({ createdAt: NOW - 8 * DAY, lastSeenAt: NOW - 8 * DAY }), NOW),
    false,
  );
});

Deno.test("inWindow: keeps an older room that is still live", () => {
  // A marathon room outliving the window is still worth reporting.
  assertEquals(inWindow(record({ createdAt: NOW - 9 * DAY, lastSeenAt: NOW }), NOW), true);
});

Deno.test("inWindow: the boundary is inclusive", () => {
  assertEquals(
    inWindow(record({ createdAt: NOW - 7 * DAY, lastSeenAt: NOW - 7 * DAY }), NOW),
    true,
  );
});

/* ------------------------------ toPublicRoom ------------------------------ */

Deno.test("toPublicRoom: live room reports its run so far and its head count", () => {
  const out = toPublicRoom(record({ createdAt: NOW - 42 * MINUTE, lastSeenAt: NOW }), NOW);
  assertEquals(out.live, true);
  assertEquals(out.minutes, 42);
  assertEquals(out.destroyedAt, null);
  assertEquals(out.participants, 3);
  assertEquals(out.peakParticipants, 5);
  assertEquals(out.createdAt, "2026-07-28T11:18:00.000Z");
});

Deno.test("toPublicRoom: closed room measures created -> destroyed", () => {
  const out = toPublicRoom(
    record({
      createdAt: NOW - 90 * MINUTE,
      destroyedAt: NOW - 30 * MINUTE,
      lastSeenAt: NOW - 35 * MINUTE,
    }),
    NOW,
  );
  assertEquals(out.live, false);
  assertEquals(out.minutes, 60);
  assertEquals(out.destroyedAt, "2026-07-28T11:30:00.000Z");
  // Nobody is in a closed room, whatever the last refresh happened to say.
  assertEquals(out.participants, 0);
});

Deno.test("toPublicRoom: a room killed with the process measures to its last refresh", () => {
  const out = toPublicRoom(
    record({
      createdAt: NOW - 3 * DAY,
      destroyedAt: null,
      lastSeenAt: NOW - 3 * DAY + 20 * MINUTE,
    }),
    NOW,
  );
  assertEquals(out.live, false);
  assertEquals(out.destroyedAt, null, "no destroy event was ever recorded");
  assertEquals(out.minutes, 20, "duration stops at the last sign of life, not at now");
});

/* ----------------------------- bearerMatches ----------------------------- */

Deno.test("bearerMatches: accepts the right token, any header casing", () => {
  assertEquals(bearerMatches("Bearer s3cret", "s3cret"), true);
  assertEquals(bearerMatches("bearer s3cret", "s3cret"), true);
  assertEquals(bearerMatches("BEARER s3cret", "s3cret"), true);
});

Deno.test("bearerMatches: rejects wrong, short, long and empty tokens", () => {
  assertEquals(bearerMatches("Bearer wrong", "s3cret"), false);
  assertEquals(bearerMatches("Bearer s3cre", "s3cret"), false, "prefix of the token");
  assertEquals(bearerMatches("Bearer s3cretX", "s3cret"), false, "token plus extra");
  assertEquals(bearerMatches("Bearer ", "s3cret"), false);
});

Deno.test("bearerMatches: rejects a missing or malformed header", () => {
  assertEquals(bearerMatches(null, "s3cret"), false);
  assertEquals(bearerMatches("s3cret", "s3cret"), false, "no scheme");
  assertEquals(bearerMatches("Basic s3cret", "s3cret"), false);
  assertEquals(bearerMatches("Bea", "s3cret"), false, "shorter than the scheme");
});

Deno.test("bearerMatches: never passes when no token is configured", () => {
  assertEquals(bearerMatches("Bearer anything", ""), false);
  assertEquals(bearerMatches("Bearer ", ""), false);
});

Deno.test("bearerMatches: compares bytes, so unicode tokens work", () => {
  assertEquals(bearerMatches("Bearer pä€ss", "pä€ss"), true);
  assertEquals(bearerMatches("Bearer pa€ss", "pä€ss"), false);
});

/* -------------------------------- storage --------------------------------- */

/** A throwaway KV per test, so nothing leaks between them. */
async function freshKv(): Promise<Deno.Kv> {
  return await Deno.openKv(":memory:");
}

/** Every session record held for a code, oldest first. */
async function sessions(kv: Deno.Kv, code: string): Promise<RoomRecord[]> {
  const found: RoomRecord[] = [];
  for await (const entry of kv.list<RoomRecord>({ prefix: ["session", code] })) {
    found.push(entry.value);
  }
  return found.sort((a, b) => a.createdAt - b.createdAt);
}

const hasPointer = async (kv: Deno.Kv, code: string) =>
  (await kv.get(["live", code])).value !== null;

Deno.test("storage: a room opens once and refreshes in place", async () => {
  const kv = await freshKv();
  await writeRoomActivity(kv, "QK7M", 2, NOW);
  await writeRoomActivity(kv, "QK7M", 4, NOW + 30_000);
  const [only, ...rest] = await sessions(kv, "QK7M");
  assertEquals(rest.length, 0, "one session, not one per call");
  assertEquals(only.createdAt, NOW, "createdAt is pinned to the first sight");
  assertEquals(only.lastSeenAt, NOW + 30_000);
  assertEquals(only.peakParticipants, 4);
  kv.close();
});

Deno.test("storage: peak survives a refresh with fewer people left", async () => {
  const kv = await freshKv();
  await writeRoomActivity(kv, "QK7M", 6, NOW);
  await writeRoomActivity(kv, "QK7M", 1, NOW + 30_000);
  const [only] = await sessions(kv, "QK7M");
  assertEquals(only.participants, 1);
  assertEquals(only.peakParticipants, 6, "peak is a high-water mark");
  kv.close();
});

Deno.test("storage: the isolate holding the last slice closes the room", async () => {
  const kv = await freshKv();
  await writeRoomActivity(kv, "QK7M", 3, NOW);
  // Its room sat empty for the 5-minute cleanup TTL, so nothing refreshed the
  // session in the meantime and the close is this isolate's to make.
  await writeRoomClosed(kv, "QK7M", NOW + 5 * MINUTE);
  const [only] = await sessions(kv, "QK7M");
  assertEquals(only.destroyedAt, NOW + 5 * MINUTE);
  assertEquals(only.participants, 0);
  assertEquals(await hasPointer(kv, "QK7M"), false, "the live pointer is released");
  kv.close();
});

Deno.test("storage: a sibling's cleanup cannot close a room still being served", async () => {
  const kv = await freshKv();
  await writeRoomActivity(kv, "QK7M", 4, NOW);
  // The other isolate is still holding sockets and refreshing every 30s...
  await writeRoomActivity(kv, "QK7M", 4, NOW + 30_000);
  // ...while this one's slice emptied earlier and its cleanup timer now fires.
  await writeRoomClosed(kv, "QK7M", NOW + 40_000);

  const open = await sessions(kv, "QK7M");
  assertEquals(open.length, 1);
  assertEquals(open[0].destroyedAt, null, "a room others are serving stays open");
  assertEquals(await hasPointer(kv, "QK7M"), true, "so the pointer must survive");

  // The real damage was downstream: with the pointer gone, the sibling's next
  // heartbeat used to start a *second* session for the same room.
  await writeRoomActivity(kv, "QK7M", 2, NOW + 60_000);
  const after = await sessions(kv, "QK7M");
  assertEquals(after.length, 1, "still one session, not a split room");
  assertEquals(after[0].createdAt, NOW, "which keeps its original start");
  assertEquals(after[0].peakParticipants, 4, "and its peak");
  kv.close();
});

Deno.test("storage: a stale cleanup timer cannot close a newer session", async () => {
  const kv = await freshKv();
  // An earlier run that died with its process: never closed, never refreshed.
  await writeRoomActivity(kv, "QK7M", 9, NOW);
  // Long enough later that the old session has aged out, new people take the
  // same code and a genuinely new session starts.
  const later = NOW + 10 * MINUTE;
  await writeRoomActivity(kv, "QK7M", 3, later);
  // Only now does the first isolate's forgotten cleanup timer fire.
  await writeRoomClosed(kv, "QK7M", later + 40_000);

  const [old, fresh] = await sessions(kv, "QK7M");
  assertEquals(old.createdAt, NOW);
  assertEquals(fresh.createdAt, later);
  assertEquals(fresh.destroyedAt, null, "the live room must not be closed by it");
  assertEquals(await hasPointer(kv, "QK7M"), true);
  kv.close();
});

Deno.test("storage: closing is not repeated once a session is closed", async () => {
  const kv = await freshKv();
  await writeRoomActivity(kv, "QK7M", 3, NOW);
  await writeRoomClosed(kv, "QK7M", NOW + 5 * MINUTE);
  // A duplicate close (both isolates' timers firing) must not move destroyedAt.
  await writeRoomClosed(kv, "QK7M", NOW + 9 * MINUTE);
  const [only] = await sessions(kv, "QK7M");
  assertEquals(only.destroyedAt, NOW + 5 * MINUTE, "the first close stands");
  kv.close();
});
