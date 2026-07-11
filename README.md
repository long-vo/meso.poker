# meso.poker

Scrum poker for team estimation — share a room code, everyone picks a card, reveal together. Split
out of [meso.utilities](https://github.com/long-vo/meso.utilities), which now hosts the static
tools and links here from its hub.

**Live:** <https://meso-poker.onrender.com/>

## Features

Open the page, enter your name and either create a room or join with a teammate's 4–8 character
code (invite links look like `/?room=QK7M`). Everyone picks a card from the classic deck (0 ½ 1 2 3
5 8 13 20 40 100 ? ☕); votes stay hidden until someone hits **Reveal**, which locks the round and
shows the average, the vote distribution and a consensus banner. **New round** clears the cards.
Anyone can edit the shared story line, reveal or reset — no host role, no accounts. Empty rooms
evaporate after a few minutes. Every player can pick a **card theme** (ocean, violet, forest,
sunset, ruby) via the dots next to "Your card" — your deck and the card back other players see take
that colour, and the choice is remembered for the next session.

At the bottom sits a **random-name wheel** for picking who presents, breaks a tie or fetches the
coffee. It mirrors the people in the room until someone edits it — add guests or remove names via
the chips — after which it keeps the custom list. Spins are part of the room state, so everyone
watches the wheel land on the same name.

## How it works

Sockets connect to `/api/poker/ws?room=CODE&name=NAME` and rooms live in memory, driven by the
shared reducer in `src/poker.mjs` — the same module the browser imports, so server and client can
never disagree on the rules. When no server is reachable, the page falls back to a single-person
**solo mode** using that reducer locally.

The client first probes `GET /health`: a miss means static hosting (instant solo fallback); an
answer means a server exists, and the initial WebSocket is retried for up to 90 s — free-tier hosts
spin down when idle and need ~30–60 s to wake. While a room is open, the page pings `/health` every
5 minutes so the host sees inbound traffic and keeps the instance alive mid-game.

On Deno Deploy, sockets for one room may land on different isolates; a `BroadcastChannel` gossips
per-isolate snapshots (participant maps are disjoint, shared flags resolve last-writer-wins) so
every isolate renders the full room. On single-instance hosts like Render this is simply quiet.

## Run locally

Requires Deno 2.x.

```sh
deno task start      # http://localhost:8000
deno task dev        # same, with --watch auto-reload
```

Other tasks:

```sh
deno task test       # reducer tests
deno task check      # type-check
deno task fmt        # format
deno task lint       # lint
```

Set `PORT` to change the port locally (e.g. `PORT=3000 deno task start`).

`GET /health` returns a liveness JSON payload.

## Deploy to Render

The live instance runs on [Render](https://render.com/) as a Docker web service — see `Dockerfile`
(official `denoland/deno` alpine image, same flags as `deno task start`) and `render.yaml` (Render
Blueprint: free plan, health check on `/health`, auto-deploy on push).

One-time setup: sign in to Render with GitHub, then **New → Blueprint** and pick this repo — it
reads `render.yaml` automatically. Render injects `PORT`, which `main.ts` already honours.

Free-tier note: the instance spins down after ~15 minutes idle. The next request takes ~30–60 s to
wake it; the client rides this out (see above). Also works on Deno Deploy with **Entrypoint:**
`main.ts` and no build step.

## Layout

```
main.ts               Deno.serve entry: static routes + poker WebSocket
Dockerfile            container image for Render (denoland/deno alpine)
render.yaml           Render Blueprint: free web service, /health check
src/
  poker.mjs           shared poker-room reducer (server + browser solo mode)
  poker-server.ts     poker rooms: WebSocket handling + isolate gossip
  poker.test.ts       poker reducer tests
static/
  index.html          Scrum Poker UI
  poker.js            poker client (WebSocket + solo fallback)
  styles.css          theme + tool styles (shared origin: meso.utilities)
  theme.js            dark/light toggle
```

## Development

Trunk-based: `main` is always deployable and protected — no direct pushes, all changes go through a
PR with green CI. Branch with `feature/…`, `bugfix/…` or `chore/…`; commit messages use an
imperative title (e.g. `Add card theme`). Run `deno task check`, `deno task lint`, `deno task fmt`
and `deno task test` before opening a PR.

A versioned pre-commit hook (`.githooks/pre-commit`) runs the same four checks as CI on every
commit. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

CI (`.github/workflows/ci.yml`) runs the format check, lint, type check and tests on every push to
`main` and every pull request.
