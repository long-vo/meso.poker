/**
 * meso.poker — scrum poker for team estimation, served by a small Deno app.
 * Split out of meso.utilities; the hub there links to this deployment.
 *
 * Runtime: Deno (Deno.serve). Deployed to Render as a Docker web service
 * (see Dockerfile + render.yaml); also runs on Deno Deploy with no build step.
 * Local: `deno task start` (or `deno task dev` for watch mode).
 *
 * Routes:
 *   GET  /               -> the poker UI (static/index.html)
 *   GET  /styles.css     -> shared stylesheet
 *   GET  /theme.js       -> theme toggle
 *   GET  /poker.js       -> poker client
 *   GET  /poker.mjs      -> shared poker-room module (server + browser)
 *   GET  /api/poker/ws   -> WebSocket upgrade for a scrum-poker room
 *   GET  /health         -> liveness probe (also the client's server detector)
 */
import { handlePokerSocket } from "./src/poker-server.ts";

const STATIC_DIR = new URL("./static/", import.meta.url);
const SRC_DIR = new URL("./src/", import.meta.url);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Read a file relative to a base directory URL and return it as a Response.
 * Returns null if the file does not exist, so callers can fall through to 404.
 * The leading path is sanitized to keep requests inside the base directory.
 */
async function serveFile(baseUrl: URL, name: string): Promise<Response | null> {
  if (name.includes("..") || name.includes("\0")) return null;
  try {
    const fileUrl = new URL(name, baseUrl);
    const data = await Deno.readFile(fileUrl);
    return new Response(data, {
      headers: {
        "content-type": contentTypeFor(name),
        "cache-control": "no-cache",
      },
    });
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function handler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (req.method === "GET" && pathname === "/api/poker/ws") {
    return handlePokerSocket(req);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/health") {
      return json({ status: "ok", service: "meso.poker", time: new Date().toISOString() });
    }
    if (pathname === "/" || pathname === "/index.html") {
      return (await serveFile(STATIC_DIR, "index.html")) ?? notFound();
    }
    // The shared room module lives in src/ — the same file the server imports.
    if (pathname === "/poker.mjs") {
      return (await serveFile(SRC_DIR, "poker.mjs")) ?? notFound();
    }
    const asset = pathname.replace(/^\/+/, "");
    if (asset) {
      const res = await serveFile(STATIC_DIR, asset);
      if (res) return res;
    }
  }

  return notFound();
}

// Render/Deno Deploy provide the port; locally we honour $PORT, default 8000.
const port = Number(Deno.env.get("PORT")) || 8000;
Deno.serve({
  port,
  onListen: ({ hostname, port }) => {
    console.log(`meso.poker listening on http://${hostname}:${port}/`);
  },
}, handler);
