const DB_NAME = "Ultra_Fischer";
const LEGACY_DB_NAME = "ultra-fischer";
const DB_VERSION = 2;
const PREFERENCES_KEY = "Ultra_Fischer.preferences";
const LEGACY_PREFERENCES_KEY = "ultraFischer.preferences";
const BACKUP_FORMAT = "Ultra_Fischer-backup";
const LEGACY_BACKUP_FORMAT = "ultra-fischer-backup";
const BACKUP_VERSION = 1;

const DEFAULT_PREFERENCES = Object.freeze({
  aiStrength: "4",
  evalVisible: true,
  moveAnimation: "slide",
  positionDepth: 12,
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

export function isValidFen(fen) {
  const fields = normalizeFen(fen).split(" ");
  if (fields.length !== 6 || !/^[wb]$/.test(fields[1]) || !/^(?:-|[KQkq]{1,4})$/.test(fields[2]) || !/^(?:-|[a-h][36])$/.test(fields[3])) {
    return false;
  }
  const rows = fields[0].split("/");
  if (rows.length !== 8) {
    return false;
  }
  return rows.every((row) => {
    let width = 0;
    for (const char of row) {
      if (/^[1-8]$/.test(char)) {
        width += Number(char);
      } else if (/^[prnbqkPRNBQK]$/.test(char)) {
        width += 1;
      } else {
        return false;
      }
    }
    return width === 8;
  });
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
      database.addEventListener("versionchange", () => database.close());
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
    games.forEach((game) => transaction.objectStore("games").put(game));
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
  });
  return databasePromise;
}

async function withStore(storeName, mode, callback) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const result = await callback(store, transaction);
  await transactionToPromise(transaction);
  return result;
}

function readPreferences() {
  try {
    const currentRaw = localStorage.getItem(PREFERENCES_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_PREFERENCES_KEY);
    const raw = currentRaw || legacyRaw;
    if (raw) {
      const preferences = { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
      preferences.moveAnimation = normalizeMoveAnimation(preferences.moveAnimation);
      if (!currentRaw) {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
      }
      return preferences;
    }
    const legacy = {
      aiStrength: localStorage.getItem("ultra-fischer-ai-strength"),
      evalVisible: localStorage.getItem("ultra-fischer-eval-visible"),
      moveAnimation: localStorage.getItem("ultra-fischer-move-animation"),
      positionDepth: localStorage.getItem("ultra-fischer-position-depth"),
      requestedColor: localStorage.getItem("ultra-fischer-requested-color"),
      settingsOpen: localStorage.getItem("ultra-fischer-settings-open"),
      theme: localStorage.getItem("ultra-fischer-theme"),
    };
    const migrated = {
      ...DEFAULT_PREFERENCES,
      ...(legacy.aiStrength ? { aiStrength: legacy.aiStrength } : {}),
      ...(legacy.evalVisible ? { evalVisible: legacy.evalVisible !== "false" } : {}),
      ...(legacy.moveAnimation ? { moveAnimation: normalizeMoveAnimation(legacy.moveAnimation) } : {}),
      ...(legacy.positionDepth ? { positionDepth: Number(legacy.positionDepth) } : {}),
      ...(legacy.requestedColor ? { requestedColor: legacy.requestedColor } : {}),
      ...(legacy.settingsOpen ? { settingsOpen: legacy.settingsOpen === "true" } : {}),
      ...(legacy.theme ? { theme: legacy.theme } : {}),
    };
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(migrated));
    return migrated;
  } catch (error) {
    console.warn("Local preferences are unavailable.", error);
    return { ...DEFAULT_PREFERENCES };
  }
}

export function getPreferences() {
  return Promise.resolve(readPreferences());
}

export function savePreferences(preferences) {
  const next = { ...DEFAULT_PREFERENCES, ...preferences };
  next.moveAnimation = normalizeMoveAnimation(next.moveAnimation);
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
    for (const key of ["ultra-fischer-ai-strength", "ultra-fischer-eval-visible", "ultra-fischer-move-animation", "ultra-fischer-position-depth", "ultra-fischer-requested-color", "ultra-fischer-settings-open", "ultra-fischer-theme"]) {
      localStorage.removeItem(key);
    }
  } catch (error) {
    throw new Error("Preferences could not be reset.", { cause: error });
  }
  return Promise.resolve({ ...DEFAULT_PREFERENCES });
}

