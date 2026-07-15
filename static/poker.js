// meso.poker — scrum poker client.
// Talks to the server room over a WebSocket; when no server is reachable
// (e.g. the static GitHub Pages build) it falls back to a local solo room
// driven by the SAME reducer module the server uses.
import {
  applyEvent,
  CARD_THEMES,
  CODE_PATTERN,
  createRoom,
  DECK,
  generateRoomCode,
  isAway,
  LIMITS,
  publicState,
  REACTIONS,
  sanitizeNotes,
  sanitizeWheelNames,
  STATUSES,
} from "./poker.mjs";

/** Theme id -> colour. Theme CSS variables adapt to dark/light mode. */
const CARD_THEME_COLORS = {
  ocean: "var(--accent)",
  violet: "var(--accent-2)",
  forest: "var(--good)",
  sunset: "var(--mask)",
  ruby: "var(--danger)",
};

/** Status id -> preset, so the badge renderer needn't scan STATUSES. */
const STATUS_BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
/** Picker options: "Available" (clear, id "") first, then every preset. */
const STATUS_OPTIONS = [{ id: "", emoji: "🟢", label: "Available", away: false }, ...STATUSES];

const $ = (id) => document.getElementById(id);

const els = {
  conn: $("conn"),
  connectHint: $("connect-hint"),
  join: $("join"),
  joinError: $("join-error"),
  joinBtn: $("join-btn"),
  createBtn: $("create-btn"),
  playerName: $("player-name"),
  observerCheck: $("observer-check"),
  observerNote: $("observer-note"),
  deckFoot: $("deck-foot"),
  roomCode: $("room-code"),
  table: $("table"),
  roomChip: $("room-chip"),
  invite: $("invite"),
  leave: $("leave"),
  story: $("story"),
  roundStatus: $("round-status"),
  yourTurn: $("your-turn"),
  players: $("players"),
  results: $("results"),
  reveal: $("reveal"),
  reset: $("reset"),
  deck: $("deck"),
  toast: $("toast"),
  wheel: $("wheel"),
  spin: $("spin"),
  wheelName: $("wheel-name"),
  wheelAdd: $("wheel-add"),
  wheelChips: $("wheel-chips"),
  wheelSync: $("wheel-sync"),
  wheelShuffle: $("wheel-shuffle"),
  wheelAutoShuffle: $("wheel-autoshuffle"),
  wheelStatus: $("wheel-status"),
  wheelResult: $("wheel-result"),
  pickPanel: $("pick-panel"),
  pickClose: $("pick-close"),
  pickName: $("pick-name"),
  observerPanel: $("observer-panel"),
  observerNames: $("observer-names"),
  cardThemes: $("card-themes"),
  statusPicker: $("status-picker"),
  themesPanel: $("themes-panel"),
  reactions: $("reactions"),
  reactionLayer: $("reaction-layer"),
  notesList: $("notes-list"),
  notesStatus: $("notes-status"),
  noteDate: $("note-date"),
  noteText: $("note-text"),
  noteAdd: $("note-add"),
};

/** Current session: null until joined. */
let session = null; // { code, name, transport }
let lastState = null;

/* wheel animation state (client-side; the spinner picks the winner and the
   room relays it, so every client lands on the same name) */
let wheelRotation = 0;
let wheelSpinning = false;
let lastSpunAt = 0;
let wheelNamesKey = "";
let firstWheelState = true;
/* Auto-shuffle is a local preference: only the client that spins reshuffles
   the order, and it does so at the start of its next spin (not on landing, which
   would snap the wheel off the winner), so the room never gets competing
   reorders and the last result stays parked until someone spins again. */
let autoShuffle = false;

/* ------------------------------- helpers -------------------------------- */

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* The initial connect can take ~1 min while a free-tier host wakes from an
   idle spin-down (see INITIAL_WINDOW_MS). The pill alone reads as "broken" to
   first-timers, so while connecting we also show an in-view banner counting the
   elapsed seconds. It holds off for 2s so a warm server never flashes it. */
let connectHintTimer = 0;

function startConnectHint() {
  clearInterval(connectHintTimer);
  const startAt = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - startAt) / 1000);
    els.connectHint.hidden = secs < 2;
    els.connectHint.textContent =
      `⏳ Waking the room — a free-tier host can take up to a minute to start. (${secs}s)`;
  };
  tick();
  connectHintTimer = setInterval(tick, 1000);
}

function stopConnectHint() {
  clearInterval(connectHintTimer);
  connectHintTimer = 0;
  els.connectHint.hidden = true;
}

/** Update the connection pill: live | solo | connecting | reconnecting. */
function setConn(state) {
  const pill = els.conn;
  if (!state) {
    pill.hidden = true;
    stopConnectHint();
    return;
  }
  pill.hidden = false;
  pill.className = "pill pill-conn " + state;
  pill.textContent = state === "live"
    ? "🟢 Live"
    : state === "solo"
    ? "🟡 Solo mode"
    : state === "reconnecting"
    ? "🔄 Reconnecting…"
    : "⏳ Connecting…";
  pill.title = state === "solo"
    ? "No server reachable — votes stay on this device. Run the Deno server for live rooms."
    : "";
  // The banner tracks the initial connect only; reconnects keep the pill quiet.
  if (state === "connecting") startConnectHint();
  else stopConnectHint();
}

/* ------------------------------ transports ------------------------------ */

/**
 * Live transport: WebSocket to the Deno server, with automatic reconnects.
 *
 * A `GET /health` probe runs first: on static hosting (GitHub Pages) it
 * misses, so the page switches to solo mode immediately. When the probe
 * answers, a server exists and the initial WebSocket is retried patiently —
 * free-tier hosts (e.g. Render) spin down when idle and need ~30–60 s to
 * wake. Only when the initial window runs out does `handlers.fail()` give up.
 */
