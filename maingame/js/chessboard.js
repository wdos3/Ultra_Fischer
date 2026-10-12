import {
  ANALYSIS_PROFILE,
  getLevelConfig,
} from "./stockfish-config.mjs";
import { StockfishEngine } from "./stockfish-engine.mjs";
import { generatePosition, generateBalancedPosition as findBalancedPosition } from "./position-generator.mjs";
import { positionSettingsKey, cachedPositionAccepted } from "./position-policy.mjs";
import { buildPgn, replayGame, detectResult, resultCode } from "./chess-rules.mjs";
import { GameSession } from "./game-session.mjs";
import { validateBackupFile } from "./backup-validator.mjs";
import { DialogManager } from "./dialog-manager.mjs";
import { MoveRecordView } from "./move-record.mjs";
import { RecordsView } from "./records-view.mjs";

import {
  clearGameFavorites,
  clearGames,
  createGame,
  deleteAllData,
  deleteGame,
  exportBackup,
  getPreferences,
  getGame,
  listGamesPage,
  saveGameProgress,
  getStatistics,
  getStorageSummary,
  importValidatedBackup,
  loadPositionPool,
  MAX_POSITION_BALANCE_CP,
  MIN_POSITION_BALANCE_CP,
  normalizePositionBalance,
  renameGame,
  resetPreferences,
  savePositionPool,
  savePreferences,
  setGameFavorite,
  updateGame,
} from "./storage.mjs";

const LEGACY_LEVELS = {
  easy: "2",
  medium: "4",
  hard: "6",
  "very-hard": "7",
};

const EVALUATION_DEPTH = 16;
const POSITION_GENERATION_TIMEOUT_MS = 15000;
const POSITION_POOL_LIMIT = 2;

function normalizeLevel(value) {
  const migratedValue = LEGACY_LEVELS[value] || value;
  return /^[1-8]$/.test(migratedValue) ? migratedValue : "4";
}

const ui = {
  aiStrength: document.getElementById("ai-strength"),
  aboutClose: document.getElementById("about-close"),
  aboutDialog: document.getElementById("about-dialog"),
  aboutToggle: document.getElementById("about-toggle"),
  board: document.getElementById("board"),
  colorButtons: Array.from(document.querySelectorAll(".color-button")),
  evalFill: document.getElementById("eval-fill"),
  evalLabel: document.getElementById("eval-label"),
  evalMarker: document.getElementById("eval-marker"),
  evalSettingToggle: document.getElementById("eval-setting-toggle"),
  evalToggle: document.getElementById("eval-toggle"),
  historyClose: document.getElementById("history-close"),
  historyToggle: document.getElementById("history-toggle"),
  appMenu: document.getElementById("app-menu"),
  menuClose: document.getElementById("menu-close"),
  recordsMenu: document.getElementById("records-menu"),
  recordsMenuClose: document.getElementById("records-menu-close"),
  recordsToggle: document.getElementById("records-toggle"),
  historyDialog: document.getElementById("history-dialog"),
  historyList: document.getElementById("history-list"),
  historyFilter: document.getElementById("history-filter"),
  historySort: document.getElementById("history-sort"),
  favoritesDialog: document.getElementById("favorites-dialog"),
  favoritesList: document.getElementById("favorites-list"),
  statisticsDialog: document.getElementById("statistics-dialog"),
  statisticsContent: document.getElementById("statistics-content"),
  dataDialog: document.getElementById("data-dialog"),
  storageSummary: document.getElementById("storage-summary"),
  exportData: document.getElementById("export-data"),
  importData: document.getElementById("import-data"),
  importFile: document.getElementById("import-file"),
  clearHistory: document.getElementById("clear-history"),
  clearFavorites: document.getElementById("clear-favorites"),
  resetPreferences: document.getElementById("reset-preferences"),
  deleteAllData: document.getElementById("delete-all-data"),
  resumeDialog: document.getElementById("resume-dialog"),
  resumeDetail: document.getElementById("resume-detail"),
  resumeGame: document.getElementById("resume-game"),
  resumeNewGame: document.getElementById("resume-new-game"),
  resumeClose: document.getElementById("resume-close"),
  replayDialog: document.getElementById("replay-dialog"),
  replayBoard: document.getElementById("replay-board"),
  replayClose: document.getElementById("replay-close"),
  replayMoves: document.getElementById("replay-moves"),
  replayPosition: document.getElementById("replay-position"),
  replayFirst: document.getElementById("replay-first"),
  replayPrev: document.getElementById("replay-prev"),
  replayNext: document.getElementById("replay-next"),
  replayLast: document.getElementById("replay-last"),
  hintButton: document.getElementById("hint-button"),
  modePill: document.getElementById("mode-pill"),
  moveAnimation: document.getElementById("move-animation"),
  moveHistory: document.getElementById("move-history"),
  newGame: document.getElementById("new-game"),
  newGameDialog: document.getElementById("new-game-dialog"),
  opponentLabel: document.getElementById("opponent-label"),
  recordColor: document.getElementById("record-color"),
  recordTurn: document.getElementById("record-turn"),
  positionBalance: document.getElementById("position-balance"),
  friendlyModeToggle: document.getElementById("friendly-mode-toggle"),
  settingInfoDialog: document.getElementById("setting-info-dialog"),
  settingInfoTitle: document.getElementById("setting-info-title"),
  settingInfoBody: document.getElementById("setting-info-body"),
  settingInfoClose: document.getElementById("setting-info-close"),
  promotionDetail: document.getElementById("promotion-detail"),
  promotionDialog: document.getElementById("promotion-dialog"),
  promotionOptions: document.getElementById("promotion-options"),
  resultDialog: document.getElementById("result-dialog"),
  resultDetail: document.getElementById("result-detail"),
  resultDismiss: document.getElementById("result-dismiss"),
  resultClose: document.getElementById("result-close"),
  resultMark: document.getElementById("result-mark"),
  resultNewGame: document.getElementById("result-new-game"),
  resultTitle: document.getElementById("result-title"),
  resign: document.getElementById("resign"),
  settingsCard: document.getElementById("settings-card"),
  settingsClose: document.getElementById("settings-close"),
  settingsToggle: document.getElementById("settings-toggle"),
  sharePosition: document.getElementById("share-position"),
  statusText: document.getElementById("status-text"),
  themeSelect: document.getElementById("theme-select"),
  toast: document.getElementById("toast"),
  toggleMode: document.getElementById("toggle-mode"),
  undo: document.getElementById("undo"),
  setupClose: document.getElementById("setup-close"),
  setupLevelLabel: document.getElementById("setup-level-label"),
  setupSettings: document.getElementById("setup-settings"),
  startGame: document.getElementById("start-game"),
};

const game = new Chess();

const state = {
  actualPlayerColor: "w",
  aiStrength: "4",
  board: null,
  analysisEngine: null,
  engineReady: false,
  evalVisible: false,
  evalVisibilityConfigured: false,
  moveAnimation: "slide",
  isBusy: true,
  lastEvalScore: null,
  matchOver: false,
  historyOpen: false,
  playerVsPlayer: false,
  requestedColor: "w",
  setupOpen: false,
  settingsOpen: false,
  taskToken: 0,
  theme: "dark",
  toastTimer: null,
  opponentEngine: null,
  positionEngine: null,
  positionPool: [],
  positionPrefetchPromise: null,
  positionPrefetchTimer: null,
  positionGenerationToken: 0,
  session: null,
  moveLog: [],
  startingGame: false,
  importing: false,
  resuming: false,
  sessionConflict: false,
  opponentTurn: null,
  hintSearch: null,
  animationUntil: 0,
  currentGameId: null,
  currentGameFavorite: false,
  currentGameLabel: null,
  currentStartingFen: null,
  initialFen: null,
  initialColor: null,
  pendingStartFen: null,
  resumeRecord: null,
  replay: { board: null, game: null, record: null, index: 0 },
  selectedSquare: null,
  suppressClickUntil: 0,
  boardInteractionBound: false,
  resizeBound: false,
  promotionRequest: null,
  friendlyMode: true,
  positionBalanceCp: MIN_POSITION_BALANCE_CP,
};


function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sideName(color) {
  return color === "w" ? "White" : "Black";
}

function setStatus(message) {
  ui.statusText.textContent = message;
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("visible");
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }
  state.toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove("visible");
  }, 2200);
}

