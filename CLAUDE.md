# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Commands

Requires Deno 2.x. No npm/node_modules; the project is dependency-free by design.

```sh
deno task start        # serve on http://localhost:8000 (PORT env overrides)
deno task dev          # same, with --watch
deno task test         # reducer tests (src/poker.test.ts)
deno task check        # type-check main.ts + tests
deno task lint
deno task fmt          # format (CI/pre-commit verify with `deno task fmt --check`)
```

Run a single test: `deno test --allow-read --filter "substring of test name" src/poker.test.ts`

Pre-commit hook (`.githooks/pre-commit`) mirrors CI: fmt --check, check, lint, test. Enable once per
clone with `git config core.hooksPath .githooks`. CI runs the same four on every push/PR.

## Architecture

Scrum-poker app: a small Deno server (`main.ts`, `src/poker-server.ts`) plus a static browser UI
(`static/`). No build step, no framework, no accounts; rooms live in memory and evaporate ~5 min
after emptying.

**The core design decision: one isomorphic reducer.** `src/poker.mjs` (plain JS + JSDoc types,
dependency-free) holds all room rules — join/vote/reveal/reset/story/theme/wheel events via
`applyEvent(room, event)`, per-viewer projection via `publicState(room, viewerId)` (hides others'
votes until reveal), stats, limits, and `mergeRooms`. Three consumers import this exact file:

1. `src/poker-server.ts` — drives shared rooms over WebSocket
2. the browser (`static/poker.js`) — runs "solo mode" locally when no server answers (`main.ts`
   serves `/poker.mjs` from `src/` for this)
3. `src/poker.test.ts` — the test suite

Rule changes therefore go in `poker.mjs` only; server and client cannot disagree. When changing the
shape returned by `publicState`, update the expected objects in `poker.test.ts` (they compare via
JSON equality, so any new field breaks them).

**Multi-isolate gossip.** On Deno Deploy, sockets for one room can land on different isolates.
`poker-server.ts` gossips per-isolate snapshots over a `BroadcastChannel`: each isolate owns exactly
the participants whose sockets it holds (so participant maps merge disjointly), shared flags
(revealed/story/wheel) resolve last-writer-wins via the `at` timestamps carried on events, and
`mergeRooms` combines local + remote snapshots for rendering. On single-instance hosts (Render,
local dev) the channel is quiet and everything still works — don't break this fallback.

**Client resilience.** `static/poker.js` probes `GET /health` first: no answer means static hosting
→ instant solo mode; an answer means a real server → the initial WebSocket retries up to 90 s
(free-tier cold starts), and an open room pings `/health` every 5 min to keep the instance awake.
Wire protocol is documented at the top of `poker-server.ts`.

**Server events vs. client events.** Clients never send `join` — the server synthesizes it from the
WS query params (`/api/poker/ws?room=CODE&name=NAME`). Client messages are size-capped (4 KB) and
validated against the reducer; invalid events are no-ops returning `false`.

## Front-end notes

- `static/styles.css` is shared-origin with meso.utilities (the hub this project was split from); a
  large portion is unused here. `UI-AUDIT.md` documents known styling debt and the proposed fixes —
  consult it before restyling.
- Theme (dark/light) is `data-theme` on `<html>`, toggled by `static/theme.js`, persisted in
  localStorage. All colors come from CSS custom properties in `:root` / `[data-theme="light"]`.
- Per-player card themes flow as ids (`CARD_THEMES` in poker.mjs) through room state; the client
  maps ids to colors and sets `--card-accent` / `--dot-color` inline.

## Conventions

- Trunk-based: `main` is protected and always deployable; branch as `feature/…`, `bugfix/…`,
  `chore/…`; imperative commit titles; PRs need green CI.
- Formatting is enforced by `deno fmt` (100-col lines, 2-space indent, semicolons; HTML excluded).
- Tests are deliberately std-free (a local `assertEquals`) so they run offline.
- Deploy: Render Docker web service (`Dockerfile` + `render.yaml`, health check `/health`,
  auto-deploy on push); also runs on Deno Deploy with entrypoint `main.ts`.
