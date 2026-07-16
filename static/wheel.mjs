// Fair-play weighting for the random-picker wheel. Kept as a small, pure,
// DOM-free module so it can be unit-tested; the client (poker.js) owns the
// in-memory pickCounts map (client-local, resets on reload).

/**
 * Pick a name at random, weighted by 0.5^(times already picked this round), so
 * recently-picked names are less likely but never impossible.
 * @param {string[]} names non-empty list of wheel names
 * @param {Map<string, number>} pickCounts name -> times picked since last reset
 * @param {() => number} [rng] source of [0,1) randomness (injectable for tests)
 * @returns {string}
 */
export function weightedPick(names, pickCounts, rng = Math.random) {
  const weights = names.map((n) => Math.pow(0.5, pickCounts.get(n) ?? 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < names.length; i++) {
    if ((r -= weights[i]) < 0) return names[i];
  }
  return names[names.length - 1]; // float-rounding safety
}

/**
 * Record that `winner` was picked. Once every name currently on the wheel has
 * been picked at least once, the round resets so all names return to full odds.
 * Mutates `pickCounts` in place.
 * @param {Map<string, number>} pickCounts
 * @param {string} winner
 * @param {string[]} names current wheel names
 */
export function notePick(pickCounts, winner, names) {
  pickCounts.set(winner, (pickCounts.get(winner) ?? 0) + 1);
  if (names.every((n) => (pickCounts.get(n) ?? 0) >= 1)) pickCounts.clear();
}
