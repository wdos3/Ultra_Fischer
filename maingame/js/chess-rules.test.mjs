import test from "node:test";
import assert from "node:assert/strict";
import { Chess, isValidChessFen, replayGame } from "./chess-rules.mjs";

test("castling rights require the corresponding king and same-color rook", () => {
  for (const fen of [
    "4k3/8/8/8/8/8/P7/4K3 w KQ - 0 1",
    "4k3/8/8/8/8/8/P7/4K2n w K - 0 1",
    "4k3/8/8/8/8/8/P7/2K4R w K - 0 1",
    "4k3/7p/8/8/8/8/8/4K3 b kq - 0 1",
  ]) {
    assert.equal(isValidChessFen(fen), false, fen);
    assert.throws(() => replayGame(fen, ["O-O"]), /invalid starting position/);
  }
  assert.equal(isValidChessFen(new Chess().fen()), true);
  const clearPath = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  assert.equal(isValidChessFen(clearPath), true);
  assert.deepEqual(replayGame(clearPath, ["O-O", "O-O-O"]).chess.history(), ["O-O", "O-O-O"]);
});

test("en-passant fields must describe a pawn's immediately preceding double move", () => {
  for (const fen of [
    "4k3/8/8/4P3/8/8/8/4K3 w - d6 0 1",
    "4k3/8/8/3PP3/8/8/8/4K3 w - d6 0 1",
    "4k3/8/3N4/3pP3/8/8/8/4K3 w - d6 0 1",
    "4k3/3p4/8/3pP3/8/8/8/4K3 w - d6 0 1",
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 1 1",
    "4k3/8/8/3pP3/8/8/8/4K3 b - d6 0 1",
  ]) assert.equal(isValidChessFen(fen), false, fen);
  const whiteCapture = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2";
  const blackCapture = "4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1";
  assert.equal(isValidChessFen(whiteCapture), true);
  assert.equal(isValidChessFen(blackCapture), true);
  assert.equal(replayGame(whiteCapture, ["exd6"]).moves[0].flags, "e");
  assert.equal(replayGame(blackCapture, ["dxe3"]).moves[0].flags, "e");
});

test("a valid en-passant target does not require an adjacent capturing pawn", () => {
  const chess = new Chess();
  for (const san of ["e4", "a5", "d4", "h5"]) {
    chess.move(san);
    assert.notEqual(chess.fen().split(" ")[3], "-");
    assert.equal(isValidChessFen(chess.fen()), true);
  }
});
