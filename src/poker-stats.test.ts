/**
 * Tests for the pure half of the stats module — the window filter, the liveness
 * rule and the bearer check. Deliberately std-free, like poker.test.ts, and
 * KV-free so `deno task test` needs no extra flags: everything here takes a
 * record and a clock reading.
 */
import { bearerMatches, inWindow, isLive, type RoomRecord, toPublicRoom } from "./poker-stats.ts";

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
