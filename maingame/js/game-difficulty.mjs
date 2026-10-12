export function normalizeLevelHistory(history, level, moveCount) {
  const entries = Array.isArray(history) ? history.filter((entry) =>
    Number.isInteger(entry?.ply) && entry.ply >= 0 && entry.ply <= moveCount
    && Number.isInteger(entry.level) && entry.level >= 1 && entry.level <= 8
  ).map(({ ply, level }) => ({ ply, level })).sort((a, b) => a.ply - b.ply) : [];
  const boundaries = [];
  for (const entry of entries) {
    if (boundaries.at(-1)?.ply === entry.ply) boundaries[boundaries.length - 1] = entry;
    else boundaries.push(entry);
  }
  if (!boundaries.length || boundaries[0].ply !== 0) boundaries.unshift({ ply: 0, level });
  // Undo rewinds moves, not the current setting. Record its new move boundary.
  if (boundaries.at(-1).level !== level) {
    if (boundaries.at(-1).ply === moveCount) boundaries.at(-1).level = level;
    else boundaries.push({ ply: moveCount, level });
  }
  return boundaries.filter((entry, index) => index === 0 || entry.level !== boundaries[index - 1].level);
}

export function difficultyLabel(record) {
  const levels = [...new Set((record.levelHistory || []).map((entry) => entry.level))];
  return levels.length > 1 ? `Mixed levels (${levels.join(", ")})` : `Level ${record.stockfishLevel}`;
}

export function statisticsLevel(record) {
  return new Set((record.levelHistory || []).map((entry) => entry.level)).size > 1 ? "mixed" : String(record.stockfishLevel);
}