const INITIAL_WINDOW_MS = 90_000; // Render free tier can take 30–60s to wake
// While connected, ping /health so a free-tier host sees inbound HTTP traffic
// and doesn't spin down mid-game (Render idles out after ~15 min without it;
// WebSocket frames alone may not count). Runs only while a room is open.
const KEEP_ALIVE_MS = 5 * 60_000;
function connectLive(code, name, observer, handlers) {
  let socket = null;
  let everOpened = false;
  let closedByUs = false;
  let attempts = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let keepAliveTimer = 0;
  let firstTryAt = 0; // set once the health probe confirms a server

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(
      `${proto}://${location.host}/api/poker/ws?room=${code}` +
        `&name=${encodeURIComponent(name)}&theme=${encodeURIComponent(currentTheme())}` +
        (observer ? "&observer=1" : ""),
    );
    socket.onopen = () => {
      everOpened = true;
      attempts = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: "ping" }), 25_000);
      clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        fetch("/health", { cache: "no-store" }).catch(() => {/* ping only */});
      }, KEEP_ALIVE_MS);
      handlers.up();
    };
    socket.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "state") handlers.state(msg.state);
      else if (msg.type === "error") handlers.error(msg.message);
      else if (msg.type === "react") handlers.react(msg);
      else if (msg.type === "nudge") handlers.nudge(msg);
    };
    socket.onclose = () => {
      clearInterval(pingTimer);
      clearInterval(keepAliveTimer);
      if (closedByUs) return;
      attempts += 1;
      if (!everOpened) {
        if (Date.now() - firstTryAt >= INITIAL_WINDOW_MS) {
          handlers.fail();
          return;
        }
        // Server may still be waking from an idle spin-down — keep trying
        // (backoff capped at 5s) until the initial window runs out.
        retryTimer = setTimeout(open, Math.min(5_000, 1500 * attempts));
        return;
      }
      handlers.down();
      retryTimer = setTimeout(open, Math.min(10_000, 1500 * attempts));
    };
  };

  const send = (message) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  // Probe for a server before dialing the socket. The probe itself may hang
  // while a sleeping instance wakes — that's fine, it resolves when the
  // server is up. A 404/HTML answer or a network error means static hosting.
  (async () => {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      const body = res.ok ? await res.json() : null;
      if (!body || body.status !== "ok") throw new Error("no server");
    } catch {
      if (!closedByUs) handlers.fail();
      return;
    }
    if (closedByUs) return;
    firstTryAt = Date.now();
    open();
  })();

  return {
    kind: "live",
    send,
    close: () => {
      closedByUs = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      clearInterval(keepAliveTimer);
      // Announce the leave as a data frame first: proxies relay it instantly,
      // while the close handshake itself can take ~10s to reach the server.
      send({ type: "leave" });
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Solo transport: a local one-person room, same reducer as the server. */
function createSolo(name, observer, onState) {
  const room = createRoom();
  applyEvent(room, {
    type: "join",
    id: "you",
    name,
    theme: currentTheme(),
    observer,
    at: Date.now(),
  });
  const push = () => onState(publicState(room, "you"));
  queueMicrotask(push);
  return {
    kind: "solo",
    send: (message) => {
      if (message.type === "ping") return;
      // Ephemeral signals: no server to relay them, so react echoes locally
      // and nudge is a no-op (there is nobody else to poke in solo mode).
      if (message.type === "react") {
        floatReaction(String(message.emoji ?? ""), name);
        return;
      }
      if (message.type === "nudge") return;
      const event = message.type === "vote"
        ? { type: "vote", id: "you", value: message.value }
        : message.type === "story"
        ? { type: "story", text: message.text, at: Date.now() }
        : message.type === "wheel-set"
        ? { type: "wheel-set", names: message.names, at: Date.now() }
        : message.type === "wheel-spin"
        ? { type: "wheel-spin", winner: message.winner, at: Date.now() }
        : message.type === "notes-set"
        ? { type: "notes-set", notes: message.notes, id: "you", at: Date.now() }
        : message.type === "theme"
        ? { type: "theme", id: "you", theme: message.theme }
        : message.type === "status"
        ? { type: "status", id: "you", status: message.status }
        : { type: message.type, at: Date.now() };
      if (applyEvent(room, event)) push();
    },
    close: () => {},
  };
}

/* ------------------------------- rendering ------------------------------ */

/* ------------------------------ card themes ------------------------------ */

function currentTheme() {
  try {
    const saved = localStorage.getItem("meso-poker-theme");
    if (saved && CARD_THEMES.includes(saved)) return saved;
  } catch {
    /* ignore */
  }
  return CARD_THEMES[0];
}

function themeColor(theme) {
  return CARD_THEME_COLORS[theme] ?? CARD_THEME_COLORS[CARD_THEMES[0]];
}

function markSelectedTheme(theme) {
  els.deck.style.setProperty("--card-accent", themeColor(theme));
  for (const dot of els.cardThemes.children) {
    dot.classList.toggle("selected", dot.dataset.theme === theme);
  }
}

function setTheme(theme) {
  if (!CARD_THEMES.includes(theme)) return;
  try {
    localStorage.setItem("meso-poker-theme", theme);
  } catch {
    /* fine */
  }
  markSelectedTheme(theme); // instant feedback; the room state echo confirms
  session?.transport.send({ type: "theme", theme });
}

function buildThemePicker() {
  els.cardThemes.innerHTML = "";
  for (const theme of CARD_THEMES) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "theme-dot";
    dot.dataset.theme = theme;
    dot.style.setProperty("--dot-color", themeColor(theme));
    dot.title = `${theme[0].toUpperCase()}${theme.slice(1)} cards`;
    dot.setAttribute("aria-label", `${theme} card theme`);
    dot.classList.toggle("selected", theme === currentTheme());
    dot.addEventListener("click", () => setTheme(theme));
    els.cardThemes.appendChild(dot);
  }
}

/* -------------------------------- status --------------------------------- */
/* Your presence status (Away / Break / BRB / Thinking), set on yourself and
   shown as a badge on everyone's card. Like the card theme: an owner-set
   participant flag echoed through room state. Away statuses also pause the
   round — see the active-voter tally in render(). */

function setStatus(id) {
  markSelectedStatus(id); // instant feedback; the room state echo confirms
  session?.transport.send({ type: "status", status: id });
}

function markSelectedStatus(id) {
  for (const btn of els.statusPicker.children) {
    const on = btn.dataset.status === id;
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
}

function buildStatusPicker() {
  els.statusPicker.innerHTML = "";
  for (const opt of STATUS_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "status-opt";
    btn.dataset.status = opt.id;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", opt.id === "" ? "true" : "false");
    // Labels come from our own STATUS_OPTIONS constant, so no escaping needed.
    btn.innerHTML = `<span class="status-opt-emoji" aria-hidden="true">${opt.emoji}</span>` +
      `<span class="status-opt-label">${opt.label}</span>`;
    // Away-type statuses take you out of the round, so say so on their hint.
    btn.title = opt.id === ""
      ? "Clear your status"
      : opt.away
      ? `Set status: ${opt.label} — you won't be counted for estimation`
      : `Set status: ${opt.label}`;
    btn.addEventListener("click", () => setStatus(opt.id));
    els.statusPicker.appendChild(btn);
  }
}

/* -------------------------- reactions & nudges --------------------------- */
/* Both are ephemeral signals: the server relays them to every open socket
   but never writes them to the room, so nothing here touches room state. */

const REACTION_FLOAT_MS = 2600; // outlives the longest rise animation
const REACT_THROTTLE_MS = 350;
const NUDGE_COOLDOWN_MS = 5_000;
let lastReactAt = 0;
/** name -> when we last nudged them (client-side politeness on top of the
    server's rate limit; the map is tiny and cleared on leave). */
const nudgedAt = new Map();

function buildReactions() {
  els.reactions.innerHTML = "";
  for (const emoji of REACTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reaction-btn";
    btn.textContent = emoji;
    btn.title = `React with ${emoji}`;
    btn.setAttribute("aria-label", `React with ${emoji}`);
    btn.addEventListener("click", () => sendReaction(emoji));
    els.reactions.appendChild(btn);
  }
}

function sendReaction(emoji) {
  if (!session) return;
  const now = Date.now();
  if (now - lastReactAt < REACT_THROTTLE_MS) return;
  lastReactAt = now;
  session.transport.send({ type: "react", emoji });
}

/** Float an emoji up over the players panel; the sender's name tags along. */
function floatReaction(emoji, name) {
  if (!REACTIONS.includes(emoji)) return;
  // A stampede can't flood the DOM: the oldest balloon pops early.
  if (els.reactionLayer.childElementCount >= 30) {
    els.reactionLayer.firstElementChild?.remove();
  }
  const float = document.createElement("span");
  float.className = "reaction-float";
  float.style.left = `${8 + Math.random() * 76}%`;
  float.style.animationDuration = `${(2 + Math.random() * 0.4).toFixed(2)}s`;
  const glyph = document.createElement("span");
  glyph.className = "reaction-emoji";
  glyph.textContent = emoji;
  const who = document.createElement("span");
  who.className = "reaction-name";
  who.textContent = name;
  float.append(glyph, who);
  els.reactionLayer.appendChild(float);
  // Removal is timer-based, not animationend: reduced-motion swaps the
  // animation for a plain fade and the node must still go away.
  setTimeout(() => float.remove(), REACTION_FLOAT_MS);
}

function sendNudge(name) {
  if (!session || !lastState || lastState.revealed) return;
  const now = Date.now();
  if (now - (nudgedAt.get(name) ?? 0) < NUDGE_COOLDOWN_MS) {
    showToast(`Easy — ${name} was just nudged`);
    return;
  }
  nudgedAt.set(name, now);
  session.transport.send({ type: "nudge", name });
}

/** Replay the wiggle on every card owned by `name` (names can collide). */
function wigglePlayer(name) {
  for (const card of els.players.querySelectorAll(".pcard[data-name]")) {
    if (card.dataset.name !== name) continue;
    card.classList.remove("nudged");
    // Force a style flush so re-adding the class replays the animation.
    void card.getBoundingClientRect();
    card.classList.add("nudged");
  }
}

function onNudge(target, from) {
  if (!target) return;
  wigglePlayer(target);
  const mine = lastState?.participants.find((p) => p.you);
  if (mine?.name === target) {
    showToast(`👉 ${from} nudged you — pick a card!`);
    navigator.vibrate?.(200);
  } else if (mine?.name === from) {
    showToast(`You nudged ${target}`);
  }
}

/* -------------------------------- room notes ------------------------------ */
/* Notes are shared room state (notes-set events, LWW across isolates) and
   additionally saved per room code in localStorage: when a room has expired
   server-side, the first returning client re-seeds it. That local copy is
   what makes notes effectively permanent without any server storage. */

const notesKey = (code) => `meso-poker-notes-${code}`;
let notesSeedChecked = false;
let lastNotesAt = -1;

/** Local YYYY-MM-DD (toISOString would shift the date across midnight UTC). */
function todayStr() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatNoteDate(date) {
  if (date === todayStr()) return "Today";
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function renderNotes(state) {
  const { list, at } = state.notes;

  // Persist the freshest copy for this room; `at` > 0 means the list was
  // deliberately edited at least once, so even a clear-out is remembered.
  if (session && at > 0 && at !== lastNotesAt) {
    lastNotesAt = at;
    try {
      localStorage.setItem(notesKey(session.code), JSON.stringify({ at, list }));
    } catch {
      /* storage blocked or full — notes still live in the room */
    }
  }

  // Re-seed a virgin room (never edited, nothing in it) once per connection
  // from the copy this browser saved last time the room was open.
  if (session && !notesSeedChecked) {
    notesSeedChecked = true;
    if (at === 0 && list.length === 0) {
      try {
        const saved = JSON.parse(localStorage.getItem(notesKey(session.code)) ?? "null");
        const seed = sanitizeNotes(saved?.list);
        if (seed.length) session.transport.send({ type: "notes-set", notes: seed });
      } catch {
        /* corrupt copy — start clean */
      }
    }
  }

  els.notesStatus.textContent = list.length
    ? `${list.length} ${list.length === 1 ? "note" : "notes"}`
    : "";
  els.notesList.innerHTML = "";
  if (list.length === 0) {
    els.notesList.innerHTML =
      `<span class="hint">No notes yet — decisions, reminders, dates to remember.</span>`;
    return;
  }
  const today = todayStr();
  // Only your own notes get a remove button (the reducer enforces the same
  // rule server-side); author-less notes are fair game for anyone.
  const myName = state.participants.find((p) => p.you)?.name ?? "";
  list.forEach((note, index) => {
    const row = document.createElement("div");
    row.className = "note" + (note.date === today ? " today" : note.date < today ? " past" : "");
    const date = document.createElement("span");
    date.className = "note-date";
    date.textContent = formatNoteDate(note.date);
    date.title = note.date;
    const body = document.createElement("div");
    body.className = "note-body";
    body.textContent = note.text;
    if (note.who) {
      const who = document.createElement("div");
      who.className = "note-who";
      who.textContent = `— ${note.who}`;
      body.appendChild(who);
    }
    row.append(date, body);
    if (!note.who || note.who === myName) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "note-x";
      remove.textContent = "✕";
      remove.title = "Remove note";
      remove.setAttribute("aria-label", `Remove note: ${note.text}`);
      remove.addEventListener("click", () => {
        session?.transport.send({
          type: "notes-set",
          notes: list.filter((_, i) => i !== index),
        });
      });
      row.appendChild(remove);
    }
    els.notesList.appendChild(row);
  });
}

function addNote() {
  if (!session || !lastState) return;
  const text = els.noteText.value.trim().slice(0, LIMITS.note);
  const date = els.noteDate.value;
  if (!text) {
    els.noteText.focus();
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    showToast("Pick a date for the note");
    return;
  }
  const list = lastState.notes.list;
  if (list.length >= LIMITS.notes) {
    showToast(`A room holds at most ${LIMITS.notes} notes`);
    return;
  }
  const mine = lastState.participants.find((p) => p.you);
  session.transport.send({
    type: "notes-set",
    notes: [...list, { date, text, who: mine?.name ?? session.name, at: Date.now() }],
  });
  els.noteText.value = "";
  els.noteText.style.height = ""; // collapse the auto-grown field
  els.noteText.focus();
}

/* ------------------------------- rendering ------------------------------- */

function buildDeck() {
  els.deck.innerHTML = "";
  for (const card of DECK) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "deck-card";
    btn.textContent = card;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", "false");
    btn.addEventListener("click", () => {
      if (!session || !lastState || lastState.revealed) return;
      const mine = lastState.participants.find((p) => p.you);
      session.transport.send({ type: "vote", value: mine?.vote === card ? null : card });
    });
    els.deck.appendChild(btn);
  }
}

function renderPlayers(state) {
  els.players.innerHTML = "";
  // Observers (PO) watch from outside: they appear neither in the players
  // grid nor on the wheel.
  for (const p of state.participants) {
    if (p.observer) continue;
    const away = isAway(p.status);
    const wrap = document.createElement("div");
    wrap.className = "player" + (p.you ? " me" : "") + (away ? " away" : "");

    const card = document.createElement("div");
    card.className = "pcard";
    card.dataset.name = p.name;
    card.style.setProperty("--card-accent", themeColor(p.theme));
    // A teammate who hasn't voted yet can be poked awake — click their card.
    // An away player is sitting out, so they can't be nudged.
    if (!state.revealed && !p.you && !p.voted && !away) {
      card.classList.add("nudgable");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.title = `Nudge ${p.name}`;
      card.setAttribute("aria-label", `Nudge ${p.name}`);
      card.addEventListener("click", () => sendNudge(p.name));
      card.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        sendNudge(p.name);
      });
    }
    if (state.revealed) {
      card.classList.add("face");
      if (p.vote === null) {
        card.classList.add("no-vote");
        card.textContent = "—";
      } else {
        card.textContent = p.vote;
      }
    } else if (p.voted) {
      if (p.you && p.vote !== null) {
        card.classList.add("face");
        card.textContent = p.vote;
      } else {
        card.classList.add("back");
        card.textContent = "✓";
      }
    } else {
      card.classList.add("waiting");
      card.textContent = "·";
    }

    const label = document.createElement("div");
    label.className = "player-name";
    const who = `<span class="pname">${escapeHtml(p.name)}</span>`;
    // The "you" badge sits on its own line so a long name can't crowd it out.
    label.innerHTML = p.you ? `${who}<span class="you">you</span>` : who;
    label.title = p.name;

    wrap.appendChild(card);
    wrap.appendChild(label);
    // Presence badge pinned to the card's top-right corner. It's a sibling of
    // the card (not a child) so dimming an away card never fades the badge.
    const preset = STATUS_BY_ID[p.status];
    if (preset) {
      const badge = document.createElement("span");
      badge.className = "pcard-status" + (preset.away ? " away" : "");
      badge.textContent = preset.emoji;
      badge.title = preset.label;
      badge.setAttribute("aria-label", `${p.name}: ${preset.label}`);
      wrap.appendChild(badge);
    }
    els.players.appendChild(wrap);
  }

  // Every other panel shows an empty state; give the core panel one too. When
  // you're alone at the table, point at the invite control (top-left room bar).
  const voterCount = state.participants.filter((p) => !p.observer).length;
  if (voterCount <= 1) {
    const empty = document.createElement("p");
    empty.className = "hint players-empty";
    empty.textContent = voterCount === 1
      ? "You're the only one here — copy the invite link to bring your team in."
      : "Nobody's at the table yet — copy the invite link to get started.";
    els.players.appendChild(empty);
  }
}

