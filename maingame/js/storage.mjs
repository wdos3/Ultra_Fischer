import { isValidChessFen, replayGame, resultCode } from "./chess-rules.mjs";
import { GameConflictError } from "./game-errors.mjs";
import { normalizeLevelHistory, statisticsLevel } from "./game-difficulty.mjs";

const DB_NAME = "Ultra_Fischer";
const LEGACY_DB_NAME = "ultra-fischer";
const DB_VERSION = 3;
const PREFERENCES_KEY = "Ultra_Fischer.preferences";
const POSITION_POOL_KEY = "Ultra_Fischer.position-pool";
const LEGACY_PREFERENCES_KEY = "ultraFischer.preferences";
const BACKUP_FORMAT = "Ultra_Fischer-backup";
const LEGACY_BACKUP_FORMAT = "ultra-fischer-backup";
const BACKUP_VERSION = 1;
const MIN_POSITION_BALANCE_CP = 150;
const MAX_POSITION_BALANCE_CP = 2000;
const SUPPORTED_THEMES = ["dark", "light", "slate", "forest", "blue"];

const DEFAULT_PREFERENCES = Object.freeze({
  aiStrength: "4",
  evalVisible: false,
  evalVisibilityConfigured: false,
  friendlyMode: true,
  moveAnimation: "slide",
  positionBalanceCp: MIN_POSITION_BALANCE_CP,
  requestedColor: "w",
  settingsOpen: false,
  theme: "dark",
});

let databasePromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction was aborted.")), { once: true });
  });
}

function makeId(prefix = "item") {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  const random = globalThis.crypto?.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).map((value) => value.toString(16)).join("")
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

function normalizeFen(fen) {
  return String(fen || "").trim().replace(/\s+/g, " ");
}

function normalizeMoveAnimation(value) {
  return value === "instant" ? "instant" : "slide";
}

function normalizePositionBalance(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return MIN_POSITION_BALANCE_CP;
  }
  return Math.round(Math.min(MAX_POSITION_BALANCE_CP, Math.max(MIN_POSITION_BALANCE_CP, numeric)));
}

function normalizePreferences(preferences = {}) {
  const source = { ...DEFAULT_PREFERENCES, ...preferences };
  return {
    aiStrength: /^[1-8]$/.test(String(source.aiStrength)) ? String(source.aiStrength) : DEFAULT_PREFERENCES.aiStrength,
    evalVisible: Boolean(source.evalVisible),
    evalVisibilityConfigured: Boolean(source.evalVisibilityConfigured),
    friendlyMode: source.friendlyMode === true || source.friendlyMode === "true",
    moveAnimation: normalizeMoveAnimation(source.moveAnimation),
    positionBalanceCp: normalizePositionBalance(source.positionBalanceCp),
    requestedColor: ["w", "b", "random"].includes(source.requestedColor) ? source.requestedColor : DEFAULT_PREFERENCES.requestedColor,
    settingsOpen: Boolean(source.settingsOpen),
    theme: SUPPORTED_THEMES.includes(source.theme) ? source.theme : DEFAULT_PREFERENCES.theme,
  };
}

export function isValidFen(fen) {
  return isValidChessFen(normalizeFen(fen));
}

function configureObjectStores(database, transaction) {
  const games = database.objectStoreNames.contains("games")
    ? transaction.objectStore("games")
    : database.createObjectStore("games", { keyPath: "id" });
  for (const index of ["startedAt", "updatedAt", "status", "isFavorite", "stockfishLevel", "playerColor"]) {
    if (!games.indexNames.contains(index)) {
      games.createIndex(index, index, { unique: false });
    }
  }
  for (const [name, keyPath] of Object.entries({
    updatedAtId: ["updatedAt", "id"],
    statusUpdated: ["status", "updatedAt", "id"],
    resultUpdated: ["result", "updatedAt", "id"],
    favoriteUpdated: ["favoriteKey", "updatedAt", "id"],
  })) {
    if (!games.indexNames.contains(name)) games.createIndex(name, keyPath);
  }
  const cursor = games.openCursor();
  cursor.addEventListener("success", () => {
    if (!cursor.result) return;
    cursor.result.update({ ...cursor.result.value, mode: cursor.result.value.mode || "pvai", favoriteKey: cursor.result.value.isFavorite ? 1 : 0 });
    cursor.result.continue();
  });
  const positions = database.objectStoreNames.contains("savedPositions")
    ? transaction.objectStore("savedPositions")
    : database.createObjectStore("savedPositions", { keyPath: "id" });
  for (const index of ["createdAt", "fen"]) {
    if (!positions.indexNames.contains(index)) {
      positions.createIndex(index, index, { unique: false });
    }
  }
  if (!database.objectStoreNames.contains("meta")) {
    database.createObjectStore("meta", { keyPath: "id" });
  }
}

