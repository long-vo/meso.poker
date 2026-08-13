// @ts-check
/**
 * Scrum-poker room logic for meso.poker.
 *
 * Isomorphic and dependency-free, like `sanitize.mjs`: the Deno server drives
 * shared rooms with it, and the browser imports the very same file to run a
 * local "solo mode" when no server is reachable (e.g. the GitHub Pages build).
 *
 * A room is a plain object mutated by `applyEvent`. Vote values are hidden
 * from other participants until the round is revealed; `publicState` produces
 * the per-viewer projection that is safe to send over the wire.
 */

/** The card deck (classic planning-poker values). */
export const DECK = ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100", "?", "☕"];

/**
 * Card themes a player can pick for their own cards ("sleeves"): the first
 * one is the default. The UI maps each id to a colour; the room only stores
 * the id, so every client renders the owner's card back in their theme.
 */
export const CARD_THEMES = ["ocean", "violet", "forest", "sunset", "ruby"];

/** Input limits, shared by server validation and UI. */
export const LIMITS = {
  name: 24,
  story: 200,
  participants: 50,
  wheelNames: 30,
  note: 280,
  notes: 50,
  pin: 4,
};

/**
 * Emoji a player can send as a fleeting reaction. Reactions are relay-only:
 * they are never written to room state — the server validates against this
 * list and fans the message out to every open socket (see poker-server.ts),
 * so late joiners simply never see past reactions.
 */
export const REACTIONS = ["👍", "🎉", "🤯", "😴"];

/**
 * Presence statuses a player can set on themselves (like a card theme: the
 * owner picks it, everyone sees it, and it persists across rounds). The empty
 * string is the implicit default ("Available" — no badge shown). `away` marks
 * a "stepped out" status: an away player drops out of the round's active-voter
 * tally and can't be nudged (see the client render and the server nudge guard).
 */
export const STATUSES = [
  { id: "away", emoji: "🚪", label: "Away", away: true },
  { id: "break", emoji: "☕", label: "Break", away: true },
  { id: "brb", emoji: "⏱️", label: "BRB", away: true },
  { id: "thinking", emoji: "🤔", label: "Thinking", away: false },
];

/**
 * Whether a status id marks its owner as "away" (sitting out the round).
 * The default ("") and unknown ids are never away. Shared by the client tally
 * and the server's nudge guard so both agree on who is pausing.
 * @param {string} status
 * @returns {boolean}
 */
export function isAway(status) {
  return STATUSES.some((s) => s.id === status && s.away);
}

/**
 * `joinedAt` fixes the seat order and survives reconnects; `connectedAt` is
 * bumped by every (re)join and only breaks ties when two isolates report the
 * same participant — the fresher connection wins.
 * @typedef {{ name: string, vote: string | null, joinedAt: number, connectedAt: number, theme: string, observer: boolean, status: string }} Participant
 * @typedef {{ date: string, text: string, who: string, at: number }} Note
 * @typedef {{
 *   participants: Record<string, Participant>,
 *   revealed: boolean,
 *   revealedAt: number,
 *   story: string,
 *   storyAt: number,
 *   wheelNames: string[],
 *   wheelNamesAt: number,
 *   wheelWinner: string | null,
 *   wheelSpunAt: number,
 *   notes: Note[],
 *   notesAt: number,
 *   password: string | null,
 * }} Room
 * @typedef {{
 *   type: string,
 *   id?: string,
 *   name?: string,
 *   value?: string | null,
 *   text?: string,
 *   names?: string[],
 *   winner?: string,
 *   theme?: string,
 *   observer?: boolean,
 *   status?: string,
 *   notes?: unknown[],
 *   password?: string,
 *   at?: number,
 * }} RoomEvent
 */

/** @returns {Room} a fresh, empty room. */
export function createRoom() {
  return {
    participants: {},
    revealed: false,
    revealedAt: 0,
    story: "",
    storyAt: 0,
    wheelNames: [],
    wheelNamesAt: 0,
    wheelWinner: null,
    wheelSpunAt: 0,
    notes: [],
    notesAt: 0,
    // null = never initialised (the first joiner will set it); "" = an open
    // room; a 4-digit string = the PIN a joiner must supply. Never sent to
    // clients — `publicState` omits it — so it only travels server-to-server.
    password: null,
  };
}

