/**
 * WebSocket server for the scrum-poker tool.
 *
 * Rooms are kept in memory and driven by the shared reducer in `poker.mjs`
 * (the same module the browser uses for solo mode). On Deno Deploy, sockets
 * for one room may land on different isolates; a BroadcastChannel gossips
 * per-isolate snapshots and shared events so every isolate can render the
 * full room. Each participant is owned by exactly one isolate — the one
 * holding its socket — so participant maps merge without conflicts.
 *
 * Wire protocol (JSON):
 *   client -> server: { type: "vote", value }   value: deck card or null
 *                     { type: "reveal" } | { type: "reset" }
 *                     { type: "story", text } | { type: "ping" }
 *                     { type: "wheel-set", names } | { type: "wheel-spin", winner }
 *                     { type: "theme", theme }    theme: a CARD_THEMES id
 *   server -> client: { type: "state", room, state }  (see publicState)
 *                     { type: "pong" } | { type: "error", message }
 */
import { applyEvent, CODE_PATTERN, createRoom, LIMITS, mergeRooms, publicState } from "./poker.mjs";

type Room = ReturnType<typeof createRoom>;
type RoomEvent = Parameters<typeof applyEvent>[1];

interface LocalRoom {
  /** This isolate's slice of the room: its own participants + shared flags. */
  state: Room;
  /** Open sockets on this isolate, by participant id. */
  clients: Map<string, WebSocket>;
  /** Latest snapshot from each sibling isolate. */
  remotes: Map<string, { state: Room; seenAt: number }>;
  /** Typed via setTimeout so it works whether Deno resolves web or Node timer types. */
  emptyTimer?: ReturnType<typeof setTimeout>;
}

interface GossipMessage {
  from: string;
  room: string;
  /** The sender's local snapshot. */
  state: Room;
  /** A shared event every isolate must replay (reveal / reset / story). */
  event?: RoomEvent;
  /** The sender just opened this room and asks siblings for their snapshots. */
  hello?: boolean;
}

const MAX_ROOMS = 500;
const MAX_MESSAGE_BYTES = 4096;
const REMOTE_TTL_MS = 75_000;
const HEARTBEAT_MS = 30_000;
const EMPTY_ROOM_TTL_MS = 5 * 60_000;

const isolateId = crypto.randomUUID();
const rooms = new Map<string, LocalRoom>();

// BroadcastChannel spans isolates on Deno Deploy; locally there are no
// siblings, so the channel is simply quiet.
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("meso-poker");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* the socket died mid-send; onclose will clean up */
  }
}

function getRoom(code: string): LocalRoom {
  let room = rooms.get(code);
  if (!room) {
    room = { state: createRoom(), clients: new Map(), remotes: new Map() };
    rooms.set(code, room);
  }
  clearTimeout(room.emptyTimer);
  return room;
}

function broadcast(code: string, room: LocalRoom, extra?: Partial<GossipMessage>): void {
  if (!channel) return;
  const message: GossipMessage = { from: isolateId, room: code, state: room.state, ...extra };
  channel.postMessage(message);
}

/** Send every local client its per-viewer projection of the merged room. */
function pushState(code: string, room: LocalRoom): void {
  const merged = mergeRooms(room.state, [...room.remotes.values()].map((r) => r.state));
  for (const [id, socket] of room.clients) {
    send(socket, { type: "state", room: code, state: publicState(merged, id) });
  }
}

/** When the last local socket is gone, keep the state briefly, then drop it. */
function scheduleCleanup(code: string, room: LocalRoom): void {
  clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    const current = rooms.get(code);
    if (current === room && current.clients.size === 0) rooms.delete(code);
  }, EMPTY_ROOM_TTL_MS);
}

if (channel) {
  channel.onmessage = (e: MessageEvent<GossipMessage>) => {
    const msg = e.data;
    if (!msg || msg.from === isolateId) return;
    // Only rooms with local sockets need syncing; a future local join sends
    // `hello` and the siblings answer with their snapshots.
    const room = rooms.get(msg.room);
    if (!room) return;
    room.remotes.set(msg.from, { state: msg.state, seenAt: Date.now() });
    if (msg.event) applyEvent(room.state, msg.event);
    // Catch-up: adopt newer shared flags from the snapshot (no-op when the
    // event above already carried them).
    if (msg.state.revealedAt > room.state.revealedAt) {
      room.state.revealed = msg.state.revealed;
      room.state.revealedAt = msg.state.revealedAt;
    }
    if (msg.state.storyAt > room.state.storyAt) {
      room.state.story = msg.state.story;
      room.state.storyAt = msg.state.storyAt;
    }
    if (msg.state.wheelNamesAt > room.state.wheelNamesAt) {
      room.state.wheelNames = [...msg.state.wheelNames];
      room.state.wheelNamesAt = msg.state.wheelNamesAt;
    }
    if (msg.state.wheelSpunAt > room.state.wheelSpunAt) {
      room.state.wheelWinner = msg.state.wheelWinner;
      room.state.wheelSpunAt = msg.state.wheelSpunAt;
    }
    if (msg.hello) broadcast(msg.room, room);
    pushState(msg.room, room);
  };
}

