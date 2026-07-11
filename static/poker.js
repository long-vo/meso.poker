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
  LIMITS,
  publicState,
  sanitizeWheelNames,
} from "./poker.mjs";

/** Theme id -> colour. Theme CSS variables adapt to dark/light mode. */
const CARD_THEME_COLORS = {
  ocean: "var(--accent)",
  violet: "var(--accent-2)",
  forest: "var(--good)",
  sunset: "var(--mask)",
  ruby: "var(--danger)",
};

const $ = (id) => document.getElementById(id);

const els = {
  conn: $("conn"),
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
  wheelStatus: $("wheel-status"),
  wheelResult: $("wheel-result"),
  pickPanel: $("pick-panel"),
  pickClose: $("pick-close"),
  pickName: $("pick-name"),
  cardThemes: $("card-themes"),
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

/** Update the connection pill: live | solo | connecting | reconnecting. */
function setConn(state) {
  const pill = els.conn;
  if (!state) {
    pill.hidden = true;
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
      const event = message.type === "vote"
        ? { type: "vote", id: "you", value: message.value }
        : message.type === "story"
        ? { type: "story", text: message.text, at: Date.now() }
        : message.type === "wheel-set"
        ? { type: "wheel-set", names: message.names, at: Date.now() }
        : message.type === "wheel-spin"
        ? { type: "wheel-spin", winner: message.winner, at: Date.now() }
        : message.type === "theme"
        ? { type: "theme", id: "you", theme: message.theme }
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

/* ------------------------------- rendering ------------------------------- */

function buildDeck() {
  els.deck.innerHTML = "";
  for (const card of DECK) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "deck-card";
    btn.textContent = card;
    btn.setAttribute("role", "option");
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
    const wrap = document.createElement("div");
    wrap.className = p.you ? "player me" : "player";

    const card = document.createElement("div");
    card.className = "pcard";
    card.style.setProperty("--card-accent", themeColor(p.theme));
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
    label.innerHTML = p.you
      ? `${escapeHtml(p.name)} <span class="you">you</span>`
      : escapeHtml(p.name);
    label.title = p.name;

    wrap.appendChild(card);
    wrap.appendChild(label);
    els.players.appendChild(wrap);
  }
}

function renderResults(state) {
  const stats = state.stats;
  if (!state.revealed || !stats) {
    els.results.hidden = true;
    els.results.innerHTML = "";
    return;
  }
  const parts = [];
  for (const { card, count } of stats.distribution) {
    // "5 pts × 3" for point cards; "?" and "☕" carry no unit.
    const unit = card === "?" || card === "☕" ? "" : card === "1" || card === "½" ? " pt" : " pts";
    parts.push(`<span class="tag dist-chip">${escapeHtml(card)}${unit} × ${count}</span>`);
  }
  if (stats.consensus) parts.push(`<span class="consensus">🎉 Consensus!</span>`);
  els.results.innerHTML = parts.join("");
  els.results.hidden = false;
}

/* ------------------------------ name wheel ------------------------------ */

/**
 * Evenly-spaced hues around the colour circle, so every name gets its own
 * colour (identical on every client, since the name order is shared) and the
 * Spin hub — a neutral themed circle — never blends into a segment.
 * The label is a pale tint of the same hue: distinct per name, yet always
 * readable on its mid-lightness segment.
 */
function wheelHue(index, count) {
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
    const size = names.length <= 8 ? 11 : names.length <= 14 ? 9 : 7.5;
    const mid = (i + 0.5) * per;
    parts.push(
      `<text x="100" y="46" text-anchor="middle" font-size="${size}" class="wheel-label" ` +
        `style="fill:${wheelLabelColor(i, names.length)}" ` +
        `transform="rotate(${mid.toFixed(2)} 100 100)">${escapeHtml(label)}</text>`,
    );
  });
  els.wheel.innerHTML = `<g id="wheel-g" class="wheel-g">${parts.join("")}</g>` +
    `<circle cx="100" cy="100" r="13" class="wheel-hub"></circle>`;
}

function hidePickPanel() {
  els.pickPanel.hidden = true;
  els.pickPanel.classList.remove("show");
}

/** Slide the floating announcement in from the right. */
function floatWinner(winner) {
  els.pickName.textContent = `🎯 ${winner}`;
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
      `${escapeHtml(name)} <span class="chip-x" aria-hidden="true">×</span>`;
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
  renderWheel(state);

  const voters = state.participants.filter((p) => !p.observer);
  const voted = voters.filter((p) => p.voted).length;
  const total = voters.length;
  els.roundStatus.textContent = state.revealed ? "Revealed" : `${voted}/${total} voted`;
  els.roundStatus.className = state.revealed ? "status ok" : "status";

  els.reveal.disabled = state.revealed || voted === 0;
  els.reset.disabled = !state.revealed && voted === 0;

  const mine = state.participants.find((p) => p.you);
  // Observers have no deck: hide the cards and theme dots, show the note.
  const observing = mine?.observer === true;
  els.deck.hidden = observing;
  els.deckFoot.hidden = observing;
  els.observerNote.hidden = !observing;
  markSelectedTheme(mine?.theme ?? currentTheme());
  for (const btn of els.deck.children) {
    btn.classList.toggle("selected", mine?.vote === btn.textContent);
    btn.disabled = state.revealed;
  }

  // Nudge when everyone but you has voted and the round is still open.
  const lastVoter = !state.revealed && !observing && total >= 2 &&
    !mine?.voted && voted === total - 1;
  els.yourTurn.hidden = !lastVoter;
  document.querySelector(".deck-panel")?.classList.toggle("awaiting-you", lastVoter);
  if (state.revealed || voted === 0) nudgedThisRound = false;
  if (lastVoter && !nudgedThisRound) {
    nudgedThisRound = true;
    showToast("🃏 Everyone's in — pick your card");
  }
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
  try {
    localStorage.setItem("meso-poker-name", name);
  } catch {
    /* fine */
  }

  setConn("connecting");
  const observer = els.observerCheck.checked;
  const transport = connectLive(code, name, observer, {
    state: render,
    up: () => setConn("live"),
    down: () => {
      setConn("reconnecting");
      // Treat whatever arrives after a reconnect as history: show the last
      // winner without replaying the spin animation.
      firstWheelState = true;
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
  els.roomChip.textContent = code;
  els.join.hidden = true;
  els.table.hidden = false;
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
  setConn(null);
  history.replaceState(null, "", location.pathname);
  els.roomCode.focus();
}

/* --------------------------------- wire --------------------------------- */

buildDeck();
buildThemePicker();

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

els.spin.addEventListener("click", () => {
  if (!session || !lastState || wheelSpinning) return;
  const names = wheelNamesOf(lastState);
  if (names.length < 2) return;
  // Freeze the derived list first so the spin validates against it and every
  // client animates over the exact same segments.
  if (!lastState.wheel.custom) {
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
