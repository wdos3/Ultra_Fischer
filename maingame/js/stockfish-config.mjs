const STOCKFISH_LEVELS = Object.freeze({
  1: Object.freeze({ requestedSkill: -9, depth: 5, moveTime: 50, candidateCount: 6 }),
  2: Object.freeze({ requestedSkill: -5, depth: 5, moveTime: 100, candidateCount: 5 }),
  3: Object.freeze({ requestedSkill: -1, depth: 5, moveTime: 150, candidateCount: 4 }),
  4: Object.freeze({ requestedSkill: 3, depth: 5, moveTime: 200, candidateCount: 1 }),
  5: Object.freeze({ requestedSkill: 7, depth: 5, moveTime: 300, candidateCount: 1 }),
  6: Object.freeze({ requestedSkill: 11, depth: 8, moveTime: 400, candidateCount: 1 }),
  7: Object.freeze({ requestedSkill: 16, depth: 13, moveTime: 500, candidateCount: 1 }),
  8: Object.freeze({ requestedSkill: 20, depth: 22, moveTime: 1000, candidateCount: 1 }),
});

const ANALYSIS_PROFILE = Object.freeze({
  requestedSkill: 20,
  depth: 10,
  moveTime: 350,
  candidateCount: 1,
});

function getLevelConfig(level) {
  const normalizedLevel = Number(level);
  return STOCKFISH_LEVELS[normalizedLevel] || STOCKFISH_LEVELS[4];
}

function getSkillOption(options) {
  return options["skill level"] || null;
}

function getOption(options, name) {
  return options[name] || null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolveEngineDifficulty(profile, options = {}) {
  const skillOption = getSkillOption(options);
  const limitStrengthOption = getOption(options, "uci_limitstrength");
  const eloOption = getOption(options, "uci_elo");
  const skillMin = skillOption?.min ?? 0;
  const skillMax = skillOption?.max ?? 20;
  const nativeSkillSupported =
    profile.requestedSkill >= skillMin && profile.requestedSkill <= skillMax;

  if (nativeSkillSupported) {
    return {
      ...profile,
      nativeSkill: profile.requestedSkill,
      useLimitStrength: false,
      elo: null,
      compatibility: "native skill level",
    };
  }

  const nativeSkill = clamp(profile.requestedSkill, skillMin, skillMax);
  const elo = eloOption
    ? Math.round(
        clamp(
          1350 + ((profile.requestedSkill + 9) / 29) * 950,
          eloOption.min ?? 1350,
          eloOption.max ?? 2850
        )
      )
    : null;

  return {
    ...profile,
    nativeSkill,
    useLimitStrength: Boolean(limitStrengthOption && elo !== null),
    elo,
    compatibility: elo
      ? "UCI_Elo plus controlled candidate selection"
      : "native floor plus controlled candidate selection",
  };
}

function selectCandidateMove(candidates, candidateCount) {
  const ranked = candidates
    .filter((candidate) => candidate?.move)
    .sort((first, second) => (second.score?.value || 0) - (first.score?.value || 0))
    .slice(0, Math.max(1, candidateCount));

  if (ranked.length === 0) {
    return null;
  }

  if (ranked.length === 1) {
    return ranked[0].move;
  }

  const weights = ranked.map((_, index) => 1 / (index + 1));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let threshold = Math.random() * weightTotal;
  for (let index = 0; index < ranked.length; index += 1) {
    threshold -= weights[index];
    if (threshold <= 0) {
      return ranked[index].move;
    }
  }

  return ranked[0].move;
}

export {
  ANALYSIS_PROFILE,
  STOCKFISH_LEVELS,
  getLevelConfig,
  resolveEngineDifficulty,
  selectCandidateMove,
};
