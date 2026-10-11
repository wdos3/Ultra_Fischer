import { resolveEngineDifficulty, selectCandidateMove } from "./stockfish-config.mjs";

export const STOCKFISH_VERSION = "18";
const SOURCES = ["stockfish-18-lite-single.js", "stockfish-18-asm.js"];

export class StockfishEngine {
  constructor({ workerFactory = (url) => new Worker(url), startupTimeout = 20000, cancelTimeout = 2000 } = {}) {
    this.workerFactory = workerFactory;
    this.startupTimeout = startupTimeout;
    this.cancelTimeout = cancelTimeout;
    this.pending = [];
    this.active = null;
    this.options = {};
    this.worker = null;
    this.disposed = false;
    this.resetHash = true;
    this.sequence = 0;
    this.initPromise = this.initialize();
    this.initPromise.catch(() => null);
  }

  async initialize() {
    let cause;
    const sources = typeof WebAssembly === "object" ? SOURCES : SOURCES.slice(1);
    for (const source of sources) {
      try {
        await this.startWorker(source);
        this.source = source;
        return;
      } catch (error) {
        cause = error;
        this.worker?.terminate();
        this.worker = null;
      }
    }
    throw new Error("Stockfish could not start. Please retry the game.", { cause });
  }

  startWorker(source) {
    return new Promise((resolve, reject) => {
      const worker = this.workerFactory(new URL(`./engines/${source}`, import.meta.url));
      this.worker = worker;
      this.options = {};
      let ready = false;
      const timer = setTimeout(() => reject(new Error("Stockfish startup timed out.")), this.startupTimeout);
      const fail = (error) => {
        const cause = error instanceof Error ? error : new Error(error.message || "Stockfish worker failed.");
        clearTimeout(timer);
        if (worker !== this.worker) return;
        if (!ready) reject(cause); else this.failWorker(cause);
      };
      worker.addEventListener("error", fail);
      worker.addEventListener("messageerror", () => fail(new Error("Stockfish sent an unreadable response.")));
      worker.addEventListener("message", (event) => {
        if (worker !== this.worker) return;
        const line = String(event.data || "").trim();
        const option = line.match(/^option name (.+?) type (\w+)(.*)$/);
        if (option) {
          this.options[option[1].toLowerCase()] = {
            name: option[1], type: option[2],
            min: Number(option[3].match(/\bmin (-?\d+)/)?.[1] ?? 0),
            max: Number(option[3].match(/\bmax (-?\d+)/)?.[1] ?? 20),
          };
        } else if (line === "uciok") {
          worker.postMessage("isready");
        } else if (line === "readyok" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        } else {
          this.handleMessage(line);
        }
      });
      worker.postMessage("uci");
    });
  }

  ready() { return this.initPromise; }
  newGame() { this.resetHash = true; }

  search(fen, profile, { kind = "analysis", priority = 20, timeoutMs } = {}) {
    if (this.disposed) return Promise.reject(new Error("Stockfish is closed."));
    return new Promise((resolve, reject) => {
      const task = { fen, profile, kind, priority, timeoutMs, resolve, reject, sequence: this.sequence++, depths: new Map(), settled: false };
      this.pending.push(task);
      this.pending.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      if (this.active && priority < this.active.priority) this.cancelActive();
      void this.pump();
    });
  }