/**
 * Normalize a wheel name list: trim, drop blanks, dedupe, cap length and count.
 * Shared by the reducer and the UI so both agree on what a valid list is.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function sanitizeWheelNames(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const names = [];
  for (const item of raw) {
    const name = String(item ?? "").trim().slice(0, LIMITS.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= LIMITS.wheelNames) break;
  }
  return names;
}

/**
 * Normalize a note list: keep only well-formed entries (a real YYYY-MM-DD
 * date and non-blank text), trim and cap the fields, cap the count, and sort
 * chronologically (creation time breaks date ties). Deterministic order makes
 * the reducer's JSON no-op comparison reliable. Shared by reducer and UI.
 * @param {unknown} raw
 * @returns {Note[]}
 */
export function sanitizeNotes(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Note[]} */
  const notes = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const note = /** @type {Record<string, unknown>} */ (item);
    const date = String(note.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) continue;
    const text = String(note.text ?? "").trim().slice(0, LIMITS.note);
    if (!text) continue;
    const who = String(note.who ?? "").trim().slice(0, LIMITS.name);
    const at = Number(note.at);
    notes.push({ date, text, who, at: Number.isFinite(at) && at > 0 ? at : 0 });
    if (notes.length >= LIMITS.notes) break;
  }
  notes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.at - b.at));
  return notes;
}

/** Shape of a room PIN: exactly four digits (shared by server and UI). */
export const PIN_PATTERN = /^\d{4}$/;

/**
 * Normalize a room PIN: keep it only when it is exactly four digits, else "".
 * Shared by the reducer's join gate, the server pre-check and the client so all
 * three agree on what counts as a PIN (blank means "no PIN / open room").
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizePin(raw) {
  const pin = String(raw ?? "");
  return PIN_PATTERN.test(pin) ? pin : "";
}

/**
 * Numeric value of a card, or null when it has none ("?" and "☕").
 * @param {string} card
 * @returns {number | null}
 */
export function cardValue(card) {
  if (card === "½") return 0.5;
  const n = Number(card);
  return card.trim() !== "" && Number.isFinite(n) ? n : null;
}

/**
 * Apply an event to a room, mutating it in place.
 * Unknown or invalid events are ignored so a hostile client can never corrupt
 * the room. Votes are locked while a round is revealed (reset starts anew).
 * @param {Room} room
 * @param {RoomEvent} event
 * @returns {boolean} true when the room actually changed.
 */