function formatDate(timestamp) {
  if (!timestamp) {
    return "Unknown date";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function resultForWinner(winner) {
  if (!winner) {
    return "draw";
  }
  return winner === state.actualPlayerColor ? "win" : "loss";
}

function gameResult() {
  return detectResult(game, state.actualPlayerColor);
}

const moveRecord = new MoveRecordView(ui.moveHistory);

async function saveCurrentGame(overrides = {}) {
  const session = state.session;
  if (!session) return null;
  const saved = await session.save(game, state.lastEvalScore, overrides, state.moveLog.map((move) => move.san));
  if (session === state.session && saved) {
    state.currentGameId = saved.id;
    state.currentGameFavorite = session.record.isFavorite;
    state.currentGameLabel = session.record.label;
  }
  return saved;
}

async function terminateCurrentGame() {
  if (!state.session || !state.session.recording || state.sessionConflict || state.session.record.status !== "in_progress" || state.matchOver || game.game_over()) {
    return null;
  }
  return saveCurrentGame({ status: "terminated", termination: "new_game" });
}

async function terminateGameRecord(record) {
  if (!record || record.status !== "in_progress") {
    return null;
  }
  const now = Date.now();
  return updateGame({ ...record, status: "terminated", result: null, termination: "new_game", updatedAt: now, finishedAt: now });
}

async function persistCurrentGameQuietly() {
  try {
    await saveCurrentGame();
  } catch (error) {
    console.error(error);
    if (error.code === "GAME_CONFLICT") handleGameConflict(error);
    else showToast("Local storage is unavailable; this game is still playable.");
  }
}

async function createLocalGame(startingFen, score = null) {
  await state.session?.detach();
  state.sessionConflict = false;
  state.currentGameId = null;
  state.currentStartingFen = startingFen;
  state.currentGameFavorite = false;
  state.moveLog = [];
  const startedAt = Date.now();
  state.currentGameLabel = `Game ${formatDate(startedAt)}`;
  state.session = new GameSession({
    label: state.currentGameLabel, startingFen, playerColor: state.actualPlayerColor,
    engineColor: state.actualPlayerColor === "w" ? "b" : "w",
    stockfishLevel: Number(state.aiStrength), mode: state.playerVsPlayer ? "pvp" : "pvai",
    status: "in_progress", startedAt, isFavorite: false, initialEvaluation: score,
  }, { create: createGame, update: saveGameProgress });
  state.opponentEngine.newGame();
  await persistCurrentGameQuietly();
}

const dialogs = new DialogManager(document);

function closeOverlay(element) { dialogs.close(element); }

function openOverlay(element) { dialogs.open(element); }

function closeAppMenu() {
  closeOverlay(ui.appMenu);
  ui.settingsToggle.setAttribute("aria-expanded", "false");
}

function openAppMenu() {
  closeRecordsMenu();
  state.settingsOpen = false;
  closeOverlay(ui.settingsCard);
  openOverlay(ui.appMenu);
  ui.settingsToggle.setAttribute("aria-expanded", "true");
}

function closeRecordsMenu() {
  closeOverlay(ui.recordsMenu);
  ui.recordsToggle.setAttribute("aria-expanded", "false");
}

function openRecordsMenu() {
  closeAppMenu();
  closeOverlay(ui.historyDialog);
  closeOverlay(ui.favoritesDialog);
  closeOverlay(ui.statisticsDialog);
  openOverlay(ui.recordsMenu);
  ui.recordsToggle.setAttribute("aria-expanded", "true");
}

function returnToAppMenu() {
  [ui.historyDialog, ui.favoritesDialog, ui.statisticsDialog, ui.dataDialog, ui.settingsCard].forEach(closeOverlay);
  state.settingsOpen = false;
  void persistPreferences();
  openAppMenu();
}

function returnToRecordsMenu() {
  [ui.historyDialog, ui.favoritesDialog, ui.statisticsDialog].forEach(closeOverlay);
  openRecordsMenu();
}

function openSettingInfo(topic) {
  const details = {
    stockfish: {
      title: "Stockfish levels",
      paragraphs: ["Higher levels spend more time searching and look deeper before choosing a move. The level changes the opponent engine only; the evaluation display uses its own higher-accuracy analysis profile."],
      rows: [
        ["1–3", "Fast play", "Shallow search and short thinking time"],
        ["4–5", "Standard", "Balanced speed and strength"],
        ["6–7", "Strong", "Deeper search and longer thinking time"],
        ["8", "Maximum", "Deepest search and longest thinking time"],
      ],
      advanced: true,
    },
    friendly: {
      title: "Friendly mode",
      paragraphs: ["Friendly mode screens generated starting positions for practical play. Both modes still use the starting balance limit."],
      rows: [],
      comparison: {
        headers: ["Friendly mode On", "Friendly mode Off"],
        rows: [
          ["Requires several legal moves and at least two closely scored engine choices.", "Allows forced or tactical starts as long as the balance limit passes."],
          ["Designed to reduce immediate one-move traps.", "Designed to expose the full range of balanced positions."],
        ],
      },
    },
  }[topic];
  if (!details) return;
  ui.settingInfoTitle.textContent = details.title;
  ui.settingInfoBody.replaceChildren();
  details.paragraphs.forEach((paragraph) => {
    const element = document.createElement("p");
    element.textContent = paragraph;
    ui.settingInfoBody.appendChild(element);
  });
  if (details.rows.length) {
    const table = document.createElement("div");
    table.className = "info-table";
    details.rows.forEach(([level, label, description]) => {
      const levelCell = document.createElement("strong");
      levelCell.textContent = level;
      const labelCell = document.createElement("strong");
      labelCell.textContent = label;
      const descriptionCell = document.createElement("span");
      descriptionCell.textContent = description;
      table.append(levelCell, labelCell, descriptionCell);
    });
    ui.settingInfoBody.appendChild(table);
  }
  if (details.comparison) {
    const comparison = document.createElement("div");
    comparison.className = "info-comparison";
    details.comparison.headers.forEach((header) => {
      const heading = document.createElement("strong");
      heading.textContent = header;
      comparison.appendChild(heading);
    });
    details.comparison.rows.forEach(([onText, offText]) => {
      const onCell = document.createElement("span");
      onCell.textContent = onText;
      const offCell = document.createElement("span");
      offCell.textContent = offText;
      comparison.append(onCell, offCell);
    });
    ui.settingInfoBody.appendChild(comparison);
  }
  if (details.advanced) {
    const advanced = document.createElement("details");
    advanced.className = "info-advanced";
    const summary = document.createElement("summary");
    summary.textContent = "Advanced engine specs";
    advanced.appendChild(summary);
    const table = document.createElement("div");
    table.className = "info-advanced-grid";
    [["Level", "Skill", "Depth", "Time", "MultiPV"], ...Array.from({ length: 8 }, (_, index) => {
      const config = getLevelConfig(index + 1);
      return [String(index + 1), String(config.requestedSkill), String(config.depth), `${config.moveTime} ms`, String(config.candidateCount)];
    })].forEach((row, rowIndex) => {
      row.forEach((value) => {
        const cell = document.createElement(rowIndex === 0 ? "strong" : "span");
        cell.textContent = value;
        table.appendChild(cell);
      });
    });
    advanced.appendChild(table);
    ui.settingInfoBody.appendChild(advanced);
  }
  openOverlay(ui.settingInfoDialog);
}

function loadRecordIntoGame(record) {
  const validated = replayGame(record.startingFen, record.moves || [], record.currentFen);
  game.load(record.startingFen);
  for (const move of validated.moves) game.move(move.san);
  state.moveLog = validated.moves;
}

async function resumeRecord(record) {
  if (state.startingGame || state.importing || state.resuming) return;
  const token = ++state.taskToken;
  let loaded = false;
  state.resuming = true;
  cancelEngineSearches();
  resetBoardInteraction();
  setBusy(true);
  try {
    replayGame(record.startingFen, record.moves || [], record.currentFen);
    if (state.session?.id !== record.id || state.sessionConflict || !state.session?.recording) {
      await terminateCurrentGame();
      if (token !== state.taskToken) return;
      await state.session?.detach();
      setCurrentRecord(record);
    }
    [ui.historyDialog, ui.favoritesDialog, ui.resumeDialog].forEach(closeOverlay);
    loaded = true;
  } catch (error) {
    console.error(error);
    if (error.code === "GAME_CONFLICT") handleGameConflict(error);
    else showToast("Could not resume this game: " + error.message);
  } finally {
    state.resuming = false;
    if (token === state.taskToken) setBusy(false);
  }
  if (loaded && token === state.taskToken) await continuePlay();
}

async function persistPreferences() {
  try {
    await savePreferences({ aiStrength: state.aiStrength, evalVisible: state.evalVisible, evalVisibilityConfigured: state.evalVisibilityConfigured, friendlyMode: state.friendlyMode, moveAnimation: state.moveAnimation, positionBalanceCp: state.positionBalanceCp, requestedColor: state.requestedColor, settingsOpen: state.settingsOpen, theme: state.theme });
  } catch (error) {
    console.error(error);
    showToast("Preferences could not be saved.");
  }
}

function persistPositionPool() {
  void savePositionPool(state.positionPool.slice(0, POSITION_POOL_LIMIT));
}

function setCurrentRecord(record) {
  loadRecordIntoGame(record);
  state.sessionConflict = false;
  state.session = new GameSession(record, { create: createGame, update: saveGameProgress });
  state.playerVsPlayer = record.mode === "pvp";
  syncModeUI();
  state.currentGameId = record.id;
  state.currentStartingFen = record.startingFen;
  state.currentGameFavorite = Boolean(record.isFavorite);
  state.currentGameLabel = record.label || `Game ${formatDate(record.startedAt)}`;
  state.actualPlayerColor = record.playerColor;
  state.aiStrength = normalizeLevel(record.stockfishLevel);
  state.matchOver = record.status !== "in_progress";
  state.board.orientation(state.actualPlayerColor === "w" ? "white" : "black");
  state.board.position(game.fen(), false);
  syncSettingsUI();
  updateSideLabels();
  renderMoveHistory();
  updateEvalBar(record.finalEvaluation || record.initialEvaluation || null);
  syncActionAvailability();
  setStatus(describeResult());
}

function syncTheme() {
  document.body.dataset.theme = state.theme;
  ui.themeSelect.value = state.theme;
  if (state.board) {
    state.board.resize();
  }
}

function syncEvalVisibility() {
  document.body.classList.toggle("eval-hidden", !state.evalVisible);
  const label = state.evalVisible ? "Hide evaluation bar" : "Show evaluation bar";
  ui.evalToggle.innerHTML = state.evalVisible ? "<span aria-hidden=\"true\">&#8722;</span>" : "<span aria-hidden=\"true\">+</span>";
  ui.evalToggle.setAttribute("aria-label", label);
  ui.evalToggle.title = label;
  ui.evalSettingToggle.textContent = state.evalVisible ? "Visible" : "Hidden";
}

function syncColorButtons() {
  ui.colorButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.color === state.requestedColor);
  });
}

