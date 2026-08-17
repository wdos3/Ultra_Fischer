import assert from "node:assert/strict";
import test from "node:test";
import {
  getLevelConfig,
  resolveEngineDifficulty,
} from "./stockfish-config.mjs";

const installedOptions = {
  "skill level": { min: 0, max: 20 },
  multipv: { min: 1, max: 500 },
};

test("level profiles keep the requested depth and move time", () => {
  assert.deepEqual(
    getLevelConfig(1),
    { requestedSkill: -9, depth: 5, moveTime: 50, candidateCount: 6 }
  );
  assert.deepEqual(
    getLevelConfig(4),
    { requestedSkill: 3, depth: 5, moveTime: 200, candidateCount: 1 }
  );
  assert.deepEqual(
    getLevelConfig(8),
    { requestedSkill: 20, depth: 22, moveTime: 1000, candidateCount: 1 }
  );
});

test("unsupported negative skill values remain distinct", () => {
  const levelOne = resolveEngineDifficulty(getLevelConfig(1), installedOptions);
  const levelTwo = resolveEngineDifficulty(getLevelConfig(2), installedOptions);
  const levelThree = resolveEngineDifficulty(getLevelConfig(3), installedOptions);

  assert.equal(levelOne.nativeSkill, 0);
  assert.equal(levelTwo.nativeSkill, 0);
  assert.equal(levelThree.nativeSkill, 0);
  assert.equal(levelOne.candidateCount, 6);
  assert.equal(levelTwo.candidateCount, 5);
  assert.equal(levelThree.candidateCount, 4);
  assert.notEqual(levelOne.moveTime, levelTwo.moveTime);
  assert.notEqual(levelTwo.moveTime, levelThree.moveTime);
});
