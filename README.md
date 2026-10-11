# Ultra Fischer

Ultra Fischer is randomized chess with a local-first game archive. Positions are generated in the browser and evaluated by the bundled Stockfish workers.

The engine path uses the Stockfish.js 18 lite single-threaded WebAssembly build in modern browsers, with the Stockfish.js 18 ASM-JS worker as a compatibility fallback.

New positions use a configurable starting-balance limit (150 cp by default). Screening must actually reach depth 12, followed by confirmation at depth 16. Incomplete searches and bounded scores are rejected. Friendly Mode additionally requires at least three legal moves and two distinct, legal engine choices within the selected balance limit and 125 cp of the best choice at the same depth.

The search has a 15-second budget and can return no qualifying position. Retry New Game without reloading; the balance requirement is never relaxed to meet the deadline. A small two-position, versioned cache is prepared while idle and retained locally. Finite-depth Stockfish scores are estimates, not proofs of a drawn position.

## Local data

- Game records, unfinished and terminated games, favorite games, replays, and statistics use IndexedDB in a versioned `Ultra_Fischer` database.
- Engine and interface preferences use the namespaced `Ultra_Fischer.preferences` localStorage key.
- The Data & Storage panel exports and imports a validated JSON backup and provides deliberate clear/delete controls.
- No account, email address, remote game API, or cloud sync is required.
- Each match retains its own player side, mode, starting position, and result. Starting another game terminates an unfinished match before changing the new game's preferences.
- AI statistics exclude local PvP games. Legacy records without a stored mode are treated as PvAI because their original mode cannot be recovered.
- Imports replay all SAN moves and verify the resulting FEN before writing. Replacement of games and legacy positions uses one IndexedDB transaction. An invalid record rejects the entire import; nothing is silently discarded.

## Engine and rendering

- The Vercel CSP permits only the specific `wasm-unsafe-eval` allowance needed for WebAssembly compilation, not general JavaScript eval.
- Cancelled searches drain their final UCI `bestmove` before another search begins. Runtime errors, search timeouts, and missing stop replies reject affected tasks and restart the worker.
- Opponent turns preempt lower-priority analysis. The transposition table is retained between searches and reset for a new match.
- Board motion uses frame-aligned transforms. Clicks are distinguished from drags, obsolete animations are cancelled, and destroyed boards release their timers and global handlers.
- History and favorites use indexed 50-record pages. The live move list updates incrementally and groups moves by their real side and starting fullmove number.
- Engine transport, match persistence, position generation/policy, chess validation, and record views are separate modules under `maingame/js`.

## Development

Serve the repository from a local HTTP server so module scripts, workers, and IndexedDB behave like production. For example:

```powershell
npm ci
npm run dev
```

Then open `http://127.0.0.1:4176/`. The development server applies the production security headers.

Run unit tests with `npm test` and syntax checks with `npm run check`. For browser regressions, run `npx playwright install chromium` once, then `npm run test:browser`. An existing Chromium executable can be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. CI runs all three checks, including real WASM startup and deadline/acceptance checks for real generated positions.
