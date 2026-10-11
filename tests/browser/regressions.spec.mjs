import { test, expect } from "@playwright/test";

const standardFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test.beforeEach(async ({ page }) => {
  page.runtimeErrors = [];
  page.on("pageerror", (error) => page.runtimeErrors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(page.runtimeErrors).toEqual([]); });

async function seed(page, record = {}, { fake = true, resume = true } = {}) {
  await page.goto("/404.html");
  await page.addScriptTag({ url: "/maingame/js/chess.js" });
  await page.evaluate(async ({ standardFen, record }) => {
    const storage = await import("/maingame/js/storage.mjs");
    await storage.createGame({
      id: "fixture", label: "Fixture game", startingFen: standardFen, currentFen: record.startingFen || standardFen,
      moves: [], status: "in_progress", mode: "pvai", playerColor: "w", ...record,
    });
  }, { standardFen, record });
  if (fake) await page.addInitScript(() => {
    window.testWorkers = [];
    window.holdOpponent = false;
    class ControlledWorker extends EventTarget {
      constructor(url) {
        super(); this.url = String(url); this.commands = []; this.multiPV = 1; window.testWorkers.push(this);
        if (window.failEngineStartup) queueMicrotask(() => this.dispatchEvent(new Event("error")));
      }
      emit(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
      postMessage(command) {
        this.commands.push(command);
        if (command === "uci" && !window.failEngineStartup) queueMicrotask(() => {
          this.emit("option name MultiPV type spin default 1 min 1 max 500");
          this.emit("option name Skill Level type spin default 20 min 0 max 20");
          this.emit("uciok");
        });
        if (command === "isready") queueMicrotask(() => this.emit("readyok"));
        if (command.startsWith("setoption name MultiPV")) this.multiPV = Number(command.split(" ").at(-1));
        if (command.startsWith("position fen ")) this.fen = command.slice(13);
        if (command.startsWith("go ")) {
          const depth = Number(command.match(/depth (\d+)/)[1]);
          const chess = new window.Chess(this.fen);
          this.moves = chess.moves({ verbose: true }).slice(0, this.multiPV).map((move) => move.from + move.to + (move.promotion || ""));
          const respond = () => {
            if (this.terminated) return;
            this.moves.forEach((move, index) => this.emit(`info depth ${depth} multipv ${index + 1} score cp ${-index * 10} pv ${move}`));
            this.emit("bestmove " + (this.moves[0] || "(none)"));
          };
          if (window.holdOpponent && depth <= 8) this.held = respond;
          else this.timer = setTimeout(respond, 30);
        }
        if (command === "stop") {
          clearTimeout(this.timer);
          this.held = null;
          setTimeout(() => this.emit("bestmove " + (this.moves?.[0] || "(none)")), 30);
        }
      }
      terminate() { this.terminated = true; clearTimeout(this.timer); }
    }
    window.Worker = ControlledWorker;
  });
  await page.goto("/");
  if (resume) {
    await expect(page.locator("#resume-dialog")).toBeVisible();
    await page.locator("#resume-game").click();
    await expect(page.locator("#resign")).toBeEnabled();
  }
}

async function clickMove(page, from, to) {
  await page.locator('#board [data-square="' + from + '"]').click();
  await page.locator('#board [data-square="' + to + '"]').click();
}
async function readRecord(page, id = "fixture") {
  return page.evaluate(async (id) => (await import("/maingame/js/storage.mjs")).getGame(id), id);
}
async function openRecords(page, panel) {
  await page.locator("#records-toggle").click();
  await page.locator('#records-menu [data-panel="' + panel + '"]').click();
}

test("real Stockfish starts as WASM under production security headers", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/404.html");
  const result = await page.evaluate(async (fen) => {
    const { StockfishEngine } = await import("/maingame/js/stockfish-engine.mjs");
    const { ANALYSIS_PROFILE } = await import("/maingame/js/stockfish-config.mjs");
    const engine = new StockfishEngine();
    try {
      await engine.ready();
      const result = await engine.search(fen, { ...ANALYSIS_PROFILE, depth: 12, moveTime: 500 });
      return { source: engine.source, score: result.score, bestMove: result.bestMove };
    } finally { engine.dispose(); }
  }, standardFen);
  expect(result.source).toBe("stockfish-18-lite-single.js");
  expect(result.bestMove).toMatch(/^[a-h][1-8][a-h][1-8]/);
  expect(result.score.depth).toBeGreaterThan(0);
  expect(errors.filter((error) => /WebAssembly|Content Security Policy|wasm|Stockfish/i.test(error))).toEqual([]);
});

test("mode switch during AI thinking remains playable and resumes as PvP", async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { window.holdOpponent = true; });
  await clickMove(page, "e2", "e4");
  await expect(page.locator("#status-text")).toContainText("thinking");
  await page.locator("#toggle-mode").click();
  await expect(page.locator("#undo")).toBeEnabled();
  await clickMove(page, "e7", "e5");
  await expect.poll(async () => (await readRecord(page)).moves).toEqual(["e4", "e5"]);
  expect((await readRecord(page)).mode).toBe("pvp");
  await page.reload();
  await page.locator("#resume-game").click();
  await expect(page.locator("#mode-pill")).toHaveText("Player vs Player");
  await expect(page.locator("#start-game")).toBeEnabled();
});

