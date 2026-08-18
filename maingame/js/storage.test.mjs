import test from "node:test";
import assert from "node:assert/strict";
import { isValidFen, normalizeFen, validateBackup } from "./storage.mjs";

const startingFen = "7k/8/8/8/8/8/8/K7 w - - 0 1";

test("validates and normalizes FEN values", () => {
  assert.equal(isValidFen(startingFen), true);
  assert.equal(isValidFen("not a fen"), false);
  assert.equal(normalizeFen("  7k/8/8/8/8/8/8/K7   w - - 0 1 "), startingFen);
});

test("validates a backup and discards malformed records", () => {
  const backup = validateBackup({
    format: "ultra-fischer-backup",
    version: 1,
    games: [{ id: "game_1", startingFen, currentFen: startingFen, moves: [], status: "in_progress" }],
    savedPositions: [{ id: "position_1", fen: startingFen }],
    preferences: { theme: "light" },
  });
  assert.equal(backup.games.length, 1);
  assert.equal(backup.games[0].label, "Game");
  assert.equal(backup.savedPositions.length, 1);
  assert.equal(backup.preferences.theme, "light");
  assert.equal(backup.preferences.moveAnimation, "slide");
  assert.throws(() => validateBackup({ format: "other", version: 1, games: [], savedPositions: [] }));
});

test("keeps terminated games distinct from completed results and accepts favorite-game backups", () => {
  const backup = validateBackup({
    format: "Ultra_Fischer-backup",
    version: 1,
    games: [{ id: "game_terminated", startingFen, currentFen: startingFen, moves: [], status: "terminated", termination: "new_game" }],
    favoriteGames: [{ id: "game_terminated", startingFen, currentFen: startingFen, moves: [], status: "terminated", termination: "new_game", isFavorite: true }],
    preferences: {},
  });
  assert.equal(backup.games[0].status, "terminated");
  assert.equal(backup.games[0].result, null);
  assert.equal(backup.favoriteGames[0].isFavorite, true);
  assert.equal(backup.savedPositions.length, 0);
});