function syncSettingsUI() {
  const level = getLevelConfig(state.aiStrength);
  ui.positionBalance.min = String(MIN_POSITION_BALANCE_CP);
  ui.positionBalance.max = String(MAX_POSITION_BALANCE_CP);
  ui.positionBalance.value = String(state.positionBalanceCp);
  ui.moveAnimation.value = state.moveAnimation;
  ui.aiStrength.value = state.aiStrength;
  ui.themeSelect.value = state.theme;
  ui.friendlyModeToggle.textContent = state.friendlyMode ? "On" : "Off";
  ui.friendlyModeToggle.setAttribute("aria-pressed", String(state.friendlyMode));
  ui.setupLevelLabel.textContent = `Level ${state.aiStrength} · ${level.moveTime} ms`;
  ui.opponentLabel.textContent = state.playerVsPlayer
    ? "Local opponent"
    : `Stockfish Level ${state.session?.record.stockfishLevel || state.aiStrength}`;
}

function syncSettingsPanel() {
  if (state.settingsOpen) openOverlay(ui.settingsCard);
  else closeOverlay(ui.settingsCard);
}

function syncSetupPanel() {
  if (state.setupOpen) openOverlay(ui.newGameDialog);
  else closeOverlay(ui.newGameDialog);
}

function syncHistoryPanel() {
  document.body.classList.toggle("history-open", state.historyOpen);
  ui.historyToggle.setAttribute("aria-expanded", String(state.historyOpen));
}

const historyRecords = new RecordsView(ui.historyList);
const favoriteRecords = new RecordsView(ui.favoritesList, { favorites: true });

function resultCodeForRecord(record) {
  return resultCode(record.result, record.playerColor);
}

function refreshHistoryList() {
  return historyRecords.refresh(ui.historyFilter.value, ui.historySort.value);
}

function refreshFavoritesList() {
  return favoriteRecords.refresh();
}

async function refreshStatistics() {
  const stats = await getStatistics();
  ui.statisticsContent.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "statistics-grid";
  for (const [label, value] of [["Games", stats.total], ["Wins", stats.wins], ["Draws", stats.draws], ["Losses", stats.losses], ["Terminated", stats.terminated]]) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    card.append(strong, span);
    grid.appendChild(card);
  }
  ui.statisticsContent.appendChild(grid);
  const rate = document.createElement("p");
  rate.textContent = `AI win rate: ${stats.winRate}%`;
  ui.statisticsContent.appendChild(rate);
  const table = document.createElement("div");
  table.className = "level-table";
  for (const value of ["Level", "Games", "Wins", "Draws", "Losses", "Terminated"]) {
    const cell = document.createElement("span");
    cell.textContent = value;
    table.appendChild(cell);
  }
  for (const level of Object.keys(stats.levels).sort((a, b) => a === "mixed" ? 1 : b === "mixed" ? -1 : Number(a) - Number(b))) {
    const row = stats.levels[level];
    for (const value of [level === "mixed" ? "Mixed" : level, row.total, row.wins, row.draws, row.losses, row.terminated]) {
      const cell = document.createElement("span");
      cell.textContent = value;
      table.appendChild(cell);
    }
  }
  ui.statisticsContent.appendChild(table);
}

async function refreshStorageSummary() {
  const summary = await getStorageSummary();
  const usage = summary.estimate?.usage ? ` · ${Math.round(summary.estimate.usage / 1024)} KB used` : "";
  ui.storageSummary.textContent = `${summary.games.length} games · ${summary.favorites.length} favorite games${usage}`;
}

async function openPanel(panel) {
  closeAppMenu();
  closeRecordsMenu();
  const panels = { history: ui.historyDialog, favorites: ui.favoritesDialog, statistics: ui.statisticsDialog, data: ui.dataDialog, settings: ui.settingsCard };
  const element = panels[panel];
  if (!element) return;
  openOverlay(element);
  if (panel === "history") await refreshHistoryList();
  if (panel === "favorites") await refreshFavoritesList();
  if (panel === "statistics") await refreshStatistics();
  if (panel === "data") await refreshStorageSummary();
  if (panel === "settings") {
    state.settingsOpen = true;
    syncSettingsPanel();
  }
}

function closePanel(element) {
  closeOverlay(element);
  if (element === ui.settingsCard) {
    state.settingsOpen = false;
    void persistPreferences();
    syncSettingsPanel();
  }
}

function preparePlayAgain(startingFen, color, level) {
  state.pendingStartFen = startingFen;
  state.requestedColor = color;
  state.aiStrength = normalizeLevel(level);
  syncColorButtons();
  syncSettingsUI();
  closeOverlay(ui.historyDialog);
  closeOverlay(ui.favoritesDialog);
  openOverlay(ui.newGameDialog);
  state.setupOpen = true;
  syncSetupPanel();
}

function createReplayBoard() {
  if (state.replay.board) return;
  state.replay.board = ChessBoard("replay-board", { draggable: false, orientation: "white", pieceTheme: "maingame/img/chesspieces/wikipedia/{piece}.png", position: "start" });
}

function renderReplay() {
  const { record, index } = state.replay;
  if (!record) return;
  state.replay.game = new Chess(record.startingFen);
  for (const san of (record.moves || []).slice(0, index)) state.replay.game.move(san);
  createReplayBoard();
  state.replay.board.orientation(record.playerColor === "w" ? "white" : "black");
  state.replay.board.position(state.replay.game.fen(), false);
  ui.replayPosition.textContent = `${index} / ${(record.moves || []).length}`;
  ui.replayMoves.querySelectorAll(".replay-move").forEach((button) => button.classList.toggle("active", Number(button.dataset.index) === index));
}

function openReplay(record) {
  state.replay = { ...state.replay, record, index: 0 };
  ui.replayMoves.innerHTML = "";
  let moveNumber = Number(record.startingFen.split(" ")[5]);
  const verbose = replayGame(record.startingFen, record.moves || []).moves;
  verbose.forEach((move, index) => {
    const button = document.createElement("button");
    button.className = "replay-move";
    button.type = "button";
    button.dataset.index = String(index + 1);
    button.textContent = `${moveNumber}${move.color === "b" ? "..." : "."} ${move.san}`;
    if (move.color === "b") moveNumber += 1;
    button.addEventListener("click", () => { state.replay.index = index + 1; renderReplay(); });
    ui.replayMoves.appendChild(button);
  });
  openOverlay(ui.replayDialog);
  renderReplay();
}

function syncModeUI() {
  if (state.playerVsPlayer) {
    ui.modePill.textContent = "Player vs Player";
    ui.toggleMode.textContent = "Switch to PvAI";
    ui.undo.setAttribute("aria-label", "Undo move");
    ui.undo.title = "Undo move";
  } else {
    ui.modePill.textContent = "Player vs AI";
    ui.toggleMode.textContent = "Switch to PvP";
    ui.undo.setAttribute("aria-label", "Undo pair");
    ui.undo.title = "Undo pair";
  }
}

function setBusy(isBusy) {
  state.isBusy = isBusy;
  if (isBusy) state.positionEngine?.cancelPending();
  else schedulePositionPrefetch();
  syncActionAvailability();
  ui.startGame.disabled = isBusy;
  ui.colorButtons.forEach((button) => {
    button.disabled = isBusy;
  });
}

function syncActionAvailability() {
  const terminal = state.matchOver || game.game_over();
  const blocked = state.isBusy || state.importing || state.sessionConflict || terminal || !state.engineReady || !state.session;
  ui.undo.disabled = blocked || state.moveLog.length === 0;
  ui.hintButton.disabled = blocked || Boolean(state.hintSearch);
  ui.hintButton.setAttribute("aria-busy", String(Boolean(state.hintSearch)));
  ui.resign.disabled = terminal || state.startingGame || state.importing || state.sessionConflict || !state.session || !state.engineReady;
  ui.toggleMode.disabled = state.startingGame || state.importing || state.resuming || state.sessionConflict || !state.engineReady || terminal;
  ui.aiStrength.disabled = state.importing || state.resuming || state.sessionConflict;
}

function terminalEvaluation(overrides = {}) {
  if (game.in_checkmate()) {
    return { type: "mate", value: game.turn() === "w" ? -1 : 1, depth: EVALUATION_DEPTH, terminal: true };
  }
  const result = overrides.result || (game.in_draw() ? "draw" : null);
  if (result === "draw") {
    return { type: "cp", value: 0, depth: EVALUATION_DEPTH, terminal: true };
  }
  if (result === "win" || result === "loss") {
    const whiteWon = result === "win" ? state.actualPlayerColor === "w" : state.actualPlayerColor === "b";
    return { type: "mate", value: whiteWon ? 1 : -1, depth: EVALUATION_DEPTH, terminal: true };
  }
  return null;
}

