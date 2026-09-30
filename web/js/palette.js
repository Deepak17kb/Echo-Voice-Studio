// The command palette (Ctrl K): jump anywhere, run actions, and search notes and tasks.

import { state } from "./state.js";
import { closeModal, element, excerpt, h, highlight, icon, openModal, topicOf } from "./ui.js";

let items = [];
let selected = 0;
let commands = {};

const ACTIONS = [
  { group: "Go to", label: "Home", hint: "Alt 1", icon: "home", keywords: "dashboard start", run: () => commands.navigate("home") },
  { group: "Go to", label: "AI Assistant", hint: "Alt 2", icon: "spark", keywords: "chat talk ask", run: () => commands.navigate("assistant") },
  { group: "Go to", label: "Voice to Note", hint: "Alt 3", icon: "mic", keywords: "dictate dictation record transcribe", run: () => commands.navigate("dictate") },
  { group: "Go to", label: "Notes", hint: "Alt 4", icon: "notes", keywords: "library all notes", run: () => commands.navigate("notes") },
  { group: "Go to", label: "Tasks", hint: "Alt 5", icon: "tasks", keywords: "todo reminders list", run: () => commands.navigate("tasks") },
  { group: "Go to", label: "Account & security", hint: "Alt 6", icon: "shield", keywords: "profile settings preferences sign-in activity history", run: () => commands.navigate("account") },
  { group: "Actions", label: "Start dictating", hint: "Alt R", icon: "mic", keywords: "record voice new note", run: () => commands.startDictation() },
  { group: "Actions", label: "Talk to the assistant", hint: "Alt M", icon: "spark", keywords: "listen voice ask", run: () => commands.talk() },
  { group: "Actions", label: "New note", hint: "Alt N", icon: "note-plus", keywords: "create write type", run: () => commands.newNote() },
  { group: "Actions", label: "Add a task", icon: "plus", keywords: "todo reminder", run: () => commands.addTask() },
  { group: "Actions", label: "Toggle dark mode", hint: "Alt T", icon: "moon", keywords: "theme light dark appearance", run: () => commands.toggleTheme() },
  { group: "Actions", label: "Turn on reminder notifications", icon: "bell", keywords: "notifications alerts permission", run: () => commands.enableReminders() },
  { group: "Actions", label: "Export all notes", icon: "download", keywords: "backup markdown download", run: () => commands.exportNotes() },
  { group: "Actions", label: "Keyboard shortcuts", hint: "?", icon: "keyboard", keywords: "help keys", run: () => commands.showShortcuts() },
  { group: "Actions", label: "Sign out", icon: "logout", keywords: "log out exit", run: () => commands.logout() },
];

export function initPalette(handlers) {
  commands = handlers;
  const input = element("palette-input");
  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paintSelection();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(items[selected]);
    }
  });
  element("palette-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-index]");
    if (row) runItem(items[Number(row.dataset.index)]);
  });
  element("palette-list").addEventListener("mousemove", (event) => {
    const row = event.target.closest("[data-index]");
    if (row && Number(row.dataset.index) !== selected) {
      selected = Number(row.dataset.index);
      paintSelection();
    }
  });
}

export function openPalette() {
  const palette = element("palette");
  if (!palette.hidden && palette.classList.contains("is-open")) {
    closeModal(palette);
    return;
  }
  element("palette-input").value = "";
  selected = 0;
  render();
  openModal(palette, { focus: element("palette-input") });
}

function matches(text, words) {
  const haystack = text.toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

function buildItems(query) {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const actions = ACTIONS.filter((action) => !words.length || matches(`${action.label} ${action.keywords}`, words));
  const notes = state.notes
    .filter((note) => words.length && matches(`${note.title} ${note.text} ${note.tags.join(" ")}`, words))
    .slice(0, 6)
    .map((note) => ({
      group: "Notes",
      label: note.title || "Untitled note",
      detail: excerpt(note.text, 80),
      emoji: topicOf(note.tags).emoji,
      run: () => commands.openNote(note.id),
    }));
  const recent = !words.length
    ? [...state.notes]
        .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))
        .slice(0, 3)
        .map((note) => ({ group: "Recent notes", label: note.title || "Untitled note", detail: excerpt(note.text, 80), emoji: topicOf(note.tags).emoji, run: () => commands.openNote(note.id) }))
    : [];
  const tasks = words.length
    ? state.tasks
        .filter((task) => !task.done && matches(task.text, words))
        .slice(0, 4)
        .map((task) => ({ group: "Tasks", label: task.text, icon: "tasks", run: () => commands.navigate("tasks") }))
    : [];
  return [...notes, ...tasks, ...actions, ...recent];
}

function render() {
  const query = element("palette-input").value.trim();
  items = buildItems(query);
  const list = element("palette-list");
  list.replaceChildren();
  if (!items.length) {
    list.append(h("li", { class: "palette-empty", text: `Nothing found for “${query}”. Try fewer words.` }));
    return;
  }
  const lowered = query.toLocaleLowerCase();
  let lastGroup = "";
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      list.append(h("li", { class: "palette-group", role: "presentation", text: item.group.toUpperCase() }));
      lastGroup = item.group;
    }
    list.append(
      h(
        "li",
        { class: "palette-item", role: "option", id: `palette-option-${index}`, "aria-selected": "false", dataset: { index: String(index) } },
        h("span", { class: "palette-item-icon", "aria-hidden": "true" }, item.emoji ? item.emoji : icon(item.icon || "spark")),
        h("span", { class: "palette-item-text" }, h("span", {}, highlight(item.label, lowered.split(/\s+/)[0] || "")), item.detail ? h("small", { text: item.detail }) : null),
        item.hint ? h("kbd", { class: "palette-item-hint", text: item.hint }) : null,
      ),
    );
  });
  paintSelection();
}

function paintSelection() {
  element("palette-list").querySelectorAll(".palette-item").forEach((row) => {
    const active = Number(row.dataset.index) === selected;
    row.classList.toggle("is-selected", active);
    row.setAttribute("aria-selected", String(active));
    if (active) {
      row.scrollIntoView({ block: "nearest" });
      element("palette-input").setAttribute("aria-activedescendant", row.id);
    }
  });
}

function runItem(item) {
  if (!item) return;
  closeModal(element("palette"));
  window.setTimeout(() => item.run(), 60);
}
