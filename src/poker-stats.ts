/**
 * Room lifecycle statistics: when each room was created, when it went away, and
 * which rooms are live right now, over a rolling 7-day window.
 *
 * GET /api/poker/stats, gated on the STATS_TOKEN env var. A live room code is
 * all anyone needs to walk into an estimation session (a PIN is optional and set
 * by the first joiner), so this endpoint publishes codes only behind a bearer
 * token, and 404s when no token is configured — an unconfigured deployment gives
 * no hint that the route exists.
 *
 * Storage is Deno KV: durable across restarts and shared by every isolate on
 * Deno Deploy. It needs `--unstable-kv` (plus `--allow-write` for the local
 * SQLite file); without it `Deno.openKv` is simply missing, every recorder here
 * turns into a no-op and the endpoint answers 503. Collecting stats must never
 * be able to break a poker room.
 *
 * Two things the obvious schema gets wrong, both worked around here:
 *
 *   - Room codes are reused. Keyed by code alone, next week's QK7M would land on
 *     top of this week's record. So each run of a room is its own session,
 *     `["session", code, startedAt]`, with `["live", code]` pointing at the
 *     current one.
 *   - On Deno Deploy a room is opened once per isolate that holds a socket for
 *     it. The pointer is written with a compare-and-swap, so the first isolate
 *     creates the session and the rest join it instead of logging duplicates.
 *
 * The 7-day window is applied when reading, not by KV expiry: `expireIn` is
 * best-effort (a local record with a 200ms TTL is still readable seconds later),
 * so it only keeps the store from growing without bound.
 *
 * `live` is derived from freshness rather than from destroyedAt alone. Each
 * isolate refreshes `lastSeenAt` on its 30s heartbeat while it holds sockets, so
 * a room whose process was killed — no cleanup, no destroy event ever — ages out
 * by itself instead of being reported live forever. `destroyedAt` stays
 * best-effort, and freshness guards it too: a close is only written once nothing
 * has refreshed the session for LIVE_TTL_MS, so an isolate whose own slice
 * emptied first cannot close a room its siblings are still serving (which would
 * strand the survivors into a second session for the same room).
 */

/** Rolling window the endpoint reports on. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Server heartbeat is 30s; three missed refreshes means the slice is gone. */
const LIVE_TTL_MS = 95_000;

/** One run of one room code. */
export interface RoomRecord {
  code: string;
  /** First successful join — a code nobody joined was never a room. */
  createdAt: number;
  /** Best-effort: null while live. */
  destroyedAt: number | null;
  lastSeenAt: number;
  /** Participants at the last refresh, merged across isolates. */
  participants: number;
  peakParticipants: number;
}

/** What the endpoint returns per room. */
export interface PublicRoom {
  code: string;
  createdAt: string;
  destroyedAt: string | null;
  lastSeenAt: string;
  live: boolean;
  minutes: number;
  participants: number;
  peakParticipants: number;
}

type Pointer = { startedAt: number };

const sessionKey = (code: string, startedAt: number) => ["session", code, startedAt];
const liveKey = (code: string) => ["live", code];

/* ------------------------------- pure logic ------------------------------- */

/** Live means "not closed, and some isolate refreshed it recently". */
export function isLive(record: RoomRecord, now: number): boolean {
  return record.destroyedAt === null && now - record.lastSeenAt < LIVE_TTL_MS;
}

/**
 * Rooms created inside the window, plus anything still live — a room running
 * longer than the window is still news.
 */
export function inWindow(record: RoomRecord, now: number): boolean {
  return record.createdAt >= now - WINDOW_MS || isLive(record, now);
}