function cancelEngineSearches() {
  state.hintSearch = null;
  syncActionAvailability();
  new Set([state.analysisEngine, state.opponentEngine].filter(Boolean)).forEach((engine) => {
    engine.cancelPending();
  });
}

async function finishMatch(message, overrides = {}) {
  if (state.matchOver) return;
  resetBoardInteraction();
  state.taskToken += 1;
  cancelEngineSearches();
  state.matchOver = true;
  setBusy(false);
  const finalEvaluation = terminalEvaluation(overrides);
  if (finalEvaluation) {
    updateEvalBar(finalEvaluation);
  }
  setStatus(message);
  showResultDialog(message, overrides);
  try {
    await saveCurrentGame(overrides);
  } catch (error) {
    console.error(error);
    if (error.code === "GAME_CONFLICT") handleGameConflict(error);
    else showToast("The game ended, but the local record could not be saved.");
  }
}

function playResultTone(result) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    const frequencies = result === "win" ? [660, 880] : result === "loss" ? [330, 220] : [440, 440];
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = "sine";
      gain.gain.setValueAtTime(0.0001, context.currentTime + index * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + index * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + index * 0.14 + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(context.currentTime + index * 0.14);
      oscillator.stop(context.currentTime + index * 0.14 + 0.18);
    });
    window.setTimeout(() => void context.close(), 700);
  } catch (error) {
    console.debug("Result sound was unavailable.", error);
  }
}

function showResultDialog(message, overrides = {}) {
  const result = overrides.result || gameResult().result || "draw";
  const title = result === "win" ? "You win" : result === "loss" ? "You lose" : "Draw";
  const mark = result === "win" ? "✓" : result === "loss" ? "!" : "=";
  ui.resultDialog.dataset.result = result;
  ui.resultTitle.textContent = title;
  ui.resultMark.textContent = mark;
  ui.resultDetail.textContent = message;
  openOverlay(ui.resultDialog);
  playResultTone(result);
}

function updateSideLabels() {
  const turn = `${sideName(game.turn())} to move`;
  ui.recordColor.textContent = `You: ${sideName(state.actualPlayerColor)}`;
  ui.recordColor.dataset.side = state.actualPlayerColor;
  ui.recordColor.classList.toggle("is-white", state.actualPlayerColor === "w");
  ui.recordColor.classList.toggle("is-black", state.actualPlayerColor === "b");
  ui.recordTurn.textContent = turn;
  ui.recordTurn.dataset.side = game.turn();
  ui.recordTurn.classList.toggle("is-white", game.turn() === "w");
  ui.recordTurn.classList.toggle("is-black", game.turn() === "b");
}

function renderMoveHistory() {
  moveRecord.render(state.moveLog, state.currentStartingFen || game.fen());
}

function normalizeScoreForWhite(score, turn) {
  if (!score) {
    return null;
  }

  return {
    ...score,
    value: turn === "w" ? score.value : -score.value,
  };
}

function formatEvalLabel(score) {
  if (!score) {
    return "0.0";
  }

  if (score.terminal) return score.type === "mate" ? (score.value > 0 ? "#1-0" : "#0-1") : "1/2";
  if (score.type === "mate") {
    return `M${score.value > 0 ? "+" : ""}${score.value}`;
  }

  const pawns = score.value / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

function scoreToRatio(score) {
  if (!score) {
    return 0.5;
  }

  if (score.terminal) return score.type === "mate" ? (score.value > 0 ? 1 : 0) : 0.5;
  if (score.type === "mate") {
    return score.value > 0 ? 0.97 : 0.03;
  }

  return clamp(0.5 + 0.44 * Math.tanh(score.value / 260), 0.06, 0.94);
}

function updateEvalBar(score) {
  state.lastEvalScore = score;
  const ratio = scoreToRatio(score);
  const percent = ratio * 100;
  ui.evalLabel.textContent = formatEvalLabel(score);

  if (window.matchMedia("(max-width: 900px)").matches) {
    ui.evalFill.style.width = `${percent}%`;
    ui.evalMarker.style.left = `calc(${percent}% - 2px)`;
    ui.evalFill.style.height = "";
    ui.evalMarker.style.bottom = "";
  } else {
    ui.evalFill.style.height = `${percent}%`;
    ui.evalMarker.style.bottom = `calc(${percent}% - 2px)`;
    ui.evalFill.style.width = "";
    ui.evalMarker.style.left = "";
  }
}

async function refreshEvaluation(depth = EVALUATION_DEPTH) {
  if (!state.evalVisible || !state.engineReady || state.matchOver || state.isBusy || game.game_over()) return;
  const token = state.taskToken;
  const fen = game.fen();
  const turn = game.turn();
  state.analysisEngine.cancelPending({ kind: "analysis" });
  try {
    const result = await state.analysisEngine.search(fen, {
      ...ANALYSIS_PROFILE, depth, moveTime: Math.max(700, Math.min(1400, depth * 70)),
    }, { kind: "analysis", priority: 20 });
    if (token !== state.taskToken || result.cancelled || state.matchOver || game.fen() !== fen) return;
    updateEvalBar(normalizeScoreForWhite(result.score, turn));
  } catch (error) {
    console.warn("Evaluation failed.", error);
    if (token === state.taskToken) showToast("Analysis interrupted. The engine is restarting.");
  }
}

function bestMoveToSan(moveString) {
  if (!moveString) {
    return null;
  }
  const probe = new Chess(game.fen());
  const move = probe.move({
    from: moveString.slice(0, 2),
    to: moveString.slice(2, 4),
    promotion: moveString[4] || "q",
  });
  return move ? move.san : moveString;
}

async function copyCurrentFen() {
  const fen = game.fen();
  const fallbackCopy = () => {
    const helper = document.createElement("textarea");
    helper.value = fen;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    helper.style.pointerEvents = "none";
    helper.style.left = "-9999px";
    document.body.appendChild(helper);
    helper.focus();
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  };

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(fen);
    } else {
      const copied = fallbackCopy();
      if (!copied) {
        throw new Error("execCommand copy failed");
      }
    }
    showToast("FEN copied to clipboard.");
  } catch (error) {
    try {
      const copied = fallbackCopy();
      if (copied) {
        showToast("FEN copied to clipboard.");
        return;
      }
    } catch (fallbackError) {
      console.error(fallbackError);
    }
    console.error(error);
    showToast("Could not copy FEN.");
  }
}

async function copyPgn(pgn) {
  const fallbackCopy = () => {
    const helper = document.createElement("textarea");
    helper.value = pgn;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    helper.style.left = "-9999px";
    document.body.appendChild(helper);
    helper.focus();
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  };
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(pgn);
    } else if (!fallbackCopy()) {
      throw new Error("Clipboard is unavailable.");
    }
    showToast("PGN copied to clipboard.");
  } catch (error) {
    try {
      if (fallbackCopy()) {
        showToast("PGN copied to clipboard.");
        return;
      }
    } catch (fallbackError) {
      console.error(fallbackError);
    }
    console.error(error);
    showToast("Could not copy PGN.");
  }
}

function showHint() {
  const token = state.taskToken;
  const fen = game.fen();
  if (state.hintSearch?.token === token && state.hintSearch.fen === fen) return state.hintSearch.promise;
  if (!state.engineReady) {
    showToast("Engine is still loading.");
    return;
  }
  if (isBoardLocked()) return;
  const request = { token, fen };
  state.hintSearch = request;
  syncActionAvailability();
  setStatus("Analyzing hint...");
  const isCurrent = () => state.hintSearch === request && token === state.taskToken && game.fen() === fen;
  request.promise = (async () => {
    try {
      const result = await state.analysisEngine.search(fen, {
        ...ANALYSIS_PROFILE, depth: 12, moveTime: 550,
      }, { kind: "hint", priority: 10 });
      if (!isCurrent() || result.cancelled) return;
      const san = bestMoveToSan(result.bestMove);
      showToast(san ? `Best move: ${san}` : "No legal move available.");
      setStatus(san ? `Hint ready: ${san}` : describeResult());
    } catch (error) {
      console.warn("Hint search failed.", error);
      if (isCurrent()) {
        showToast("Hint interrupted. Try again.");
        setStatus(describeResult());
      }
    } finally {
      if (state.hintSearch === request) {
        state.hintSearch = null;
        syncActionAvailability();
      }
    }
  })();
  return request.promise;
}

function describeResult() {
  if (game.in_checkmate()) {
    return game.turn() === "w" ? "Checkmate. Black wins." : "Checkmate. White wins.";
  }
  if (game.in_draw()) {
    return "Drawn game.";
  }
  if (game.in_check()) {
    return `${sideName(game.turn())} to move and currently in check.`;
  }
  return `${sideName(game.turn())} to move.`;
}

