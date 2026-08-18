import assert from "node:assert/strict";
import test from "node:test";
import {
  areBishopsOnOppositeColors,
  getBishopPlacementCandidates,
  getSquareColor,
} from "./position-utils.mjs";

test("bishop candidates always use the opposite square color", () => {
  const ranges = { otherStart: 21, otherEnd: 69 };
  const firstBishop = getBishopPlacementCandidates(null, ranges, [])[0];
  const firstColor = getSquareColor(firstBishop);
  const secondCandidates = getBishopPlacementCandidates(
    firstColor,
    ranges,
    [firstBishop]
  );

  assert.ok(secondCandidates.length > 0);
  assert.ok(secondCandidates.every((square) => getSquareColor(square) !== firstColor));
});

test("FEN validation rejects same-color bishop pairs", () => {
  const sameColor = "8/8/8/8/8/8/1B6/B7 w - - 0 1";
  const oppositeColors = "8/8/8/8/8/8/1B6/1B6 w - - 0 1";

  assert.equal(areBishopsOnOppositeColors(sameColor, "w"), false);
  assert.equal(areBishopsOnOppositeColors(oppositeColors, "w"), true);
});