// Refresh siblings and drop the ones that stopped gossiping (crashed isolates
// never send a "leave" for their participants).
setInterval(() => {
  const cutoff = Date.now() - REMOTE_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.clients.size === 0) continue;
    broadcast(code, room);
    let pruned = false;
    for (const [id, remote] of room.remotes) {
      if (remote.seenAt < cutoff) {
        room.remotes.delete(id);
        pruned = true;
      }
    }
    if (pruned) pushState(code, room);
  }
}, HEARTBEAT_MS);

function handleClientMessage(code: string, room: LocalRoom, id: string, raw: string): void {
  if (raw.length > MAX_MESSAGE_BYTES) return;
  let message: {
    type?: string;
    value?: unknown;
    text?: unknown;
    names?: unknown;
    winner?: unknown;
    theme?: unknown;
  };
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const socket = room.clients.get(id);

  switch (message.type) {
    case "ping": {
      if (socket) send(socket, { type: "pong" });
      return;
    }
    case "vote": {
      const value = message.value === null ? null : String(message.value ?? "");
      if (applyEvent(room.state, { type: "vote", id, value })) {
        broadcast(code, room);
        pushState(code, room);
      }
      return;
    }
    case "reveal":
    case "reset": {
      const event: RoomEvent = { type: message.type, at: Date.now() };
      if (applyEvent(room.state, event)) {
        broadcast(code, room, { event });
        pushState(code, room);
      }
      return;
    }
    case "story": {
      const event: RoomEvent = { type: "story", text: String(message.text ?? ""), at: Date.now() };
      if (applyEvent(room.state, event)) {
        broadcast(code, room, { event });
        pushState(code, room);
      }
      return;
    }
    // Wheel updates are shared flags (like the story): siblings adopt them
    // from the gossiped snapshot, so no event needs to travel along.
    case "wheel-set": {
      const names = Array.isArray(message.names) ? message.names.map((n) => String(n ?? "")) : [];
      if (applyEvent(room.state, { type: "wheel-set", names, at: Date.now() })) {
        broadcast(code, room);
        pushState(code, room);
      }
      return;
    }
    case "wheel-spin": {
      const winner = String(message.winner ?? "");
      if (applyEvent(room.state, { type: "wheel-spin", winner, at: Date.now() })) {
        broadcast(code, room);
        pushState(code, room);
      }
      return;
    }
    case "theme": {
      if (applyEvent(room.state, { type: "theme", id, theme: String(message.theme ?? "") })) {
        broadcast(code, room);
        pushState(code, room);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * GET /api/poker/ws?room=CODE&name=NAME — upgrade to a poker-room socket.
 * Returns a JSON error response when the request is not a valid upgrade.
 */
export function handlePokerSocket(req: Request): Response {
  const url = new URL(req.url);
  const code = (url.searchParams.get("room") ?? "").trim().toUpperCase();
  const name = (url.searchParams.get("name") ?? "").trim();
  // Optional card theme; the reducer falls back to the default for junk.
  const theme = url.searchParams.get("theme") ?? "";

  if (!CODE_PATTERN.test(code)) {
    return json({ error: "Invalid room code (4–8 letters/digits)." }, 400);
  }
  if (!name || name.length > LIMITS.name) {
    return json({ error: `Missing or too-long name (max ${LIMITS.name} characters).` }, 400);
  }
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "Expected a WebSocket upgrade request." }, 426);
  }
  if (!rooms.has(code) && rooms.size >= MAX_ROOMS) {
    return json({ error: "Too many active rooms — try again later." }, 503);
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = crypto.randomUUID();

  socket.onopen = () => {
    const isNewHere = !rooms.has(code);
    const room = getRoom(code);
    if (!applyEvent(room.state, { type: "join", id, name, theme, at: Date.now() })) {
      send(socket, { type: "error", message: "Room is full." });
      socket.close(1008, "room full");
      if (room.clients.size === 0) scheduleCleanup(code, room);
      return;
    }
    room.clients.set(id, socket);
    // `hello` asks sibling isolates to answer with their snapshots so a
    // freshly-opened room catches up on participants, story and reveal state.
    broadcast(code, room, isNewHere ? { hello: true } : undefined);
    pushState(code, room);
  };

  socket.onmessage = (e) => {
    const room = rooms.get(code);
    if (room && typeof e.data === "string") handleClientMessage(code, room, id, e.data);
  };

  socket.onclose = () => {
    const room = rooms.get(code);
    if (!room) return;
    room.clients.delete(id);
    if (applyEvent(room.state, { type: "leave", id })) {
      broadcast(code, room);
      pushState(code, room);
    }
    if (room.clients.size === 0) scheduleCleanup(code, room);
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  return response;
}