/* Persistent notice while observers (PO) watch the room: slides in when the
   first observer joins, updates as the list changes, slides out with the last.
   Purely derived from room state, so join/leave in live and solo mode both
   update it without extra wiring. */
let observerKey = "";

function renderObservers(state) {
  const observers = state.participants.filter((p) => p.observer);
  const key = observers.map((p) => p.name).join("\n");
  if (key === observerKey) return;
  observerKey = key;
  // Reserve (or release) the right-hand lane the pinned panel sits in.
  document.body.classList.toggle("has-observers", observers.length > 0);
  if (observers.length === 0) {
    els.observerPanel.hidden = true;
    els.observerPanel.classList.remove("show");
    return;
  }
  els.observerNames.innerHTML = observers
    .map((p) => `👁 ${escapeHtml(p.name)}`)
    .join("<br />");
  els.observerPanel.hidden = false;
  els.observerPanel.classList.remove("show");
  // Force a style flush so re-adding the class replays the slide-in.
  void els.observerPanel.getBoundingClientRect();
  els.observerPanel.classList.add("show");
}

function renderResults(state) {
  const stats = state.stats;
  // The strip stays in the flow either way (reserved height in CSS), so
  // revealing or resetting never shifts the panels below it.
  if (!state.revealed || !stats) {
    els.results.innerHTML =
      `<span class="hint">Results appear here after reveal. Most voted numbers will be highlighted.</span>`;
    return;
  }
  const parts = [];
  // Highlight the most-chosen card(s); on a tie every leader lights up.
  const maxCount = stats.distribution.reduce((m, d) => Math.max(m, d.count), 0);
  for (const { card, count } of stats.distribution) {
    // "5 pts" for point cards; "?" and "☕" carry no unit. The tally rides in a
    // pill beside it.
    const unit = card === "?" || card === "☕" ? "" : card === "1" || card === "½" ? " pt" : " pts";
    const top = count === maxCount && maxCount > 0 ? " dist-chip--top" : "";
    parts.push(
      `<span class="tag dist-chip${top}"><span>${escapeHtml(card)}${unit}</span>` +
        `<span class="dist-chip__count">${count}</span></span>`,
    );
  }
  if (stats.consensus) parts.push(`<span class="consensus">🎉 Consensus!</span>`);
  els.results.innerHTML = parts.join("");
}

