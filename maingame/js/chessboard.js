import {
  ANALYSIS_PROFILE,
  getLevelConfig,
  resolveEngineDifficulty,
  selectCandidateMove,
} from "./stockfish-config.mjs";

const STORAGE_KEYS = {
  aiStrength: "ultra-fischer-ai-strength",
  evalVisible: "ultra-fischer-eval-visible",
  positionDepth: "ultra-fischer-position-depth",
  requestedColor: "ultra-fischer-requested-color",
  settingsOpen: "ultra-fischer-settings-open",
  theme: "ultra-fischer-theme",
};

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
  aiStrength: normalizeLevel(localStorage.getItem(STORAGE_KEYS.aiStrength)),
  board: null,
  analysisEngine: null,
  engineReady: false,
  evalVisible: localStorage.getItem(STORAGE_KEYS.evalVisible) !== "false",
  isBusy: true,
  lastEvalScore: null,
  matchOver: false,
  historyOpen: false,
  playerVsPlayer: false,
  positionDepth: Number(localStorage.getItem(STORAGE_KEYS.positionDepth) || "12"),
  requestedColor: localStorage.getItem(STORAGE_KEYS.requestedColor) || "w",
  setupOpen: false,
  settingsOpen: localStorage.getItem(STORAGE_KEYS.settingsOpen) === "true",
  taskToken: 0,
  theme: localStorage.getItem(STORAGE_KEYS.theme) || "dark",
  toastTimer: null,
  opponentEngine: null,
};