test("resigning during AI thinking is a loss; finished controls stay disabled; next game works", async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { window.holdOpponent = true; });
  await clickMove(page, "e2", "e4");
  await expect(page.locator("#status-text")).toContainText("thinking");
  await page.locator("#resign").click();
  await expect(page.locator("#result-title")).toHaveText("You lose");
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(page.locator("#hint-button")).toBeDisabled();
  await expect(page.locator("#resign")).toBeDisabled();
  await expect(page.locator("#eval-label")).toHaveText("#0-1");
  await expect.poll(async () => (await readRecord(page)).result).toBe("loss");
  await page.locator("#result-new-game").click();
  await page.evaluate(() => { window.holdOpponent = false; });
  await page.locator("#start-game").click();
  await expect(page.locator("#record-turn")).toHaveText("White to move");
  await expect(page.locator("#resign")).toBeEnabled();
  await expect(page.locator("#status-text")).not.toContainText("thinking");
  expect((await readRecord(page)).result).toBe("loss");
});

test("black-starting moves render PNGs in the black column", async ({ page }) => {
  await seed(page, { startingFen: standardFen.replace(" w ", " b "), playerColor: "b", mode: "pvp" });
  await clickMove(page, "e7", "e5");
  const row = page.locator("#move-history .history-row").first();
  await expect(row.locator(".move-cell").nth(0)).toHaveText("");
  await expect(row.locator(".move-cell").nth(1)).toHaveText("e5");
  const image = row.locator("img");
  await expect(image).toHaveAttribute("src", /bP\.png/);
  expect(await image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test("unfavoriting the active game remains unfavorited after the next autosave", async ({ page }) => {
  await seed(page, { isFavorite: true, mode: "pvp" });
  await openRecords(page, "favorites");
  await page.locator('#favorites-list [data-record-action="favorite"]').click();
  await expect(page.locator("#favorites-list")).toContainText("No favorite games");
  await page.locator('#favorites-dialog [data-close-panel]').click();
  await clickMove(page, "e2", "e4");
  await expect.poll(async () => (await readRecord(page)).moves.length).toBe(1);
  expect((await readRecord(page)).isFavorite).toBe(false);
});

test("changing the next game's color does not alter the terminated record", async ({ page }) => {
  await seed(page, { mode: "pvp" });
  await page.locator("#new-game").click();
  await page.locator('.color-button[data-color="b"]').click();
  await page.locator("#start-game").click();
  await expect(page.locator("#record-color")).toHaveText("You: Black");
  await expect(page.locator("#resign")).toBeEnabled();
  const old = await readRecord(page);
  expect(old.status).toBe("terminated");
  expect(old.playerColor).toBe("w");
  expect(old.mode).toBe("pvp");
});

test("board rebuilds keep one set of handlers and drag-and-drop still works", async ({ page }) => {
  await seed(page, { mode: "pvp" });
  const count = () => page.evaluate(() => (window.jQuery._data(window, "events").mousemove || []).length);
  const before = await count();
  await page.locator("#settings-toggle").click();
  await page.locator('#app-menu [data-panel="settings"]').click();
  for (let index = 0; index < 10; index += 1) {
    await page.locator("#move-animation").selectOption(index % 2 ? "slide" : "instant");
  }
  expect(await count()).toBe(before);
  await page.locator("#settings-close").click();
  const from = await page.locator('#board [data-square="e2"]').boundingBox();
  const to = await page.locator('#board [data-square="e4"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect.poll(async () => (await readRecord(page)).moves).toEqual(["e4"]);
});

test("promotion is over the board with all four real piece images", async ({ page }) => {
  await seed(page, { startingFen: "7k/P7/8/8/8/8/8/K7 w - - 0 1", mode: "pvp" });
  await clickMove(page, "a7", "a8");
  await expect(page.locator("#promotion-dialog")).toBeVisible();
  expect(await page.locator("#promotion-options img").evaluateAll((images) => images.length === 4 && images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  await page.locator('#promotion-options [data-piece="n"]').click();
  await expect.poll(async () => (await readRecord(page)).moves[0]).toBe("a8=N");
});

test("evaluation toggling leaves layout stable on desktop and mobile", async ({ page }) => {
  await seed(page, { mode: "pvp" });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const before = await page.locator("#board").boundingBox();
    await page.locator("#eval-toggle").click();
    const after = await page.locator("#board").boundingBox();
    expect(after).toEqual(before);
    const label = await page.locator("#eval-label").boundingBox();
    const mode = await page.locator("#toggle-mode").boundingBox();
    expect(label.y + label.height <= mode.y || mode.y + mode.height <= label.y || label.x + label.width <= mode.x || mode.x + mode.width <= label.x).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: "test-results/layout-" + viewport.width + ".png", fullPage: true });
    await page.locator("#eval-toggle").click();
  }
});

test("checkmate replaces mate-in-one with a terminal full-white evaluation", async ({ page }) => {
  await seed(page, { startingFen: "7k/8/5KQ1/8/8/8/8/8 w - - 0 1", mode: "pvp" });
  await clickMove(page, "g6", "g7");
  await expect(page.locator("#result-title")).toHaveText("You win");
  await expect(page.locator("#eval-label")).toHaveText("#1-0");
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(page.locator("#hint-button")).toBeDisabled();
  await expect.poll(async () => (await readRecord(page)).termination).toBe("checkmate");
  expect(await page.locator("#eval-fill").evaluate((element) => element.style.height)).toBe("100%");
});

test("runtime engine failure releases controls and a new game can restart", async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { window.holdOpponent = true; });
  await clickMove(page, "e2", "e4");
  await expect(page.locator("#status-text")).toContainText("thinking");
  await page.evaluate(() => window.testWorkers[0].dispatchEvent(new Event("error")));
  await expect(page.locator("#start-game")).toBeEnabled();
  await page.locator("#new-game").click();
  await page.evaluate(() => { window.holdOpponent = false; });
  await page.locator("#start-game").click();
  await expect(page.locator("#resign")).toBeEnabled();
  await expect(page.locator("#status-text")).toHaveText("White to move.");
  expect(await page.evaluate(() => window.testWorkers.length)).toBeGreaterThan(1);
});

test("click moves animate through several frame transforms without stray pieces", async ({ page }) => {
  await seed(page, { mode: "pvp" });
  await page.evaluate(() => {
    window.motionTransforms = new Set();
    window.motionObserver = new MutationObserver(() => {
      for (const piece of document.querySelectorAll("body > .piece-417db")) {
        if (piece.style.transform) window.motionTransforms.add(piece.style.transform);
      }
    });
    window.motionObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
  });
  await clickMove(page, "e2", "e4");
  await expect.poll(async () => page.evaluate(() => window.motionTransforms.size)).toBeGreaterThan(3);
  await expect(page.locator('#board [data-square="e4"] img')).toHaveCount(1);
  await expect(page.locator('#board [data-square="e2"] img')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => document.querySelectorAll("body > .piece-417db").length)).toBe(1);
  await page.evaluate(() => window.motionObserver.disconnect());
});