async function runComputerTurn(token) {
  if (state.playerVsPlayer || state.matchOver || game.game_over() || token !== state.taskToken) {
    return;
  }

  const fen = game.fen();
  const level = getLevelConfig(state.aiStrength);
  setStatus(`Stockfish Level ${state.aiStrength} is thinking...`);
  const result = await state.opponentEngine.search(fen, level, { kind: "opponent", priority: 0 });
  if (token !== state.taskToken || game.fen() !== fen || result.cancelled || state.playerVsPlayer || state.matchOver || game.game_over()) {
    return;
  }

  if (result.bestMove) {
    await waitForBoardAnimation();
    if (token !== state.taskToken || game.fen() !== fen || state.playerVsPlayer || state.matchOver) return;
    const move = {
      from: result.bestMove.slice(0, 2),
      to: result.bestMove.slice(2, 4),
      promotion: result.bestMove[4] || "q",
    };
    const applied = game.move(move);
    if (!applied) throw new Error("Stockfish returned an illegal move.");
    state.moveLog.push(applied);
    state.animationUntil = performance.now() + (state.moveAnimation === "slide" ? 180 : 0);
    state.board.position(game.fen(), state.moveAnimation === "slide");
    renderMoveHistory();
    updateSideLabels();
    await persistCurrentGameQuietly();
    await waitForBoardAnimation();
    if (token !== state.taskToken) return;
  }

  if (game.game_over()) {
    await finishMatch(describeResult());
  } else {
    setStatus(describeResult());
  }
  void refreshEvaluation();
}

function getPositionSettingsKey() {
  return positionSettingsKey(state.positionBalanceCp, state.friendlyMode);
}

function generateBalancedPosition(sideToMove, token, options = {}) {
  return findBalancedPosition(sideToMove, {
    engine: state.opponentEngine, acceptanceCp: state.positionBalanceCp,
    friendlyMode: state.friendlyMode, timeoutMs: POSITION_GENERATION_TIMEOUT_MS,
    isCancelled: () => token !== state.taskToken,
    announce: (attempts) => setStatus(`Searching for a balanced position... ${attempts}`),
    ...options,
    ...(options.announce === false ? { announce: () => {} } : {}),
  });
}

function takeCachedPosition(sideToMove) {
  const settingsKey = getPositionSettingsKey();
  state.positionPool = state.positionPool.filter((candidate) => cachedPositionAccepted(candidate, state.positionBalanceCp, state.friendlyMode));
  const index = state.positionPool.findIndex((candidate) => candidate.sideToMove === sideToMove && candidate.settingsKey === settingsKey);
  if (index < 0) {
    return null;
  }
  const [candidate] = state.positionPool.splice(index, 1);
  persistPositionPool();
  return candidate;
}

function invalidatePositionPool() {
  state.positionGenerationToken += 1;
  state.positionPool = [];
  persistPositionPool();
  state.positionEngine?.cancelPending();
}

async function ensurePositionEngine() {
  if (!state.positionEngine) {
    state.positionEngine = new StockfishEngine();
  }
  try {
    await state.positionEngine.ready();
  } catch (error) {
    state.positionEngine = null;
    throw error;
  }
  return state.positionEngine;
}

async function prefetchPosition(sideToMove, settingsKey, token) {
  const engine = await ensurePositionEngine();
  const candidate = await generateBalancedPosition(sideToMove, token, {
    acceptanceCp: state.positionBalanceCp,
    announce: false,
    engine,
    friendlyMode: state.friendlyMode,
    isCancelled: () => token !== state.positionGenerationToken || settingsKey !== getPositionSettingsKey() || state.isBusy || document.hidden,
    settingsKey,
  });
  if (!candidate || token !== state.positionGenerationToken || settingsKey !== getPositionSettingsKey() || state.isBusy || document.hidden) {
    return;
  }
  if (!state.positionPool.some((item) => item.sideToMove === sideToMove && item.settingsKey === settingsKey)) {
    state.positionPool.push({ ...candidate, settingsKey, sideToMove });
    persistPositionPool();
  }
}

function prefetchPositions() {
  if (!state.engineReady || state.isBusy || document.hidden || state.positionPrefetchPromise) {
    return;
  }

  const settingsKey = getPositionSettingsKey();
  const token = state.positionGenerationToken;
  state.positionPool = state.positionPool.filter((candidate) => candidate.settingsKey === settingsKey);
  state.positionPrefetchPromise = (async () => {
    try {
      for (const sideToMove of ["w", "b"]) {
        if (state.positionPool.length >= POSITION_POOL_LIMIT || token !== state.positionGenerationToken || settingsKey !== getPositionSettingsKey()) {
          break;
        }
        if (state.positionPool.some((candidate) => candidate.sideToMove === sideToMove && candidate.settingsKey === settingsKey)) {
          continue;
        }
        await prefetchPosition(sideToMove, settingsKey, token);
      }
    } catch (error) {
      console.warn("Background position generation failed.", error);
    } finally {
      state.positionPrefetchPromise = null;
    }
  })();
}

function schedulePositionPrefetch() {
  if (state.positionPrefetchTimer) {
    window.clearTimeout(state.positionPrefetchTimer);
  }
  state.positionPrefetchTimer = window.setTimeout(() => {
    state.positionPrefetchTimer = null;
    if (state.isBusy) {
      schedulePositionPrefetch();
      return;
    }
    prefetchPositions();
  }, 1200);
}

async function startNewGame() {
  if (state.startingGame || state.importing || state.resuming) return;

  state.startingGame = true;
  resetBoardInteraction();
  const token = ++state.taskToken;
  cancelEngineSearches();
  setBusy(true);
  updateEvalBar(null);

  const actualColor = state.requestedColor === "random"
    ? (Math.random() < 0.5 ? "w" : "b")
    : state.requestedColor;

  const cachedCandidate = state.pendingStartFen ? null : takeCachedPosition(actualColor);
  setStatus(state.pendingStartFen
    ? "Loading favorite game..."
    : cachedCandidate
      ? "Loading a ready position..."
      : "Preparing a randomized position...");
  let gameStarted = false;

  try {
    if (!state.engineReady) {
      setStatus("Retrying Stockfish initialization...");
      state.opponentEngine?.dispose();
      state.opponentEngine = new StockfishEngine();
      await state.opponentEngine.ready();
      state.analysisEngine = state.opponentEngine;
      state.engineReady = true;
    }
    await terminateCurrentGame();
    if (state.session) state.matchOver = true;
    if (token !== state.taskToken) {
      return;
    }
    const candidate = state.pendingStartFen
      ? { fen: state.pendingStartFen, score: null }
      : cachedCandidate || await generateBalancedPosition(actualColor, token);
    if (!candidate || token !== state.taskToken) {
      if (token === state.taskToken) {
        setStatus("Could not find a balanced position within 15 seconds. Try again.");
      }
      return;
    }

    state.actualPlayerColor = actualColor;
    state.board.orientation(actualColor === "w" ? "white" : "black");
    state.matchOver = false;
    game.load(candidate.fen);
    state.pendingStartFen = null;
    state.initialFen = null;
    await createLocalGame(candidate.fen, candidate.score);
    state.board.position(game.fen(), false);
    renderMoveHistory();
    updateSideLabels();
    updateEvalBar(candidate.score);
    setStatus(describeResult());
    gameStarted = true;
    const evaluationToken = state.taskToken;
    window.setTimeout(() => {
      if (evaluationToken === state.taskToken && !state.isBusy) {
        void refreshEvaluation();
      }
    }, 900);
  } catch (error) {
    console.error(error);
    setStatus("Position search interrupted. Try New Game again.");
    if (error.code === "GAME_CONFLICT") handleGameConflict(error);
    else showToast(error.message);
  } finally {
    state.startingGame = false;
    if (token === state.taskToken) {
      setBusy(false);
      if (gameStarted) {
        schedulePositionPrefetch();
      }
    }
  }
  if (gameStarted && token === state.taskToken) await continuePlay();
}

function resignGame() {
  if (!state.session || state.sessionConflict || state.importing || state.matchOver || game.game_over() || state.startingGame) return;
  const loser = state.playerVsPlayer ? game.turn() : state.actualPlayerColor;
  const winnerColor = loser === "w" ? "b" : "w";
  void finishMatch(`${sideName(winnerColor)} wins by resignation.`, { result: resultForWinner(winnerColor), termination: "resignation" });
}

function resetBoardInteraction() {
  state.selectedSquare = null;
  state.suppressClickUntil = 0;
  closePromotionDialog();
  clearBoardHighlights();
}

function waitForBoardAnimation() {
  const remaining = state.animationUntil - performance.now();
  return remaining > 0 ? new Promise((resolve) => window.setTimeout(resolve, remaining)) : Promise.resolve();
}

function clearBoardHighlights() {
  document.querySelectorAll("#board .square-55d63").forEach((square) => {
    square.style.background = "";
    square.classList.remove("click-selected", "click-target");
  });
}

function isPromotionMove(source, target) {
  const piece = game.get(source);
  return Boolean(piece && piece.type === "p" && ((piece.color === "w" && target[1] === "8") || (piece.color === "b" && target[1] === "1")));
}

function closePromotionDialog() {
  state.promotionRequest = null;
  closeOverlay(ui.promotionDialog);
}