class StockfishEngine {
  constructor() {
    const supportsWasm =
      typeof WebAssembly === "object" &&
      WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
    const workerUrl = new URL(
      supportsWasm ? "./engines/stockfish.wasm.js" : "./engines/stockfish.js",
      import.meta.url
    );
    this.worker = new Worker(workerUrl);
    this.queue = Promise.resolve();
    this.initPromise = new Promise((resolve) => {
      this.initResolver = resolve;
    });
    this.currentTask = null;
    this.options = {};
    this.readySent = false;
    this.worker.addEventListener("message", this.handleMessage.bind(this));
    this.worker.postMessage("uci");
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
      this.initResolver = null;
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
  ui.settingsToggle.setAttribute("aria-expanded", String(state.settingsOpen));
  ui.settingsToggle.setAttribute(
    "aria-label",
    state.settingsOpen ? "Close settings" : "Open settings"
  );
  ui.settingsToggle.title = state.settingsOpen ? "Close settings" : "Settings";
}

function syncSetupPanel() {
  ui.newGameDialog.classList.toggle("hidden", !state.setupOpen);
  ui.newGameDialog.setAttribute("aria-hidden", String(!state.setupOpen));
}

function syncHistoryPanel() {
  document.body.classList.toggle("history-open", state.historyOpen);
  ui.historyToggle.setAttribute("aria-expanded", String(state.historyOpen));
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

function finishMatch(message) {
  state.matchOver = true;
  setBusy(false);
  setStatus(message);
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
  }

  if (game.game_over()) {
    finishMatch(describeResult());
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
  const darkSquares = [
    22, 24, 26, 28,
    31, 33, 35, 37,
    42, 44, 46, 48,
    51, 53, 55, 57,
    62, 64, 66, 68,
    71, 73, 75, 77,
    82, 84, 86, 88,
    91, 93, 95, 97,
  ];
  const lightSquares = darkSquares.map((square) => square - 1);
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

  const setPieces = (pieces, ranges, darkSet, lightSet) => {
    let bishopExclusions = null;
    for (const piece of pieces) {
      if (piece.toLowerCase() === "k") {
        continue;
      }
      let position;
      if (piece.toLowerCase() === "p") {
        position = getRandomPosition(ranges.pawnStart, ranges.pawnEnd, exclusions);
      } else {
        position = getRandomPosition(ranges.otherStart, ranges.otherEnd, exclusions);
      }
      if (piece.toLowerCase() === "b") {
        if (!bishopExclusions) {
          if (darkSet.includes(position)) {
            bishopExclusions = darkSet;
          } else if (lightSet.includes(position)) {
            bishopExclusions = lightSet;
          }
        } else {
          position = getRandomPosition(
            ranges.otherStart,
            ranges.otherEnd,
            bishopExclusions.concat(exclusions)
          );
        }
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

  setPieces(whitePieces, { pawnStart: 51, pawnEnd: 89, otherStart: 51, otherEnd: 99 }, darkSquares, lightSquares);
  setPieces(blackPieces, { pawnStart: 31, pawnEnd: 69, otherStart: 21, otherEnd: 69 }, darkSquares, lightSquares);
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

  return `${fenRows.join("/")} ${sideToMove} - - 0 1`;
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
  setStatus("Generating a balanced random position...");

  try {
    const candidate = await generateBalancedPosition(actualColor, token);
    if (!candidate || token !== state.taskToken) {
      if (token === state.taskToken) {
        setStatus("Could not generate a valid position. Try again.");
      }
      return;
    }

    game.load(candidate.fen);
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
  const winner = game.turn() === "w" ? "Black" : "White";
  finishMatch(`${winner} wins by resignation.`);
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

  if (game.game_over()) {
    finishMatch(describeResult());
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
  localStorage.setItem(STORAGE_KEYS.settingsOpen, "false");
  syncSettingsPanel();
}

function closeSetup() {
  state.setupOpen = false;
  syncSetupPanel();
}

function bindEvents() {
  ui.newGame.addEventListener("click", () => {
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
    localStorage.setItem(STORAGE_KEYS.settingsOpen, "true");
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
    updateSideLabels();
    renderMoveHistory();
    setStatus(describeResult());
    await refreshEvaluation(8);
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
    state.playerVsPlayer = !state.playerVsPlayer;
    state.taskToken += 1;
    syncModeUI();
    syncSettingsUI();
    setStatus(describeResult());
    await refreshEvaluation(8);
  });

  ui.themeToggle.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEYS.theme, state.theme);
    syncTheme();
  });

  ui.settingsToggle.addEventListener("click", () => {
    state.settingsOpen = !state.settingsOpen;
    state.setupOpen = false;
    localStorage.setItem(STORAGE_KEYS.settingsOpen, String(state.settingsOpen));
    syncSettingsPanel();
    syncSetupPanel();
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

  ui.evalToggle.addEventListener("click", async () => {
    state.evalVisible = !state.evalVisible;
    localStorage.setItem(STORAGE_KEYS.evalVisible, String(state.evalVisible));
    syncEvalVisibility();
    if (state.evalVisible) {
      await refreshEvaluation(8);
    }
  });

  ui.evalSettingToggle.addEventListener("click", async () => {
    state.evalVisible = !state.evalVisible;
    localStorage.setItem(STORAGE_KEYS.evalVisible, String(state.evalVisible));
    syncEvalVisibility();
    if (state.evalVisible) {
      await refreshEvaluation(8);
    }
  });

  ui.colorButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.requestedColor = button.dataset.color;
      localStorage.setItem(STORAGE_KEYS.requestedColor, state.requestedColor);
      syncColorButtons();
    });
  });

  ui.positionDepth.addEventListener("change", () => {
    state.positionDepth = Number(ui.positionDepth.value);
    localStorage.setItem(STORAGE_KEYS.positionDepth, String(state.positionDepth));
    syncSettingsUI();
  });

  ui.aiStrength.addEventListener("change", async () => {
    state.aiStrength = normalizeLevel(ui.aiStrength.value);
    localStorage.setItem(STORAGE_KEYS.aiStrength, state.aiStrength);
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
    state.analysisEngine = new StockfishEngine();
    await Promise.all([state.opponentEngine.ready(), state.analysisEngine.ready()]);
    state.engineReady = true;
    setBusy(false);
    setStatus("Engine ready.");
    await startNewGame();
  } catch (error) {
    console.error(error);
    setStatus("Engine failed to load.");
  }
}

init();