function cleanGame(record) {
  const now = Date.now();
  const status = ["completed", "terminated"].includes(record.status) ? record.status : "in_progress";
  return {
    id: String(record.id || makeId("game")),
    label: String(record.label || "Game").slice(0, 120),
    startingFen: normalizeFen(record.startingFen),
    currentFen: normalizeFen(record.currentFen || record.startingFen),
    playerColor: record.playerColor === "b" ? "b" : "w",
    engineColor: record.engineColor === "w" ? "w" : "b",
    stockfishLevel: Math.max(1, Math.min(8, Number(record.stockfishLevel) || 4)),
    status,
    result: status === "completed" && ["win", "draw", "loss"].includes(record.result) ? record.result : null,
    termination: record.termination || null,
    moves: Array.isArray(record.moves) ? record.moves.map((move) => String(move)).slice(0, 1000) : [],
    pgn: String(record.pgn || "").slice(0, 100000),
    isFavorite: Boolean(record.isFavorite),
    startedAt: Number(record.startedAt) || now,
    updatedAt: Number(record.updatedAt) || now,
    finishedAt: ["completed", "terminated"].includes(status) ? (record.finishedAt ? Number(record.finishedAt) : now) : null,
    initialEvaluation: record.initialEvaluation || null,
    finalEvaluation: record.finalEvaluation || null,
    moveCount: Number(record.moveCount) || (Array.isArray(record.moves) ? record.moves.length : 0),
  };
}

export async function createGame(record) {
  const game = cleanGame(record);
  await withStore("games", "readwrite", (store) => requestToPromise(store.add(game)));
  return game;
}

export async function updateGame(record) {
  const game = cleanGame(record);
  await withStore("games", "readwrite", (store) => requestToPromise(store.put(game)));
  return game;
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
  const game = await getGame(id);
  if (!game) {
    return null;
  }
  game.isFavorite = Boolean(isFavorite);
  game.updatedAt = Date.now();
  return updateGame(game);
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
  const game = await getGame(id);
  if (!game) {
    return null;
  }
  game.label = String(label || "Game").trim().slice(0, 120) || "Game";
  game.updatedAt = Date.now();
  return updateGame(game);
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
  const games = await listGames();
  const completed = games.filter((game) => game.status === "completed");
  const terminated = games.filter((game) => game.status === "terminated");
  const stats = { total: completed.length, terminated: terminated.length, wins: 0, draws: 0, losses: 0, winRate: 0, levels: {} };
  for (const game of games.filter((record) => record.status === "completed" || record.status === "terminated")) {
    if (game.result === "win") stats.wins += 1;
    if (game.result === "draw") stats.draws += 1;
    if (game.result === "loss") stats.losses += 1;
    const level = String(game.stockfishLevel);
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
  if (!record || typeof record !== "object" || !isValidFen(record.startingFen) || !isValidFen(record.currentFen || record.startingFen)) {
    return null;
  }
  return cleanGame(record);
}

export function validateBackup(backup) {
  const hasFavoriteGames = Array.isArray(backup?.favoriteGames);
  const hasLegacyPositions = Array.isArray(backup?.savedPositions);
  if (!backup || ![BACKUP_FORMAT, LEGACY_BACKUP_FORMAT].includes(backup.format) || backup.version !== BACKUP_VERSION || !Array.isArray(backup.games) || (!hasFavoriteGames && !hasLegacyPositions)) {
    throw new Error("This file is not a valid Ultra_Fischer backup.");
  }
  const games = backup.games.map(sanitizeBackupGame).filter(Boolean);
  const favoriteGames = (backup.favoriteGames || []).map(sanitizeBackupGame).filter(Boolean);
  const savedPositions = (backup.savedPositions || []).map((position) => {
    try {
      return cleanPosition(position);
    } catch (error) {
      return null;
    }
  }).filter(Boolean);
  const preferences = { ...DEFAULT_PREFERENCES, ...(backup.preferences || {}) };
  preferences.moveAnimation = normalizeMoveAnimation(preferences.moveAnimation);
  return { games, favoriteGames, savedPositions, preferences };
}

export async function exportBackup() {
  const [games, preferences] = await Promise.all([listGames(), getPreferences()]);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), games, favoriteGames: games.filter((game) => game.isFavorite), preferences };
}

export async function importBackup(backup, mode = "merge") {
  const valid = validateBackup(backup);
  if (mode === "replace") {
    await Promise.all([clearGames(), clearSavedPositions()]);
  }
  const existingGames = await listGames();
  const existingPositions = await listSavedPositions();
  const gameIds = new Set(existingGames.map((game) => game.id));
  const positionFens = new Set(existingPositions.map((position) => position.fen));
  const favoriteIds = new Set(valid.favoriteGames.map((game) => game.id));
  const importedGames = valid.games.map((game) => favoriteIds.has(game.id) ? { ...game, isFavorite: true } : game);
  for (const game of valid.favoriteGames) {
    if (!importedGames.some((item) => item.id === game.id)) importedGames.push({ ...game, isFavorite: true });
  }
  for (const game of importedGames) {
    if (gameIds.has(game.id)) await updateGame(game); else await createGame(game);
  }
  for (const position of valid.savedPositions) {
    if (!positionFens.has(position.fen)) await savePosition(position);
  }
  await savePreferences(valid.preferences);
  return valid;
}

export async function deleteAllData() {
  await Promise.all([clearGames(), clearSavedPositions(), resetPreferences()]);
}

export { DB_NAME, DB_VERSION, PREFERENCES_KEY, makeId, normalizeFen };
