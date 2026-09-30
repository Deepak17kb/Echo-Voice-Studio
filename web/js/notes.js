// The notes library: filter, sort, pin, read aloud, and edit notes in a dialog.

import { api } from "./api.js";
import { currentView } from "./router.js";
import { noteById, on, removeNote, state, upsertNote, upsertTasks } from "./state.js";
import {
  closeModal,
  confirmDialog,
  copyText,
  download,
  dueChip,
  element,
  excerpt,
  flip,
  formatStamp,
  h,
  highlight,
  icon,
  iconButton,
  moodBadge,
  openModal,
  relativeTime,
  setBusy,
  toast,
  topicBadge,
  topicOf,
  wait,
  wordCount,
} from "./ui.js";
import { speak } from "./voice.js";

let activeTag = "all";
let sortMode = "recent";
let animateNextRender = true;
let openNoteId = null;
let polishOriginal = null;
let callbacks = {};

const SORTERS = {
  recent: (a, b) => (b.updated_at || "").localeCompare(a.updated_at || "") || b.id - a.id,
  newest: (a, b) => b.id - a.id,
  oldest: (a, b) => a.id - b.id,
  az: (a, b) => (a.title || "").localeCompare(b.title || ""),
  longest: (a, b) => b.text.length - a.text.length,
};

export function initNotes(options) {
  callbacks = options;
  element("notes-search").addEventListener("input", () => renderGrid());
  element("notes-search").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.target.value) {
      event.stopPropagation();
      event.target.value = "";
      renderGrid();
    }
  });
  element("notes-sort").addEventListener("change", (event) => {
    sortMode = event.target.value;
    renderGrid();
  });
  element("tag-filters").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    activeTag = chip.dataset.tag;
    animateNextRender = true;
    render();
  });
  element("notes-grid").addEventListener("click", handleGridClick);
  element("notes-grid").addEventListener("keydown", (event) => {
    const card = event.target.closest(".note-card");
    if (card && event.target === card && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openNote(Number(card.dataset.noteId));
    }
  });
  element("export-notes-button").addEventListener("click", exportNotes);
  element("new-note-button").addEventListener("click", () => callbacks.onNewNote?.());
  element("empty-note-button").addEventListener("click", () => callbacks.onRecordNote?.());

  element("note-modal-save").addEventListener("click", saveOpenNote);
  element("note-modal-delete").addEventListener("click", () => deleteNote(openNoteId, { fromModal: true }));
  element("note-modal-pin").addEventListener("click", () => togglePin(openNoteId));
  element("note-modal-read").addEventListener("click", () => speak(element("note-modal-text").value, languageOf()));
  element("note-modal-copy").addEventListener("click", () => copyText(element("note-modal-text").value));
  element("note-modal-download").addEventListener("click", downloadOpenNote);
  element("note-modal-polish").addEventListener("click", polishOpenNote);
  element("note-modal-text").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") saveOpenNote();
  });
  element("note-modal-tasks").addEventListener("click", toggleLinkedTask);

  on("notes", () => {
    element("nav-notes-count").textContent = String(state.notes.length);
    if (currentView() === "notes") render();
  });
  on("tasks", () => {
    const note = noteById(openNoteId);
    if (note && !element("note-modal").hidden) renderLinkedTasks(note);
  });
}

export function onShowNotes() {
  animateNextRender = true;
  render();
}

const languageOf = () => element("dictate-language").value || "en-US";

function render() {
  renderFilters();
  renderGrid();
}

