import test from "node:test";
import assert from "node:assert/strict";
import { Chess, replayGame, groupMoveRows, buildPgn } from "./chess-rules.mjs";
import { GameSession } from "./game-session.mjs";
import { confirmationAccepted, friendlyMovesAccepted, positionSettingsKey } from "./position-policy.mjs";
import { generatePosition } from "./position-generator.mjs";
import { areBishopsOnOppositeColors } from "./position-utils.mjs";

test("serialized session saves retain identity, original side, mode, and terminal outcome", async () => {
  const writes = [];
  const persistence = {
    create: async (record) => { await new Promise((resolve) => setTimeout(resolve, 5)); writes.push(record); return { ...record, id: "one" }; },
    update: async (record) => { writes.push(record); return record; },
  };
  const chess = new Chess();
  const session = new GameSession({ startingFen: chess.fen(), status: "in_progress", playerColor: "w", mode: "pvp" }, persistence);
  const first = session.save(chess, null);
  chess.move("e4");
  const second = session.save(chess, null, { status: "terminated", termination: "new_game" });
  await Promise.all([first, second]);
  await session.save(chess, null, { result: "win" });
  assert.equal(writes[1].id, "one");
  assert.equal(writes[1].playerColor, "w");
  assert.equal(writes[1].mode, "pvp");
  assert.equal(writes[2].status, "terminated");
  assert.equal(writes[2].result, null);
  await session.detach();
  assert.equal(await session.save(chess, null), null);
});

test("black-to-move records keep correct columns and fullmove numbers", () => {
  const start = new Chess().fen().replace(" w ", " b ").replace(" 0 1", " 0 7");
  const { moves } = replayGame(start, ["e5", "e4", "Nf6"]);
  const rows = groupMoveRows(moves, start);
  assert.equal(rows[0].number, 7);
  assert.equal(rows[0].white, null);
  assert.equal(rows[0].black.san, "e5");
  assert.equal(rows[1].number, 8);
  assert.equal(rows[1].white.san, "e4");
  assert.equal(rows[1].black.san, "Nf6");
  assert.match(buildPgn(start, ["e5"]), /7\. \.\.\. e5/);
});

test("friendly acceptance requires distinct legal choices within balance at actual confirmation depth", () => {
  const chess = new Chess();
  const result = { score: { type: "cp", value: 20, depth: 16 }, candidates: [
    { move: "e2e4", score: { type: "cp", value: 20, depth: 16 } },
    { move: "d2d4", score: { type: "cp", value: -50, depth: 16 } },
  ] };
  assert.equal(confirmationAccepted(chess, result, 150, true), true);
  assert.equal(confirmationAccepted(chess, { ...result, score: { ...result.score, depth: 15 } }, 150, false), false);
  assert.equal(friendlyMovesAccepted(chess, { ...result, candidates: [result.candidates[0], result.candidates[0]] }, 150), false);
  assert.equal(friendlyMovesAccepted(chess, { ...result, candidates: [result.candidates[0], { move: "a1a8", score: result.score }] }, 150), false);
  assert.equal(friendlyMovesAccepted(chess, { ...result, candidates: [result.candidates[0], { ...result.candidates[1], score: { type: "cp", value: -200, depth: 16 } }] }, 150), false);
  assert.notEqual(positionSettingsKey(150, true), "150:true");
});

test("generated positions preserve both bishop pairs and legal king placement", () => {
  for (let index = 0; index < 200; index += 1) {
    const fen = generatePosition(index % 2 ? "b" : "w");
    assert.equal(areBishopsOnOppositeColors(fen, "w"), true);
    assert.equal(areBishopsOnOppositeColors(fen, "b"), true);
    assert.doesNotThrow(() => replayGame(fen));
  }
});