/* ------------------------------ name wheel ------------------------------ */

/**
 * Evenly-spaced hues around the colour circle, so every name gets its own
 * colour (identical on every client, since the name order is shared) and the
 * Spin hub — a neutral themed circle — never blends into a segment.
 * The label is a pale tint of the same hue: distinct per name, yet always
 * readable on its mid-lightness segment.
 * A lone player is the exception: index 0 would be hue 0 — a whole disc of hot
 * red — so a single name gets a calm on-brand blue instead.
 */
function wheelHue(index, count) {
  if (count === 1) return 210;
  return Math.round((index * 360) / Math.max(count, 1));
}

function wheelColor(index, count) {
  return `hsl(${wheelHue(index, count)} 62% 46%)`;
}

function wheelLabelColor(index, count) {
  return `hsl(${wheelHue(index, count)} 90% 88%)`;
}

/** The list the wheel runs on: room joiners until someone edits it. */
function wheelNamesOf(state) {
  return state.wheel.custom
    ? state.wheel.names
    : sanitizeWheelNames(state.participants.filter((p) => !p.observer).map((p) => p.name));
}

/**
 * Fisher-Yates shuffle, guaranteed to change the order (the reducer ignores a
 * reorder that lands on the same list, so a no-op shuffle would do nothing).
 */
