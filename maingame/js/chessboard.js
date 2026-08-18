import {
  ANALYSIS_PROFILE,
  getLevelConfig,
  resolveEngineDifficulty,
  selectCandidateMove,
} from "./stockfish-config.mjs";
import {
  areBishopsOnOppositeColors,
  getBishopPlacementCandidates,
  getSquareColor,
} from "./position-utils.mjs";
import {
  clearGames,
  clearSavedPositions,
  createGame,
  deleteAllData,
  deleteGame,
  deleteSavedPosition,
  exportBackup,
  getPreferences,
  getStatistics,
  getStorageSummary,
  importBackup,
  listGames,
  listSavedPositions,
  resetPreferences,
  savePosition,
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

function normalizeLevel(value) {
  const migratedValue = LEGACY_LEVELS[value] || value;
  return /^[1-8]$/.test(migratedValue) ? migratedValue : "4";
}

const ui = {
  aiStrength: document.getElementById("ai-strength"),
  aiStrengthDetail: document.getElementById("ai-strength-detail"),
  board: document.getElementById("board"),
  colorButtons: Array.from(document.querySelectorAll(".color-button")),
  evalDepth: document.getElementById("eval-depth"),
  evalFill: document.getElementById("eval-fill"),
  evalLabel: document.getElementById("eval-label"),
  evalMarker: document.getElementById("eval-marker"),
  evalSettingToggle: document.getElementById("eval-setting-toggle"),
  evalToggle: document.getElementById("eval-toggle"),
  historyClose: document.getElementById("history-close"),
  historyToggle: document.getElementById("history-toggle"),
  appMenu: document.getElementById("app-menu"),
  menuClose: document.getElementById("menu-close"),
  historyDialog: document.getElementById("history-dialog"),
  historyList: document.getElementById("history-list"),
  historyFilter: document.getElementById("history-filter"),
  historySort: document.getElementById("history-sort"),
  positionsDialog: document.getElementById("positions-dialog"),
  positionsList: document.getElementById("positions-list"),
  statisticsDialog: document.getElementById("statistics-dialog"),
  statisticsContent: document.getElementById("statistics-content"),
  dataDialog: document.getElementById("data-dialog"),
  storageSummary: document.getElementById("storage-summary"),
  exportData: document.getElementById("export-data"),
  importData: document.getElementById("import-data"),
  importFile: document.getElementById("import-file"),
  clearHistory: document.getElementById("clear-history"),
  clearPositions: document.getElementById("clear-positions"),
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
  copyPgn: document.getElementById("copy-pgn"),
  downloadPgn: document.getElementById("download-pgn"),
  hintButton: document.getElementById("hint-button"),
  modePill: document.getElementById("mode-pill"),
  moveHistory: document.getElementById("move-history"),
  newGame: document.getElementById("new-game"),
  newGameDialog: document.getElementById("new-game-dialog"),
  opponentLabel: document.getElementById("opponent-label"),
  playerColorLabel: document.getElementById("player-color-label"),
  recordColor: document.getElementById("record-color"),
  recordTurn: document.getElementById("record-turn"),
  positionDepth: document.getElementById("position-depth"),
  resign: document.getElementById("resign"),
  settingsCard: document.getElementById("settings-card"),
  settingsClose: document.getElementById("settings-close"),
  settingsCaption: document.getElementById("settings-caption"),
  settingsToggle: document.getElementById("settings-toggle"),
  sharePosition: document.getElementById("share-position"),
  savePosition: document.getElementById("save-position"),
  statusText: document.getElementById("status-text"),
  themeToggle: document.getElementById("theme-toggle"),
  toast: document.getElementById("toast"),
  toggleMode: document.getElementById("toggle-mode"),
  turnLabel: document.getElementById("turn-label"),
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
  evalVisible: true,
  isBusy: true,
  lastEvalScore: null,
  matchOver: false,
  historyOpen: false,
  playerVsPlayer: false,
  positionDepth: 12,
  requestedColor: "w",
  setupOpen: false,
  settingsOpen: false,
  taskToken: 0,
  theme: "dark",
  toastTimer: null,
  opponentEngine: null,
  currentGameId: null,
  currentGameFavorite: false,
  currentStartingFen: null,
  pendingStartFen: null,
  resumeRecord: null,
  replay: { board: null, game: null, record: null, index: 0 },
};

class StockfishEngine {
  constructor() {
    const supportsWasm =
      typeof WebAssembly === "object" &&
      WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
    this.workerSources = supportsWasm
      ? ["./engines/stockfish.wasm.js", "./engines/stockfish.js"]
      : ["./engines/stockfish.js"];
    this.worker = null;
    this.queue = Promise.resolve();
    this.currentTask = null;
    this.options = {};
    this.readySent = false;
    this.initPromise = this.initialize();
  }

  async initialize() {
    let lastError = null;
    for (const source of this.workerSources) {
      try {
        await this.startWorker(source);
        return;
      } catch (error) {
        lastError = error;
        this.worker?.terminate();
        this.worker = null;
      }
    }
    throw lastError || new Error("No Stockfish worker could be started.");
  }

  startWorker(source) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(source, import.meta.url));
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        fail(new Error(`Stockfish worker timed out while loading (${source}).`));
      }, 15000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.initResolver = null;
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(`Stockfish worker failed to load (${source}).`));
      };

      this.worker = worker;
      this.readySent = false;
      this.options = {};
      this.initResolver = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      worker.addEventListener("message", this.handleMessage.bind(this));
      worker.addEventListener("error", (event) => fail(event.error || event), { once: true });
      worker.addEventListener("messageerror", () => fail(new Error(`Stockfish worker message failed (${source}).`)), { once: true });
      worker.postMessage("uci");
    });
  }

  handleMessage(event) {
    const line = String(event.data || "").trim();
    if (!line) {
      return;
    }

    const optionMatch = line.match(/^option name (.+?) type (\w+)(.*)$/);
    if (optionMatch) {
      const optionName = optionMatch[1].trim();
      const optionDetails = optionMatch[3];
      const minMatch = optionDetails.match(/\bmin (-?\d+)/);
      const maxMatch = optionDetails.match(/\bmax (-?\d+)/);
      this.options[optionName.toLowerCase()] = {
        name: optionName,
        type: optionMatch[2],
        min: minMatch ? Number(minMatch[1]) : null,
        max: maxMatch ? Number(maxMatch[1]) : null,
      };
      return;
    }

    if (!this.readySent && line === "uciok") {
      this.readySent = true;
      this.worker.postMessage("isready");
      return;
    }

    if (this.initResolver && line === "readyok") {
      const resolve = this.initResolver;
      resolve();
      return;
    }

    if (!this.currentTask) {
      return;
    }

    const depthMatch = line.match(/\bdepth (\d+)/);
    const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/);
    const multiPvMatch = line.match(/\bmultipv (\d+)/);
    const pvMatch = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
    if (depthMatch && scoreMatch) {
      const depth = Number(depthMatch[1]);
      const multiPv = Number(multiPvMatch?.[1] || 1);
      const score = {
        type: scoreMatch[1],
        value: Number(scoreMatch[2]),
        depth,
      };
      if (depth >= this.currentTask.depth) {
        this.currentTask.depth = depth;
        if (multiPv === 1) {
          this.currentTask.score = score;
        }
      }
      if (pvMatch) {
        this.currentTask.candidates.set(multiPv, {
          move: pvMatch[1],
          score,
        });
      }
    }

    if (line.startsWith("bestmove")) {
      const match = line.match(/^bestmove (\S+)/);
      const bestMove =
        match && match[1] && match[1] !== "(none)" ? match[1] : null;
      const selectedMove =
        selectCandidateMove(
          Array.from(this.currentTask.candidates.values()),
          this.currentTask.config.candidateCount
        ) || bestMove;
      const resolve = this.currentTask.resolve;
      const payload = {
        bestMove: selectedMove,
        score: this.currentTask.score,
        config: this.currentTask.config,
      };
      this.currentTask = null;
      resolve(payload);
    }
  }

  ready() {
    return this.initPromise;
  }

  search(fen, profile) {
    const config = resolveEngineDifficulty(profile, this.options);
    this.queue = this.queue.then(
      () =>
        new Promise((resolve) => {
          this.currentTask = {
            depth: 0,
            candidates: new Map(),
            config,
            resolve,
            score: null,
          };
          this.worker.postMessage("stop");
          this.worker.postMessage("ucinewgame");
          if (this.options["skill level"]) {
            this.worker.postMessage(`setoption name Skill Level value ${config.nativeSkill}`);
          }
          if (this.options["uci_limitstrength"]) {
            this.worker.postMessage(
              `setoption name UCI_LimitStrength value ${config.useLimitStrength}`
            );
          }
          if (config.useLimitStrength && this.options["uci_elo"]) {
            this.worker.postMessage(`setoption name UCI_Elo value ${config.elo}`);
          }
          if (this.options.multipv) {
            this.worker.postMessage(`setoption name MultiPV value ${config.candidateCount}`);
          }
          this.worker.postMessage(`position fen ${fen}`);
          this.worker.postMessage(`go depth ${config.depth} movetime ${config.moveTime}`);
        })
    );
    return this.queue;
  }
}

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
  if (game.in_draw()) {
    return { result: "draw", termination: "draw", resultCode: "1/2-1/2" };
  }
  if (game.in_checkmate()) {
    const winner = game.turn() === "w" ? "b" : "w";
    return { result: resultForWinner(winner), termination: "checkmate", resultCode: winner === "w" ? "1-0" : "0-1" };
  }
  return { result: null, termination: "in_progress", resultCode: "*" };
}