function renderFilters() {
  const counts = new Map();
  state.notes.forEach((note) => note.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
  if (activeTag !== "all" && !counts.has(activeTag)) activeTag = "all";
  const chip = (tag, label, count) =>
    h(
      "button",
      {
        class: `chip${activeTag === tag ? " is-active" : ""}`,
        type: "button",
        "aria-pressed": String(activeTag === tag),
        dataset: { tag },
      },
      label,
      h("span", { class: "chip-count", text: String(count) }),
    );
  const topics = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  element("tag-filters").replaceChildren(
    chip("all", "All notes", state.notes.length),
    ...topics.map(([tag, count]) => {
      const topic = topicOf([tag]);
      return chip(tag, `${topic.emoji} ${topic.label}`, count);
    }),
  );
}

function visibleNotes(query) {
  const notes = state.notes.filter((note) => activeTag === "all" || note.tags.includes(activeTag));
  const matching = query
    ? notes.filter((note) => `${note.title} ${note.text} ${note.tags.join(" ")}`.toLocaleLowerCase().includes(query))
    : notes;
  return matching.sort((a, b) => Number(b.pinned) - Number(a.pinned) || SORTERS[sortMode](a, b));
}

function renderGrid() {
  const grid = element("notes-grid");
  const query = element("notes-search").value.trim().toLocaleLowerCase();
  const notes = visibleNotes(query);
  const total = state.notes.length;
  const shown = notes.length === total ? `${total}` : `${notes.length} OF ${total}`;
  element("notes-total").textContent = `${shown} ${total === 1 ? "NOTE" : "NOTES"}`;
  element("notes-zero-state").hidden = total !== 0;
  grid.hidden = total === 0;
  const animate = animateNextRender;
  animateNextRender = false;
  flip(grid, () => {
    grid.replaceChildren();
    if (total && !notes.length) {
      grid.append(h("p", { class: "search-empty", text: "Nothing matches that yet. Try another word or topic." }));
      return;
    }
    notes.forEach((note, index) => grid.append(noteCard(note, index, animate, query)));
  });
}

function noteCard(note, index, animate, query) {
  const topic = topicOf(note.tags);
  const title = note.title || "Untitled note";
  const pin = iconButton(note.pinned ? "Unpin note" : "Pin note", "pin", "pin");
  pin.classList.add("note-pin-btn");
  pin.setAttribute("aria-pressed", String(note.pinned));
  return h(
    "article",
    {
      class: `note-card${note.pinned ? " is-pinned" : ""}${animate ? " is-new" : ""}`,
      tabindex: "0",
      "aria-label": `${title}. ${formatStamp(note.updated_at)}. Press Enter to open.`,
      dataset: { key: String(note.id), noteId: String(note.id) },
      style: { "--hue": String(topic.hue), "--i": String(Math.min(index, 12)) },
    },
    h(
      "div",
      { class: "note-card-top" },
      topicBadge(topic),
      note.mood && note.mood !== "neutral" ? moodBadge(note.mood, { compact: true }) : null,
      h("time", { datetime: note.updated_at, text: relativeTime(note.updated_at) }),
    ),
    h("h3", {}, highlight(title, query)),
    h("p", {}, highlight(excerpt(note.text, 260), query)),
    h(
      "div",
      { class: "note-card-foot" },
      h("span", { text: `${wordCount(note.text)} words` }),
      h(
        "div",
        { class: "note-card-actions" },
        pin,
        iconButton("Read aloud", "volume", "read"),
        iconButton("Copy text", "copy", "copy"),
        iconButton("Delete note", "trash", "delete", { danger: true }),
      ),
    ),
  );
}

async function handleGridClick(event) {
  const card = event.target.closest(".note-card");
  if (!card) return;
  const id = Number(card.dataset.noteId);
  const button = event.target.closest("button[data-action]");
  if (!button) {
    openNote(id);
    return;
  }
  const note = noteById(id);
  if (!note) return;
  if (button.dataset.action === "pin") await togglePin(id);
  else if (button.dataset.action === "read") speak(note.text, languageOf());
  else if (button.dataset.action === "copy") copyText(note.text);
  else if (button.dataset.action === "delete") await deleteNote(id, { card });
}

async function togglePin(id) {
  const note = noteById(id);
  if (!note) return;
  try {
    const { note: saved } = await api(`/api/notes/${id}`, { method: "PUT", body: { pinned: !note.pinned } });
    upsertNote(saved);
    setModalPin(saved);
    toast(saved.pinned ? "Pinned to the top." : "Unpinned.", { type: "success" });
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

async function deleteNote(id, { card = null, fromModal = false } = {}) {
  const note = noteById(id);
  if (!note) return;
  const confirmed = await confirmDialog({
    title: "Delete this note?",
    message: `“${note.title || "Untitled note"}” will be removed. You can undo right after.`,
  });
  if (!confirmed) return;
  try {
    await api(`/api/notes/${id}`, { method: "DELETE" });
    if (fromModal) closeModal(element("note-modal"));
    const target = card || element("notes-grid").querySelector(`[data-note-id="${id}"]`);
    if (target) {
      target.classList.add("is-removing");
      await wait(280);
    }
    removeNote(id);
    toast("Note deleted.", {
      type: "info",
      actions: [{ label: "Undo", onClick: () => restoreNote(note) }],
    });
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

async function restoreNote(note) {
  try {
    const { note: restored } = await api("/api/notes", {
      method: "POST",
      body: { text: note.text, title: note.title, tags: note.tags, mood: note.mood, pinned: note.pinned },
    });
    upsertNote(restored);
    toast("Note restored.", { type: "success" });
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

// ------------------------------------------------------------------ note dialog

function setModalPin(note) {
  if (note.id !== openNoteId) return;
  const button = element("note-modal-pin");
  button.setAttribute("aria-pressed", String(note.pinned));
  button.setAttribute("aria-label", note.pinned ? "Unpin note" : "Pin note");
}

function renderLinkedTasks(note) {
  const container = element("note-modal-tasks");
  const tasks = state.tasks.filter((task) => task.note_id === note.id);
  container.replaceChildren();
  if (!tasks.length) return;
  container.append(
    h("p", { text: "LINKED TASKS" }),
    h(
      "ul",
      {},
      tasks.map((task) =>
        h(
          "li",
          {},
          h(
            "button",
            {
              class: `check-btn${task.done ? " is-checked" : ""}`,
              type: "button",
              "aria-pressed": String(task.done),
              "aria-label": task.done ? `Mark “${task.text}” as not done` : `Mark “${task.text}” as done`,
              dataset: { taskId: String(task.id) },
            },
            icon("check"),
          ),
          h("span", { text: task.text }),
          task.due_at ? dueChip(task.due_at, { done: task.done, completedAt: task.completed_at }) : null,
        ),
      ),
    ),
  );
}

async function toggleLinkedTask(event) {
  const button = event.target.closest("button[data-task-id]");
  if (!button) return;
  const done = button.getAttribute("aria-pressed") !== "true";
  button.classList.toggle("is-checked", done);
  try {
    const { task } = await api(`/api/tasks/${button.dataset.taskId}`, { method: "PUT", body: { done } });
    upsertTasks([task]);
  } catch (error) {
    button.classList.toggle("is-checked", !done);
    toast(error.message, { type: "error" });
  }
}

export function openNote(noteOrId) {
  const note = typeof noteOrId === "object" && noteOrId ? noteById(noteOrId.id) || noteOrId : noteById(noteOrId);
  if (!note) {
    toast("That note isn't here anymore.", { type: "error" });
    return;
  }
  openNoteId = note.id;
  polishOriginal = null;
  const topic = topicOf(note.tags);
  element("note-modal-emoji").textContent = topic.emoji;
  element("note-modal-title").value = note.title;
  element("note-modal-text").value = note.text;
  element("note-modal-tags").value = note.tags.join(", ");
  const mood = note.mood && note.mood !== "neutral" ? ` · feels ${note.mood}` : "";
  element("note-modal-meta").textContent =
    `Created ${formatStamp(note.created_at)} · Updated ${relativeTime(note.updated_at)} · ${wordCount(note.text)} words${mood}`;
  element("note-modal-polish-status").hidden = true;
  setModalPin(note);
  renderLinkedTasks(note);
  openModal(element("note-modal"), { focus: element("note-modal-text") });
}

async function saveOpenNote() {
  const text = element("note-modal-text").value.trim();
  if (!text) {
    toast("A note needs at least a few words.", { type: "error" });
    element("note-modal-text").focus();
    return;
  }
  const button = element("note-modal-save");
  setBusy(button, true);
  try {
    const tags = element("note-modal-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
    const { note } = await api(`/api/notes/${openNoteId}`, {
      method: "PUT",
      body: { title: element("note-modal-title").value.trim(), text, tags },
    });
    upsertNote(note);
    closeModal(element("note-modal"));
    toast("Your changes are saved.", { type: "success" });
    window.setTimeout(() => {
      element("notes-grid").querySelector(`[data-note-id="${note.id}"]`)?.classList.add("is-flash");
    }, 60);
  } catch (error) {
    toast(error.message, { type: "error" });
  } finally {
    setBusy(button, false);
  }
}

async function polishOpenNote() {
  const textarea = element("note-modal-text");
  const text = textarea.value.trim();
  if (!text) return;
  const button = element("note-modal-polish");
  setBusy(button, true);
  try {
    const result = await api("/api/ai/polish", { method: "POST", body: { text, lang: languageOf() } });
    const status = element("note-modal-polish-status");
    if (result.text === text) {
      status.textContent = "Already polished. Nothing needed fixing.";
    } else {
      polishOriginal = text;
      textarea.value = result.text;
      status.replaceChildren(
        `✨ ${result.summary.length ? result.summary.join(", ") : "Tidied up"}. Not saved yet. `,
        h("button", {
          class: "link-btn",
          type: "button",
          text: "Undo",
          onclick: () => {
            textarea.value = polishOriginal;
            status.hidden = true;
          },
        }),
      );
    }
    status.hidden = false;
  } catch (error) {
    toast(error.message, { type: "error" });
  } finally {
    setBusy(button, false);
  }
}

function slug(text) {
  return (text || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "note";
}

function noteMarkdown(note) {
  const tags = note.tags.length ? ` · ${note.tags.map((tag) => `#${tag}`).join(" ")}` : "";
  return `# ${note.title || "Untitled note"}\n\n_${formatStamp(note.created_at)}${tags}_\n\n${note.text}\n`;
}

function downloadOpenNote() {
  const note = noteById(openNoteId);
  if (!note) return;
  download(`${slug(note.title)}.md`, noteMarkdown({ ...note, title: element("note-modal-title").value, text: element("note-modal-text").value }), "text/markdown;charset=utf-8");
  toast("Downloaded as Markdown.", { type: "success" });
}

export function exportNotes() {
  if (!state.notes.length) {
    toast("There's nothing to export yet. Your first note is one sentence away.");
    return;
  }
  const notes = [...state.notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id);
  const body = notes.map(noteMarkdown).join("\n---\n\n");
  const stamp = new Date().toISOString().slice(0, 10);
  download(`echo-notes-${stamp}.md`, `# Echo Studio · your notes\n\n_Exported ${formatStamp(new Date())}_\n\n---\n\n${body}`, "text/markdown;charset=utf-8");
  toast(`Exported ${notes.length} note${notes.length === 1 ? "" : "s"} as Markdown.`, { type: "success" });
}
