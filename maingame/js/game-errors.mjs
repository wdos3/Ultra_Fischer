export class GameConflictError extends Error {
  constructor(message = "This game changed in another tab. Resume its latest version from history or start a new game.") {
    super(message);
    this.name = "GameConflictError";
    this.code = "GAME_CONFLICT";
  }
}