export function applyEvent(room, event) {
  switch (event.type) {
    // A join carrying an id the room already knows is a *reclaim*, not a
    // duplicate: the same person's socket dropped and came back. Clients hold a
    // stable per-tab id, so the seat — vote, position, presence — is picked up
    // where it was left instead of a second row appearing next to the ghost.
    case "join": {
      const id = String(event.id ?? "");
      const name = String(event.name ?? "").trim().slice(0, LIMITS.name);
      if (!id || !name) return false;
      const existing = room.participants[id];
      // The cap counts seats, so reclaiming one is allowed in a full room.
      if (!existing && Object.keys(room.participants).length >= LIMITS.participants) return false;
      // Password gate. A room's PIN is fixed by whoever initialises it: an
      // uninitialised room (password null) adopts this join's PIN — "" when the
      // creator set none, leaving the room open — and locks it in. Every later
      // join to a protected room must supply the matching PIN. A reclaim is a
      // fresh connection, so it is gated exactly like a first join.
      const pin = sanitizePin(event.password);
      if (room.password === null) {
        room.password = pin;
      } else if (room.password && pin !== room.password) {
        return false;
      }
      const theme = CARD_THEMES.includes(String(event.theme))
        ? String(event.theme)
        : CARD_THEMES[0];
      const at = event.at ?? Date.now();
      if (existing) {
        // Name, theme and role can change between connections; the vote, the
        // seat order and the presence status carry over — a wifi blip is not a
        // reason to lose your card or to stop being away.
        existing.name = name;
        existing.theme = theme;
        existing.observer = event.observer === true;
        // An observer holding a vote would still be counted by computeStats.
        if (existing.observer) existing.vote = null;
        existing.connectedAt = at;
        return true;
      }
      room.participants[id] = {
        name,
        vote: null,
        joinedAt: at,
        connectedAt: at,
        theme,
        // Observers (e.g. the product owner) watch and reveal but never vote.
        observer: event.observer === true,
        // Presence status is transient: everyone joins as "Available" ("").
        status: "",
      };
      return true;
    }
    case "theme": {
      const participant = room.participants[String(event.id ?? "")];
      const theme = String(event.theme ?? "");
      if (!participant || !CARD_THEMES.includes(theme) || participant.theme === theme) return false;
      participant.theme = theme;
      return true;
    }
    case "status": {
      const participant = room.participants[String(event.id ?? "")];
      const status = String(event.status ?? "");
      // "" clears back to the default; any other value must be a known preset.
      if (!participant || (status !== "" && !STATUSES.some((s) => s.id === status))) return false;
      if (participant.status === status) return false;
      participant.status = status;
      return true;
    }
    case "leave": {
      const id = String(event.id ?? "");
      if (!room.participants[id]) return false;
      delete room.participants[id];
      return true;
    }
    case "vote": {
      const participant = room.participants[String(event.id ?? "")];
      if (!participant || participant.observer || room.revealed) return false;
      const value = event.value === null || event.value === undefined ? null : String(event.value);
      if (value !== null && !DECK.includes(value)) return false;
      if (participant.vote === value) return false;
      participant.vote = value;
      return true;
    }
    case "reveal": {
      if (room.revealed) return false;
      room.revealed = true;
      room.revealedAt = event.at ?? Date.now();
      return true;
    }
    case "reset": {
      room.revealed = false;
      room.revealedAt = event.at ?? Date.now();
      for (const participant of Object.values(room.participants)) participant.vote = null;
      return true;
    }
    case "story": {
      const text = String(event.text ?? "").slice(0, LIMITS.story);
      if (room.story === text) return false;
      room.story = text;
      room.storyAt = event.at ?? Date.now();
      return true;
    }
    case "wheel-set": {
      const names = sanitizeWheelNames(event.names);
      if (JSON.stringify(names) === JSON.stringify(room.wheelNames)) return false;
      room.wheelNames = names;
      room.wheelNamesAt = event.at ?? Date.now();
      return true;
    }
    case "wheel-spin": {
      const winner = String(event.winner ?? "").trim().slice(0, LIMITS.name);
      if (!winner || !room.wheelNames.includes(winner)) return false;
      room.wheelWinner = winner;
      room.wheelSpunAt = event.at ?? Date.now();
      return true;
    }
    // Notes are replaced as a whole list (like the wheel): clients send the
    // full edited list and last-writer-wins keeps the isolates agreeing.
    // Only the author may remove their own note: when the event carries the
    // sender's id (the server always stamps it; solo mode passes "you"), an
    // edit must keep every note authored by someone else. Author-less notes
    // are removable by anyone. Events without an id — internal use, tests —
    // skip the ownership check, since untrusted clients can never omit it.
    case "notes-set": {
      const notes = sanitizeNotes(event.notes);
      if (JSON.stringify(notes) === JSON.stringify(room.notes)) return false;
      if (event.id !== undefined) {
        const editor = room.participants[String(event.id)];
        if (!editor) return false;
        const kept = new Set(notes.map((note) => JSON.stringify(note)));
        const removedForeign = room.notes.some((note) =>
          note.who !== "" && note.who !== editor.name && !kept.has(JSON.stringify(note))
        );
        if (removedForeign) return false;
      }
      room.notes = notes;
      room.notesAt = event.at ?? Date.now();
      return true;
    }
    default:
      return false;
  }
}

/**
 * Round statistics, meaningful once a round is revealed.
 * The sum uses numeric cards only ("?" and "☕" are excluded); consensus
 * requires at least two identical votes and no differing ones.
 * @param {Room} room
 * @returns {{
 *   votes: number,
 *   sum: number | null,
 *   distribution: { card: string, count: number }[],
 *   consensus: boolean,
 * }}
 */
export function computeStats(room) {
  const votes = Object.values(room.participants)
    .map((p) => p.vote)
    .filter((v) => v !== null);
  const numeric = votes.map((v) => cardValue(/** @type {string} */ (v)))
    .filter((v) => v !== null);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);
  const distribution = DECK.filter((card) => counts.has(card))
    .map((card) => ({ card, count: counts.get(card) ?? 0 }));
  const sum = numeric.length ? Math.round(numeric.reduce((a, b) => a + b, 0) * 10) / 10 : null;
  const consensus = votes.length >= 2 && votes.every((v) => v === votes[0]);
  return { votes: votes.length, sum, distribution, consensus };
}