function positionPromotionPicker(target) {
  const square = document.querySelector(`#board .square-${target}`);
  if (!square || !ui.promotionDialog) return;
  const rect = square.getBoundingClientRect();
  const size = Math.max(48, Math.min(88, rect.width * 0.82));
  const gap = Math.max(3, Math.round(size * 0.05));
  const pickerHeight = size * 4 + gap * 3;
  const startsBelow = rect.top < window.innerHeight / 2;
  const top = Math.max(8, Math.min(
    startsBelow ? rect.top : rect.bottom - pickerHeight,
    window.innerHeight - pickerHeight - 8,
  ));
  const left = Math.max(8, Math.min(
    rect.left + (rect.width - size) / 2,
    window.innerWidth - size - 8,
  ));
  ui.promotionDialog.style.setProperty("--promotion-left", `${left}px`);
  ui.promotionDialog.style.setProperty("--promotion-top", `${top}px`);
  ui.promotionDialog.style.setProperty("--promotion-size", `${size}px`);
  ui.promotionDialog.style.setProperty("--promotion-gap", `${gap}px`);
}

function openPromotionDialog(source, target) {
  const piece = game.get(source);
  if (!piece) return;
  state.promotionRequest = { source, target, renderImmediately: true };
  ui.promotionDetail.textContent = `${sideName(piece.color)} pawn promotion. Choose a piece.`;
  const pieceCode = (letter) => `${piece.color}${letter.toUpperCase()}`;
  ui.promotionOptions.querySelectorAll("[data-piece]").forEach((button) => {
    const letter = button.dataset.piece;
    const image = button.querySelector("img");
    image.src = `maingame/img/chesspieces/wikipedia/${pieceCode(letter)}.png`;
    image.alt = `${letter === "q" ? "Queen" : letter === "n" ? "Knight" : letter === "r" ? "Rook" : "Bishop"} promotion`;
  });
  openOverlay(ui.promotionDialog);
  positionPromotionPicker(target);
}

function choosePromotion(piece) {
  const pending = state.promotionRequest;
  if (!pending || !["q", "n", "r", "b"].includes(piece)) return;
  closePromotionDialog();
  const move = commitMove(pending.source, pending.target, pending.renderImmediately, piece);
  if (!move) {
    state.selectedSquare = null;
    clearBoardHighlights();
  }
}

function removeGreySquares() {
  if (!state.selectedSquare) {
    clearBoardHighlights();
  }
}

function greySquare(square) {
  const squareElement = document.querySelector(`#board .square-${square}`);
  if (!squareElement) {
    return;
  }

  const styles = getComputedStyle(document.body);
  const background = squareElement.classList.contains("black-3c85d")
    ? styles.getPropertyValue("--board-highlight-dark").trim()
    : styles.getPropertyValue("--board-highlight-light").trim();
  squareElement.style.background = background;
}

function canSelectSquare(square) {
  const piece = game.get(square);
  if (!piece || isBoardLocked()) {
    return false;
  }
  return piece.color === game.turn() && (state.playerVsPlayer || piece.color === state.actualPlayerColor);
}

function showLegalMoves(square) {
  clearBoardHighlights();
  state.selectedSquare = square;
  const source = document.querySelector(`#board .square-${square}`);
  source?.classList.add("click-selected");
  game.moves({ square, verbose: true }).forEach((move) => {
    document.querySelector(`#board .square-${move.to}`)?.classList.add("click-target");
  });
}

function commitMove(source, target, renderImmediately = false, promotion = "q") {
  if (isBoardLocked() || (!state.playerVsPlayer && game.turn() !== state.actualPlayerColor)) return null;
  const move = game.move({ from: source, to: target, promotion });
  if (!move) {
    return null;
  }
  state.moveLog.push(move);
  state.animationUntil = performance.now() + (state.moveAnimation === "slide" ? (renderImmediately ? 180 : 140) : 0);
  cancelEngineSearches();
  state.selectedSquare = null;
  clearBoardHighlights();
  state.suppressClickUntil = Date.now() + 250;
  state.taskToken += 1;
  if (renderImmediately) {
    state.board.position(game.fen(), state.moveAnimation === "slide");
  }
  void afterMove();
  return move;
}

function attemptMove(source, target, renderImmediately = false) {
  const legal = game.moves({ square: source, verbose: true }).some((move) => move.to === target);
  if (legal && isPromotionMove(source, target)) {
    state.selectedSquare = null;
    clearBoardHighlights();
    openPromotionDialog(source, target);
    return "pending";
  }
  return commitMove(source, target, renderImmediately);
}

function handleSquareClick(square) {
  if (isBoardLocked() || Date.now() < state.suppressClickUntil) {
    return;
  }
  if (!state.selectedSquare) {
    if (canSelectSquare(square)) {
      showLegalMoves(square);
    }
    return;
  }

  if (square === state.selectedSquare) {
    state.selectedSquare = null;
    clearBoardHighlights();
    return;
  }

  if (canSelectSquare(square)) {
    showLegalMoves(square);
    return;
  }

  const move = attemptMove(state.selectedSquare, square, true);
  if (!move) {
    state.selectedSquare = null;
    clearBoardHighlights();
  }
}

async function afterMove() {
  const token = state.taskToken;
  if (!state.playerVsPlayer && game.turn() !== state.actualPlayerColor && !game.game_over()) setBusy(true);
  updateSideLabels();
  renderMoveHistory();
  await persistCurrentGameQuietly();
  if (token !== state.taskToken) return;
  if (game.game_over()) {
    await finishMatch(describeResult());
    return;
  }
  await continuePlay();
}

function isBoardLocked() {
  return !state.session || !state.engineReady || state.isBusy || state.importing || state.sessionConflict || state.matchOver || game.game_over();
}

function handleGameConflict(error) {
  state.sessionConflict = true;
  if (state.session) state.session.recording = false;
  ++state.taskToken;
  cancelEngineSearches();
  resetBoardInteraction();
  closeOverlay(ui.resultDialog);
  setBusy(false);
  setStatus(error.message);
  showToast("Game changed elsewhere. Resume its latest saved version from history.");
}

async function continuePlay() {
  if (state.importing || state.sessionConflict || !state.session || state.matchOver) return;
  if (game.game_over()) { await finishMatch(describeResult()); return; }
  const token = state.taskToken;
  const fen = game.fen();
  const botTurn = !state.playerVsPlayer && game.turn() !== state.actualPlayerColor;
  if (!botTurn) {
    setBusy(false);
    setStatus(describeResult());
    void refreshEvaluation();
    return;
  }
  if (state.opponentTurn?.token === token && state.opponentTurn.fen === fen) return state.opponentTurn.promise;
  const turn = { token, fen };
  state.opponentTurn = turn;
  turn.promise = (async () => {
    setBusy(true);
    try {
      await runComputerTurn(token);
    } catch (error) {
      console.error(error);
      if (error.code === "GAME_CONFLICT") handleGameConflict(error);
      else if (token === state.taskToken) setStatus("Engine interrupted. Switch to PvP or retry with New Game.");
    } finally {
      if (state.opponentTurn === turn) state.opponentTurn = null;
      if (token === state.taskToken) {
        setBusy(false);
        void refreshEvaluation();
      }
    }
  })();
  return turn.promise;
}