function shuffled(names) {
  const out = [...names];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.length > 1 && out.every((n, i) => n === names[i])) {
    [out[0], out[1]] = [out[1], out[0]];
  }
  return out;
}

function polar(angle, radius) {
  const rad = (angle * Math.PI) / 180;
  return [100 + radius * Math.sin(rad), 100 - radius * Math.cos(rad)];
}

/** Rebuild the SVG segments; resets the rotation, so only call on change. */
function buildWheelSvg(names) {
  wheelRotation = 0;
  if (names.length === 0) {
    els.wheel.innerHTML = `<circle cx="100" cy="100" r="96" class="wheel-empty"></circle>` +
      `<text x="100" y="104" text-anchor="middle" class="wheel-empty-label">nobody yet</text>`;
    return;
  }
  const per = 360 / names.length;
  const parts = [];
  names.forEach((name, i) => {
    const color = wheelColor(i, names.length);
    if (names.length === 1) {
      parts.push(`<circle cx="100" cy="100" r="96" style="fill:${color}"></circle>`);
    } else {
      const [x0, y0] = polar(i * per, 96);
      const [x1, y1] = polar((i + 1) * per, 96);
      const large = per > 180 ? 1 : 0;
      parts.push(
        `<path d="M100,100 L${x0.toFixed(2)},${y0.toFixed(2)} ` +
          `A96,96 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" ` +
          `style="fill:${color}" stroke="var(--bg-elev)" stroke-width="1"></path>`,
      );
    }
    const label = name.length > 12 ? name.slice(0, 11) + "…" : name;
    const size = names.length <= 14 ? 9 : 7.5;
    const mid = (i + 0.5) * per;
    parts.push(
      `<text x="100" y="46" text-anchor="middle" dominant-baseline="central" ` +
        `font-size="${size}" class="wheel-label" ` +
        `style="fill:${wheelLabelColor(i, names.length)}" ` +
        `transform="rotate(${mid.toFixed(2)} 100 100) rotate(90 100 46)">${
          escapeHtml(label)
        }</text>`,
    );
  });
  els.wheel.innerHTML = `<g id="wheel-g" class="wheel-g">${parts.join("")}</g>` +
    `<circle cx="100" cy="100" r="13" class="wheel-hub"></circle>`;
}