  async pump() {
    if (this.active || this.disposed || this.starting) return;
    this.starting = true;
    try {
      await this.initPromise;
      if (this.active || this.disposed) return;
      const task = this.pending.shift();
      if (!task) return;
      task.config = resolveEngineDifficulty(task.profile, this.options);
      this.active = task;
      const { config } = task;
      const send = (command) => this.worker.postMessage(command);
      if (this.resetHash) { send("ucinewgame"); this.resetHash = false; }
      if (this.options["skill level"]) send(`setoption name Skill Level value ${config.nativeSkill}`);
      if (this.options.uci_limitstrength) send(`setoption name UCI_LimitStrength value ${config.useLimitStrength}`);
      if (config.useLimitStrength && this.options.uci_elo) send(`setoption name UCI_Elo value ${config.elo}`);
      if (this.options.multipv) send(`setoption name MultiPV value ${config.candidateCount}`);
      send(`position fen ${task.fen}`);
      task.timer = setTimeout(() => this.failWorker(new Error("Stockfish search timed out. The engine will restart.")), task.timeoutMs ?? Math.max(3000, config.moveTime + 3000));
      send(`go depth ${config.depth} movetime ${config.moveTime}`);
    } catch (error) {
      this.failWorker(error);
    } finally {
      this.starting = false;
      if (!this.active && this.pending.length && !this.disposed) void this.pump();
    }
  }

  handleMessage(line) {
    const task = this.active;
    if (!task) return;
    if (line.startsWith("bestmove")) {
      clearTimeout(task.timer);
      clearTimeout(task.cancelTimer);
      this.active = null;
      if (!task.cancelled) {
        const entries = [...task.depths.entries()].filter(([, pvs]) => pvs.has(1)).sort((a, b) => b[0] - a[0]);
        const candidates = entries.length ? [...entries[0][1].values()] : [];
        const bestMove = line.split(/\s+/)[1];
        const legalBestMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestMove) ? bestMove : null;
        this.settle(task, { bestMove: task.config.candidateCount === 1 ? legalBestMove : selectCandidateMove(candidates, task.config.candidateCount) || legalBestMove, candidates, score: candidates.find((candidate) => candidate.rank === 1)?.score || null, config: task.config });
      }
      void this.pump();
      return;
    }
    if (task.cancelled || /\b(?:upperbound|lowerbound)\b/.test(line)) return;
    const depth = line.match(/\bdepth (\d+)/);
    const score = line.match(/\bscore (cp|mate) (-?\d+)/);
    const pv = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
    if (!depth || !score || !pv) return;
    const rank = Number(line.match(/\bmultipv (\d+)/)?.[1] || 1);
    const value = { move: pv[1], rank, score: { type: score[1], value: Number(score[2]), depth: Number(depth[1]) } };
    if (!task.depths.has(value.score.depth)) task.depths.set(value.score.depth, new Map());
    task.depths.get(value.score.depth).set(rank, value);
  }

  settle(task, result, error) {
    if (task.settled) return;
    task.settled = true;
    if (error) task.reject(error); else task.resolve(result);
  }

  cancelActive() {
    const task = this.active;
    if (!task || task.cancelled) return;
    task.cancelled = true;
    clearTimeout(task.timer);
    this.settle(task, { cancelled: true, bestMove: null, score: null, candidates: [] });
    // Keep this task active until its final bestmove drains the UCI stream.
    task.cancelTimer = setTimeout(() => this.failWorker(new Error("Stockfish did not stop. The engine will restart.")), this.cancelTimeout);
    try { this.worker.postMessage("stop"); } catch (error) { this.failWorker(error); }
  }

  cancelPending({ kind } = {}) {
    const keep = [];
    for (const task of this.pending) {
      if (!kind || task.kind === kind) this.settle(task, { cancelled: true, bestMove: null, score: null, candidates: [] }); else keep.push(task);
    }
    this.pending = keep;
    if (this.active && (!kind || this.active.kind === kind)) this.cancelActive();
  }

  failWorker(error) {
    if (this.active) {
      clearTimeout(this.active.timer);
      clearTimeout(this.active.cancelTimer);
      this.settle(this.active, null, error);
      this.active = null;
    }
    this.pending.splice(0).forEach((task) => this.settle(task, null, error));
    this.worker?.terminate();
    this.worker = null;
    if (!this.disposed) {
      this.resetHash = true;
      this.initPromise = this.initialize();
      this.initPromise.catch(() => null);
    }
  }

  dispose() {
    this.disposed = true;
    this.failWorker(new Error("Stockfish is closed."));
  }
}