function openNamedDatabase(name, version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.addEventListener("upgradeneeded", () => configureObjectStores(request.result, request.transaction));
    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => { database.close(); databasePromise = null; });
      resolve(database);
    }, { once: true });
    request.addEventListener("error", () => reject(request.error || new Error(`Could not open ${name} storage.`)), { once: true });
  });
}

function readStore(database, storeName) {
  if (!database.objectStoreNames.contains(storeName)) {
    return Promise.resolve([]);
  }
  const transaction = database.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).getAll());
}

async function migrateLegacyDatabase(database) {
  if (!database.objectStoreNames.contains("meta")) {
    return;
  }
  const metaTransaction = database.transaction("meta", "readonly");
  const marker = await requestToPromise(metaTransaction.objectStore("meta").get("legacy-migrated"));
  if (marker) {
    return;
  }

  let legacyDatabase = null;
  try {
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    if (!databases.some((entry) => entry.name === LEGACY_DB_NAME)) {
      return;
    }
    legacyDatabase = await openNamedDatabase(LEGACY_DB_NAME, 1);
    const [games, positions] = await Promise.all([
      readStore(legacyDatabase, "games"),
      readStore(legacyDatabase, "savedPositions"),
    ]);
    const transaction = database.transaction(["games", "savedPositions", "meta"], "readwrite");
    games.forEach((game) => transaction.objectStore("games").put({ ...game, ...cleanGame(game) }));
    positions.forEach((position) => transaction.objectStore("savedPositions").put(position));
    transaction.objectStore("meta").put({ id: "legacy-migrated", migratedAt: Date.now() });
    await transactionToPromise(transaction);
  } catch (error) {
    console.warn("Legacy local data could not be migrated.", error);
  } finally {
    legacyDatabase?.close();
  }
}

function openDatabase() {
  if (databasePromise) {
    return databasePromise;
  }
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  }
  databasePromise = openNamedDatabase(DB_NAME, DB_VERSION).then(async (database) => {
    await migrateLegacyDatabase(database);
    return database;
  }).catch((error) => { databasePromise = null; throw error; });
  return databasePromise;
}

async function withStore(storeName, mode, callback) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, mode);
  const completion = transactionToPromise(transaction);
  completion.catch(() => null);
  try {
    const result = await callback(transaction.objectStore(storeName), transaction);
    await completion;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* An already-finished transaction cannot be aborted. */ }
    await completion.catch(() => null);
    throw error;
  }
}

function readPreferences() {
  try {
    const currentRaw = localStorage.getItem(PREFERENCES_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_PREFERENCES_KEY);
    const raw = currentRaw || legacyRaw;
    if (raw) {
      const storedPreferences = JSON.parse(raw);
      const preferences = normalizePreferences(storedPreferences);
      if (!Object.prototype.hasOwnProperty.call(storedPreferences, "evalVisibilityConfigured")) {
        preferences.evalVisible = false;
      }
      if (!currentRaw) {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
      }
      return preferences;
    }
    const legacy = {
      aiStrength: localStorage.getItem("ultra-fischer-ai-strength"),
      moveAnimation: localStorage.getItem("ultra-fischer-move-animation"),
      requestedColor: localStorage.getItem("ultra-fischer-requested-color"),
      settingsOpen: localStorage.getItem("ultra-fischer-settings-open"),
      theme: localStorage.getItem("ultra-fischer-theme"),
    };
    const migrated = normalizePreferences({
      ...DEFAULT_PREFERENCES,
      ...(legacy.aiStrength ? { aiStrength: legacy.aiStrength } : {}),
      ...(legacy.moveAnimation ? { moveAnimation: normalizeMoveAnimation(legacy.moveAnimation) } : {}),
      ...(legacy.requestedColor ? { requestedColor: legacy.requestedColor } : {}),
      ...(legacy.settingsOpen ? { settingsOpen: legacy.settingsOpen === "true" } : {}),
      ...(legacy.theme ? { theme: legacy.theme } : {}),
    });
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(migrated));
    return migrated;
  } catch (error) {
    console.warn("Local preferences are unavailable.", error);
    return normalizePreferences(DEFAULT_PREFERENCES);
  }
}

