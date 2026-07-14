/**
 * Tests for the scrum-poker room logic. Run with `deno task test`.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  applyEvent,
  CARD_THEMES,
  cardValue,
  CODE_PATTERN,
  computeStats,
  createRoom,
  DECK,
  generateRoomCode,
  isAway,
  LIMITS,
  mergeRooms,
  publicState,
  sanitizeNotes,
  sanitizeWheelNames,
  STATUSES,
} from "./poker.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function roomWith(...names: string[]) {
  const room = createRoom();
  names.forEach((name, i) => applyEvent(room, { type: "join", id: `p${i + 1}`, name, at: i }));
  return room;
}

Deno.test("join adds participants; duplicates and blanks are ignored", () => {
  const room = createRoom();
  assertEquals(applyEvent(room, { type: "join", id: "a", name: "  Long  " }), true);
  assertEquals(room.participants["a"].name, "Long");
  assertEquals(applyEvent(room, { type: "join", id: "a", name: "Again" }), false, "duplicate id");
  assertEquals(applyEvent(room, { type: "join", id: "b", name: "   " }), false, "blank name");
  assertEquals(applyEvent(room, { type: "join", id: "", name: "NoId" }), false, "missing id");
});

Deno.test("join truncates long names and enforces the participant cap", () => {
  const room = createRoom();
  applyEvent(room, { type: "join", id: "a", name: "x".repeat(99) });
  assertEquals(room.participants["a"].name.length, LIMITS.name);
  for (let i = 0; i < LIMITS.participants + 10; i++) {
    applyEvent(room, { type: "join", id: `p${i}`, name: `P${i}` });
  }
  assertEquals(Object.keys(room.participants).length, LIMITS.participants);
});

Deno.test("vote accepts deck cards only, toggles with null, locks after reveal", () => {
  const room = roomWith("Ana", "Ben");
  assertEquals(applyEvent(room, { type: "vote", id: "p1", value: "5" }), true);
  assertEquals(applyEvent(room, { type: "vote", id: "p1", value: "5" }), false, "no-op revote");
  assertEquals(applyEvent(room, { type: "vote", id: "p1", value: "4" }), false, "not in deck");
  assertEquals(applyEvent(room, { type: "vote", id: "ghost", value: "5" }), false, "unknown id");
  assertEquals(applyEvent(room, { type: "vote", id: "p1", value: null }), true, "clear vote");
  applyEvent(room, { type: "vote", id: "p1", value: "8" });
  applyEvent(room, { type: "reveal", at: 100 });
  assertEquals(applyEvent(room, { type: "vote", id: "p2", value: "3" }), false, "locked");
});

Deno.test("reset clears votes and starts a new round", () => {
  const room = roomWith("Ana", "Ben");
  applyEvent(room, { type: "vote", id: "p1", value: "13" });
  applyEvent(room, { type: "reveal", at: 100 });
  assertEquals(applyEvent(room, { type: "reveal", at: 101 }), false, "already revealed");
  applyEvent(room, { type: "reset", at: 200 });
  assertEquals(room.revealed, false);
  assertEquals(room.participants["p1"].vote, null);
  assertEquals(applyEvent(room, { type: "vote", id: "p1", value: "2" }), true, "votable again");
});

Deno.test("story is set, truncated and deduplicated", () => {
  const room = createRoom();
  assertEquals(applyEvent(room, { type: "story", text: "PROJ-42 checkout", at: 1 }), true);
  assertEquals(applyEvent(room, { type: "story", text: "PROJ-42 checkout", at: 2 }), false);
  applyEvent(room, { type: "story", text: "y".repeat(999), at: 3 });
  assertEquals(room.story.length, LIMITS.story);
});

Deno.test("unknown events never change the room", () => {
  const room = roomWith("Ana");
  assertEquals(applyEvent(room, { type: "hack" }), false);
  assertEquals(applyEvent(room, { type: "" }), false);
});

Deno.test("cardValue maps the deck to numbers where possible", () => {
  assertEquals(cardValue("½"), 0.5);
  assertEquals(cardValue("13"), 13);
  assertEquals(cardValue("?"), null);
  assertEquals(cardValue("☕"), null);
  assertEquals(DECK.length, 13);
});

Deno.test("stats: sum over numeric cards, distribution in deck order", () => {
  const room = roomWith("Ana", "Ben", "Cid", "Dee");
  applyEvent(room, { type: "vote", id: "p1", value: "3" });
  applyEvent(room, { type: "vote", id: "p2", value: "5" });
  applyEvent(room, { type: "vote", id: "p3", value: "☕" });
  const stats = computeStats(room);
  assertEquals(stats.votes, 3);
  assertEquals(stats.sum, 8);
  assertEquals(stats.distribution, [
    { card: "3", count: 1 },
    { card: "5", count: 1 },
    { card: "☕", count: 1 },
  ]);
  assertEquals(stats.consensus, false);
});

Deno.test("stats: consensus requires 2+ identical votes; ?-only rounds have no sum", () => {
  const room = roomWith("Ana", "Ben");
  applyEvent(room, { type: "vote", id: "p1", value: "8" });
  applyEvent(room, { type: "vote", id: "p2", value: "8" });
  assertEquals(computeStats(room).consensus, true);
  const solo = roomWith("Ana");
  applyEvent(solo, { type: "vote", id: "p1", value: "?" });
  assertEquals(computeStats(solo).consensus, false, "one vote is not consensus");
  assertEquals(computeStats(solo).sum, null);
});

Deno.test("publicState hides other votes until reveal, always echoes your own", () => {
  const room = roomWith("Ana", "Ben");
  applyEvent(room, { type: "vote", id: "p1", value: "5" });
  const forBen = publicState(room, "p2");
  assertEquals(forBen.participants[0], {
    name: "Ana",
    you: false,
    voted: true,
    vote: null,
    theme: "ocean",
    observer: false,
    status: "",
  });
  const forAna = publicState(room, "p1");
  assertEquals(forAna.participants[0], {
    name: "Ana",
    you: true,
    voted: true,
    vote: "5",
    theme: "ocean",
    observer: false,
    status: "",
  });
  assertEquals(forAna.stats, null, "no stats before reveal");
  applyEvent(room, { type: "reveal", at: 9 });
  assertEquals(publicState(room, "p2").participants[0].vote, "5", "visible after reveal");
});

Deno.test("observers join flagged, cannot vote, and are exposed in publicState", () => {
  const room = createRoom();
  applyEvent(room, { type: "join", id: "po", name: "Pat", observer: true, at: 1 });
  applyEvent(room, { type: "join", id: "p1", name: "Ana", at: 2 });
  assertEquals(room.participants["po"].observer, true);
  assertEquals(applyEvent(room, { type: "vote", id: "po", value: "5" }), false, "observer vote");
  assertEquals(publicState(room, "p1").participants[0].observer, true);
});

Deno.test("card theme: defaults on join, validates ids, changes via the theme event", () => {
  const room = createRoom();
  applyEvent(room, { type: "join", id: "a", name: "Ana", theme: "ruby" });
  applyEvent(room, { type: "join", id: "b", name: "Ben", theme: "sparkly-unicorn" });
  assertEquals(room.participants["a"].theme, "ruby", "valid theme kept");
  assertEquals(room.participants["b"].theme, CARD_THEMES[0], "junk falls back to default");
  assertEquals(applyEvent(room, { type: "theme", id: "b", theme: "forest" }), true);
  assertEquals(room.participants["b"].theme, "forest");
  assertEquals(applyEvent(room, { type: "theme", id: "b", theme: "forest" }), false, "no-op");
  assertEquals(applyEvent(room, { type: "theme", id: "b", theme: "neon" }), false, "unknown id");
  assertEquals(applyEvent(room, { type: "theme", id: "ghost", theme: "ruby" }), false, "no player");
  assertEquals(publicState(room, "a").participants[1].theme, "forest", "exposed to everyone");
});

Deno.test("player status: empty by default, set via the status event, validates and clears", () => {
  const room = roomWith("Ana", "Ben"); // p1 = Ana, p2 = Ben
  assertEquals(room.participants["p1"].status, "", "empty by default");
  assertEquals(applyEvent(room, { type: "status", id: "p1", status: "away" }), true);
  assertEquals(room.participants["p1"].status, "away");
  assertEquals(applyEvent(room, { type: "status", id: "p1", status: "away" }), false, "no-op");
  assertEquals(applyEvent(room, { type: "status", id: "p1", status: "napping" }), false, "unknown");
  assertEquals(
    applyEvent(room, { type: "status", id: "ghost", status: "away" }),
    false,
    "no player",
  );
  assertEquals(
    applyEvent(room, { type: "status", id: "p1", status: "" }),
    true,
    "clear back to none",
  );
  assertEquals(room.participants["p1"].status, "");
  assertEquals(
    applyEvent(room, { type: "status", id: "p1", status: "" }),
    false,
    "clear is a no-op",
  );
});

Deno.test("publicState exposes each participant's status", () => {
  const room = roomWith("Ana");
  assertEquals(publicState(room, "p1").participants[0].status, "");
  applyEvent(room, { type: "status", id: "p1", status: "thinking" });
  assertEquals(publicState(room, "p1").participants[0].status, "thinking");
});

Deno.test("STATUSES presets and isAway: away/break/brb pause, thinking stays active", () => {
  assertEquals(STATUSES.map((s) => s.id), ["away", "break", "brb", "thinking"]);
  assertEquals(isAway("away"), true);
  assertEquals(isAway("break"), true);
  assertEquals(isAway("brb"), true);
  assertEquals(isAway("thinking"), false, "present, not away");
  assertEquals(isAway(""), false, "no status is not away");
  assertEquals(isAway("bogus"), false, "unknown id is not away");
});

Deno.test("mergeRooms unions participants and resolves flags last-writer-wins", () => {
  const a = roomWith("Ana");
  const b = createRoom();
  applyEvent(b, { type: "join", id: "q1", name: "Ben", at: 5 });
  applyEvent(b, { type: "story", text: "PROJ-7", at: 50 });
  applyEvent(a, { type: "story", text: "older", at: 10 });
  applyEvent(b, { type: "reveal", at: 60 });
  const merged = mergeRooms(a, [b]);
  assertEquals(Object.keys(merged.participants).sort(), ["p1", "q1"]);
  assertEquals(merged.story, "PROJ-7");
  assertEquals(merged.revealed, true);
  assertEquals(a.revealed, false, "inputs are not modified");
});

Deno.test("generateRoomCode matches the accepted pattern", () => {
  for (let i = 0; i < 100; i++) {
    const code = generateRoomCode();
    assertEquals(CODE_PATTERN.test(code), true, `code ${code}`);
  }
});

Deno.test("sanitizeWheelNames trims, dedupes, drops blanks and caps the list", () => {
  assertEquals(sanitizeWheelNames([" Ana ", "Ben", "Ana", "", "  "]), ["Ana", "Ben"]);
  assertEquals(sanitizeWheelNames("nope"), []);
  const many = sanitizeWheelNames(Array.from({ length: 99 }, (_, i) => `P${i}`));
  assertEquals(many.length, LIMITS.wheelNames);
  assertEquals(sanitizeWheelNames(["x".repeat(99)])[0].length, LIMITS.name);
});

Deno.test("wheel-set replaces the list; identical or empty-on-empty sets are no-ops", () => {
  const room = createRoom();
  assertEquals(applyEvent(room, { type: "wheel-set", names: [], at: 1 }), false, "empty on empty");
  assertEquals(applyEvent(room, { type: "wheel-set", names: ["Ana", "Ben"], at: 2 }), true);
  assertEquals(room.wheelNames, ["Ana", "Ben"]);
  assertEquals(
    applyEvent(room, { type: "wheel-set", names: ["Ana ", "Ben"], at: 3 }),
    false,
    "same after sanitize",
  );
  assertEquals(applyEvent(room, { type: "wheel-set", names: ["Ben"], at: 4 }), true, "remove Ana");
  assertEquals(room.wheelNamesAt, 4);
});

Deno.test("wheel-spin requires a name that is on the wheel", () => {
  const room = createRoom();
  applyEvent(room, { type: "wheel-set", names: ["Ana", "Ben"], at: 1 });
  assertEquals(applyEvent(room, { type: "wheel-spin", winner: "Cid", at: 2 }), false, "not listed");
  assertEquals(applyEvent(room, { type: "wheel-spin", winner: "", at: 3 }), false, "blank");
  assertEquals(applyEvent(room, { type: "wheel-spin", winner: "Ben", at: 4 }), true);
  assertEquals(room.wheelWinner, "Ben");
  assertEquals(room.wheelSpunAt, 4);
  assertEquals(applyEvent(room, { type: "wheel-spin", winner: "Ana", at: 5 }), true, "respin ok");
});

Deno.test("round reset leaves the wheel alone", () => {
  const room = roomWith("Ana");
  applyEvent(room, { type: "wheel-set", names: ["Ana", "Guest"], at: 1 });
  applyEvent(room, { type: "wheel-spin", winner: "Guest", at: 2 });
  applyEvent(room, { type: "reset", at: 3 });
  assertEquals(room.wheelNames, ["Ana", "Guest"]);
  assertEquals(room.wheelWinner, "Guest");
});

Deno.test("publicState exposes the wheel and flips `custom` after the first edit", () => {
  const room = roomWith("Ana");
  assertEquals(publicState(room, "p1").wheel, {
    names: [],
    custom: false,
    winner: null,
    spunAt: 0,
  });
  applyEvent(room, { type: "wheel-set", names: ["Ana", "Ben"], at: 7 });
  applyEvent(room, { type: "wheel-spin", winner: "Ana", at: 8 });
  assertEquals(publicState(room, "p1").wheel, {
    names: ["Ana", "Ben"],
    custom: true,
    winner: "Ana",
    spunAt: 8,
  });
});

Deno.test("sanitizeNotes keeps well-formed notes, sorts by date, caps fields and count", () => {
  const clean = sanitizeNotes([
    { date: "2026-07-20", text: "  later  ", who: " Ana ", at: 5 },
    { date: "2026-07-14", text: "sooner", who: "Ben", at: 9 },
    { date: "2026-07-14", text: "same day, added first", who: "Cid", at: 2 },
    { date: "not-a-date", text: "dropped" },
    { date: "2026-99-99", text: "dropped too" },
    { date: "2026-07-15", text: "   " },
    "junk",
    null,
  ]);
  assertEquals(clean.map((n) => n.text), ["same day, added first", "sooner", "later"]);
  assertEquals(clean[2], { date: "2026-07-20", text: "later", who: "Ana", at: 5 });
  assertEquals(sanitizeNotes("nope"), []);
  const long = sanitizeNotes([{ date: "2026-01-01", text: "x".repeat(999), who: "y".repeat(99) }]);
  assertEquals(long[0].text.length, LIMITS.note);
  assertEquals(long[0].who.length, LIMITS.name);
  const many = sanitizeNotes(
    Array.from({ length: 99 }, (_, i) => ({ date: "2026-01-01", text: `n${i}`, at: i })),
  );
  assertEquals(many.length, LIMITS.notes);
});

Deno.test("notes-set replaces the list; identical sets are no-ops; reset leaves notes", () => {
  const room = roomWith("Ana");
  assertEquals(applyEvent(room, { type: "notes-set", notes: [], at: 1 }), false, "empty on empty");
  const note = { date: "2026-07-14", text: "Sam on PTO", who: "Ana", at: 3 };
  assertEquals(applyEvent(room, { type: "notes-set", notes: [note], at: 4 }), true);
  assertEquals(room.notesAt, 4);
  assertEquals(
    applyEvent(room, { type: "notes-set", notes: [{ ...note, text: " Sam on PTO " }], at: 5 }),
    false,
    "same after sanitize",
  );
  applyEvent(room, { type: "reset", at: 6 });
  assertEquals(room.notes.length, 1, "notes survive a new round");
  assertEquals(applyEvent(room, { type: "notes-set", notes: [], at: 7 }), true, "deliberate clear");
  assertEquals(room.notes, []);
});

Deno.test("only the author can remove their note; author-less notes are anyone's", () => {
  const room = roomWith("Ana", "Ben"); // p1 = Ana, p2 = Ben
  const anas = { date: "2026-07-14", text: "mine", who: "Ana", at: 1 };
  const bens = { date: "2026-07-15", text: "his", who: "Ben", at: 2 };
  applyEvent(room, { type: "notes-set", notes: [anas, bens], at: 3, id: "p1" });
  assertEquals(
    applyEvent(room, { type: "notes-set", notes: [anas], at: 4, id: "p1" }),
    false,
    "Ana cannot drop Ben's note",
  );
  assertEquals(
    applyEvent(room, { type: "notes-set", notes: [bens], at: 5, id: "p1" }),
    true,
    "Ana drops her own note",
  );
  assertEquals(
    applyEvent(room, { type: "notes-set", notes: [], at: 6, id: "ghost" }),
    false,
    "unknown editors cannot edit at all",
  );
  assertEquals(
    applyEvent(room, { type: "notes-set", notes: [], at: 7, id: "p2" }),
    true,
    "Ben clears his own note",
  );
  applyEvent(room, {
    type: "notes-set",
    notes: [{ date: "2026-07-16", text: "anon" }],
    id: "p1",
    at: 8,
  });
  assertEquals(
    applyEvent(room, { type: "notes-set", notes: [], at: 9, id: "p2" }),
    true,
    "author-less notes are removable by anyone",
  );
});

Deno.test("publicState exposes notes with the edit timestamp", () => {
  const room = roomWith("Ana");
  assertEquals(publicState(room, "p1").notes, { list: [], at: 0 });
  const note = { date: "2026-07-14", text: "split the epic", who: "Ana", at: 2 };
  applyEvent(room, { type: "notes-set", notes: [note], at: 9 });
  assertEquals(publicState(room, "p1").notes, { list: [note], at: 9 });
});

Deno.test("mergeRooms resolves notes last-writer-wins", () => {
  const a = createRoom();
  const b = createRoom();
  applyEvent(a, { type: "notes-set", notes: [{ date: "2026-07-01", text: "old" }], at: 10 });
  applyEvent(b, { type: "notes-set", notes: [{ date: "2026-07-02", text: "new" }], at: 20 });
  const merged = mergeRooms(a, [b]);
  assertEquals(merged.notes.map((n) => n.text), ["new"], "newer list wins");
  assertEquals(merged.notesAt, 20);
  assertEquals(a.notes.map((n) => n.text), ["old"], "inputs are not modified");
});

Deno.test("mergeRooms resolves wheel list and spin last-writer-wins", () => {
  const a = createRoom();
  const b = createRoom();
  applyEvent(a, { type: "wheel-set", names: ["Old"], at: 10 });
  applyEvent(b, { type: "wheel-set", names: ["New", "List"], at: 20 });
  applyEvent(a, { type: "wheel-spin", winner: "Old", at: 30 });
  const merged = mergeRooms(a, [b]);
  assertEquals(merged.wheelNames, ["New", "List"], "newer list wins");
  assertEquals(merged.wheelWinner, "Old", "newer spin wins");
  assertEquals(merged.wheelSpunAt, 30);
});