function createBoard() {
  const config = {
    draggable: true,
    onDragStart(source, piece) {
      if (isBoardLocked()) {
        return false;
      }
      if (piece[0] !== game.turn()) {
        return false;
      }
      if (!state.playerVsPlayer && piece[0] !== state.actualPlayerColor) {
        return false;
      }
      return true;
    },
    onDrop(source, target) {
      const move = attemptMove(source, target);
      if (move === null || move === "pending") {
        return "snapback";
      }
      return undefined;
    },
    onMouseoutSquare() {
      removeGreySquares();
    },
    onMouseoverSquare(square) {
      if (state.selectedSquare) {
        return;
      }
      const moves = game.moves({
        square,
        verbose: true,
      });
      if (moves.length === 0) {
        return;
      }
      greySquare(square);
      moves.forEach((move) => {
        greySquare(move.to);
      });
    },
    onSnapEnd() {
      state.board.position(game.fen(), false);
    },
    dragThrottleRate: 8,
    dragStartDistance: 5,
    moveSpeed: state.moveAnimation === "slide" ? 180 : 0,
    snapSpeed: state.moveAnimation === "slide" ? 140 : 0,
    snapbackSpeed: state.moveAnimation === "slide" ? 140 : 0,
    orientation: "white",
    pieceTheme: "maingame/img/chesspieces/wikipedia/{piece}.png",
    position: "start",
  };

  state.board = ChessBoard("board", config);
  if (!state.boardInteractionBound) {
    const handleBoardPress = (event) => {
      if (event.type === "touchstart" && event.cancelable) event.preventDefault();
      if (event.type === "mousedown" && event.button !== 0) {
        return;
      }
      const square = event.target.closest("[data-square]")?.dataset.square;
      if (square) {
        handleSquareClick(square);
        // A promotion opened on mousedown must keep its new keyboard focus.
        if (dialogs.active && event.cancelable) event.preventDefault();
      }
    };
    ui.board.addEventListener("mousedown", handleBoardPress);
    ui.board.addEventListener("touchstart", handleBoardPress, { passive: false });
    state.boardInteractionBound = true;
  }
  if (!state.resizeBound) {
    let resizeFrame = null;
    window.addEventListener("resize", () => {
      if (resizeFrame) {
        cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = requestAnimationFrame(() => {
        state.board.resize();
        updateEvalBar(state.lastEvalScore);
        if (state.promotionRequest) {
          positionPromotionPicker(state.promotionRequest.target);
        }
      });
    });
    state.resizeBound = true;
  }
}

function rebuildBoard() {
  const position = game.fen();
  const orientation = state.actualPlayerColor === "w" ? "white" : "black";
  state.board?.destroy?.();
  state.board = null;
  createBoard();
  state.board.orientation(orientation);
  state.board.position(position, false);
  clearBoardHighlights();
}

function closeSettings() {
  state.settingsOpen = false;
  void persistPreferences();
  syncSettingsPanel();
}

function closeSetup() {
  state.setupOpen = false;
  syncSetupPanel();
}

async function handleRecordAction(event, container) {
  const button = event.target.closest("[data-record-action]");
  if (!button) return;
  const record = await getGame(button.dataset.recordId);
  if (!record) return;
  const action = button.dataset.recordAction;
  if (action === "copy-pgn") {
    await copyPgn(buildPgn(record.startingFen, record.moves || [], resultCodeForRecord(record)));
    return;
  }
  if (action === "replay") {
    closeOverlay(container === ui.historyList ? ui.historyDialog : ui.favoritesDialog);
    openReplay(record);
    return;
  }
  if (action === "again") {
    preparePlayAgain(record.startingFen, record.playerColor, record.stockfishLevel);
    return;
  }
  if (action === "resume") { await resumeRecord(record); return; }
  if (action === "rename") {
    const label = window.prompt("Name this game", record.label || `Game ${formatDate(record.startedAt)}`);
    if (!label?.trim()) return;
    const renamed = await renameGame(record.id, label);
    if (record.id === state.currentGameId && renamed) {
      state.currentGameLabel = renamed.label;
      state.session?.patchMetadata({ label: renamed.label });
    }
  } else if (action === "favorite") {
    await setGameFavorite(record.id, !record.isFavorite);
    if (record.id === state.currentGameId) {
      state.currentGameFavorite = !record.isFavorite;
      state.session?.patchMetadata({ isFavorite: !record.isFavorite });
    }
  } else if (action === "delete") {
    if (!window.confirm("Delete this local game record?")) return;
    if (record.id === state.currentGameId) await state.session?.detach();
    await deleteGame(record.id);
  } else return;
  await refreshHistoryList();
  await refreshFavoritesList();
}

async function importSelectedBackup() {
  const file = ui.importFile.files?.[0];
  if (!file || state.importing || state.startingGame || state.resuming) return;
  const session = state.session;
  state.importing = true;
  const token = ++state.taskToken;
  cancelEngineSearches();
  resetBoardInteraction();
  setBusy(true);
  const controls = [ui.importData, ui.exportData, ui.clearHistory, ui.clearFavorites, ui.resetPreferences, ui.deleteAllData];
  controls.forEach((control) => { control.disabled = true; });
  ui.importData.textContent = "Validating...";
  try {
    const valid = await validateBackupFile(file);
    const replace = window.confirm("Press OK to replace local data, or Cancel to merge this backup.");
    // Previous saves have already reported their errors; importing may recover the archive.
    await session?.queue.catch(() => null);
    await importValidatedBackup(valid, replace ? "replace" : "merge");
    applyPreferences(valid.preferences);
    const current = session?.id ? await getGame(session.id) : null;
    if (session) await session.detach();
    if (current) {
      setCurrentRecord(current);
    } else if (session) {
      state.session = null;
      state.currentGameId = null;
      state.currentStartingFen = null;
      state.matchOver = true;
      state.sessionConflict = false;
      setStatus("Backup imported. No active saved game.");
    }
    showToast("Backup imported.");
    await refreshStorageSummary();
    await refreshHistoryList();
    await refreshFavoritesList();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not import backup.");
  } finally {
    state.importing = false;
    controls.forEach((control) => { control.disabled = false; });
    ui.importData.textContent = "Import backup";
    ui.importFile.value = "";
    if (token === state.taskToken) {
      setBusy(false);
      await continuePlay();
    }
  }
}

function applyPreferences(preferences) {
  const previousAnimation = state.moveAnimation;
  invalidatePositionPool();
  Object.assign(state, preferences);
  syncTheme();
  syncEvalVisibility();
  syncColorButtons();
  syncSettingsUI();
  if (previousAnimation !== state.moveAnimation) rebuildBoard();
}

function bindEvents() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) state.positionEngine?.cancelPending();
    else schedulePositionPrefetch();
  });
  ui.newGame.addEventListener("click", () => {
    closeOverlay(ui.resultDialog);
    state.pendingStartFen = null;
    state.setupOpen = true;
    state.settingsOpen = false;
    syncSettingsPanel();
    syncSetupPanel();
  });

  ui.startGame.addEventListener("click", () => {
    closeSetup();
    void startNewGame();
  });

  ui.setupClose.addEventListener("click", closeSetup);

  ui.setupSettings.addEventListener("click", () => {
    closeSetup();
    state.settingsOpen = true;
    void persistPreferences();
    syncSettingsPanel();
  });

  ui.undo.addEventListener("click", async () => {
    if (isBoardLocked()) return;
    const token = ++state.taskToken;
    cancelEngineSearches();
    resetBoardInteraction();
    setBusy(true);
    const movesToUndo = state.playerVsPlayer ? 1 : 2;
    for (let count = 0; count < movesToUndo; count += 1) {
      if (!game.undo()) break;
      state.moveLog.pop();
    }
    state.board.position(game.fen(), false);
    updateSideLabels();
    renderMoveHistory();
    setStatus(describeResult());
    await persistCurrentGameQuietly();
    if (token === state.taskToken) await continuePlay();
  });

  ui.resign.addEventListener("click", () => {
    resignGame();
  });

  ui.sharePosition.addEventListener("click", () => {
    void copyCurrentFen();
  });

  ui.hintButton.addEventListener("click", () => {
    void showHint();
  });

  ui.historyToggle.addEventListener("click", () => {
    state.historyOpen = !state.historyOpen;
    syncHistoryPanel();
  });

  ui.historyClose.addEventListener("click", () => {
    state.historyOpen = false;
    syncHistoryPanel();
  });

  ui.toggleMode.addEventListener("click", async () => {
    if (state.startingGame || state.importing || state.resuming || state.sessionConflict || state.matchOver || game.game_over()) return;
    state.playerVsPlayer = !state.playerVsPlayer;
    const token = ++state.taskToken;
    cancelEngineSearches();
    resetBoardInteraction();
    setBusy(false);
    state.session?.patchMetadata({ mode: state.playerVsPlayer ? "pvp" : "pvai" });
    syncModeUI();
    syncSettingsUI();
    await persistCurrentGameQuietly();
    if (token === state.taskToken) await continuePlay();
  });

  ui.themeSelect.addEventListener("change", () => {
    state.theme = ui.themeSelect.value;
    void persistPreferences();
    syncTheme();
  });

  ui.moveAnimation.addEventListener("change", () => {
    state.moveAnimation = ui.moveAnimation.value === "instant" ? "instant" : "slide";
    void persistPreferences();
    rebuildBoard();
  });

  ui.aboutToggle.addEventListener("click", () => openOverlay(ui.aboutDialog));
  ui.aboutClose.addEventListener("click", () => closeOverlay(ui.aboutDialog));
  ui.aboutDialog.addEventListener("click", (event) => {
    if (event.target === ui.aboutDialog) closeOverlay(ui.aboutDialog);
  });

  ui.settingsToggle.addEventListener("click", () => {
    if (ui.appMenu.classList.contains("hidden")) openAppMenu(); else closeAppMenu();
  });

  ui.recordsToggle.addEventListener("click", () => {
    if (ui.recordsMenu.classList.contains("hidden")) openRecordsMenu(); else closeRecordsMenu();
  });

  ui.menuClose.addEventListener("click", closeAppMenu);
  ui.recordsMenuClose.addEventListener("click", closeRecordsMenu);
  ui.appMenu.addEventListener("click", (event) => {
    if (event.target === ui.appMenu) closeAppMenu();
    const button = event.target.closest("[data-panel]");
    if (button) void openPanel(button.dataset.panel);
  });
  ui.recordsMenu.addEventListener("click", (event) => {
    if (event.target === ui.recordsMenu) closeRecordsMenu();
    const button = event.target.closest("[data-panel]");
    if (button) void openPanel(button.dataset.panel);
  });
  document.querySelectorAll("[data-back-menu]").forEach((button) => {
    button.addEventListener("click", returnToAppMenu);
  });
  document.querySelectorAll("[data-back-records]").forEach((button) => {
    button.addEventListener("click", returnToRecordsMenu);
  });
  document.querySelectorAll("[data-close-panel]").forEach((button) => {
    button.addEventListener("click", () => closePanel(document.getElementById(button.dataset.closePanel)));
  });
  document.querySelectorAll("[data-setting-info]").forEach((button) => {
    button.addEventListener("click", () => openSettingInfo(button.dataset.settingInfo));
  });
  ui.settingInfoClose.addEventListener("click", () => closeOverlay(ui.settingInfoDialog));
  ui.settingInfoDialog.addEventListener("click", (event) => {
    if (event.target === ui.settingInfoDialog) closeOverlay(ui.settingInfoDialog);
  });
  [ui.historyFilter, ui.historySort].forEach((control) => control.addEventListener("change", () => void refreshHistoryList()));
  [ui.historyList, ui.favoritesList].forEach((container) => {
    container.addEventListener("click", (event) => {
      void handleRecordAction(event, container).catch((error) => {
        console.error(error);
        showToast(error.message || "The archive action failed.");
      });
    });
  });
  ui.resumeGame.addEventListener("click", async () => { if (state.resumeRecord) await resumeRecord(state.resumeRecord); });

  ui.resumeNewGame.addEventListener("click", async () => {
    const record = state.resumeRecord;
    closeOverlay(ui.resumeDialog);
    state.resumeRecord = null;
    try {
      await terminateGameRecord(record);
      await startNewGame();
    } catch (error) {
      console.error(error);
      showToast("Could not start a new game.");
    }
  });
  ui.resumeClose.addEventListener("click", () => closeOverlay(ui.resumeDialog));
  ui.promotionOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-piece]");
    if (button) choosePromotion(button.dataset.piece);
  });
  ui.promotionDialog.addEventListener("click", (event) => {
    if (event.target === ui.promotionDialog) closePromotionDialog();
  });
  ui.replayClose.addEventListener("click", () => closeOverlay(ui.replayDialog));
  ui.replayFirst.addEventListener("click", () => { state.replay.index = 0; renderReplay(); });
  ui.replayPrev.addEventListener("click", () => { state.replay.index = Math.max(0, state.replay.index - 1); renderReplay(); });
  ui.replayNext.addEventListener("click", () => { state.replay.index = Math.min(state.replay.record?.moves?.length || 0, state.replay.index + 1); renderReplay(); });
  ui.replayLast.addEventListener("click", () => { state.replay.index = state.replay.record?.moves?.length || 0; renderReplay(); });
  ui.exportData.addEventListener("click", async () => { try { const backup = await exportBackup(); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" })); link.download = `Ultra-Fischer-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); showToast("Backup exported."); } catch (error) { console.error(error); showToast("Could not export local data."); } });
  ui.importData.addEventListener("click", () => ui.importFile.click());
  ui.importFile.addEventListener("change", () => void importSelectedBackup());
  ui.clearHistory.addEventListener("click", async () => { if (window.confirm("Clear all local game history?")) { await state.session?.detach(); await clearGames(); await refreshStorageSummary(); await refreshHistoryList(); await refreshFavoritesList(); showToast("Game history cleared."); } });
  ui.clearFavorites.addEventListener("click", async () => { if (window.confirm("Remove all games from Favorite Games?")) { await clearGameFavorites(); state.currentGameFavorite = false; state.session?.patchMetadata({ isFavorite: false }); await refreshStorageSummary(); await refreshFavoritesList(); await refreshHistoryList(); showToast("Favorite games cleared."); } });
  ui.resetPreferences.addEventListener("click", async () => { if (window.confirm("Reset local preferences?")) { applyPreferences(await resetPreferences()); await persistPreferences(); showToast("Preferences reset."); } });
  ui.deleteAllData.addEventListener("click", async () => {
    if (window.prompt("Type DELETE to remove all local games, favorite games, and preferences.") !== "DELETE") return;
    ui.deleteAllData.disabled = true;
    try {
      await state.session?.detach();
      await deleteAllData();
      applyPreferences(await getPreferences());
      showToast("All local data deleted.");
      await refreshStorageSummary();
      await refreshHistoryList();
      await refreshFavoritesList();
    } catch (error) {
      console.error(error);
      showToast("Could not delete all local data. Check storage and try again.");
    } finally {
      ui.deleteAllData.disabled = false;
    }
  });

  ui.settingsClose.addEventListener("click", closeSettings);

  ui.settingsCard.addEventListener("click", (event) => {
    if (event.target === ui.settingsCard) {
      closeSettings();
    }
  });

  ui.newGameDialog.addEventListener("click", (event) => {
    if (event.target === ui.newGameDialog) {
      closeSetup();
    }
  });

  ui.resultClose.addEventListener("click", () => closeOverlay(ui.resultDialog));
  ui.resultDismiss.addEventListener("click", () => closeOverlay(ui.resultDialog));
  ui.resultNewGame.addEventListener("click", () => {
    closeOverlay(ui.resultDialog);
    ui.newGame.click();
  });
  ui.resultDialog.addEventListener("click", (event) => {
    if (event.target === ui.resultDialog) closeOverlay(ui.resultDialog);
  });

  ui.evalToggle.addEventListener("click", async () => {
    state.evalVisible = !state.evalVisible;
    state.evalVisibilityConfigured = true;
    void persistPreferences();
    syncEvalVisibility();
    if (state.evalVisible) {
      await refreshEvaluation();
    }
  });

  ui.evalSettingToggle.addEventListener("click", async () => {
    state.evalVisible = !state.evalVisible;
    state.evalVisibilityConfigured = true;
    void persistPreferences();
    syncEvalVisibility();
    if (state.evalVisible) {
      await refreshEvaluation();
    }
  });

  ui.colorButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.requestedColor = button.dataset.color;
      void persistPreferences();
      syncColorButtons();
    });
  });

  ui.positionBalance.addEventListener("change", () => {
    const nextBalance = normalizePositionBalance(ui.positionBalance.value);
    if (nextBalance !== state.positionBalanceCp) {
      invalidatePositionPool();
    }
    state.positionBalanceCp = nextBalance;
    void persistPreferences();
    syncSettingsUI();
  });

  ui.friendlyModeToggle.addEventListener("click", () => {
    state.friendlyMode = !state.friendlyMode;
    invalidatePositionPool();
    void persistPreferences();
    syncSettingsUI();
  });

  ui.aiStrength.addEventListener("change", async () => {
    if (state.importing || state.resuming || state.sessionConflict) return;
    state.aiStrength = normalizeLevel(ui.aiStrength.value);
    void persistPreferences();
    if (state.session && !state.matchOver && !game.game_over()) {
      const token = ++state.taskToken;
      cancelEngineSearches();
      state.session.setDifficulty(Number(state.aiStrength), state.moveLog.length);
      syncSettingsUI();
      await persistCurrentGameQuietly();
      if (token === state.taskToken) await continuePlay();
    } else {
      syncSettingsUI();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    const active = dialogs.active;
    if (active) {
      event.preventDefault();
      if (active === ui.settingsCard) closeSettings();
      else if (active === ui.newGameDialog) closeSetup();
      else if (active === ui.appMenu) closeAppMenu();
      else if (active === ui.recordsMenu) closeRecordsMenu();
      else if (active === ui.promotionDialog) closePromotionDialog();
      else closePanel(active);
      return;
    }
    state.historyOpen = false;
    syncHistoryPanel();
  });
}

