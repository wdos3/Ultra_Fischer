import { detectResult } from "./chess-rules.mjs";
import { normalizeLevelHistory } from "./game-difficulty.mjs";

export class GameSession {
  constructor(record, persistence) {
    this.record = { ...record };
    this.persistence = persistence;
    this.created = Boolean(record.id);
    this.revision = record.revision || 0;
    this.generation = record.generation || null;
    this.recording = true;
    this.queue = Promise.resolve();
  }

  get id() { return this.record.id; }

  patchMetadata(patch) {
    for (const key of ["label", "isFavorite", "mode"]) {
      if (key in patch) this.record[key] = patch[key];
    }
  }

  setDifficulty(level, ply) {
    if (this.record.status !== "in_progress" || Number(this.record.stockfishLevel) === level) return;
    const history = (this.record.levelHistory || [{ ply: 0, level: Number(this.record.stockfishLevel) }]).map((entry) => ({ ...entry }));
    if (history.at(-1).ply === ply) history.at(-1).level = level;
    else history.push({ ply, level });
    this.record.stockfishLevel = level;
    this.record.levelHistory = history;
  }

  save(chess, score, overrides = {}, moves = chess.history()) {
    if (!this.recording) return Promise.resolve(null);
    const locked = this.record.status !== "in_progress";
    const outcome = locked ? this.record : { ...detectResult(chess, this.record.playerColor), ...overrides };
    const status = locked ? this.record.status : overrides.status || (outcome.result ? "completed" : "in_progress");
    const snapshot = {
      ...this.record,
      currentFen: chess.fen(),
      moves: [...moves],
      moveCount: moves.length,
      levelHistory: normalizeLevelHistory(this.record.levelHistory, Number(this.record.stockfishLevel) || 4, moves.length),
      pgn: "",
      status,
      result: status === "completed" ? outcome.result : null,
      termination: outcome.termination,
      finalEvaluation: score,
      updatedAt: Date.now(),
      finishedAt: status === "in_progress" ? null : this.record.finishedAt || Date.now(),
    };
    this.record = snapshot;
    // Serialize snapshots so a slow save cannot overwrite a later move or finish.
    const write = this.queue.catch(() => null).then(async () => {
      if (!this.recording) return null;
      const next = { ...snapshot, id: this.record.id, revision: this.revision, generation: this.generation, label: this.record.label, isFavorite: this.record.isFavorite };
      const saved = await (this.created ? this.persistence.update(next) : this.persistence.create(next));
      if (saved) {
        this.created = true;
        this.record.id = saved.id;
        this.revision = saved.revision || 0;
        this.generation = saved.generation || null;
        this.record.revision = this.revision;
        this.record.generation = this.generation;
      }
      return saved;
    });
    this.queue = write;
    return write;
  }

  async detach() {
    this.recording = false;
    await this.queue.catch(() => null);
  }
}
