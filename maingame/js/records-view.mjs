import { listGamesPage } from "./storage.mjs";

const sideName = (color) => color === "w" ? "White" : "Black";
const formatDate = (timestamp) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp || Date.now()));

function makeButton(label, action, id) {
  const button = document.createElement("button");
  button.className = "compact-button secondary";
  button.type = "button";
  button.textContent = label;
  button.dataset.recordAction = action;
  button.dataset.recordId = id;
  return button;
}

function makeEditButton(action, id) {
  const button = document.createElement("button");
  button.className = "icon-button edit-record-button";
  button.type = "button";
  button.innerHTML = "&#9998;";
  button.title = "Edit name";
  button.setAttribute("aria-label", "Edit name");
  button.dataset.recordAction = action;
  button.dataset.recordId = id;
  return button;
}

function makeFavoriteButton(record) {
  const button = document.createElement("button");
  button.className = "icon-button record-title-action favorite-button";
  button.type = "button";
  button.innerHTML = record.isFavorite ? "&#9733;" : "&#9734;";
  button.title = record.isFavorite ? "Remove favorite" : "Favorite game";
  button.setAttribute("aria-label", record.isFavorite ? "Remove favorite" : "Favorite game");
  button.dataset.recordAction = "favorite";
  button.dataset.recordId = record.id;
  return button;
}

function appendRecordTitle(main, record) {
  const titleRow = document.createElement("div");
  titleRow.className = "record-item-title-row";
  const title = document.createElement("strong");
  title.className = "record-item-title";
  title.textContent = record.label || `Game ${formatDate(record.startedAt)}`;
  titleRow.append(title, makeEditButton("rename", record.id), makeFavoriteButton(record));
  main.appendChild(titleRow);
}

function recordStatusLabel(record) {
  if (record.status === "terminated") {
    return "Terminated";
  }
  if (record.status === "completed") {
    return record.result === "win" ? "Won" : record.result === "loss" ? "Lost" : "Draw";
  }
  return "In progress";
}


function renderRecords(container, games, favorites, append) {
  if (!append) container.replaceChildren();
  if (!games.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = favorites ? "No favorite games yet." : "No games match this filter yet.";
    container.appendChild(empty);
    return;
  }
  for (const record of games) {
    const item = document.createElement("article");
    item.className = "record-item";
    const main = document.createElement("div");
    main.className = "record-item-main";
    appendRecordTitle(main, record);
    const detail = document.createElement("span");
    detail.className = "record-item-detail";
    detail.textContent = `${sideName(record.playerColor)} vs ${record.mode === "pvp" ? "Local opponent" : `Level ${record.stockfishLevel}`} · ${formatDate(record.updatedAt)} · ${record.moveCount || 0} moves`;
    const meta = document.createElement("span");
    meta.className = "record-item-meta";
    meta.textContent = record.status === "terminated" && record.termination && record.termination !== "new_game"
      ? `${recordStatusLabel(record)} · ${record.termination.replaceAll("_", " ")}`
      : recordStatusLabel(record);
    main.append(detail, meta);
    const actions = document.createElement("div");
    actions.className = "record-item-actions";
    actions.appendChild(makeButton("Copy PGN", "copy-pgn", record.id));
    if (record.status === "in_progress") actions.appendChild(makeButton("Resume", "resume", record.id));
    actions.appendChild(makeButton("Replay", "replay", record.id));
    actions.appendChild(makeButton("Play Again", "again", record.id));
    if (!favorites) actions.appendChild(makeButton("Delete", "delete", record.id));
    item.append(main, actions);
    container.appendChild(item);
  }
}


export class RecordsView {
  constructor(container, { favorites = false } = {}) {
    this.container = container;
    this.favorites = favorites;
    this.revision = 0;
    this.loadMore = document.createElement("button");
    this.loadMore.type = "button";
    this.loadMore.className = "compact-button secondary";
    this.loadMore.textContent = "Load more";
    this.loadMore.addEventListener("click", () => void this.load(false));
  }

  refresh(filter = this.favorites ? "favorite" : "all", sort = "newest") {
    this.filter = filter;
    this.sort = sort;
    this.cursor = null;
    this.revision += 1;
    return this.load(true);
  }

  async load(reset) {
    const revision = this.revision;
    this.loadMore.disabled = true;
    try {
      const page = await listGamesPage({ filter: this.filter, sort: this.sort, after: this.cursor });
      if (revision !== this.revision) return;
      this.loadMore.remove();
      renderRecords(this.container, page.items, this.favorites, !reset);
      this.cursor = page.nextCursor;
      if (this.cursor) this.container.append(this.loadMore);
    } catch (error) {
      console.error("Archive read failed.", error);
      if (revision === this.revision) this.container.textContent = "Local game history is unavailable.";
    } finally {
      this.loadMore.disabled = false;
    }
  }
}