function buildPgn(startingFen, moves, resultCode = "*") {
  const replay = new Chess(startingFen);
  replay.header("Event", "Ultra Fischer", "SetUp", "1", "FEN", startingFen, "Result", resultCode);
  for (const san of moves) {
    if (!replay.move(san)) {
      break;
    }
  }
  return replay.pgn();
}

async function saveCurrentGame(overrides = {}) {
  if (!state.currentStartingFen) {
    return null;
  }
  const now = Date.now();
  const detected = gameResult();
  const result = overrides.result || detected.result;
  const termination = overrides.termination || detected.termination;
  const resultCode = result === "draw" ? "1/2-1/2" : result === "win" ? (state.actualPlayerColor === "w" ? "1-0" : "0-1") : result === "loss" ? (state.actualPlayerColor === "w" ? "0-1" : "1-0") : "*";
  const record = {
    id: state.currentGameId,
    startingFen: state.currentStartingFen,
    currentFen: game.fen(),
    playerColor: state.actualPlayerColor,
    engineColor: state.actualPlayerColor === "w" ? "b" : "w",
    stockfishLevel: Number(state.aiStrength),
    status: result ? "completed" : "in_progress",
    result,
    termination,
    moves: game.history(),
    pgn: buildPgn(state.currentStartingFen, game.history(), resultCode),
    isFavorite: state.currentGameFavorite,
    startedAt: state.currentStartedAt || now,
    updatedAt: now,
    finishedAt: result ? (state.currentFinishedAt || now) : null,
    initialEvaluation: state.currentInitialEvaluation || null,
    finalEvaluation: state.lastEvalScore || null,
    moveCount: game.history().length,
  };
  const saved = state.currentGameId ? await updateGame(record) : await createGame(record);
  state.currentGameId = saved.id;
  state.currentStartedAt = saved.startedAt;
  state.currentFinishedAt = saved.finishedAt;
  state.currentGameFavorite = saved.isFavorite;
  return saved;
}

