/**
 * meso.poker -> Google Sheets: room lifecycle sync.
 *
 * Google Apps Script, run on a time trigger from your own Drive. It polls
 * GET /api/poker/stats and keeps one row per room session in a Sheet, which is
 * what turns the server's rolling 7-day window into a permanent log: the
 * endpoint forgets a session 7 days after it started, the Sheet does not.
 *
 * Nothing here needs credentials on the server side — the poker service only
 * ever answers a bearer-token GET, and this script lives in the Drive that owns
 * the Sheet. It logs room lifecycle only: codes, timings and head counts, no
 * participant names, so the Sheet holds no personal data.
 *
 * Setup, once:
 *   1. sheets.new, then Extensions -> Apps Script, and paste this file in.
 *   2. Project Settings -> Script properties, add:
 *        MESO_POKER_STATS_TOKEN = the same value as STATS_TOKEN on the server
 *      (Script properties, not the source, so the token stays out of the code.)
 *   3. Edit ENDPOINT below if you are not pointing at the Render deployment.
 *   4. Run installTrigger() once, and approve the two scopes it asks for
 *      (external fetch + this spreadsheet). syncMesoPokerRooms() then runs
 *      every 10 minutes.
 *
 * Why 10 minutes: it has to beat the shortest window in which a session can be
 * lost. On Render's free plan the instance spins down after ~15 minutes idle and
 * its stats database goes with it, so a slower poll would silently miss rooms.
 * Polling every 10 minutes also keeps the instance awake, which is what stops
 * that spin-down happening at all. Two consequences worth knowing: the service
 * then runs ~730 instance-hours a month, which is most of the free tier's 750,
 * and on Deno Deploy (managed, durable KV) none of this applies — an hourly or
 * daily trigger is plenty there.
 */

/** The deployment to poll. */
const ENDPOINT = "https://meso-poker.onrender.com/api/poker/stats";
/** Tab to write into; created on first run. */
const SHEET_NAME = "Rooms";
/** Script property holding the bearer token (never the token itself). */
const TOKEN_PROPERTY = "MESO_POKER_STATS_TOKEN";

const HEADERS = [
  "code",
  "createdAt",
  "destroyedAt",
  "live",
  "minutes",
  "participants",
  "peakParticipants",
  "lastSeenAt",
  "syncedAt",
];

/**
 * Poll the endpoint and reconcile the Sheet. Safe to run as often as you like:
 * rows are keyed on the room session, so re-seeing a room updates it instead of
 * duplicating it.
 */
function syncMesoPokerRooms() {
  const token = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY);
  if (!token) {
    throw new Error(
      "Missing " + TOKEN_PROPERTY + " — add it under Project Settings -> Script properties.",
    );
  }

  const response = UrlFetchApp.fetch(ENDPOINT, {
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status !== 200) {
    // 401 the token here is wrong; 404 STATS_TOKEN is unset on the server, so
    // the route does not exist; 503 the server started without --unstable-kv.
    throw new Error(
      "meso.poker stats returned " + status + ": " + response.getContentText().slice(0, 200),
    );
  }

  const payload = JSON.parse(response.getContentText());
  const rooms = payload.rooms || [];
  const sheet = openSheet_();
  const rows = readRows_(sheet);

  // A room code is reused across meetings, so identity is the code plus its
  // start time — the same pair the server keys its own records on. Keying on the
  // code alone would collapse every future meeting into one row.
  const rowByKey = {};
  for (let i = 0; i < rows.length; i++) {
    rowByKey[keyOf_(rows[i][0], rows[i][1])] = i;
  }

  const syncedAt = new Date().toISOString();
  const added = [];
  let updated = 0;

  for (const room of rooms) {
    const row = toRow_(room, syncedAt);
    const key = keyOf_(room.code, room.createdAt);
    const at = rowByKey[key];
    if (at === undefined) {
      rowByKey[key] = rows.length + added.length;
      added.push(row);
    } else if (!sameRow_(rows[at], row)) {
      // Typically a room first seen live and now closed: destroyedAt, the final
      // duration and the peak all land on the existing row.
      rows[at] = row;
      updated++;
    }
  }

  const all = rows.concat(added);
  if (all.length) {
    // One read and one write per run: appendRow per room would burn through the
    // Apps Script quota for no reason.
    sheet.getRange(2, 1, all.length, HEADERS.length).setValues(all);
  }

  console.log(
    "meso.poker sync: " + rooms.length + " in window, " + added.length + " new, " +
      updated + " updated, " + payload.liveNow + " live now",
  );
}

/** Install (or replace) the 10-minute trigger. Run once, by hand. */
function installTrigger() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "syncMesoPokerRooms") {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  ScriptApp.newTrigger("syncMesoPokerRooms").timeBased().everyMinutes(10).create();
  console.log("Trigger installed: syncMesoPokerRooms every 10 minutes.");
}

/* -------------------------------- helpers -------------------------------- */

/** The tab, created with a frozen, text-formatted header on first run. */
function openSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (sheet) return sheet;

  sheet = book.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  // Plain text for every cell, so ISO timestamps come back as the strings they
  // went in as. Left as dates, Sheets would reformat them and the session keys
  // would stop matching on the next run.
  sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat("@");
  return sheet;
}

/** Existing data rows, header excluded. */
function readRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
}

function toRow_(room, syncedAt) {
  return [
    room.code,
    room.createdAt,
    room.destroyedAt === null ? "" : room.destroyedAt,
    room.live ? "TRUE" : "FALSE",
    room.minutes,
    room.participants,
    room.peakParticipants,
    room.lastSeenAt,
    syncedAt,
  ];
}

function keyOf_(code, createdAt) {
  return String(code) + "|" + sessionStamp_(createdAt);
}

/**
 * A start time reduced to whole seconds, which is what makes the key survive the
 * round trip through a Sheet. Cells in a tab that was not text-formatted (an
 * older tab, or one edited by hand) come back as Date objects, and Sheets may
 * have dropped the milliseconds on the way — matching on the full ISO string
 * would then miss and duplicate the row on every single poll. Whole seconds are
 * still unique per code: a session cannot restart until the room has been
 * created, emptied and reaped, which takes minutes.
 */
function sessionStamp_(value) {
  const iso = value instanceof Date
    ? value.toISOString()
    : String(value === null || value === undefined ? "" : value);
  return iso.replace(/\.\d+(?=Z?$)/, "");
}

/** Compare ignoring syncedAt, so an unchanged room is not rewritten each run. */
function sameRow_(a, b) {
  for (let i = 0; i < HEADERS.length - 1; i++) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}
