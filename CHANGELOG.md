# Changelog

All notable Ultra Fischer changes currently present in this repository are recorded here. Legacy entries are reconstructed from Git history; the latest entry records the implementation and verification directly.

## 2026-10-12

### Backup, rule validation, and interaction fixes

- Export compact JSON with each game stored once; preserve favorites through their record flags and retain compatibility with older duplicate-favorite backups.
- Remove the fixed 5 MB import rejection. Read and parse files inside the validation worker, retaining its timeout, cleanup, and all-or-nothing import safeguards.
- Reject inconsistent castling rights when the king or same-color rook is absent, and reject en-passant targets without a preceding pawn double move. Preserve valid FEN targets even when no adjacent pawn can capture.
- Add shared dialog focus management, background inertness, Tab/Shift+Tab containment, opener restoration, and top-dialog-only Escape handling, including nested setting information and promotion.
- Preserve promotion-picker focus when it opens during a board mouse press.
- Coalesce repeated hint requests for the same game position, disable the hint control while pending, and recover cleanly after cancellation or worker failure without stale feedback.
- Add unit coverage for special-move FEN fields, favorite export round-trips, and validator cleanup. Add browser coverage for new and legacy backups over 5 MB, malformed imports, dialog/promotion keyboard behavior, repeated hints, and hint interruption/retry.

### Live preference reset

- Apply default preferences to the live page after Delete all local data, including theme, evaluation visibility, difficulty, animation, balance, Friendly Mode, and requested side. Subsequent setting changes and reloads no longer restore deleted preferences.
- Disable duplicate deletion requests while deletion runs and report failures without claiming success.
- Add browser regressions for deletion followed by settings changes and reload, and cancellation preserving both preferences and active recording.

### Input, persistence, and turn recovery

- Prevent touch compatibility mouse events from cancelling square selection; retain both touch tapping and dragging.
- Add transactional progress revisions and import generations. Stale tabs cannot overwrite newer moves, completed results, deleted games, or reimported records, and can recover by resuming the latest record or starting a new match.
- Preserve independent archive name/favorite edits during autosaves without introducing false progress conflicts.
- Rebase active sessions after successful backup merges; resume autosaving instead of silently detaching the active writer. Replacement that removes the active record disables the old board.
- Move JSON parsing, SAN validation, FEN verification, and PGN reconstruction off the main thread into a disposable backup worker; remove duplicate validation and replay passes.
- Pause conflicting game/data operations during import, and preserve active recording after invalid imports.
- Reconcile turns after Undo so undoing a lone AI opening starts a replacement opponent move.
- Guard asynchronous mode, resume, undo, and difficulty continuations with match tokens and position checks; deduplicate opponent searches for each active turn.
- Persist mid-game difficulty changes with move boundaries and label mixed-level archives/statistics separately. Undo retains the selected difficulty at its rewound boundary.
- Start search deadlines when requests enter the queue, including worker initialization. Expiring queued work leaves unrelated searches running, and disposing during initialization cannot resurrect a fallback worker.

### Verification

- Add unit regressions for progress conflicts, delete/reimport identity, serialized revisions, mixed-level statistics, difficulty rewind, queued/startup deadlines, and startup disposal.
- Add browser regressions for touch taps/drags, active merge/replace recovery, conflicting tabs, AI-opening undo, rapid mode switches with delayed persistence, live difficulty changes, and responsive large imports.
- Retain real Stockfish 18 WASM startup and randomized depth-confirmed position checks under production security headers.

## 2026-10-11

### Engine reliability and position accuracy

- Permit WASM compilation in the production CSP without allowing general JavaScript eval.
- Extract the worker/UCI transport into its own module. Drain cancelled searches before starting the next task, isolate replies from old workers, and restart after runtime errors, hung searches, or missing stop responses.
- Prioritize opponent turns over hints and evaluation; retain the transposition table between searches and reset it only for a new match.
- Make New Game retry failed engine initialization, and prevent the unverified startup-preview board from accepting moves.
- Require actual depth-12 screening and depth-16 confirmation. Ignore bound estimates, reject incomplete searches, and require legal, distinct Friendly Mode alternatives at the same depth within the selected balance limit.
- Screen one principal variation first, then confirm two for Friendly Mode, reducing unnecessary search work while retaining the strict acceptance rules.
- Version cached-position keys and revalidate cached FENs, bishops, balance scores, and alternatives before use.
- Bound raw-position retries and retain the 15-second search budget without accepting a weaker position on timeout.
- Correct mate candidate ordering and preserve Stockfish's native weakened best move when no candidate sampling is requested.

