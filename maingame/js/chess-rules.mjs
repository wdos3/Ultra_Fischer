import * as chessModule from "./chess.js";

export const Chess = chessModule.Chess || chessModule.default?.Chess || globalThis.Chess;

export function isValidChessFen(fen) {
  if (typeof fen !== "string") return false;
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6 || !/^\d+$/.test(fields[4]) || !/^[1-9]\d*$/.test(fields[5])) return false;
  if (!Number.isSafeInteger(Number(fields[4])) || !Number.isSafeInteger(Number(fields[5]))) return false;
  const chess = new Chess();
  if (!chess.load(fields.join(" "))) return false;
  const pieces = fields[0];
  if ((pieces.match(/K/g) || []).length !== 1 || (pieces.match(/k/g) || []).length !== 1) return false;
  const rows = pieces.split("/");
  if (/[pP]/.test(rows[0] + rows[7])) return false;
  // The side that just moved cannot have left its own king in check.
  fields[1] = fields[1] === "w" ? "b" : "w";
  const previousSide = new Chess(fields.join(" "));
  return !previousSide.in_check();
}

export function replayGame(startingFen, moves = [], currentFen = null) {
  if (!isValidChessFen(startingFen)) throw new Error("The game has an invalid starting position.");
  if (!Array.isArray(moves) || moves.length > 1000) throw new Error("The game has an invalid move history.");
  const chess = new Chess(startingFen);
  const verboseMoves = [];
  for (const san of moves) {
    const move = typeof san === "string" ? chess.move(san) : null;
    if (!move) throw new Error(`The game contains an illegal move: ${String(san).slice(0, 20)}.`);
    verboseMoves.push(move);
  }
  if (currentFen && chess.fen() !== currentFen.trim().replace(/\s+/g, " ")) {
    throw new Error("The current position does not match the saved moves.");
  }
  return { chess, moves: verboseMoves };
}

export function resultCode(result, playerColor) {
  if (result === "draw") return "1/2-1/2";
  if (result !== "win" && result !== "loss") return "*";
  const whiteWon = result === "win" ? playerColor === "w" : playerColor === "b";
  return whiteWon ? "1-0" : "0-1";
}

export function detectResult(chess, playerColor) {
  if (chess.in_checkmate()) {
    const winner = chess.turn() === "w" ? "b" : "w";
    return { result: winner === playerColor ? "win" : "loss", termination: "checkmate" };
  }
  if (chess.in_draw()) return { result: "draw", termination: "draw" };
  return { result: null, termination: "in_progress" };
}

export function buildPgn(startingFen, moves, code = "*") {
  const { chess } = replayGame(startingFen, moves);
  chess.header("Event", "Ultra Fischer", "SetUp", "1", "FEN", startingFen, "Result", code);
  return chess.pgn();
}

export function groupMoveRows(moves, startingFen) {
  let number = Number(startingFen?.split(" ")[5]) || 1;
  const rows = [];
  for (const move of moves) {
    if (!rows.length || (move.color === "w" && rows.at(-1).black)) rows.push({ number, white: null, black: null });
    rows.at(-1)[move.color === "w" ? "white" : "black"] = move;
    if (move.color === "b") number += 1;
  }
  return rows;
}
