/**
 * Socket-level tests for the room server. Run with `deno task test`.
 *
 * These exist for one reason: the duplicate-player bug lived in how the server
 * hands out participant ids, which the reducer tests cannot see. The scenario is
 * a *half-open* connection — the browser knows its socket died, the server does
 * not, because no FIN ever crossed the (now missing) network. That is what a
 * wifi drop, an LTE handoff or a VPN toggle looks like, and it is the only way
 * the ghost appears: every tidy exit (close handshake, `leave` frame, tab close)
 * already worked.
 *
 * A ghost is built by hand-rolling the WebSocket upgrade over a raw TCP socket
 * and then simply abandoning it — no close frame, no FIN — which no WebSocket
 * client API can express.
 */
import { CLIENT_TIMEOUT_MS, handlePokerSocket, heartbeat } from "./poker-server.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

/** A server on an ephemeral port, so tests never collide with a dev server. */
function startServer() {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req: Request) =>
      new URL(req.url).pathname === "/api/poker/ws" ? handlePokerSocket(req) : new Response("ok"),
  );
  return { server, port: (server.addr as Deno.NetAddr).port };
}

const utf8 = new TextEncoder();

interface State {
  revealed: boolean;
  story: string;
  participants: { name: string }[];
  stats: { votes: number } | null;
}

/**
 * A connected client that remembers the newest state frame, so a test can read
 * the table without waiting for a push that may never come (the last client to
 * join is nobody else's news), and can still await the push an action causes.
 */
interface Client {
  ws: WebSocket;
  /** Names at the table right now, in table order. */
  table(): string[];
  /**
   * The next state frame to arrive, for asserting after an action. Rejects if
   * none comes: the interesting regressions here are ones where the server
   * silently stops pushing, and a test that hangs on those is far worse in CI
   * than one that fails.
   */
  next(timeoutMs?: number): Promise<State>;
  close(): Promise<void>;
}

function join(port: number, room: string, name: string, cid?: string): Promise<Client> {
  const query = `room=${room}&name=${encodeURIComponent(name)}` + (cid ? `&cid=${cid}` : "");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/poker/ws?${query}`);
  let latest: State | null = null;
  const waiters: ((s: State) => void)[] = [];
  const client: Client = {
    ws,
    table: () => (latest?.participants ?? []).map((p) => p.name),
    next: (timeoutMs = 5_000) =>
      new Promise<State>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${name}: no state frame within ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push((s) => {
          clearTimeout(timer);
          resolve(s);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.onclose = () => resolve();
        ws.close();
      }),
  };
  return new Promise<Client>((resolve, reject) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type !== "state") return;
      latest = msg.state;
      for (const waiter of waiters.splice(0)) waiter(msg.state);
      resolve(client);
    };
    ws.onerror = () => reject(new Error(`${name} could not connect`));
  });
}

/**
 * Join, then let the connection go silent forever without ever closing it.
 * Returns the raw conn so the test can release it at the end.
 */
async function joinThenVanish(port: number, room: string, name: string, cid: string) {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await conn.write(
    new TextEncoder().encode(
      `GET /api/poker/ws?room=${room}&name=${name}&cid=${cid} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ),
  );
  const buf = new Uint8Array(256);
  const n = await conn.read(buf);
  const status = new TextDecoder().decode(buf.subarray(0, n ?? 0)).split("\r\n")[0];
  assertEquals(status, "HTTP/1.1 101 Switching Protocols", "ghost socket did not connect");
  return conn;
}

Deno.test("a reconnect after a silent drop reclaims its seat, it does not duplicate", async () => {
  const { server, port } = startServer();
  const cid = crypto.randomUUID();
  const ghost = await joinThenVanish(port, "GHOST", "Long", cid);
  // The server still believes Long is here — that is the whole point.
  const long = await join(port, "GHOST", "Long", cid); // the browser redialled
  const mai = await join(port, "GHOST", "Mai");
  assertEquals(mai.table(), ["Long", "Mai"], "Long must appear exactly once");

  // And the reclaimed seat is the live one: its votes still land.
  const voted = mai.next();
  long.ws.send(JSON.stringify({ type: "vote", value: "5" }));
  await voted;
  const revealed = mai.next();
  mai.ws.send(JSON.stringify({ type: "reveal" }));
  assertEquals((await revealed).stats?.votes, 1, "the reclaimed seat is the one that votes");

  await long.close();
  await mai.close();
  ghost.close();
  await server.shutdown();
});

Deno.test("a ghost's late close cannot evict the client that reclaimed its seat", async () => {
  const { server, port } = startServer();
  const cid = crypto.randomUUID();
  // Here the old socket *does* eventually close — the slow-proxy case — after
  // the reconnect already took the seat over.
  const stale = await join(port, "LATE", "Long", cid);
  const long = await join(port, "LATE", "Long", cid);
  const mai = await join(port, "LATE", "Mai");
  await stale.close();
  // The eviction, if it happened, would arrive as a state frame; give it the
  // chance to and then check nobody vanished.
  const seen = mai.next();
  long.ws.send(JSON.stringify({ type: "vote", value: "3" }));
  assertEquals((await seen).participants.map((p) => p.name), ["Long", "Mai"], "Long stays seated");

  await long.close();
  await mai.close();
  await server.shutdown();
});