test("real position search obeys the deadline and only returns depth-confirmed starts", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/404.html");
  await page.addScriptTag({ url: "/maingame/js/chess.js" });
  const samples = await page.evaluate(async () => {
    const { StockfishEngine } = await import("/maingame/js/stockfish-engine.mjs");
    const { generateBalancedPosition } = await import("/maingame/js/position-generator.mjs");
    const { confirmationAccepted } = await import("/maingame/js/position-policy.mjs");
    const engine = new StockfishEngine();
    const samples = [];
    try {
      await engine.ready();
      for (const [sideToMove, friendlyMode] of [["w", true], ["b", true], ["w", false]]) {
        const started = performance.now();
        const traces = [];
        const measuredEngine = { search: async (...args) => {
          const result = await engine.search(...args);
          traces.push({ requested: args[1].depth, depth: result.score?.depth, cp: result.score?.value, candidates: result.candidates.map((candidate) => candidate.score.value) });
          return result;
        } };
        const candidate = await generateBalancedPosition(sideToMove, { engine: measuredEngine, acceptanceCp: 150, friendlyMode });
        const accepted = !candidate || confirmationAccepted(new window.Chess(candidate.fen), {
          score: { ...candidate.score, value: sideToMove === "w" ? candidate.score.value : -candidate.score.value },
          candidates: candidate.alternatives,
        }, 150, friendlyMode);
        samples.push({ sideToMove, friendlyMode, accepted, found: Boolean(candidate), durationMs: Math.round(performance.now() - started), depth: candidate?.score.depth, cp: candidate?.score.value, screens: traces.filter((trace) => trace.requested === 12).length, confirmations: traces.filter((trace) => trace.requested === 16) });
      }
      return samples;
    } finally { engine.dispose(); }
  });
  console.log("Real position samples:", JSON.stringify(samples));
  expect(samples.every((sample) => sample.accepted && sample.durationMs < 16500)).toBe(true);
});

