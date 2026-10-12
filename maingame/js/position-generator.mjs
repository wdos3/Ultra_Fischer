import { Chess, isValidChessFen } from "./chess-rules.mjs";
import { areBishopsOnOppositeColors, getBishopPlacementCandidates, getSquareColor } from "./position-utils.mjs";
import { ANALYSIS_PROFILE } from "./stockfish-config.mjs";
import { confirmationAccepted, POSITION_CONFIRM_DEPTH, POSITION_SCREEN_DEPTH } from "./position-policy.mjs";

function getRandomPosition(start, end, exclusions) {
  const available = [];
  for (let square = start; square < end; square += 1) {
    if (!exclusions.includes(square)) {
      available.push(square);
    }
  }
  return available[Math.floor(Math.random() * available.length)];
}

export function generatePosition(sideToMove) {
  if (!["w", "b"].includes(sideToMove)) throw new Error("Invalid starting side.");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const fen = generateCandidate(sideToMove);
    if (isValidChessFen(fen) && areBishopsOnOppositeColors(fen, "w") && areBishopsOnOppositeColors(fen, "b")) return fen;
  }
  throw new Error("Could not place a legal pair of kings. Retry the position search.");
}

function generateCandidate(sideToMove) {
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

  const setPieces = (pieces, ranges) => {
    let bishopColor = null;
    for (const piece of pieces) {
      if (piece.toLowerCase() === "k") {
        continue;
      }
      let position;
      if (piece.toLowerCase() === "b") {
        const candidates = getBishopPlacementCandidates(
          bishopColor,
          ranges,
          exclusions
        );
        position = candidates[Math.floor(Math.random() * candidates.length)];
        bishopColor = getSquareColor(position);
      } else if (piece.toLowerCase() === "p") {
        position = getRandomPosition(ranges.pawnStart, ranges.pawnEnd, exclusions);
      } else {
        position = getRandomPosition(ranges.otherStart, ranges.otherEnd, exclusions);
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

  setPieces(whitePieces, { pawnStart: 51, pawnEnd: 89, otherStart: 51, otherEnd: 99 });
  setPieces(blackPieces, { pawnStart: 31, pawnEnd: 69, otherStart: 21, otherEnd: 69 });
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

  const fen = `${fenRows.join("/")} ${sideToMove} - - 0 1`;
  return fen;
}

export async function generateBalancedPosition(sideToMove, {
  engine, acceptanceCp, friendlyMode, isCancelled = () => false, announce = () => {}, timeoutMs = 15000,
}) {
  const deadline = performance.now() + timeoutMs;
  let attempt = 0;
  while (performance.now() < deadline && !isCancelled()) {
    const fen = generatePosition(sideToMove);
    if (!isValidChessFen(fen)) continue;
    const probe = new Chess(fen);
    if (probe.game_over()) continue;
    announce(++attempt);
    const search = (depth, moveTime, candidateCount = 1) => {
      const remaining = deadline - performance.now();
      return engine.search(fen, {
        ...ANALYSIS_PROFILE, depth, candidateCount,
        moveTime: Math.max(1, Math.floor(Math.min(moveTime, remaining - 50))),
      }, { kind: "position", priority: 5, timeoutMs: Math.max(1, Math.floor(remaining)) });
    };
    if (deadline - performance.now() < 300) break;
    let screen;
    try { screen = await search(POSITION_SCREEN_DEPTH, 300); }
    catch (error) { if (error.code === "ENGINE_TIMEOUT") return null; throw error; }
    if (isCancelled() || screen.cancelled) return null;
    if (!screen.score || screen.score.type !== "cp" || screen.score.depth < POSITION_SCREEN_DEPTH || Math.abs(screen.score.value) > Math.max(350, acceptanceCp * 1.5)) continue;
    if (deadline - performance.now() < 400) break;
    let confirmation;
    try { confirmation = await search(POSITION_CONFIRM_DEPTH, 2500, friendlyMode ? 2 : 1); }
    catch (error) { if (error.code === "ENGINE_TIMEOUT") return null; throw error; }
    if (isCancelled() || confirmation.cancelled) return null;
    if (performance.now() > deadline || !confirmationAccepted(probe, confirmation, acceptanceCp, friendlyMode)) continue;
    return {
      fen, sideToMove,
      score: { ...confirmation.score, value: sideToMove === "w" ? confirmation.score.value : -confirmation.score.value },
      alternatives: confirmation.candidates,
    };
  }
  return null;
}