### Match lifecycle, records, and rendering

- Extract match persistence and chess validation/replay into shared modules. Serialize saves and lock completed/terminated outcomes.
- Cancel AI work and clear busy state when switching modes; preserve PvP mode on resume.
- Correct resignation during an opponent turn, disable finished-game actions, and reflect checkmate/resignation with terminal evaluation labels and a fully won/lost bar.
- Terminate the old match before assigning the next game's player color. Preserve active-record name/favorite edits and prevent cleared/deleted records from being resurrected by autosaves.
- Exclude PvP from AI statistics and identify local opponents correctly in the archive.
- Render black-starting moves in the black column, with correct fullmove numbers in both the live record and replay.
- Extract record views, add indexed 50-record pagination, and update live move rows incrementally.
- Separate clicks from drags, wait for board motion before applying fast AI replies, cancel obsolete animations, and release board handlers/timers/transient pieces on destruction.
- Validate backups by replaying SAN and checking the final FEN. Reject malformed records before any replacement and import all game/legacy-position records in one rollback-safe transaction.
- Preserve legacy saved positions in exports and apply imported preferences without allowing the previously active game to overwrite imported records.
- Correct About wording on finite-depth estimates, draw rules, minimum reached depths, and retry behavior.
- Keep the mobile evaluation readout and toggle inside the reserved bar row so they do not overlap the mode controls or clip off-screen.

### Verification and development

- Add engine, lifecycle, position-policy, storage-failure, and mate-ordering unit regressions.
- Add browser coverage for real WASM startup under production CSP, engine interruption, mode switching, resignation/checkmate, move columns/images, favorites, next-game metadata, board cleanup, dragging, promotion, animation, backup rejection, paginated history, PGN clipboard export, and desktop/mobile layout stability.
- Add a local server using production headers, a reproducible development lockfile, syntax checks for all application modules, and GitHub Actions for unit/browser checks.

## 2026-09-07

### Navigation, settings, and presentation

- Turn the App menu into an icon-led launcher for full-screen Game History, Favorite Games, Statistics, Settings, and Data & Storage views, with a consistent return-to-menu button on each view.
- Remove the user-facing position-depth control and fix starting-position screening at depth 12; document the finite position space, bundled Stockfish.js WASM/fallback engine, confirmation depth, and local storage behavior in About.
- Add compact Stockfish-level and Friendly Mode information panels, including the difference between Friendly Mode on and off.
- Add Dark, Light, Slate, Forest, and Blue color themes with persisted selection.
- Keep the evaluation-bar column reserved when the bar is hidden so toggling it no longer moves the board or surrounding layout.

### Engine, records, and game outcomes

- Replace the legacy Stockfish 10-era browser workers with the Stockfish.js 18 lite single-threaded WASM build and an ASM-JS fallback, retaining the worker-based UCI interface.
- Move Game History, Favorite Games, and Statistics into a dedicated records menu beside the App menu, and replace the record-summary squares with side-specific king icons.
- Add an advanced Stockfish-level specification table and a Friendly Mode on/off comparison table.
- Show terminal mate evaluations as `M+1`/`M-1` instead of leaving the previous evaluation in place, and add a clear win/loss/draw result overlay with a short best-effort tone.

## 2026-09-02

### Position generation and evaluation

- Add a persisted starting-balance setting with a 150 cp minimum and a bounded 2000 cp maximum, plus Friendly Mode for rejecting positions with too few legal choices or too few closely scored engine alternatives.
- Add a small two-position local cache backed by a separate Stockfish worker so ready positions can be prepared in the background and reused after a page reload without storing thousands of seeds or competing with the live game engine.
- Make the evaluation bar's white fill span the full track in both orientations and keep the selected balance limit accurate in the About copy.