/** A record's public shape. Duration runs to the close, or to now while live. */
export function toPublicRoom(record: RoomRecord, now: number): PublicRoom {
  const live = isLive(record, now);
  const until = record.destroyedAt ?? (live ? now : record.lastSeenAt);
  return {
    code: record.code,
    createdAt: new Date(record.createdAt).toISOString(),
    destroyedAt: record.destroyedAt === null ? null : new Date(record.destroyedAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    live,
    minutes: Math.max(0, Math.round((until - record.createdAt) / 60_000)),
    // Defaulted like the write path does: `isRecord` doesn't vet the counts, and
    // an undefined here would be dropped from the JSON entirely rather than
    // reported as 0.
    participants: live ? record.participants ?? 0 : 0,
    peakParticipants: record.peakParticipants ?? 0,
  };
}

/**
 * Constant-time bearer check, so a wrong token leaks nothing through timing.
 * The loop always runs the configured token's length; a length mismatch still
 * fails via the folded-in length comparison.
 */
export function bearerMatches(header: string | null, token: string): boolean {
  const prefix = "bearer ";
  if (!token || !header || header.length < prefix.length) return false;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  const encoder = new TextEncoder();
  const given = encoder.encode(header.slice(prefix.length).trim());
  const want = encoder.encode(token);
  let diff = given.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= (given[i] ?? 0) ^ want[i];
  return diff === 0;
}

/** Guards against junk read back from KV (an older record shape, say). */
function isRecord(value: unknown): value is RoomRecord {
  const r = value as RoomRecord | null;
  return !!r && typeof r.code === "string" && typeof r.createdAt === "number" &&
    typeof r.lastSeenAt === "number" &&
    (r.destroyedAt === null || typeof r.destroyedAt === "number");
}

/* --------------------------------- storage -------------------------------- */

let kv: Deno.Kv | null = null;
let opening: Promise<Deno.Kv | null> | null = null;

/**
 * Opens KV once; null (and one warning) when the runtime has no KV.
 *
 * POKER_KV_PATH pins the database file, which is how the container gets a
 * writable location without the process needing write access to its whole
 * filesystem. Unset — Deno Deploy, and local dev — means the default: Deploy's
 * managed store there, a file under DENO_DIR here.
 */
function kvHandle(): Promise<Deno.Kv | null> {
  opening ??= (async () => {
    try {
      if (typeof Deno.openKv !== "function") {
        throw new Error("Deno.openKv is missing — start the server with --unstable-kv");
      }
      const path = Deno.env.get("POKER_KV_PATH");
      kv = path ? await Deno.openKv(path) : await Deno.openKv();
    } catch (err) {
      console.warn(
        `meso.poker: room stats disabled (${err instanceof Error ? err.message : String(err)})`,
      );
      kv = null;
    }
    return kv;
  })();
  return opening;
}

/** Fire-and-forget: a stats write must never delay, or break, a socket. */
function background(task: (kv: Deno.Kv) => Promise<unknown>): void {
  kvHandle()
    .then((handle) => (handle ? task(handle) : undefined))
    .catch((err) => {
      console.warn(`meso.poker: stats write failed (${err instanceof Error ? err.message : err})`);
    });
}

/** The live session for a code, or null when there isn't a fresh one. */
async function currentSession(
  handle: Deno.Kv,
  code: string,
  now: number,
): Promise<{ key: Deno.KvKey; record: RoomRecord; versionstamp: string } | null> {
  const pointer = await handle.get<Pointer>(liveKey(code));
  if (!pointer.value || pointer.versionstamp === null) return null;
  const key = sessionKey(code, pointer.value.startedAt);
  const entry = await handle.get<RoomRecord>(key);
  // A killed process leaves the pointer behind, so a stale session reads as gone
  // and the next join starts a fresh one.
  if (!isRecord(entry.value) || !isLive(entry.value, now) || entry.versionstamp === null) {
    return null;
  }
  return { key, record: entry.value, versionstamp: entry.versionstamp };
}

/**
 * The write behind `recordRoomActivity`, with its handle and clock passed in so
 * tests can drive it without the module's KV singleton or real time.
 */
export async function writeRoomActivity(
  handle: Deno.Kv,
  code: string,
  participants: number,
  now: number,
): Promise<void> {
  const session = await currentSession(handle, code, now);

  if (session) {
    const next: RoomRecord = {
      ...session.record,
      destroyedAt: null,
      lastSeenAt: now,
      participants,
      peakParticipants: Math.max(session.record.peakParticipants ?? 0, participants),
    };
    // Compare-and-swap rather than a blind set, so two isolates refreshing at
    // once can't clobber each other's peak. Losing the race is harmless: the
    // winner already refreshed lastSeenAt, and the next heartbeat retries.
    await handle.atomic()
      .check({ key: session.key, versionstamp: session.versionstamp })
      .set(session.key, next, { expireIn: WINDOW_MS })
      .commit();
    return;
  }

  // No live session: claim the pointer. Checking the versionstamp we just read
  // (null when absent, or a stale pointer's) means exactly one isolate creates
  // the session and any other falls through to the next heartbeat.
  const pointer = await handle.get<Pointer>(liveKey(code));
  const record: RoomRecord = {
    code,
    createdAt: now,
    destroyedAt: null,
    lastSeenAt: now,
    participants,
    peakParticipants: participants,
  };
  await handle.atomic()
    .check({ key: liveKey(code), versionstamp: pointer.versionstamp })
    .set(liveKey(code), { startedAt: now }, { expireIn: WINDOW_MS })
    .set(sessionKey(code, now), record, { expireIn: WINDOW_MS })
    .commit();
}

/**
 * Record that a room is open, creating its session on first sight. Called on
 * every join and leave and on the server heartbeat, so `lastSeenAt` keeps the
 * room live and `participants` tracks the merged count.
 */
export function recordRoomActivity(code: string, participants: number): void {
  background((handle) => writeRoomActivity(handle, code, participants, Date.now()));
}

/**
 * The write behind `recordRoomClosed`, with its handle and clock passed in.
 *
 * A cleanup timer only speaks for the isolate that set it, so it may close the
 * session only once nothing is refreshing it any more. A sibling still holding
 * sockets refreshes every 30s, and a session started after this timer was set is
 * fresher still — closing on either would end a room that is still running, and
 * the next heartbeat would then open a second session for it. The isolate that
 * genuinely held the last slice always sees a stale record: its own room sat
 * empty for EMPTY_ROOM_TTL_MS (5 min) before this fires, far longer than the
 * 95s liveness window.
 */
export async function writeRoomClosed(handle: Deno.Kv, code: string, now: number): Promise<void> {
  const pointer = await handle.get<Pointer>(liveKey(code));
  if (!pointer.value) return;
  const key = sessionKey(code, pointer.value.startedAt);
  const entry = await handle.get<RoomRecord>(key);
  if (!isRecord(entry.value)) return;
  // Already closed, or someone is still serving it: not this isolate's to close.
  if (entry.value.destroyedAt !== null || isLive(entry.value, now)) return;
  const closed: RoomRecord = { ...entry.value, destroyedAt: now, participants: 0 };
  await handle.atomic()
    .check({ key, versionstamp: entry.versionstamp })
    .set(key, closed, { expireIn: WINDOW_MS })
    .delete(liveKey(code))
    .commit();
}

/** Record that a room went away. Best-effort — see the module comment. */
export function recordRoomClosed(code: string): void {
  background((handle) => writeRoomClosed(handle, code, Date.now()));
}

/* -------------------------------- endpoint -------------------------------- */

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * GET /api/poker/stats — room lifecycle over the last 7 days, newest first.
 * 404 when STATS_TOKEN is unset, 401 without a matching bearer token, 503 when
 * the runtime has no KV.
 */
export async function handleStatsRequest(req: Request): Promise<Response> {
  const token = Deno.env.get("STATS_TOKEN") ?? "";
  if (!token) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (!bearerMatches(req.headers.get("authorization"), token)) {
    return json({ error: "Unauthorized." }, 401, { "www-authenticate": "Bearer" });
  }

  const handle = await kvHandle();
  if (!handle) {
    return json({
      error: "Room stats unavailable: the server was started without --unstable-kv.",
    }, 503);
  }

  const now = Date.now();
  const records: RoomRecord[] = [];
  for await (const entry of handle.list<RoomRecord>({ prefix: ["session"] })) {
    if (isRecord(entry.value) && inWindow(entry.value, now)) records.push(entry.value);
  }
  records.sort((a, b) => b.createdAt - a.createdAt);

  const rooms = records.map((record) => toPublicRoom(record, now));
  return json(
    {
      generatedAt: new Date(now).toISOString(),
      windowDays: WINDOW_MS / 86_400_000,
      liveNow: rooms.filter((room) => room.live).length,
      created: rooms.length,
      destroyed: rooms.filter((room) => room.destroyedAt !== null).length,
      rooms,
    },
    200,
    { "cache-control": "no-store" },
  );
}
