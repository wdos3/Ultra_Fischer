import { groupMoveRows } from "./chess-rules.mjs";

export class MoveRecordView {
  constructor(container) {
    this.container = container;
    this.rows = [];
    this.startingFen = null;
  }

  render(moves, startingFen) {
    if (this.startingFen !== startingFen) {
      this.container.replaceChildren();
      this.rows = [];
      this.startingFen = startingFen;
    }
    const groups = groupMoveRows(moves, startingFen);
    if (!groups.length) {
      this.container.replaceChildren();
      this.rows = [];
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No moves yet.";
      this.container.append(empty);
      return;
    }
    this.container.querySelector(".history-empty")?.remove();
    while (this.rows.length > groups.length) this.rows.pop().element.remove();
    groups.forEach((group, index) => {
      let row = this.rows[index];
      if (!row) {
        const element = document.createElement("div");
        element.className = "history-row";
        const number = document.createElement("span");
        number.className = "move-number";
        number.textContent = group.number + ".";
        const white = document.createElement("span");
        const black = document.createElement("span");
        white.className = black.className = "move-cell";
        element.append(number, white, black);
        this.container.append(element);
        row = { element, white, black, signature: "" };
        this.rows.push(row);
      }
      const signature = [group.white?.san, group.black?.san].join(":");
      if (row.signature === signature) return;
      row.signature = signature;
      for (const side of ["white", "black"]) {
        const move = group[side];
        row[side].replaceChildren();
        if (!move) continue;
        const image = document.createElement("img");
        image.className = "move-piece-icon";
        image.src = `maingame/img/chesspieces/wikipedia/${move.color}${move.piece.toUpperCase()}.png`;
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        const san = document.createElement("span");
        san.textContent = move.san;
        row[side].append(image, san);
      }
    });
    this.container.scrollTop = this.container.scrollHeight;
  }
}