function hidePickPanel() {
  els.pickPanel.hidden = true;
  els.pickPanel.classList.remove("show");
}

/** The winner's wheel-segment colour (same hue as their chip dot). */
function winnerColor(winner) {
  if (!lastState) return "";
  const names = wheelNamesOf(lastState);
  const index = names.indexOf(winner);
  return index === -1 ? "" : wheelColor(index, names.length);
}

/** Slide the floating announcement in from the right. */
function floatWinner(winner) {
  els.pickName.textContent = `🎯 ${winner}`;
  els.pickName.style.color = winnerColor(winner);
  els.pickPanel.hidden = false;
  els.pickPanel.classList.remove("show");
  // Force a style flush so re-adding the class replays the slide-in.
  void els.pickPanel.getBoundingClientRect();
  els.pickPanel.classList.add("show");
}

/**
 * Announce a winner. Live spins (`float`) get the floating panel; historical
 * results (joining a room that already spun) only fill the quiet inline line.
 */
function showWinner(winner, float = false) {
  if (!winner) return;
  els.wheelResult.innerHTML = `🎯 <b>${escapeHtml(winner)}</b>`;
  els.wheelResult.hidden = false;
  if (float) floatWinner(winner);
}

/** Rotate so the winner's segment lands under the top pointer. */
function animateWheelTo(winner, names) {
  const index = names.indexOf(winner);
  const group = els.wheel.querySelector("#wheel-g");
  if (index === -1 || !group) {
    showWinner(winner, true);
    return;
  }
  const per = 360 / names.length;
  const mid = (index + 0.5) * per;
  const jitter = (Math.random() - 0.5) * per * 0.6;
  const landing = (((-(mid + jitter)) % 360) + 360) % 360;
  const delta = ((landing - (wheelRotation % 360)) % 360 + 360) % 360;
  const target = wheelRotation + 4 * 360 + delta;

  wheelSpinning = true;
  els.wheelResult.hidden = true;
  hidePickPanel();
  els.spin.disabled = true;
  els.wheelStatus.textContent = "spinning…";
  group.classList.add("spinning");
  // Force a style flush so the transition starts from the current angle.
  void group.getBoundingClientRect();
  group.style.transform = `rotate(${target}deg)`;
  wheelRotation = target;

  // If a newer spin lands mid-animation, the transition simply retargets:
  // cancel the old completion so only the latest winner is announced.
  clearTimeout(animateWheelTo.timer);
  animateWheelTo.timer = setTimeout(() => {
    wheelSpinning = false;
    group.classList.remove("spinning");
    showWinner(winner, true);
    if (lastState) render(lastState);
  }, 4300);
}

function renderWheelChips(names) {
  els.wheelChips.innerHTML = "";
  names.forEach((name, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip wheel-chip";
    chip.title = `Remove ${name} from the wheel`;
    chip.innerHTML =
      `<span class="chip-dot" style="background:${wheelColor(i, names.length)}"></span>` +
      `${escapeHtml(name)} <span class="chip-x" aria-hidden="true">✕</span>`;
    chip.addEventListener("click", () => {
      session?.transport.send({ type: "wheel-set", names: names.filter((n) => n !== name) });
    });
    els.wheelChips.appendChild(chip);
  });
}

function renderWheel(state) {
  const names = wheelNamesOf(state);
  const key = JSON.stringify(names);
  if (key !== wheelNamesKey && !wheelSpinning) {
    wheelNamesKey = key;
    buildWheelSvg(names);
  }
  renderWheelChips(names);

  if (!wheelSpinning) {
    els.wheelStatus.textContent = names.length ? `${names.length} on the wheel` : "wheel is empty";
    els.spin.disabled = names.length < 2;
    els.wheelShuffle.disabled = names.length < 2;
  }

  if (state.wheel.spunAt > lastSpunAt) {
    lastSpunAt = state.wheel.spunAt;
    if (firstWheelState) {
      showWinner(state.wheel.winner); // historical spin: show, don't replay
    } else {
      animateWheelTo(state.wheel.winner, names);
    }
  }
  firstWheelState = false;
}

/* One toast per round when you become the last voter; reset on reveal/reset. */
let nudgedThisRound = false;