## 2026-08-18

### Board, promotion, and evaluation

- `177ddc9` Redesign the pawn promotion picker as a compact, board-anchored overlay. Dim the board while choosing a promotion piece, keep click-away and Escape cancellation, and load the correct white and black promotion PNG assets.
- `395e1de` Replace jQuery board movement animations with requestAnimationFrame-based 60 Hz-friendly motion, restore black move-history piece icons, remove the redundant bottom player strip, and clarify the side and turn badges in the game record.
- `2ad0b9f` Harden randomized position creation with strict centipawn-loss screening, a 15-second search deadline, a higher-accuracy evaluation path, a hidden-by-default evaluation bar, and related Vercel delivery headers.
- `0b6c5ce` Add recovery paths for Stockfish startup failures so the board can remain usable when the engine needs to be restarted.
- `9ce17c6` Improve engine startup and board interaction responsiveness, including smoother movement behavior and better loading-state handling.
- `1762b15` Render the initial board while Stockfish is still initializing instead of leaving the game surface blank.
- `19a1795` Restore the Ultra Fischer bishop invariant: each side's two bishops must occupy opposite-colored squares. Add FEN validation, candidate filtering, and focused tests for the rule.

### Game history and local data

- `7ca8724` Compact game-history actions so editing, favoriting, replaying, deleting, and PGN copying fit cleanly in each record.
- `a602580` Add terminated-game outcomes, favorite games, expanded history filters, replay/statistics support, and the local storage migrations needed to keep unfinished and terminated games distinct.
- `3d9e567` Add editable saved-record names, promotion controls, favorite metadata, and the initial saved-position management UI.
- `307eb2f` Migrate the application to local-first storage. Replace the account/cloud game flow with versioned IndexedDB records, local preferences, validated backup import/export, and deliberate local data controls.

### Public interface and branding

- `8f81fb0` Serve the application from the clean root URL through a Vercel rewrite and remove the redundant root page.
- `90b9336` Polish the public game interface: remove cluttering flavor text, update the public Ultra Fischer wording and About section, rearrange game controls, add move-history piece icons, refine the evaluation display, and remove the old bottom PGN controls and local-randomized-chess label.
- `cb6ac32` Rename the project and public-facing product surfaces to `Ultra_Fischer`/Ultra Fischer, update the repository metadata, and migrate local storage names.

### Authentication and delivery phase

The following commits document an earlier Supabase/Vercel account phase from today. That phase was subsequently superseded by `307eb2f`, which made the game archive local-first; the commits remain part of the repository history for traceability.

- `544bd3b` Handle authentication email delivery failures and provide clearer recovery behavior.
- `5bde980` Fix authentication form serialization.
- `60b6339` Prevent stale authentication-page caching in production.
- `b30da73` Avoid false browser email-validation failures and add coverage for the corrected behavior.
- `c4ccfcf` Refresh the cached authentication module after validation changes.
- `3df97ff` Set the password policy to a minimum of 8 and maximum of 32 characters, updating UI, API validation, documentation, and tests.
- `e9c5c56` Improve authentication validation feedback.
- `e48ce9c` Normalize invisible characters in authentication email addresses and test the handling.
- `f716943` Trim authentication email input before validation.
- `fef8394` Apply production Supabase authentication email templates.
- `28ec53d` Fix Supabase service-role RPC authentication and its tests.
- `1daf4ce` Configure the Supabase authentication project, confirmation/recovery templates, and deployment documentation.
- `36a6f3e` Harden authentication origin rejection.
- `d7e5a4e` Add the production authentication flow, API handlers, Supabase migration, frontend account UI, and authentication tests.

## 2026-08-17

- `3c699f7` Deliver the major Ultra Fischer UI/UX redesign and Stockfish difficulty rework, including the new visual system, settings surface, engine-level profiles, and focused Stockfish configuration tests.

## 2026-04-30

- `b95afe4` Import the original Ultra Fischer website: chessboard UI, chess.js, chessboard.js, bundled Stockfish WASM assets, Wikipedia chess-piece PNGs, favicon, initial pages, package metadata, and deployment scaffolding.
