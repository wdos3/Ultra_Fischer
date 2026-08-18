# Changelog

All notable Ultra Fischer changes currently present in this repository are recorded here. Entries are reconstructed from the Git history and include the commit that introduced each change.

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