function render(state) {
  lastState = state;

  // Never clobber a story the user is currently typing.
  if (document.activeElement !== els.story && els.story.value !== state.story) {
    els.story.value = state.story;
  }

  renderPlayers(state);
  renderResults(state);
  renderObservers(state);
  renderWheel(state);
  renderNotes(state);

  const mine = state.participants.find((p) => p.you);
  const observing = mine?.observer === true;
  const iAmAway = isAway(mine?.status ?? "");

  // "Active voters" excludes observers and anyone away: a stepped-out teammate
  // shouldn't hold up the tally, the reveal gate, or the "waiting for you" nudge.
  const voters = state.participants.filter((p) => !p.observer && !isAway(p.status));
  const voted = voters.filter((p) => p.voted).length;
  const total = voters.length;
  els.roundStatus.textContent = state.revealed ? "Revealed" : `${voted}/${total} voted`;
  els.roundStatus.className = state.revealed ? "status ok" : "status";

  els.reveal.disabled = state.revealed || voted === 0;
  els.reset.disabled = !state.revealed && voted === 0;

  // Observers have no deck: hide the cards, status + theme pickers, show the note.
  els.deck.hidden = observing;
  els.deckFoot.hidden = observing;
  els.themesPanel.hidden = observing;
  els.observerNote.hidden = !observing;
  markSelectedTheme(mine?.theme ?? currentTheme());
  markSelectedStatus(mine?.status ?? "");
  for (const btn of els.deck.children) {
    const chosen = mine?.vote === btn.textContent;
    btn.classList.toggle("selected", chosen);
    btn.setAttribute("aria-selected", chosen ? "true" : "false");
    btn.disabled = state.revealed;
  }

  // Nudge when everyone but you has voted and the round is still open. If you're
  // away or observing you aren't expected to vote, so you get no prompt.
  const lastVoter = !state.revealed && !observing && !iAmAway && total >= 2 &&
    !mine?.voted && voted === total - 1;
  els.yourTurn.hidden = !lastVoter;
  document.querySelector(".deck-panel")?.classList.toggle("awaiting-you", lastVoter);
  if (state.revealed || voted === 0) nudgedThisRound = false;
  if (lastVoter && !nudgedThisRound) {
    nudgedThisRound = true;
    showToast("🃏 Everyone's in — pick your card");
  }

  // Re-centre the theme dots on the "Your card" panel after this relayout.
  alignThemeDots();
}

/* The theme-dot strip lives in its own table column, so it would naturally sit
   at the column top (beside the players). Nudge it down so the dots are centred
   on the "Your card" panel. Re-runs on any layout shift via the ResizeObserver
   wired up at the bottom of this file. */
function alignThemeDots() {
  const deck = document.querySelector(".deck-panel");
  // Skip when observing (picker hidden) or in the stacked ≤960px layout.
  if (!deck || els.themesPanel.hidden || !matchMedia("(min-width: 961px)").matches) {
    els.cardThemes.style.marginTop = "";
    return;
  }
  // Point the strip's top at the deck's centre; the CSS translateY(-50%) then
  // pulls it back by half its own height, so it stays centred whether it's
  // collapsed to one dot or expanded to all five.
  const themesTop = els.themesPanel.getBoundingClientRect().top;
  const d = deck.getBoundingClientRect();
  const offset = d.top + d.height / 2 - themesTop;
  els.cardThemes.style.marginTop = `${Math.max(0, Math.round(offset))}px`;
}

/* ------------------------------ join / leave ----------------------------- */

function joinRoom(code) {
  const name = els.playerName.value.trim();
  if (!name) {
    els.joinError.textContent = "Please enter your name first.";
    els.playerName.focus();
    return;
  }
  code = code.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    els.joinError.textContent = "Room codes are 4–8 letters or digits, e.g. QK7M.";
    els.roomCode.focus();
    return;
  }
  els.joinError.textContent = "";
  const observer = els.observerCheck.checked;
  // Remember the name and the observer role so a reload (auto-join below)
  // rejoins the same way — a PO shouldn't silently turn into a voter.
  try {
    localStorage.setItem("meso-poker-name", name);
    localStorage.setItem("meso-poker-observer", observer ? "1" : "");
  } catch {
    /* fine */
  }

  setConn("connecting");
  const transport = connectLive(code, name, observer, {
    state: render,
    react: (msg) => floatReaction(String(msg.emoji ?? ""), String(msg.name ?? "")),
    nudge: (msg) => onNudge(String(msg.name ?? ""), String(msg.from ?? "")),
    up: () => setConn("live"),
    down: () => {
      setConn("reconnecting");
      // Treat whatever arrives after a reconnect as history: show the last
      // winner without replaying the spin animation.
      firstWheelState = true;
      // A reconnect may land on a fresh room (server restarted): allow one
      // more re-seed check so the saved notes come back.
      notesSeedChecked = false;
    },
    error: (message) => {
      showToast(message || "The room turned you away.");
      leaveRoom();
    },
    fail: () => {
      // No server (static build or server down): same table, local room.
      if (!session) return;
      session.transport = createSolo(name, observer, render);
      setConn("solo");
      showToast("No server reachable — solo mode");
    },
  });

  session = { code, name, transport };
  notesSeedChecked = false;
  lastNotesAt = -1;
  els.noteDate.value = todayStr();
  els.roomChip.textContent = code;
  els.join.hidden = true;
  els.table.hidden = false;
  // The table just became visible; align the theme dots once it has laid out.
  requestAnimationFrame(alignThemeDots);
  history.replaceState(null, "", `?room=${code}`);
}

function leaveRoom() {
  session?.transport.close();
  session = null;
  lastState = null;
  els.table.hidden = true;
  els.join.hidden = false;
  els.story.value = "";
  wheelRotation = 0;
  wheelSpinning = false;
  lastSpunAt = 0;
  wheelNamesKey = "";
  firstWheelState = true;
  els.wheelResult.hidden = true;
  hidePickPanel();
  observerKey = "";
  els.observerPanel.hidden = true;
  els.observerPanel.classList.remove("show");
  document.body.classList.remove("has-observers");
  els.reactionLayer.innerHTML = "";
  nudgedAt.clear();
  notesSeedChecked = false;
  lastNotesAt = -1;
  els.noteText.value = "";
  setConn(null);
  history.replaceState(null, "", location.pathname);
  els.roomCode.focus();
}