async function persistCurrentGameQuietly() {
  try {
    await saveCurrentGame();
  } catch (error) {
    console.error(error);
    showToast("Local storage is unavailable; this game is still playable.");
  }
}

async function createLocalGame(startingFen, score = null) {
  state.currentGameId = null;
  state.currentStartingFen = startingFen;
  state.currentStartedAt = Date.now();
  state.currentFinishedAt = null;
  state.currentInitialEvaluation = score;
  state.currentGameFavorite = false;
  await persistCurrentGameQuietly();
}

function closeOverlay(element) {
  if (!element) return;
  element.classList.add("hidden");
  element.setAttribute("aria-hidden", "true");
}

function openOverlay(element) {
  if (!element) return;
  element.classList.remove("hidden");
  element.setAttribute("aria-hidden", "false");
}

function closeAppMenu() {
  closeOverlay(ui.appMenu);
  ui.settingsToggle.setAttribute("aria-expanded", "false");
}

function openAppMenu() {
  state.settingsOpen = false;
  closeOverlay(ui.settingsCard);
  openOverlay(ui.appMenu);
  ui.settingsToggle.setAttribute("aria-expanded", "true");
}

function loadRecordIntoGame(record) {
  if (!game.load(record.startingFen)) {
    throw new Error("This saved game has an invalid starting position.");
  }
  for (const san of record.moves || []) {
    if (!game.move(san)) {
      throw new Error("This saved game contains an invalid move.");
    }
  }
  if (record.currentFen && game.fen() !== record.currentFen) {
    console.warn("Saved move history and current FEN differed; keeping the replayable move history.");
  }
}

async function persistPreferences() {
  try {
    await savePreferences({ aiStrength: state.aiStrength, evalVisible: state.evalVisible, positionDepth: state.positionDepth, requestedColor: state.requestedColor, settingsOpen: state.settingsOpen, theme: state.theme });
  } catch (error) {
    console.error(error);
    showToast("Preferences could not be saved.");
  }
}

function setCurrentRecord(record) {
  loadRecordIntoGame(record);
  state.currentGameId = record.id;
  state.currentStartingFen = record.startingFen;
  state.currentStartedAt = record.startedAt;
  state.currentFinishedAt = record.finishedAt;
  state.currentInitialEvaluation = record.initialEvaluation || null;
  state.currentGameFavorite = Boolean(record.isFavorite);
  state.actualPlayerColor = record.playerColor;
  state.aiStrength = normalizeLevel(record.stockfishLevel);
  state.matchOver = record.status === "completed";
  state.board.orientation(state.actualPlayerColor === "w" ? "white" : "black");
  state.board.position(game.fen(), false);
  syncSettingsUI();
  updateSideLabels();
  renderMoveHistory();
  updateEvalBar(record.finalEvaluation || record.initialEvaluation || null);
  setStatus(state.matchOver ? describeResult() : describeResult());
}

function syncTheme() {
  document.body.dataset.theme = state.theme;
  ui.themeToggle.textContent = state.theme === "dark" ? "Light" : "Dark";
  ui.settingsCaption.textContent = `${state.theme === "dark" ? "Dark" : "Light"} interface`;
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
  ui.positionDepth.value = String(state.positionDepth);
  ui.aiStrength.value = state.aiStrength;
  ui.aiStrengthDetail.textContent = `Depth ${level.depth} · ${level.moveTime} ms search`;
  ui.setupLevelLabel.textContent = `Level ${state.aiStrength} · ${level.moveTime} ms`;
  ui.opponentLabel.textContent = state.playerVsPlayer
    ? "Local opponent"
    : `Stockfish Level ${state.aiStrength}`;
}

function syncSettingsPanel() {
  ui.settingsCard.classList.toggle("hidden", !state.settingsOpen);
  ui.settingsCard.setAttribute("aria-hidden", String(!state.settingsOpen));
}

function syncSetupPanel() {
  ui.newGameDialog.classList.toggle("hidden", !state.setupOpen);
  ui.newGameDialog.setAttribute("aria-hidden", String(!state.setupOpen));
}

function syncHistoryPanel() {
  document.body.classList.toggle("history-open", state.historyOpen);
  ui.historyToggle.setAttribute("aria-expanded", String(state.historyOpen));
}

function makeButton(label, action, id) {
  const button = document.createElement("button");
  button.className = "compact-button secondary";
  button.type = "button";
  button.textContent = label;
  button.dataset.recordAction = action;
  button.dataset.recordId = id;
  return button;
}