export function getPreferences() {
  return Promise.resolve(readPreferences());
}

export function savePreferences(preferences) {
  const next = normalizePreferences(preferences);
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  } catch (error) {
    throw new Error("Preferences could not be saved in this browser.", { cause: error });
  }
  return Promise.resolve(next);
}

export function resetPreferences() {
  try {
    localStorage.removeItem(PREFERENCES_KEY);
    localStorage.removeItem(LEGACY_PREFERENCES_KEY);
    localStorage.removeItem(POSITION_POOL_KEY);
    for (const key of ["ultra-fischer-ai-strength", "ultra-fischer-eval-visible", "ultra-fischer-move-animation", "ultra-fischer-position-balance", "ultra-fischer-position-depth", "ultra-fischer-requested-color", "ultra-fischer-settings-open", "ultra-fischer-theme"]) {
      localStorage.removeItem(key);
    }
  } catch (error) {
    throw new Error("Preferences could not be reset.", { cause: error });
  }
  return Promise.resolve({ ...DEFAULT_PREFERENCES });
}

function cleanPositionPoolCandidate(candidate) {
  if (!candidate || !["w", "b"].includes(candidate.sideToMove) || typeof candidate.settingsKey !== "string" || !isValidFen(candidate.fen)) {
    return null;
  }
  const score = candidate.score && ["cp", "mate"].includes(candidate.score.type) && Number.isFinite(Number(candidate.score.value))
    ? { type: candidate.score.type, value: Number(candidate.score.value), depth: Number(candidate.score.depth) || 0 }
    : null;
  return { fen: normalizeFen(candidate.fen), score, alternatives: Array.isArray(candidate.alternatives) ? candidate.alternatives.slice(0, 4) : [], settingsKey: candidate.settingsKey, sideToMove: candidate.sideToMove };
}

export function loadPositionPool() {
  try {
    const stored = JSON.parse(localStorage.getItem(POSITION_POOL_KEY) || "[]");
    return Promise.resolve(Array.isArray(stored) ? stored.map(cleanPositionPoolCandidate).filter(Boolean) : []);
  } catch (error) {
    console.warn("Saved position cache is unavailable.", error);
    return Promise.resolve([]);
  }
}

export function savePositionPool(candidates) {
  const cleanCandidates = (Array.isArray(candidates) ? candidates : [])
    .map(cleanPositionPoolCandidate)
    .filter(Boolean)
    .slice(0, 2);
  try {
    localStorage.setItem(POSITION_POOL_KEY, JSON.stringify(cleanCandidates));
  } catch (error) {
    console.warn("Saved position cache could not be updated.", error);
  }
  return Promise.resolve(cleanCandidates);
}

