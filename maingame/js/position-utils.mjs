const BOARD_DARK_SQUARES = Object.freeze([
  22, 24, 26, 28,
  31, 33, 35, 37,
  42, 44, 46, 48,
  51, 53, 55, 57,
  62, 64, 66, 68,
  71, 73, 75, 77,
  82, 84, 86, 88,
  91, 93, 95, 97,
]);

const BOARD_LIGHT_SQUARES = Object.freeze(
  BOARD_DARK_SQUARES.map((square) => square - 1)
);

function getSquareColor(index) {
  if (BOARD_DARK_SQUARES.includes(index)) {
    return "dark";
  }
  if (BOARD_LIGHT_SQUARES.includes(index)) {
    return "light";
  }
  return null;
}

function getBishopPlacementCandidates(currentColor, ranges, exclusions) {
  const pool =
    currentColor === "dark"
      ? BOARD_LIGHT_SQUARES
      : currentColor === "light"
        ? BOARD_DARK_SQUARES
        : [...BOARD_DARK_SQUARES, ...BOARD_LIGHT_SQUARES];

  return pool.filter(
    (square) =>
      square >= ranges.otherStart &&
      square < ranges.otherEnd &&
      !exclusions.includes(square)
  );
}

function getBishopColorsFromFen(fen, side) {
  const colors = [];
  const rows = fen.split(" ")[0].split("/");

  rows.forEach((row, rowIndex) => {
    let file = 1;
    for (const character of row) {
      if (/\d/.test(character)) {
        file += Number(character);
        continue;
      }

      if (character === (side === "w" ? "B" : "b")) {
        const rank = 8 - rowIndex;
        colors.push((file + rank) % 2 === 0 ? "dark" : "light");
      }
      file += 1;
    }
  });

  return colors;
}

function areBishopsOnOppositeColors(fen, side) {
  const colors = getBishopColorsFromFen(fen, side);
  return colors.length === 2 && new Set(colors).size === 2;
}

export {
  areBishopsOnOppositeColors,
  getBishopColorsFromFen,
  getBishopPlacementCandidates,
  getSquareColor,
};