function renderHistoryList(games) {
  ui.historyList.innerHTML = "";
  if (!games.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No games match this filter yet.";
    ui.historyList.appendChild(empty);
    return;
  }
  for (const record of games) {
    const item = document.createElement("article");
    item.className = "record-item";
    const main = document.createElement("div");
    main.className = "record-item-main";
    const title = document.createElement("strong");
    title.className = "record-item-title";
    title.textContent = `${record.status === "completed" ? record.result || "Finished" : "In progress"} - ${sideName(record.playerColor)} vs Level ${record.stockfishLevel}`;
    const detail = document.createElement("span");
    detail.className = "record-item-detail";
    detail.textContent = `${formatDate(record.updatedAt)} · ${record.moveCount || 0} moves${record.isFavorite ? " · Favorite" : ""}`;
    const meta = document.createElement("span");
    meta.className = "record-item-meta";
    meta.textContent = record.termination ? record.termination.replaceAll("_", " ") : "In progress";
    main.append(title, detail, meta);
    const actions = document.createElement("div");
    actions.className = "record-item-actions";
    const favorite = makeButton(record.isFavorite ? "Unfavorite" : "Favorite", "favorite", record.id);
    favorite.classList.add("favorite-button");
    actions.appendChild(favorite);
    if (record.status === "in_progress") actions.appendChild(makeButton("Resume", "resume", record.id));
    actions.appendChild(makeButton("Replay", "replay", record.id));
    actions.appendChild(makeButton("Play Again", "again", record.id));
    actions.appendChild(makeButton("Delete", "delete", record.id));
    item.append(main, actions);
    ui.historyList.appendChild(item);
  }
}

async function refreshHistoryList() {
  try {
    const filter = ui.historyFilter.value;
    const games = await listGames({ favorite: filter === "favorite", sort: ui.historySort.value });
    renderHistoryList(games.filter((record) => filter === "all" || filter === "favorite" || (filter === "in_progress" && record.status === "in_progress") || record.result === filter));
  } catch (error) {
    console.error(error);
    ui.historyList.textContent = "Local game history is unavailable in this browser.";
  }
}

function renderPositionsList(positions) {
  ui.positionsList.innerHTML = "";
  if (!positions.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No saved positions yet. Save the current board from the game controls.";
    ui.positionsList.appendChild(empty);
    return;
  }
  for (const position of positions) {
    const item = document.createElement("article");
    item.className = "record-item";
    const main = document.createElement("div");
    main.className = "record-item-main";
    const title = document.createElement("strong");
    title.className = "record-item-title";
    title.textContent = position.label;
    const detail = document.createElement("span");
    detail.className = "record-item-detail";
    detail.textContent = `${sideName(position.playerColor)} · Level ${position.stockfishLevel} · ${formatDate(position.createdAt)}`;
    const fen = document.createElement("span");
    fen.className = "record-item-meta";
    fen.textContent = position.fen;
    main.append(title, detail, fen);
    const actions = document.createElement("div");
    actions.className = "record-item-actions";
    const white = makeButton("Play White", "position-white", position.id);
    const black = makeButton("Play Black", "position-black", position.id);
    actions.append(white, black, makeButton("Delete", "position-delete", position.id));
    item.append(main, actions);
    ui.positionsList.appendChild(item);
  }
}

async function refreshPositionsList() {
  try {
    renderPositionsList(await listSavedPositions());
  } catch (error) {
    console.error(error);
    ui.positionsList.textContent = "Saved positions are unavailable in this browser.";
  }
}

