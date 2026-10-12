import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import {
  isValidFen,
  MAX_POSITION_BALANCE_CP,
  MIN_POSITION_BALANCE_CP,
  normalizeFen,
  normalizePositionBalance,
  validateBackup,
  createGame,
  getGame,
  listGames,
  listGamesPage,
  clearGames,
  saveGameProgress,
  setGameFavorite,
  renameGame,
  deleteGame,
  importBackup,
  getPreferences,
  getStatistics,
} from "./storage.mjs";

const startingFen = "7k/8/8/8/8/8/8/K7 w - - 0 1";
const preferences = new Map();
globalThis.localStorage = {
  getItem: (key) => preferences.get(key) ?? null,
  setItem: (key, value) => preferences.set(key, String(value)),
  removeItem: (key) => preferences.delete(key),
};

test("validates and normalizes FEN values", () => {
  assert.equal(isValidFen(startingFen), true);
  assert.equal(isValidFen("not a fen"), false);
  assert.equal(normalizeFen("  7k/8/8/8/8/8/8/K7   w - - 0 1 "), startingFen);
});

test("keeps the starting balance setting within the supported range", () => {
  assert.equal(normalizePositionBalance(100), MIN_POSITION_BALANCE_CP);
  assert.equal(normalizePositionBalance(375), 375);
  assert.equal(normalizePositionBalance("not a number"), MIN_POSITION_BALANCE_CP);
  assert.equal(normalizePositionBalance(MAX_POSITION_BALANCE_CP + 1), MAX_POSITION_BALANCE_CP);
});

test("validates legacy backups without silently discarding records", () => {
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
  assert.equal(backup.preferences.positionBalanceCp, MIN_POSITION_BALANCE_CP);
  assert.equal(backup.preferences.friendlyMode, true);
  assert.throws(() => validateBackup({ format: "other", version: 1, games: [], savedPositions: [] }));
});

test("rejects missing kings, adjacent kings, edge-rank pawns, and invalid counters", () => {
  for (const fen of [
    "8/8/8/8/8/8/8/8 w - - 0 1",
    "8/8/8/8/8/8/k7/K7 w - - 0 1",
    "P6k/8/8/8/8/8/8/K7 w - - 0 1",
    startingFen.replace("0 1", "-1 1"),
    startingFen.replace("0 1", "0 0"),
  ]) assert.equal(isValidFen(fen), false, fen);
});

test("invalid replacement backups leave existing games untouched", async () => {
  await clearGames();
  await createGame({ id: "protected", startingFen, moves: [] });
  for (const record of [
    { startingFen: "8/8/8/8/8/8/8/8 w - - 0 1", moves: [] },
    { startingFen, moves: ["Qxg7"] },
    { startingFen, moves: [], currentFen: startingFen.replace(" w ", " b ") },
  ]) {
    await assert.rejects(importBackup({ format: "Ultra_Fischer-backup", version: 1, games: [record], favoriteGames: [] }, "replace"));
    assert.equal((await getGame("protected")).id, "protected");
  }
});

test("replacement rolls back all records and preferences if a write fails", async () => {
  await clearGames();
  await createGame({ id: "protected", startingFen, moves: [] });
  const before = await getPreferences();
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (record) {
    if (record.id === "fail") throw new DOMException("Quota exhausted", "QuotaExceededError");
    return original.call(this, record);
  };
  try {
    await assert.rejects(importBackup({
      format: "Ultra_Fischer-backup", version: 1,
      games: [{ id: "first", startingFen, moves: [] }, { id: "fail", startingFen, moves: [] }],
      favoriteGames: [], preferences: { theme: "blue" },
    }, "replace"), /existing games were not replaced/);
  } finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual((await listGames()).map((game) => game.id), ["protected"]);
  assert.deepEqual(await getPreferences(), before);
});

test("indexed history pagination has no duplicates when timestamps tie", async () => {
  await clearGames();
  for (let index = 0; index < 53; index += 1) {
    await createGame({ id: String(index).padStart(3, "0"), startingFen, moves: [], updatedAt: 1000, isFavorite: index % 2 === 0 });
  }
  const first = await listGamesPage({ limit: 50 });
  const second = await listGamesPage({ limit: 50, after: first.nextCursor });
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 3);
  assert.equal(new Set([...first.items, ...second.items].map((game) => game.id)).size, 53);
  const favorites = await listGamesPage({ filter: "favorite" });
  assert.equal(favorites.items.length, 27);
});

test("autosaves preserve archive edits and never resurrect deleted records", async () => {
  await clearGames();
  const game = await createGame({ id: "active", startingFen, moves: [], isFavorite: true });
  await renameGame(game.id, "Renamed");
  await setGameFavorite(game.id, false);
  const saved = await saveGameProgress(game);
  assert.equal(saved.label, "Renamed");
  assert.equal(saved.isFavorite, false);
  await deleteGame(game.id);
  await assert.rejects(saveGameProgress(saved), (error) => error.code === "GAME_CONFLICT");
  assert.equal(await getGame(game.id), undefined);
});

test("stale tabs cannot overwrite newer game progress or terminal results", async () => {
  await clearGames();
  const first = await createGame({ id: "shared", startingFen, moves: [] });
  const latest = await saveGameProgress({ ...first, moves: ["Ka2"], status: "completed", result: "draw" });
  await assert.rejects(saveGameProgress({ ...first, moves: ["Kb1"] }), (error) => error.code === "GAME_CONFLICT");
  assert.deepEqual(await getGame(first.id), latest);
});

test("merging a backup invalidates old writers without invalidating unrelated games", async () => {
  await clearGames();
  const overwritten = await createGame({ id: "overwritten", startingFen, moves: [] });
  const unrelated = await createGame({ id: "unrelated", startingFen, moves: [] });
  await importBackup({ format: "Ultra_Fischer-backup", version: 1, games: [overwritten], favoriteGames: [] });
  assert.equal((await getGame(overwritten.id)).revision, overwritten.revision + 1);
  await assert.rejects(saveGameProgress(overwritten), (error) => error.code === "GAME_CONFLICT");
  assert.equal((await saveGameProgress(unrelated)).revision, unrelated.revision + 1);
});

test("deleting and reimporting the same ID cannot revive an old writer", async () => {
  await clearGames();
  const old = await createGame({ id: "reimported", startingFen, moves: [] });
  await deleteGame(old.id);
  await importBackup({ format: "Ultra_Fischer-backup", version: 1, games: [old], favoriteGames: [] });
  const imported = await getGame(old.id);
  assert.equal(imported.revision, old.revision);
  assert.notEqual(imported.generation, old.generation);
  await assert.rejects(saveGameProgress(old), (error) => error.code === "GAME_CONFLICT");
});

test("mixed difficulty games have their own statistics bucket", async () => {
  await clearGames();
  await createGame({ id: "mixed", startingFen, moves: ["Ka2", "Kh7"], stockfishLevel: 8,
    levelHistory: [{ ply: 0, level: 4 }, { ply: 1, level: 8 }], status: "completed", result: "win" });
  const stats = await getStatistics();
  assert.equal(stats.levels.mixed.wins, 1);
  assert.equal(stats.levels[8], undefined);
});

test("AI statistics exclude local PvP records", async () => {
  await clearGames();
  await createGame({ id: "local", startingFen, mode: "pvp", status: "completed", result: "win" });
  await createGame({ id: "ai", startingFen, mode: "pvai", status: "completed", result: "loss" });
  const stats = await getStatistics();
  assert.equal(stats.total, 1);
  assert.equal(stats.wins, 0);
  assert.equal(stats.losses, 1);
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