async function init() {
  try {
    Object.assign(state, await getPreferences());
    if (!state.evalVisibilityConfigured) {
      state.evalVisible = false;
    }
    state.aiStrength = normalizeLevel(state.aiStrength);
    state.moveAnimation = state.moveAnimation === "instant" ? "instant" : "slide";
    state.positionBalanceCp = normalizePositionBalance(state.positionBalanceCp);
    state.friendlyMode = state.friendlyMode !== false;
    state.positionPool = (await loadPositionPool()).filter((candidate) => candidate.settingsKey === getPositionSettingsKey());
  } catch (error) {
    console.warn("Local preferences could not be loaded.", error);
  }
  syncTheme();
  syncEvalVisibility();
  syncColorButtons();
  syncModeUI();
  syncSettingsUI();
  syncSettingsPanel();
  syncSetupPanel();
  syncHistoryPanel();
  renderMoveHistory();
  createBoard();
  bindEvents();
  updateEvalBar(null);

  const previewColor = state.requestedColor === "random"
    ? (Math.random() < 0.5 ? "w" : "b")
    : state.requestedColor;
  state.actualPlayerColor = previewColor;
  state.initialColor = previewColor;
  state.initialFen = generatePosition(previewColor);
  game.load(state.initialFen);
  state.board.orientation(previewColor === "w" ? "white" : "black");
  state.board.position(state.initialFen, false);
  renderMoveHistory();
  updateSideLabels();
  setStatus("Loading Stockfish...");

  try {
    setStatus("Loading Stockfish...");
    state.opponentEngine = new StockfishEngine();
    await state.opponentEngine.ready();
    state.analysisEngine = state.opponentEngine;
    state.engineReady = true;
    setBusy(false);
    setStatus("Engine ready.");
    try {
      const { items: unfinished } = await listGamesPage({ filter: "in_progress", limit: 1 });
      if (unfinished[0]) {
        state.resumeRecord = unfinished[0];
        ui.resumeDetail.textContent = `${sideName(unfinished[0].playerColor)} vs Stockfish Level ${unfinished[0].stockfishLevel} · ${unfinished[0].moveCount || 0} moves · updated ${formatDate(unfinished[0].updatedAt)}`;
        openOverlay(ui.resumeDialog);
      } else {
        await startNewGame();
      }
    } catch (error) {
      console.error(error);
      showToast("Local history is unavailable; this game will remain in memory.");
      await startNewGame();
    }
  } catch (error) {
    console.error(error);
    setBusy(false);
    setStatus("Engine failed to load. New Game retries initialization.");
  }
}

init();