async function refreshStatistics() {
  const stats = await getStatistics();
  ui.statisticsContent.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "statistics-grid";
  for (const [label, value] of [["Games", stats.total], ["Wins", stats.wins], ["Draws", stats.draws], ["Losses", stats.losses]]) {
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
  rate.textContent = `Win rate: ${stats.winRate}%`;
  ui.statisticsContent.appendChild(rate);
  const table = document.createElement("div");
  table.className = "level-table";
  for (const value of ["Level", "Games", "Wins", "Draws", "Losses"]) {
    const cell = document.createElement("span");
    cell.textContent = value;
    table.appendChild(cell);
  }
  for (const level of Object.keys(stats.levels).sort((a, b) => Number(a) - Number(b))) {
    const row = stats.levels[level];
    for (const value of [level, row.total, row.wins, row.draws, row.losses]) {
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
  ui.storageSummary.textContent = `${summary.games.length} saved games · ${summary.positions.length} saved positions${usage}`;
}

async function openPanel(panel) {
  closeAppMenu();
  const panels = { history: ui.historyDialog, positions: ui.positionsDialog, statistics: ui.statisticsDialog, data: ui.dataDialog, settings: ui.settingsCard };
  const element = panels[panel];
  if (!element) return;
  openOverlay(element);
  if (panel === "history") await refreshHistoryList();
  if (panel === "positions") await refreshPositionsList();
  if (panel === "statistics") await refreshStatistics();
  if (panel === "data") await refreshStorageSummary();
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
  closeOverlay(ui.positionsDialog);
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
  (record.moves || []).forEach((move, index) => {
    const button = document.createElement("button");
    button.className = "replay-move";
    button.type = "button";
    button.dataset.index = String(index + 1);
    button.textContent = `${Math.floor(index / 2) + 1}${index % 2 ? "..." : "."} ${move}`;
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
  ui.undo.disabled = isBusy;
  ui.hintButton.disabled = isBusy;
  ui.startGame.disabled = isBusy;
  ui.colorButtons.forEach((button) => {
    button.disabled = isBusy;
  });
}

async function finishMatch(message, overrides = {}) {
  state.matchOver = true;
  setBusy(false);
  setStatus(message);
  try {
    await saveCurrentGame(overrides);
  } catch (error) {
    console.error(error);
    showToast("The game ended, but the local record could not be saved.");
  }
}

function updateSideLabels() {
  ui.playerColorLabel.textContent = sideName(state.actualPlayerColor);
  const turn = `${sideName(game.turn())} to move`;
  ui.turnLabel.textContent = turn;
  ui.recordColor.textContent = `You: ${sideName(state.actualPlayerColor)}`;
  ui.recordTurn.textContent = turn;
}

function renderMoveHistory() {
  const moves = game.history();
  ui.moveHistory.innerHTML = "";

  if (moves.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No moves yet.";
    ui.moveHistory.appendChild(empty);
    return;
  }

  for (let i = 0; i < moves.length; i += 2) {
    const row = document.createElement("div");
    row.className = "history-row";

    const number = document.createElement("span");
    number.className = "move-number";
    number.textContent = `${Math.floor(i / 2) + 1}.`;

    const white = document.createElement("span");
    white.className = "move-cell";
    white.textContent = moves[i] || "";

    const black = document.createElement("span");
    black.className = "move-cell";
    black.textContent = moves[i + 1] || "";

    row.appendChild(number);
    row.appendChild(white);
    row.appendChild(black);
    ui.moveHistory.appendChild(row);
  }

  ui.moveHistory.scrollTop = ui.moveHistory.scrollHeight;
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
  ui.evalDepth.textContent = score ? `Depth ${score.depth || "--"}` : "Depth --";

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

async function refreshEvaluation(depth = 8) {
  if (!state.evalVisible || !state.engineReady) {
    return;
  }

  const token = state.taskToken;
  const result = await state.analysisEngine.search(game.fen(), {
    ...ANALYSIS_PROFILE,
    depth,
    moveTime: Math.max(250, Math.min(700, depth * 45)),
  });
  if (token !== state.taskToken) {
    return;
  }
  updateEvalBar(normalizeScoreForWhite(result.score, game.turn()));
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

async function copyCurrentPgn() {
  const pgn = buildPgn(state.currentStartingFen || game.fen(), game.history(), gameResult().resultCode);
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

function downloadCurrentPgn() {
  const pgn = buildPgn(state.currentStartingFen || game.fen(), game.history(), gameResult().resultCode);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([pgn], { type: "application/x-chess-pgn" }));
  link.download = `ultra-fischer-${new Date().toISOString().slice(0, 10)}.pgn`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("PGN download started.");
}

async function saveCurrentPosition() {
  const label = window.prompt("Name this position", "Saved position");
  if (label === null) return;
  try {
    await savePosition({ fen: game.fen(), label: label.trim() || "Saved position", playerColor: state.actualPlayerColor, stockfishLevel: state.aiStrength });
    showToast("Position saved locally.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not save position.");
  }
}

async function showHint() {
  if (!state.engineReady) {
    showToast("Engine is still loading.");
    return;
  }

  setStatus("Analyzing hint...");
  const token = state.taskToken;
  const result = await state.analysisEngine.search(game.fen(), {
    ...ANALYSIS_PROFILE,
    depth: 12,
    moveTime: 550,
  });
  if (token !== state.taskToken) {
    return;
  }

  const san = bestMoveToSan(result.bestMove);
  if (san) {
    showToast(`Best move: ${san}`);
    setStatus(`Hint ready: ${san}`);
  } else {
    showToast("No legal move available.");
    setStatus(describeResult());
  }
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
  if (state.playerVsPlayer || game.game_over()) {
    return;
  }

  const level = getLevelConfig(state.aiStrength);
  setStatus(`Stockfish Level ${state.aiStrength} is thinking...`);
  const result = await state.opponentEngine.search(game.fen(), level);
  if (token !== state.taskToken || state.playerVsPlayer) {
    return;
  }

  if (result.bestMove) {
    const move = {
      from: result.bestMove.slice(0, 2),
      to: result.bestMove.slice(2, 4),
      promotion: result.bestMove[4] || "q",
    };
    game.move(move);
    state.board.position(game.fen());
    renderMoveHistory();
    updateSideLabels();
    await persistCurrentGameQuietly();
  }

  if (game.game_over()) {
    await finishMatch(describeResult());
  } else {
    setStatus(describeResult());
  }
  await refreshEvaluation(8);
}

function getRandomPosition(start, end, exclusions) {
  const available = [];
  for (let square = start; square < end; square += 1) {
    if (!exclusions.includes(square)) {
      available.push(square);
    }
  }
  return available[Math.floor(Math.random() * available.length)];
}

function generatePosition(sideToMove) {
  const board = Array.from(
    "         \n         \n ........\n ........\n ........\n ........\n ........\n ........\n ........\n ........\n         \n         \n"
  );
  const exclusions = [];
  const whitePieces = "PPPPPPPPRNBQKBNR";
  const blackPieces = "pppppppprnbqkbnr";
  const directions = {
    N: -10,
    E: 1,
    S: 10,
    W: -1,
  };
  const whiteDirections = {
    P: [directions.N + directions.W, directions.N + directions.E],
    N: [
      directions.N + directions.N + directions.E,
      directions.E + directions.N + directions.E,
      directions.E + directions.S + directions.E,
      directions.S + directions.S + directions.E,
      directions.S + directions.S + directions.W,
      directions.W + directions.S + directions.W,
      directions.W + directions.N + directions.W,
      directions.N + directions.N + directions.W,
    ],
    B: [
      directions.N + directions.E,
      directions.S + directions.E,
      directions.S + directions.W,
      directions.N + directions.W,
    ],
    R: [directions.N, directions.E, directions.S, directions.W],
    Q: [
      directions.N,
      directions.E,
      directions.S,
      directions.W,
      directions.N + directions.E,
      directions.S + directions.E,
      directions.S + directions.W,
      directions.N + directions.W,
    ],
    K: [
      directions.N,
      directions.E,
      directions.S,
      directions.W,
      directions.N + directions.E,
      directions.S + directions.E,
      directions.S + directions.W,
      directions.N + directions.W,
    ],
  };
  const blackDirections = {
    p: [directions.S + directions.W, directions.S + directions.E],
    n: whiteDirections.N,
    b: whiteDirections.B,
    r: whiteDirections.R,
    q: whiteDirections.Q,
    k: whiteDirections.K,
  };

  const edgeSquares = [
    ...Array.from({ length: 20 }, (_, index) => index),
    ...Array.from({ length: 20 }, (_, index) => index + 100),
    ...Array.from({ length: 8 }, (_, index) => 20 + index * 10),
    ...Array.from({ length: 8 }, (_, index) => 29 + index * 10),
  ];
  exclusions.push(...edgeSquares);

  const setPieces = (pieces, ranges) => {
    let bishopColor = null;
    for (const piece of pieces) {
      if (piece.toLowerCase() === "k") {
        continue;
      }
      let position;
      if (piece.toLowerCase() === "b") {
        const candidates = getBishopPlacementCandidates(
          bishopColor,
          ranges,
          exclusions
        );
        position = candidates[Math.floor(Math.random() * candidates.length)];
        bishopColor = getSquareColor(position);
      } else if (piece.toLowerCase() === "p") {
        position = getRandomPosition(ranges.pawnStart, ranges.pawnEnd, exclusions);
      } else {
        position = getRandomPosition(ranges.otherStart, ranges.otherEnd, exclusions);
      }
      board[position] = piece;
      exclusions.push(position);
    }
  };

  const attackSquaresFor = (enemyDirections) => {
    const attacked = [];
    Object.keys(enemyDirections).forEach((piece) => {
      board.forEach((square, position) => {
        if (square !== piece) {
          return;
        }
        enemyDirections[piece].forEach((direction) => {
          let next = position + direction;
          while (board[next] === ".") {
            attacked.push(next);
            if ("pnkPNK".includes(piece)) {
              break;
            }
            next += direction;
          }
        });
      });
    });
    return attacked;
  };

  const setKing = (king, enemyDirections, start, end) => {
    const attackedSquares = attackSquaresFor(enemyDirections);
    const position = getRandomPosition(start, end, exclusions.concat(attackedSquares));
    board[position] = king;
    exclusions.push(position);
  };

  setPieces(whitePieces, { pawnStart: 51, pawnEnd: 89, otherStart: 51, otherEnd: 99 });
  setPieces(blackPieces, { pawnStart: 31, pawnEnd: 69, otherStart: 21, otherEnd: 69 });
  setKing("K", blackDirections, 51, 99);
  setKing("k", whiteDirections, 21, 69);

  const rows = [];
  for (let row = 2; row < 10; row += 1) {
    let rowText = "";
    for (let col = 1; col < 9; col += 1) {
      rowText += board[10 * row + col];
    }
    rows.push(rowText);
  }

  const fenRows = rows.map((row) => {
    let blanks = 0;
    let fenRow = "";
    for (const char of row) {
      if (char === ".") {
        blanks += 1;
      } else {
        if (blanks) {
          fenRow += String(blanks);
          blanks = 0;
        }
        fenRow += char;
      }
    }
    if (blanks) {
      fenRow += String(blanks);
    }
    return fenRow;
  });

  const fen = `${fenRows.join("/")} ${sideToMove} - - 0 1`;
  if (
    !areBishopsOnOppositeColors(fen, "w") ||
    !areBishopsOnOppositeColors(fen, "b")
  ) {
    return generatePosition(sideToMove);
  }
  return fen;
}

async function generateBalancedPosition(sideToMove, token) {
  let bestCandidate = null;

  for (let attempt = 1; attempt <= 24; attempt += 1) {
    if (token !== state.taskToken) {
      return null;
    }

    const fen = generatePosition(sideToMove);
    const probe = new Chess();
    if (!probe.load(fen)) {
      continue;
    }

    const result = await state.analysisEngine.search(fen, {
      ...ANALYSIS_PROFILE,
      depth: state.positionDepth,
      moveTime: Math.max(250, Math.min(700, state.positionDepth * 45)),
    });
    if (token !== state.taskToken) {
      return null;
    }

    if (!result.score || result.score.type !== "cp") {
      continue;
    }

    const normalized = normalizeScoreForWhite(result.score, probe.turn());
    const distance = Math.abs(normalized.value);

    if (!bestCandidate || distance < bestCandidate.distance) {
      bestCandidate = {
        distance,
        fen,
        score: normalized,
      };
    }

    if (distance <= 200) {
      return bestCandidate;
    }
  }

  return bestCandidate;
}

async function startNewGame() {
  if (!state.engineReady) {
    return;
  }

  const token = ++state.taskToken;
  state.matchOver = false;
  setBusy(true);
  updateEvalBar(null);

  const actualColor =
    state.requestedColor === "random"
      ? Math.random() < 0.5
        ? "w"
        : "b"
      : state.requestedColor;

  state.actualPlayerColor = actualColor;
  state.board.orientation(actualColor === "w" ? "white" : "black");
  setStatus(state.pendingStartFen ? "Loading saved position..." : "Generating a balanced random position...");

  try {
    const candidate = state.pendingStartFen
      ? { fen: state.pendingStartFen, score: null }
      : await generateBalancedPosition(actualColor, token);
    if (!candidate || token !== state.taskToken) {
      if (token === state.taskToken) {
        setStatus("Could not generate a valid position. Try again.");
      }
      return;
    }

    game.load(candidate.fen);
    state.pendingStartFen = null;
    await createLocalGame(candidate.fen, candidate.score);
    state.board.position(game.fen(), false);
    renderMoveHistory();
    updateSideLabels();
    updateEvalBar(candidate.score);
    setStatus(describeResult());
  } finally {
    if (token === state.taskToken) {
      setBusy(false);
    }
  }
}

function resignGame() {
  state.taskToken += 1;
  const winnerColor = game.turn() === "w" ? "b" : "w";
  const winner = sideName(winnerColor);
  void finishMatch(`${winner} wins by resignation.`, { result: resultForWinner(winnerColor), termination: "resignation" });
}

function removeGreySquares() {
  document.querySelectorAll("#board .square-55d63").forEach((square) => {
    square.style.background = "";
  });
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

async function afterMove() {
  updateSideLabels();
  renderMoveHistory();
  await persistCurrentGameQuietly();

  if (game.game_over()) {
    await finishMatch(describeResult());
    await refreshEvaluation(8);
    return;
  }

  if (!state.playerVsPlayer && game.turn() !== state.actualPlayerColor) {
    const token = state.taskToken;
    setBusy(true);
    try {
      await runComputerTurn(token);
    } finally {
      if (token === state.taskToken) {
        setBusy(false);
      }
    }
    return;
  }

  setStatus(describeResult());
  await refreshEvaluation(8);
}

function createBoard() {
  const config = {
    draggable: true,
    onDragStart(source, piece) {
      if (state.isBusy || state.matchOver || game.game_over()) {
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
      const move = game.move({
        from: source,
        to: target,
        promotion: "q",
      });
      removeGreySquares();
      if (move === null) {
        return "snapback";
      }
      state.taskToken += 1;
      void afterMove();
      return undefined;
    },
    onMouseoutSquare() {
      removeGreySquares();
    },
    onMouseoverSquare(square) {
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
      state.board.position(game.fen());
    },
    orientation: "white",
    pieceTheme: "maingame/img/chesspieces/wikipedia/{piece}.png",
    position: "start",
  };

  state.board = ChessBoard("board", config);
  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) {
      cancelAnimationFrame(resizeFrame);
    }
    resizeFrame = requestAnimationFrame(() => {
      state.board.resize();
      updateEvalBar(state.lastEvalScore);
    });
  });
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

function bindEvents() {
  ui.newGame.addEventListener("click", () => {
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
    const movesToUndo = state.playerVsPlayer ? 1 : 2;
    for (let count = 0; count < movesToUndo; count += 1) {
      if (!game.undo()) {
        break;
      }
    }
    state.board.position(game.fen());
    state.taskToken += 1;
    state.matchOver = false;
    updateSideLabels();
    renderMoveHistory();
    setStatus(describeResult());
    void persistCurrentGameQuietly();
    await refreshEvaluation(8);
  });

  ui.resign.addEventListener("click", () => {
    resignGame();
  });

  ui.sharePosition.addEventListener("click", () => {
    void copyCurrentFen();
  });

  ui.savePosition.addEventListener("click", () => {
    void saveCurrentPosition();
  });

  ui.copyPgn.addEventListener("click", () => {
    void copyCurrentPgn();
  });

  ui.downloadPgn.addEventListener("click", downloadCurrentPgn);

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
    state.playerVsPlayer = !state.playerVsPlayer;
    state.taskToken += 1;
    syncModeUI();
    syncSettingsUI();
    setStatus(describeResult());
    await refreshEvaluation(8);
  });

  ui.themeToggle.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    void persistPreferences();
    syncTheme();
  });

  ui.settingsToggle.addEventListener("click", () => {
    if (ui.appMenu.classList.contains("hidden")) openAppMenu(); else closeAppMenu();
  });

  ui.menuClose.addEventListener("click", closeAppMenu);
  ui.appMenu.addEventListener("click", (event) => {
    if (event.target === ui.appMenu) closeAppMenu();
    const button = event.target.closest("[data-panel]");
    if (button) void openPanel(button.dataset.panel);
  });
  document.querySelectorAll("[data-close-panel]").forEach((button) => {
    button.addEventListener("click", () => closeOverlay(document.getElementById(button.dataset.closePanel)));
  });
  [ui.historyFilter, ui.historySort].forEach((control) => control.addEventListener("change", () => void refreshHistoryList()));
  ui.historyList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-record-action]");
    if (!button) return;
    const record = (await listGames()).find((item) => item.id === button.dataset.recordId);
    if (!record) return;
    const action = button.dataset.recordAction;
    if (action === "favorite") {
      await setGameFavorite(record.id, !record.isFavorite);
      if (record.id === state.currentGameId) state.currentGameFavorite = !record.isFavorite;
    }
    if (action === "delete" && window.confirm("Delete this local game record?")) await deleteGame(record.id);
    if (action === "replay") { closeOverlay(ui.historyDialog); openReplay(record); return; }
    if (action === "again") { preparePlayAgain(record.startingFen, record.playerColor, record.stockfishLevel); return; }
    if (action === "resume") {
      try { setCurrentRecord(record); closeOverlay(ui.historyDialog); if (!state.matchOver && !state.playerVsPlayer && game.turn() !== state.actualPlayerColor) { setBusy(true); await runComputerTurn(++state.taskToken); setBusy(false); } } catch (error) { console.error(error); showToast("Could not resume this game."); }
      return;
    }
    await refreshHistoryList();
  });
  ui.positionsList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-record-action]");
    if (!button) return;
    const position = (await listSavedPositions()).find((item) => item.id === button.dataset.recordId);
    if (!position) return;
    if (button.dataset.recordAction === "position-delete") { if (window.confirm("Delete this saved position?")) await deleteSavedPosition(position.id); await refreshPositionsList(); return; }
    preparePlayAgain(position.fen, button.dataset.recordAction === "position-black" ? "b" : "w", position.stockfishLevel);
    closeOverlay(ui.positionsDialog);
  });
  ui.resumeGame.addEventListener("click", async () => { if (!state.resumeRecord) return; try { setCurrentRecord(state.resumeRecord); closeOverlay(ui.resumeDialog); if (!state.matchOver && !state.playerVsPlayer && game.turn() !== state.actualPlayerColor) { setBusy(true); await runComputerTurn(++state.taskToken); setBusy(false); } } catch (error) { console.error(error); showToast("Could not resume this game."); } });
  ui.resumeNewGame.addEventListener("click", () => { closeOverlay(ui.resumeDialog); state.resumeRecord = null; void startNewGame(); });
  ui.resumeClose.addEventListener("click", () => closeOverlay(ui.resumeDialog));
  ui.replayClose.addEventListener("click", () => closeOverlay(ui.replayDialog));
  ui.replayFirst.addEventListener("click", () => { state.replay.index = 0; renderReplay(); });
  ui.replayPrev.addEventListener("click", () => { state.replay.index = Math.max(0, state.replay.index - 1); renderReplay(); });
  ui.replayNext.addEventListener("click", () => { state.replay.index = Math.min(state.replay.record?.moves?.length || 0, state.replay.index + 1); renderReplay(); });
  ui.replayLast.addEventListener("click", () => { state.replay.index = state.replay.record?.moves?.length || 0; renderReplay(); });
  ui.exportData.addEventListener("click", async () => { try { const backup = await exportBackup(); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" })); link.download = `ultra-fischer-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); showToast("Backup exported."); } catch (error) { console.error(error); showToast("Could not export local data."); } });
  ui.importData.addEventListener("click", () => ui.importFile.click());
  ui.importFile.addEventListener("change", async () => { const file = ui.importFile.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { showToast("Backup is larger than 5 MB."); return; } try { const backup = JSON.parse(await file.text()); const replace = window.confirm("Press OK to replace local data, or Cancel to merge this backup."); await importBackup(backup, replace ? "replace" : "merge"); showToast("Backup imported."); await refreshStorageSummary(); await refreshHistoryList(); } catch (error) { console.error(error); showToast(error.message || "Could not import backup."); } finally { ui.importFile.value = ""; } });
  ui.clearHistory.addEventListener("click", async () => { if (window.confirm("Clear all local game history?")) { await clearGames(); await refreshStorageSummary(); await refreshHistoryList(); showToast("Game history cleared."); } });
  ui.clearPositions.addEventListener("click", async () => { if (window.confirm("Clear all saved positions?")) { await clearSavedPositions(); await refreshStorageSummary(); await refreshPositionsList(); showToast("Saved positions cleared."); } });
  ui.resetPreferences.addEventListener("click", async () => { if (window.confirm("Reset local preferences?")) { const preferences = await resetPreferences(); Object.assign(state, preferences); syncTheme(); syncEvalVisibility(); syncColorButtons(); syncSettingsUI(); await persistPreferences(); showToast("Preferences reset."); } });
  ui.deleteAllData.addEventListener("click", async () => { if (window.prompt("Type DELETE to remove all local games, positions, and preferences.") === "DELETE") { await deleteAllData(); showToast("All local data deleted."); await refreshStorageSummary(); await refreshHistoryList(); } });

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

  ui.evalToggle.addEventListener("click", async () => {
    state.evalVisible = !state.evalVisible;
    void persistPreferences();
    syncEvalVisibility();
    if (state.evalVisible) {
      await refreshEvaluation(8);
    }
  });

  ui.evalSettingToggle.addEventListener("click", async () => {
    state.evalVisible = !state.evalVisible;
    void persistPreferences();
    syncEvalVisibility();
    if (state.evalVisible) {
      await refreshEvaluation(8);
    }
  });

  ui.colorButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.requestedColor = button.dataset.color;
      void persistPreferences();
      syncColorButtons();
    });
  });

  ui.positionDepth.addEventListener("change", () => {
    state.positionDepth = Number(ui.positionDepth.value);
    void persistPreferences();
    syncSettingsUI();
  });

  ui.aiStrength.addEventListener("change", async () => {
    state.aiStrength = normalizeLevel(ui.aiStrength.value);
    void persistPreferences();
    syncSettingsUI();
    await refreshEvaluation(8);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    closeSettings();
    closeSetup();
    state.historyOpen = false;
    syncHistoryPanel();
  });
}

async function init() {
  try {
    Object.assign(state, await getPreferences());
    state.aiStrength = normalizeLevel(state.aiStrength);
    state.positionDepth = Number(state.positionDepth) || 12;
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

  try {
    state.opponentEngine = new StockfishEngine();
    await state.opponentEngine.ready();
    state.analysisEngine = new StockfishEngine();
    await state.analysisEngine.ready();
    state.engineReady = true;
    setBusy(false);
    setStatus("Engine ready.");
    try {
      const unfinished = await listGames({ status: "in_progress", sort: "newest" });
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
    setStatus("Engine failed to load.");
  }
}

init();