function cleanGame(record) {
  const now = Date.now();
  const status = ["completed", "terminated"].includes(record.status) ? record.status : "in_progress";
  const level = Math.round(Math.max(1, Math.min(8, Number(record.stockfishLevel) || 4)));
  const moveCount = Array.isArray(record.moves) ? record.moves.length : 0;
  return {
    id: String(record.id || makeId("game")),
    revision: Number.isSafeInteger(record.revision) && record.revision >= 0 ? record.revision : 0,
    generation: typeof record.generation === "string" ? record.generation : null,
    label: String(record.label || "Game").slice(0, 120),
    startingFen: normalizeFen(record.startingFen),
    currentFen: normalizeFen(record.currentFen || record.startingFen),
    mode: record.mode === "pvp" ? "pvp" : "pvai",
    playerColor: record.playerColor === "b" ? "b" : "w",
    engineColor: record.engineColor === "w" ? "w" : "b",
    stockfishLevel: level,
    levelHistory: normalizeLevelHistory(record.levelHistory, level, moveCount),
    status,
    result: status === "completed" && ["win", "draw", "loss"].includes(record.result) ? record.result : null,
    termination: typeof record.termination === "string" ? record.termination.slice(0, 120) : null,
    moves: Array.isArray(record.moves) ? record.moves.map((move) => String(move)).slice(0, 1000) : [],
    pgn: String(record.pgn || "").slice(0, 100000),
    isFavorite: Boolean(record.isFavorite),
    favoriteKey: record.isFavorite ? 1 : 0,
    startedAt: normalizeTimestamp(record.startedAt, now),
    updatedAt: normalizeTimestamp(record.updatedAt, now),
    finishedAt: ["completed", "terminated"].includes(status) ? normalizeTimestamp(record.finishedAt, now) : null,
    initialEvaluation: record.initialEvaluation || null,
    finalEvaluation: record.finalEvaluation || null,
    moveCount,
  };
}

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8640000000000000 ? timestamp : fallback;
}

export async function createGame(record) {
  const game = cleanGame({ ...record, revision: 1, generation: makeId("generation") });
  await withStore("games", "readwrite", (store) => requestToPromise(store.add(game)));
  return game;
}

export async function updateGame(record) {
  return saveGameProgress(record);
}

export async function saveGameProgress(record) {
  return withStore("games", "readwrite", async (store) => {
    const existing = await requestToPromise(store.get(record.id));
    if (!existing) throw new GameConflictError("This game was removed. Resume another saved game or start a new game.");
    if ((existing.revision || 0) !== (record.revision || 0) || (existing.generation || null) !== (record.generation || null)) throw new GameConflictError();
    const outcome = existing.status !== "in_progress" ? { status: existing.status, result: existing.result, termination: existing.termination, finishedAt: existing.finishedAt } : {};
    const next = cleanGame({ ...record, ...outcome, revision: (existing.revision || 0) + 1, label: existing.label, isFavorite: existing.isFavorite });
    await requestToPromise(store.put(next));
    return next;
  });
}

export async function listGamesPage({ filter = "all", sort = "newest", after = null, limit = 50 } = {}) {
  const size = Math.max(1, Math.min(100, limit));
  const prefix = filter === "favorite" ? 1 : filter;
  const name = filter === "all" ? "updatedAtId" : filter === "favorite" ? "favoriteUpdated"
    : ["in_progress", "terminated", "completed"].includes(filter) ? "statusUpdated" : "resultUpdated";
  const lower = name === "updatedAtId" ? [0, ""] : [prefix, 0, ""];
  const upper = name === "updatedAtId" ? [Number.MAX_SAFE_INTEGER, []] : [prefix, Number.MAX_SAFE_INTEGER, []];
  const ascending = sort === "oldest";
  const range = IDBKeyRange.bound(ascending && after ? after : lower, !ascending && after ? after : upper, Boolean(ascending && after), Boolean(!ascending && after));
  return withStore("games", "readonly", (store) => new Promise((resolve, reject) => {
    const items = [];
    let lastKey = null;
    const request = store.index(name).openCursor(range, ascending ? "next" : "prev");
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || items.length === size) {
        resolve({ items, nextCursor: cursor ? lastKey : null });
        return;
      }
      items.push(cursor.value);
      lastKey = cursor.key;
      cursor.continue();
    });
  }));
}

export async function getGame(id) {
  return withStore("games", "readonly", (store) => requestToPromise(store.get(id)));
}

