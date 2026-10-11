import { Chess, isValidChessFen } from "./chess-rules.mjs";
import { areBishopsOnOppositeColors } from "./position-utils.mjs";

export const POSITION_SCREEN_DEPTH = 12;
export const POSITION_CONFIRM_DEPTH = 16;
const GENERATION_VERSION = "sf18-lite-rules3-d12-d16-friendly125";

export function positionSettingsKey(balance, friendly) {
  return `${GENERATION_VERSION}:${balance}:${friendly}`;
}

export function friendlyMovesAccepted(chess, result, acceptanceCp) {
  const legalMoves = chess.moves({ verbose: true });
  if (legalMoves.length < 3) return false;
  const legalCodes = new Set(legalMoves.map((move) => move.from + move.to + (move.promotion || "")));
  const unique = new Map();
  for (const candidate of result.candidates || []) {
    if (legalCodes.has(candidate.move) && candidate.score?.type === "cp" && candidate.score.depth >= result.score.depth && Math.abs(candidate.score.value) <= acceptanceCp) {
      unique.set(candidate.move, candidate.score.value);
    }
  }
  const values = [...unique.values()];
  const best = Math.max(...values);
  return values.filter((value) => best - value <= 125).length >= 2;
}

export function confirmationAccepted(chess, result, acceptanceCp, friendlyMode) {
  return Boolean(!result.cancelled && result.score?.type === "cp" && Number.isFinite(result.score.value) && result.score.depth >= POSITION_CONFIRM_DEPTH && Math.abs(result.score.value) <= acceptanceCp && (!friendlyMode || friendlyMovesAccepted(chess, result, acceptanceCp)));
}

export function cachedPositionAccepted(candidate, balance, friendlyMode) {
  if (!candidate || candidate.settingsKey !== positionSettingsKey(balance, friendlyMode) || !isValidChessFen(candidate.fen)) return false;
  if (!areBishopsOnOppositeColors(candidate.fen, "w") || !areBishopsOnOppositeColors(candidate.fen, "b")) return false;
  const chess = new Chess(candidate.fen);
  if (chess.turn() !== candidate.sideToMove || chess.game_over()) return false;
  const score = candidate.score && { ...candidate.score, value: chess.turn() === "w" ? candidate.score.value : -candidate.score.value };
  return confirmationAccepted(chess, { score, candidates: candidate.alternatives }, balance, friendlyMode);
}
