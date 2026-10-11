import test from "node:test";
import assert from "node:assert/strict";
import { StockfishEngine } from "./stockfish-engine.mjs";
import { ANALYSIS_PROFILE } from "./stockfish-config.mjs";

class FakeWorker extends EventTarget {
  constructor() { super(); this.commands = []; }
  postMessage(command) {
    this.commands.push(command);
    if (command === "uci") queueMicrotask(() => {
      this.emit("option name MultiPV type spin default 1 min 1 max 500");
      this.emit("uciok");
    });
    if (command === "isready") queueMicrotask(() => this.emit("readyok"));
  }
  emit(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  crash() { this.dispatchEvent(new Event("error")); }
  terminate() { this.terminated = true; }
}

async function fixture(t, options = {}) {
  const workers = [];
  const engine = new StockfishEngine({ workerFactory: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  }, ...options });
  t.after(() => engine.dispose());
  await engine.ready();
  return { engine, workers, worker: workers[0] };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const fen = "7k/8/8/8/8/8/8/K7 w - - 0 1";

test("cancelled bestmove drains before the next search starts", async (t) => {
  const { engine, worker } = await fixture(t);
  const first = engine.search(fen, ANALYSIS_PROFILE);
  await tick();
  engine.cancelPending();
  assert.equal((await first).cancelled, true);
  const second = engine.search(fen, ANALYSIS_PROFILE);
  await tick();
  assert.equal(worker.commands.filter((command) => command.startsWith("go ")).length, 1);
  worker.emit("bestmove a1a2");
  await tick();
  worker.emit("info depth 16 score cp 22 pv a1b1");
  worker.emit("bestmove a1b1");
  assert.equal((await second).bestMove, "a1b1");
});

test("worker crashes reject active tasks and restart without a page reload", async (t) => {
  const { engine, workers, worker } = await fixture(t);
  const failed = engine.search(fen, ANALYSIS_PROFILE);
  const rejection = assert.rejects(failed, /worker failed/);
  await tick();
  worker.crash();
  await rejection;
  await engine.ready();
  assert.equal(workers.length, 2);
  const retry = engine.search(fen, ANALYSIS_PROFILE);
  await tick();
  worker.emit("bestmove h8g8");
  workers[1].emit("bestmove a1b1");
  assert.equal((await retry).bestMove, "a1b1");
});

test("watchdog rejects a hung search and enables a retry", async (t) => {
  const { engine, workers } = await fixture(t);
  await assert.rejects(engine.search(fen, ANALYSIS_PROFILE, { timeoutMs: 15 }), /timed out/);
  await engine.ready();
  assert.equal(workers.length, 2);
});

test("opponent searches preempt analysis and hash resets happen only for new games", async (t) => {
  const { engine, worker } = await fixture(t);
  const analysis = engine.search(fen, ANALYSIS_PROFILE);
  await tick();
  const opponent = engine.search(fen, ANALYSIS_PROFILE, { kind: "opponent", priority: 0 });
  assert.equal((await analysis).cancelled, true);
  worker.emit("bestmove a1a2");
  await tick();
  worker.emit("bestmove a1b1");
  await opponent;
  assert.equal(worker.commands.filter((command) => command === "ucinewgame").length, 1);
  engine.newGame();
  const next = engine.search(fen, ANALYSIS_PROFILE);
  await tick();
  worker.emit("bestmove a1a2");
  await next;
  assert.equal(worker.commands.filter((command) => command === "ucinewgame").length, 2);
});

test("scores use one exact depth and ignore bound estimates", async (t) => {
  const { engine, worker } = await fixture(t);
  const result = engine.search(fen, { ...ANALYSIS_PROFILE, candidateCount: 4 });
  await tick();
  worker.emit("info depth 12 multipv 1 score cp 0 pv a1b1");
  worker.emit("info depth 12 multipv 2 score cp -10 pv a1a2");
  worker.emit("info depth 16 multipv 1 score cp 20 pv a1b1");
  worker.emit("info depth 17 multipv 1 score cp 999 lowerbound pv a1b1");
  worker.emit("bestmove a1b1");
  const response = await result;
  assert.equal(response.score.depth, 16);
  assert.equal(response.candidates.length, 1);
  assert.equal(response.score.value, 20);
});

test("missing stop response restarts the worker instead of blocking the queue", async (t) => {
  const { engine, workers } = await fixture(t, { cancelTimeout: 15 });
  const result = engine.search(fen, ANALYSIS_PROFILE);
  await tick();
  engine.cancelPending();
  assert.equal((await result).cancelled, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await engine.ready();
  assert.equal(workers.length, 2);
});
