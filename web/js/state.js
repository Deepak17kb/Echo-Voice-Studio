// Shared in-memory state with a tiny publish/subscribe, plus per-browser preferences.

const listeners = new Map();

export const state = {
  user: null,
  notes: [],
  tasks: [],
  ai: { engine: "local", model: null },
};

export function on(topic, listener) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(listener);
  return () => listeners.get(topic).delete(listener);
}

export function emit(topic, detail = {}) {
  listeners.get(topic)?.forEach((listener) => listener(detail));
}

// ------------------------------------------------------------------ notes

export function setNotes(notes) {
  state.notes = [...notes];
  emit("notes");
}

export function upsertNote(note) {
  const index = state.notes.findIndex((item) => item.id === note.id);
  if (index === -1) state.notes.unshift(note);
  else state.notes[index] = note;
  emit("notes", { changed: note.id });
}

export function removeNote(id) {
  state.notes = state.notes.filter((note) => note.id !== id);
  state.tasks = state.tasks.map((task) => (task.note_id === id ? { ...task, note_id: null } : task));
  emit("notes", { removed: id });
  emit("tasks");
}

export const noteById = (id) => state.notes.find((note) => note.id === Number(id)) || null;

// ------------------------------------------------------------------ tasks

export function setTasks(tasks) {
  state.tasks = [...tasks];
  emit("tasks");
}

export function upsertTasks(tasks) {
  for (const task of tasks) {
    const index = state.tasks.findIndex((item) => item.id === task.id);
    if (index === -1) state.tasks.push(task);
    else state.tasks[index] = task;
  }
  emit("tasks", { changed: tasks.map((task) => task.id) });
}

export function removeTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  emit("tasks", { removed: id });
}

export const taskById = (id) => state.tasks.find((task) => task.id === Number(id)) || null;

// ------------------------------------------------------------------ browser storage

export function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is unavailable (private window, blocked site data); preferences just won't persist.
  }
}

export function removeStored(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

// ------------------------------------------------------------------ preferences

const PREFS_KEY = "echo.prefs";
const DEFAULT_PREFS = {
  theme: "system",
  language: "en-US",
  autoPolish: true,
  voiceCommands: true,
  detectTodos: true,
  speakReplies: true,
  sound: true,
};
const savedPrefs = readJson(PREFS_KEY, {});

export const prefs = { ...DEFAULT_PREFS, ...(savedPrefs && typeof savedPrefs === "object" ? savedPrefs : {}) };

export function setPref(key, value) {
  prefs[key] = value;
  writeJson(PREFS_KEY, prefs);
  emit("prefs", { key, value });
}