export async function listGames({ status = "all", favorite = false, sort = "newest" } = {}) {
  const games = await withStore("games", "readonly", (store) => requestToPromise(store.getAll()));
  return games
    .filter((game) => status === "all" || game.status === status)
    .filter((game) => !favorite || game.isFavorite)
    .sort((a, b) => (sort === "oldest" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
}

export async function setGameFavorite(id, isFavorite) {
  return patchGameMetadata(id, { isFavorite: Boolean(isFavorite) });
}

async function patchGameMetadata(id, patch) {
  return withStore("games", "readwrite", async (store) => {
    const existing = await requestToPromise(store.get(id));
    if (!existing) return null;
    const next = cleanGame({ ...existing, ...patch, updatedAt: Date.now() });
    await requestToPromise(store.put(next));
    return next;
  });
}

export async function listFavoriteGames({ sort = "newest" } = {}) {
  return listGames({ favorite: true, sort });
}

export async function clearGameFavorites() {
  const favorites = await listFavoriteGames();
  await Promise.all(favorites.map((game) => setGameFavorite(game.id, false)));
  return favorites.length;
}

export async function renameGame(id, label) {
  return patchGameMetadata(id, { label: String(label || "Game").trim().slice(0, 120) || "Game" });
}

export async function deleteGame(id) {
  return withStore("games", "readwrite", (store) => requestToPromise(store.delete(id)));
}

export async function clearGames() {
  return withStore("games", "readwrite", (store) => requestToPromise(store.clear()));
}

function cleanPosition(position) {
  const fen = normalizeFen(position.fen);
  if (!isValidFen(fen)) {
    throw new Error("That position does not contain a valid FEN.");
  }
  return {
    id: String(position.id || makeId("position")),
    fen,
    label: String(position.label || "Saved position").slice(0, 120),
    playerColor: position.playerColor === "b" ? "b" : "w",
    stockfishLevel: Math.max(1, Math.min(8, Number(position.stockfishLevel) || 4)),
    createdAt: Number(position.createdAt) || Date.now(),
  };
}

export async function savePosition(position) {
  const next = cleanPosition(position);
  const positions = await listSavedPositions();
  const existing = positions.find((item) => item.fen === next.fen);
  if (existing) {
    return existing;
  }
  await withStore("savedPositions", "readwrite", (store) => requestToPromise(store.add(next)));
  return next;
}

export async function listSavedPositions() {
  const positions = await withStore("savedPositions", "readonly", (store) => requestToPromise(store.getAll()));
  return positions.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSavedPosition(id) {
  return withStore("savedPositions", "readwrite", (store) => requestToPromise(store.delete(id)));
}

export async function renameSavedPosition(id, label) {
  const position = await withStore("savedPositions", "readonly", (store) => requestToPromise(store.get(id)));
  if (!position) {
    return null;
  }
  position.label = String(label || "Saved position").trim().slice(0, 120) || "Saved position";
  return withStore("savedPositions", "readwrite", (store) => requestToPromise(store.put(position)));
}

export async function clearSavedPositions() {
  return withStore("savedPositions", "readwrite", (store) => requestToPromise(store.clear()));
}

export async function getStatistics() {
  const games = (await listGames()).filter((record) => record.mode !== "pvp");
  const completed = games.filter((game) => game.status === "completed");
  const terminated = games.filter((game) => game.status === "terminated");
  const stats = { total: completed.length, terminated: terminated.length, wins: 0, draws: 0, losses: 0, winRate: 0, levels: {} };
  for (const game of games.filter((record) => record.status === "completed" || record.status === "terminated")) {
    if (game.result === "win") stats.wins += 1;
    if (game.result === "draw") stats.draws += 1;
    if (game.result === "loss") stats.losses += 1;
    const level = statisticsLevel(game);
    stats.levels[level] ||= { total: 0, terminated: 0, wins: 0, draws: 0, losses: 0 };
    if (game.status === "completed") stats.levels[level].total += 1;
    if (game.status === "terminated") stats.levels[level].terminated += 1;
    if (game.result === "win") stats.levels[level].wins += 1;
    if (game.result === "draw") stats.levels[level].draws += 1;
    if (game.result === "loss") stats.levels[level].losses += 1;
  }
  stats.winRate = stats.total ? Math.round((stats.wins / stats.total) * 100) : 0;
  return stats;
}

export async function getStorageSummary() {
  const [games, positions] = await Promise.all([listGames(), listSavedPositions()]);
  let estimate = null;
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch (error) {
    console.warn("Storage estimate unavailable.", error);
  }
  return { games, positions, favorites: games.filter((game) => game.isFavorite), estimate };
}

function sanitizeBackupGame(record) {
  if (!record || typeof record !== "object") throw new Error("A backup game is not an object.");
  const replay = replayGame(record.startingFen, record.moves || [], record.currentFen || record.startingFen);
  const clean = cleanGame({ ...record, moves: replay.moves.map((move) => move.san) });
  replay.chess.header("Event", "Ultra Fischer", "SetUp", "1", "FEN", clean.startingFen, "Result", resultCode(clean.result, clean.playerColor));
  clean.pgn = replay.chess.pgn();
  return clean;
}

export function validateBackup(backup) {
  if (!backup || ![BACKUP_FORMAT, LEGACY_BACKUP_FORMAT].includes(backup.format) || backup.version !== BACKUP_VERSION
      || !Array.isArray(backup.games) || (!Array.isArray(backup.favoriteGames) && !Array.isArray(backup.savedPositions))) {
    throw new Error("This file is not a valid Ultra Fischer backup.");
  }
  const validateRecords = (records, validate, label) => records.map((record, index) => {
    try { return validate(record); }
    catch (cause) { throw new Error(`${label} ${index + 1}: ${cause.message}`, { cause }); }
  });
  return {
    games: validateRecords(backup.games, sanitizeBackupGame, "Game"),
    favoriteGames: validateRecords(backup.favoriteGames || [], sanitizeBackupGame, "Favorite"),
    savedPositions: validateRecords(backup.savedPositions || [], cleanPosition, "Position"),
    preferences: normalizePreferences(backup.preferences || {}),
  };
}

export async function exportBackup() {
  const [games, preferences, savedPositions] = await Promise.all([listGames(), getPreferences(), listSavedPositions()]);
  // Favorite flags already live on games; retain the legacy field without duplicating records.
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), games, favoriteGames: [], savedPositions, preferences };
}

export async function importBackup(backup, mode = "merge") {
  return importValidatedBackup(validateBackup(backup), mode);
}

// The browser supplies a payload already checked by the backup validation worker.
export async function importValidatedBackup(valid, mode = "merge") {
  if (!["merge", "replace"].includes(mode)) throw new Error("Unknown import mode.");
  const imported = new Map(valid.games.map((record) => [record.id, record]));
  for (const favorite of valid.favoriteGames) imported.set(favorite.id, { ...(imported.get(favorite.id) || favorite), isFavorite: true, favoriteKey: 1 });
  const database = await openDatabase();
  const previousPreferences = localStorage.getItem(PREFERENCES_KEY);
  await savePreferences(valid.preferences);
  try {
    // One transaction makes replacement all-or-nothing, including quota failures.
    const transaction = database.transaction(["games", "savedPositions"], "readwrite");
    const completion = transactionToPromise(transaction);
    completion.catch(() => null);
    try {
      const previous = new Map((await requestToPromise(transaction.objectStore("games").getAll())).map((record) => [record.id, record]));
      if (mode === "replace") {
        transaction.objectStore("games").clear();
        transaction.objectStore("savedPositions").clear();
      }
      for (const record of imported.values()) transaction.objectStore("games").put({ ...record, revision: (previous.get(record.id)?.revision || 0) + 1, generation: makeId("generation") });
      for (const position of valid.savedPositions) transaction.objectStore("savedPositions").put(position);
    } catch (error) {
      transaction.abort();
      await completion.catch(() => null);
      throw error;
    }
    await completion;
  } catch (error) {
    if (previousPreferences === null) localStorage.removeItem(PREFERENCES_KEY);
    else localStorage.setItem(PREFERENCES_KEY, previousPreferences);
    throw new Error("Import failed; existing games were not replaced.", { cause: error });
  }
  return valid;
}

export async function deleteAllData() {
  await Promise.all([clearGames(), clearSavedPositions(), resetPreferences(), savePositionPool([])]);
}

export {
  DB_NAME,
  DB_VERSION,
  MAX_POSITION_BALANCE_CP,
  MIN_POSITION_BALANCE_CP,
  PREFERENCES_KEY,
  makeId,
  normalizeFen,
  normalizePositionBalance,
};