/**
 * Deck distance between two cards, in deck positions — the deck's numeric run
 * is ordered, so "how many steps apart" is a better measure of disagreement
 * than the arithmetic gap (13 vs 20 is one step; 3 vs 8 is two).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function deckDistance(a, b) {
  return Math.abs(DECK.indexOf(a) - DECK.indexOf(b));
}

/**
 * A one-line reading of a revealed round: what the spread actually means, so
 * every outcome that isn't unanimous stops looking alike. Derived purely from
 * `computeStats` output, so the client can call it on `publicState().stats`.
 *
 * A majority of "☕" or "?" outranks consensus: an all-"?" round is unanimous,
 * but "nobody understands this yet" is the useful thing to say about it.
 * @param {ReturnType<typeof computeStats>} stats
 * @returns {{ id: string, emoji: string, label: string, tone: string } | null}
 */
export function roundVerdict(stats) {
  if (!stats || stats.votes < 2) return null;
  /** @param {string} card */
  const count = (card) => stats.distribution.find((d) => d.card === card)?.count ?? 0;
  // Strictly more than half — with two voters, one "☕" is not the room's mood.
  /** @param {string} card */
  const majority = (card) => count(card) * 2 > stats.votes;
  if (majority("☕")) {
    return { id: "coffee", emoji: "☕", label: "Break?", tone: "info" };
  }
  if (majority("?")) {
    return { id: "unclear", emoji: "🤷", label: "Nobody understands this one yet", tone: "warn" };
  }
  if (stats.consensus) {
    return { id: "consensus", emoji: "🎯", label: "Perfect call", tone: "good" };
  }
  const numeric = stats.distribution.filter((d) => cardValue(d.card) !== null);
  const numericVotes = numeric.reduce((n, d) => n + d.count, 0);
  if (numericVotes < 2) return null;
  const spread = deckDistance(numeric[0].card, numeric[numeric.length - 1].card);
  if (spread === 0) {
    return { id: "agreed", emoji: "👍", label: "Agreed on the numbers", tone: "good" };
  }
  if (spread === 1) {
    return { id: "close", emoji: "🤏", label: "Close enough — take the higher", tone: "good" };
  }
  if (spread === 2) {
    return { id: "near", emoji: "🫱", label: "Nearly there", tone: "info" };
  }
  return { id: "wide", emoji: "↔️", label: "Wide spread — talk it out", tone: "warn" };
}

/**
 * The two ends of a revealed round: who went highest and who went lowest. This
 * is the pair a team actually talks to, so it is worth naming.
 *
 * Takes the participant list as `publicState` projects it (votes are only
 * populated there once the round is revealed). Null unless the ends are at
 * least two deck positions apart — 3 vs 5 is agreement, not an outlier.
 * @param {{ name: string, vote: string | null, observer?: boolean }[]} participants
 * @returns {{ high: { card: string, names: string[] }, low: { card: string, names: string[] } } | null}
 */
export function roundOutliers(participants) {
  const voted = (participants ?? []).filter((p) =>
    !p.observer && p.vote !== null && cardValue(p.vote) !== null
  );
  if (voted.length < 2) return null;
  const positions = voted.map((p) => DECK.indexOf(/** @type {string} */ (p.vote)));
  const high = DECK[Math.max(...positions)];
  const low = DECK[Math.min(...positions)];
  if (deckDistance(high, low) < 2) return null;
  /** @param {string} card */
  const namesOn = (card) => voted.filter((p) => p.vote === card).map((p) => p.name);
  return {
    high: { card: high, names: namesOn(high) },
    low: { card: low, names: namesOn(low) },
  };
}

/**
 * The per-viewer projection of a room that is safe to send over the wire:
 * before the reveal, other participants' card values are replaced by a
 * "voted" flag; your own vote is always echoed back so the UI can render it.
 * The wheel is included as-is: names are public within a room anyway, and the
 * client needs `spunAt` to know when to animate a new spin. `custom` tells the
 * UI whether the list was ever edited (until then it mirrors room joiners).
 * @param {Room} room
 * @param {string} selfId
 * @returns {{
 *   revealed: boolean,
 *   story: string,
 *   participants: {
 *     name: string,
 *     you: boolean,
 *     voted: boolean,
 *     vote: string | null,
 *     theme: string,
 *     observer: boolean,
 *     status: string,
 *   }[],
 *   stats: ReturnType<typeof computeStats> | null,
 *   wheel: { names: string[], custom: boolean, winner: string | null, spunAt: number },
 *   notes: { list: Note[], at: number },
 * }}
 */
