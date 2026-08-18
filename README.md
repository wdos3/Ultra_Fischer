# Ultra_Fischer

Ultra_Fischer is randomized chess with a local-first game archive. Positions are generated in the browser and evaluated by the bundled Stockfish workers.

## Local data

- Game records, unfinished and terminated games, favorite games, replays, and statistics use IndexedDB in a versioned `Ultra_Fischer` database.
- Engine and interface preferences use the namespaced `Ultra_Fischer.preferences` localStorage key.
- The Data & Storage panel exports and imports a validated JSON backup and provides deliberate clear/delete controls.
- No account, email address, remote game API, or cloud sync is required.

## Development

Serve the repository from a local HTTP server so module scripts, workers, and IndexedDB behave like production. For example:

```powershell
npx serve . -l 4175
```

Then open `http://localhost:4175/home.html`.

Run the focused checks with `npm test` and syntax checks with `npm run check`.