Deno.test("two tabs are still two players", async () => {
  const { server, port } = startServer();
  const one = await join(port, "TABS", "Long", crypto.randomUUID());
  const two = await join(port, "TABS", "Long", crypto.randomUUID());
  const mai = await join(port, "TABS", "Mai");
  assertEquals(mai.table(), ["Long", "Long", "Mai"], "distinct ids keep distinct seats");

  await one.close();
  await two.close();
  await mai.close();
  await server.shutdown();
});

Deno.test("the reaper releases a silent seat rather than awaiting a close that never comes", async () => {
  const { server, port } = startServer();
  const ghost = await joinThenVanish(port, "REAP", "Long", crypto.randomUUID());
  // A gap, so a deadline can be placed between the two connections: the ghost
  // counts as silent, Mai does not.
  await new Promise((r) => setTimeout(r, 50));
  const betweenThem = Date.now();
  const mai = await join(port, "REAP", "Mai");
  assertEquals(mai.table(), ["Long", "Mai"], "the ghost is seated to begin with");

  const seen = mai.next();
  heartbeat(betweenThem + CLIENT_TIMEOUT_MS); // as if the 30 minutes had passed
  assertEquals((await seen).participants.map((p) => p.name), ["Mai"], "silent seat released");

  await mai.close();
  ghost.close();
  await server.shutdown();
});

Deno.test("reaping the last seat empties the room", async () => {
  // Emptying is what lets a room evaporate: while the ghost held a seat, the
  // room's client map never reached zero and cleanup was never scheduled.
  const { server, port } = startServer();
  const ghost = await joinThenVanish(port, "REAP2", "Long", crypto.randomUUID());
  await new Promise((r) => setTimeout(r, 50));
  heartbeat(Date.now() + CLIENT_TIMEOUT_MS);

  const newcomer = await join(port, "REAP2", "Mai");
  assertEquals(newcomer.table(), ["Mai"], "nobody is left holding a seat");

  await newcomer.close();
  ghost.close();
  await server.shutdown();
});

/**
 * A second isolate: a worker with its own module graph, so it gets its own
 * `rooms` map, its own isolateId, and reaches this one only over the
 * BroadcastChannel — which in the Deno CLI does span workers. That makes the
 * gossip path, and the `hasSiblings` guard on it, testable off Deno Deploy.
 */
async function startSiblingIsolate(): Promise<{ port: number; stop: () => void }> {
  const source = `
    import { handlePokerSocket } from ${
    JSON.stringify(new URL("./poker-server.ts", import.meta.url).href)
  };
    Deno.serve({ port: 0, onListen: ({ port }) => self.postMessage({ port }) }, (req) =>
      new URL(req.url).pathname === "/api/poker/ws" ? handlePokerSocket(req) : new Response("ok"));
  `;
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  const worker = new Worker(url, { type: "module" });
  const port = await new Promise<number>((resolve) => {
    worker.onmessage = (e) => resolve(e.data.port);
  });
  return {
    port,
    stop: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

Deno.test("two isolates find each other, and players on both see one table", async () => {
  const { server, port } = startServer();
  const sibling = await startSiblingIsolate();

  // Long lands on this isolate, Mai on the other — the Deno Deploy case.
  const long = await join(port, "GOSSIP", "Long", crypto.randomUUID());
  const mai = await join(sibling.port, "GOSSIP", "Mai", crypto.randomUUID());

  // Gossip is asynchronous: `hello` goes out, the other side answers with its
  // snapshot. Both then push a merged table to their own clients.
  for (const client of [long, mai]) {
    const table = client.table();
    if (table.length < 2) await client.next(5_000);
  }
  assertEquals(long.table().sort(), ["Long", "Mai"], "this isolate sees the sibling's player");
  assertEquals(mai.table().sort(), ["Long", "Mai"], "the sibling sees ours");

  await long.close();
  await mai.close();
  sibling.stop();
  await server.shutdown();
});

Deno.test("an oversized message is ignored without dropping the connection", async () => {
  const { server, port } = startServer();
  const long = await join(port, "BIGMSG", "Long", crypto.randomUUID());
  const mai = await join(port, "BIGMSG", "Mai");

  // Under the 4096 cap by UTF-16 length, well over it in bytes: each emoji is
  // 2 units but 4 bytes. Before the byte check this landed as a truncated story.
  const oversized = JSON.stringify({ type: "story", text: "🎉".repeat(1_500) });
  assertEquals(oversized.length < 4096, true, "the payload must pass the cheap length check");
  assertEquals(utf8.encode(oversized).length > 4096, true, "…while exceeding the byte cap");

  let pushed = false;
  mai.next(600).then(() => pushed = true, () => {});
  long.ws.send(oversized);
  await new Promise((r) => setTimeout(r, 900));
  assertEquals(pushed, false, "an oversized message must change nothing");

  // The socket is still usable — we ignore the message, not the client.
  const seen = mai.next();
  long.ws.send(JSON.stringify({ type: "story", text: "PROJ-7" }));
  assertEquals((await seen).story, "PROJ-7", "normal messages still work afterwards");

  await long.close();
  await mai.close();
  await server.shutdown();
});

Deno.test("a client that sends no cid still gets a seat", async () => {
  const { server, port } = startServer();
  const long = await join(port, "LEGACY", "Long"); // an older cached client
  const mai = await join(port, "LEGACY", "Mai");
  assertEquals(mai.table(), ["Long", "Mai"]);

  await long.close();
  await mai.close();
  await server.shutdown();
});