test("invalid backup imports preserve both history and active recording", async ({ page }) => {
  await seed(page, { mode: "pvp" });
  await page.locator("#settings-toggle").click();
  await page.locator('#app-menu [data-panel="data"]').click();
  await page.locator("#import-file").setInputFiles({
    name: "invalid.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "Ultra_Fischer-backup", version: 1, games: [{ startingFen: standardFen, moves: ["Qxg7"] }], favoriteGames: [] })),
  });
  await expect(page.locator("#toast")).toContainText("illegal move");
  expect((await readRecord(page)).label).toBe("Fixture game");
  await page.locator('#data-dialog [data-close-panel]').click();
  await clickMove(page, "e2", "e4");
  await expect.poll(async () => (await readRecord(page)).moves).toEqual(["e4"]);
});

test("history loads in pages and Copy PGN exports the actual game", async ({ page }) => {
  await seed(page, { mode: "pvp" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await clickMove(page, "e2", "e4");
  await page.evaluate(async (startingFen) => {
    const { createGame } = await import("/maingame/js/storage.mjs");
    for (let index = 0; index < 52; index += 1) await createGame({ id: "older" + index, label: "Older " + index, startingFen, currentFen: startingFen, moves: [], status: "terminated", updatedAt: 1000 });
  }, standardFen);
  await openRecords(page, "history");
  await expect(page.locator("#history-list .record-item")).toHaveCount(50);
  await page.locator("#history-list").getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.locator("#history-list .record-item")).toHaveCount(53);
  await page.locator('#history-list [data-record-id="fixture"][data-record-action="copy-pgn"]').click();
  await expect(page.locator("#toast")).toHaveText("PGN copied to clipboard.");
  const parsed = await page.evaluate(async () => {
    const pgn = await navigator.clipboard.readText();
    const chess = new window.Chess();
    return { valid: chess.load_pgn(pgn), moves: chess.history(), pgn };
  });
  expect(parsed.valid).toBe(true);
  expect(parsed.moves).toEqual(["e4"]);
  expect(parsed.pgn).toContain('[SetUp "1"]');
});

test("initial engine failure can be retried through New Game without refreshing", async ({ page }) => {
  await page.addInitScript(() => { window.failEngineStartup = true; });
  await seed(page, {}, { resume: false });
  await expect(page.locator("#status-text")).toContainText("Engine failed to load");
  await page.evaluate(() => { window.failEngineStartup = false; });
  await page.locator("#new-game").click();
  await expect(page.locator("#start-game")).toBeEnabled();
  await page.locator("#start-game").click();
  await expect(page.locator("#resign")).toBeEnabled();
});