export function publicState(room, selfId) {
  const participants = Object.entries(room.participants)
    .sort(([, a], [, b]) => a.joinedAt - b.joinedAt || a.name.localeCompare(b.name))
    .map(([id, p]) => ({
      name: p.name,
      you: id === selfId,
      voted: p.vote !== null,
      vote: room.revealed || id === selfId ? p.vote : null,
      theme: p.theme,
      observer: p.observer === true,
      status: p.status ?? "",
    }));
  return {
    revealed: room.revealed,
    story: room.story,
    participants,
    stats: room.revealed ? computeStats(room) : null,
    wheel: {
      names: [...room.wheelNames],
      custom: room.wheelNamesAt > 0,
      winner: room.wheelWinner,
      spunAt: room.wheelSpunAt,
    },
    // `at` doubles as the "was ever edited" flag (0 = untouched) and lets
    // clients persist the freshest copy per room code (see poker.js).
    notes: { list: room.notes.map((note) => ({ ...note })), at: room.notesAt },
  };
}

/**
 * Merge this isolate's room with snapshots gossiped by sibling isolates
 * (on Deno Deploy, sockets for one room may land on different isolates).
 * Participant maps are normally disjoint — each participant is owned by the
 * isolate holding its socket — but a reconnect onto a different isolate is
 * briefly claimed by both, until the old one notices its socket is dead. Since
 * clients keep a stable id, those two claims share a key and collapse to one
 * row here, the fresher `connectedAt` winning so a stale snapshot cannot
 * resurrect an old vote. Shared flags resolve by last-writer-wins.
 * Returns a new room; inputs are not modified.
 * @param {Room} local
 * @param {Room[]} remotes
 * @returns {Room}
 */
export function mergeRooms(local, remotes) {
  /** @type {Room} */
  const merged = {
    participants: { ...local.participants },
    revealed: local.revealed,
    revealedAt: local.revealedAt,
    story: local.story,
    storyAt: local.storyAt,
    wheelNames: [...local.wheelNames],
    wheelNamesAt: local.wheelNamesAt,
    wheelWinner: local.wheelWinner,
    wheelSpunAt: local.wheelSpunAt,
    notes: local.notes.map((note) => ({ ...note })),
    notesAt: local.notesAt,
    password: local.password,
  };
  for (const remote of remotes) {
    for (const [id, participant] of Object.entries(remote.participants)) {
      const mine = merged.participants[id];
      if (!mine || (participant.connectedAt ?? 0) > (mine.connectedAt ?? 0)) {
        merged.participants[id] = participant;
      }
    }
    // Adopt a sibling's PIN when this isolate hasn't been initialised yet, so a
    // joiner landing on a fresh isolate is still gated by the creator's PIN.
    if (merged.password === null && remote.password !== null) {
      merged.password = remote.password;
    }
    if (remote.revealedAt > merged.revealedAt) {
      merged.revealed = remote.revealed;
      merged.revealedAt = remote.revealedAt;
    }
    if (remote.storyAt > merged.storyAt) {
      merged.story = remote.story;
      merged.storyAt = remote.storyAt;
    }
    if (remote.wheelNamesAt > merged.wheelNamesAt) {
      merged.wheelNames = [...remote.wheelNames];
      merged.wheelNamesAt = remote.wheelNamesAt;
    }
    if (remote.wheelSpunAt > merged.wheelSpunAt) {
      merged.wheelWinner = remote.wheelWinner;
      merged.wheelSpunAt = remote.wheelSpunAt;
    }
    if (remote.notesAt > merged.notesAt) {
      merged.notes = remote.notes.map((note) => ({ ...note }));
      merged.notesAt = remote.notesAt;
    }
  }
  return merged;
}

/** Alphabet for room codes — no ambiguous characters (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Shape of a valid room code (shared by server validation and UI). */
export const CODE_PATTERN = /^[A-Z0-9]{4,8}$/;

/**
 * Generate a short, shareable room code, e.g. "QK7M".
 * @param {number} [length]
 * @returns {string}
 */
export function generateRoomCode(length = 4) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}