/* --------------------------------- wire --------------------------------- */

buildDeck();
buildThemePicker();
buildStatusPicker();
buildReactions();

// Re-centre the theme dots when the viewport changes; render() handles the
// state-driven relayouts (players joining, results appearing, and so on).
addEventListener("resize", alignThemeDots);

els.joinBtn.addEventListener("click", () => joinRoom(els.roomCode.value));
els.createBtn.addEventListener("click", () => joinRoom(generateRoomCode()));
for (const input of [els.playerName, els.roomCode]) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom(els.roomCode.value || generateRoomCode());
  });
}

els.leave.addEventListener("click", leaveRoom);
els.pickClose.addEventListener("click", hidePickPanel);

els.invite.addEventListener("click", async () => {
  if (!session) return;
  const url = `${location.origin}${location.pathname}?room=${session.code}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Invite link copied");
  } catch {
    showToast(url);
  }
});

// Collapsible left-column panels. Local view state only — not a room rule, so
// it stays out of poker.mjs and never touches the transport. Reset on reload.
els.table.addEventListener("click", (e) => {
  const toggle = e.target.closest(".panel-toggle");
  if (!toggle) return;
  const collapsed = toggle.closest(".panel").classList.toggle("collapsed");
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${toggle.dataset.label}`);
});

els.reveal.addEventListener("click", () => session?.transport.send({ type: "reveal" }));
els.reset.addEventListener("click", () => session?.transport.send({ type: "reset" }));

let storyTimer = 0;
els.story.addEventListener("input", () => {
  clearTimeout(storyTimer);
  storyTimer = setTimeout(() => {
    session?.transport.send({ type: "story", text: els.story.value });
  }, 300);
});

/* wheel controls */

function addWheelName() {
  if (!session || !lastState) return;
  const name = els.wheelName.value.trim().slice(0, LIMITS.name);
  if (!name) return;
  const names = wheelNamesOf(lastState);
  if (names.includes(name)) {
    showToast(`${name} is already on the wheel`);
    return;
  }
  if (names.length >= LIMITS.wheelNames) {
    showToast(`The wheel holds at most ${LIMITS.wheelNames} names`);
    return;
  }
  session.transport.send({ type: "wheel-set", names: [...names, name] });
  els.wheelName.value = "";
  els.wheelName.focus();
}

els.wheelAdd.addEventListener("click", addWheelName);
els.wheelName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addWheelName();
});

els.wheelSync.addEventListener("click", () => {
  if (!session || !lastState) return;
  const names = sanitizeWheelNames(
    lastState.participants.filter((p) => !p.observer).map((p) => p.name),
  );
  session.transport.send({ type: "wheel-set", names });
  showToast("Wheel now matches the room");
});

els.wheelShuffle.addEventListener("click", () => {
  if (!session || !lastState || wheelSpinning) return;
  const names = wheelNamesOf(lastState);
  if (names.length < 2) return;
  session.transport.send({ type: "wheel-set", names: shuffled(names) });
  showToast("Shuffled the order");
});

function setAutoShuffle(on) {
  autoShuffle = on;
  try {
    localStorage.setItem("meso-poker-autoshuffle", on ? "1" : "");
  } catch {
    /* fine */
  }
  els.wheelAutoShuffle.setAttribute("aria-pressed", on ? "true" : "false");
}
els.wheelAutoShuffle.addEventListener("click", () => setAutoShuffle(!autoShuffle));
try {
  setAutoShuffle(localStorage.getItem("meso-poker-autoshuffle") === "1");
} catch {
  /* ignore */
}

/* room notes */

els.noteAdd.addEventListener("click", addNote);
// Notes are often long: plain Enter breaks the line (textarea default),
// Ctrl/⌘+Enter submits.
els.noteText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    addNote();
  }
});
// Grow with the text up to the CSS max-height, then scroll.
els.noteText.addEventListener("input", () => {
  els.noteText.style.height = "auto";
  els.noteText.style.height = `${els.noteText.scrollHeight + 2}px`;
});
els.noteDate.value = todayStr();

els.spin.addEventListener("click", () => {
  if (!session || !lastState || wheelSpinning) return;
  let names = wheelNamesOf(lastState);
  if (names.length < 2) return;
  // Auto-shuffle reorders here, at the start of the spin, so the previous
  // result stayed parked on the wheel until now.
  if (autoShuffle) names = shuffled(names);
  // Freeze the list so the spin validates against it and every client animates
  // over the exact same segments. A shuffle always needs pushing; an unshuffled
  // derived list only needs freezing when it isn't already custom.
  if (autoShuffle || !lastState.wheel.custom) {
    session.transport.send({ type: "wheel-set", names });
  }
  const winner = names[Math.floor(Math.random() * names.length)];
  session.transport.send({ type: "wheel-spin", winner });
});

// Tell the server we're gone on refresh/tab close: a deliberate close beats
// waiting for the proxy to notice a dead TCP connection. `pagehide` fires
// reliably on mobile too, where `beforeunload` often doesn't.
addEventListener("pagehide", () => {
  session?.transport.close();
});

// Prefill from the last session and the invite link; auto-join when both
// the name and a valid ?room= code are already known.
try {
  els.playerName.value = localStorage.getItem("meso-poker-name") ?? "";
  els.observerCheck.checked = localStorage.getItem("meso-poker-observer") === "1";
} catch {
  /* ignore */
}
const invited = (new URLSearchParams(location.search).get("room") ?? "").toUpperCase();
if (invited) els.roomCode.value = invited;
if (invited && CODE_PATTERN.test(invited) && els.playerName.value) {
  joinRoom(invited);
} else if (!els.playerName.value) {
  els.playerName.focus();
} else {
  els.roomCode.focus();
}
