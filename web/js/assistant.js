// The AI assistant: talk or type, get answers, and choose where each thought is saved.

import { api } from "./api.js";
import { navigate } from "./router.js";
import { noteById, on, prefs, setPref, state, upsertNote, upsertTasks } from "./state.js";
import {
  capitalize,
  dueChip,
  element,
  firstName,
  h,
  icon,
  moodBadge,
  prefersReducedMotion,
  setBusy,
  toast,
  topicBadge,
  topicOf,
  wait,
  wordCount,
} from "./ui.js";
import { VoiceSession, recognitionErrorMessage, speak, speechSupported, stopSpeaking } from "./voice.js";

const SILENCE_MS = 1800;
let history = [];
let voice = null;
let silenceTimer = 0;
let callbacks = {};

export function initAssistant(options = {}) {
  callbacks = options;
  element("assistant-orb").addEventListener("click", toggleListening);
  element("assistant-mic").addEventListener("click", toggleListening);
  element("command-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = element("command-input");
    const text = input.value;
    input.value = "";
    send(text);
  });
  element("assistant-view").querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => send(chip.dataset.prompt));
  });
  element("clear-chat").addEventListener("click", () => resetConversation({ announce: true }));
  element("speak-replies").addEventListener("change", (event) => {
    setPref("speakReplies", event.target.checked);
    if (!event.target.checked) stopSpeaking();
  });
  element("assistant-language").addEventListener("change", (event) => setPref("language", event.target.value));
  element("assistant-notebooks").addEventListener("click", (event) => {
    const item = event.target.closest("[data-note-id]");
    if (item) callbacks.openNote?.(Number(item.dataset.noteId));
  });
  element("chat-feed").addEventListener("click", handleFeedClick);
  on("notes", renderNotebooks);
  on("prefs", syncPrefs);
  syncPrefs();
}

export function onShowAssistant() {
  syncPrefs();
  renderNotebooks();
  if (!element("chat-feed").children.length) resetConversation();
}

export function onHideAssistant() {
  voice?.abort();
}

export function stopAssistant() {
  voice?.abort();
  window.clearTimeout(silenceTimer);
}

export function resetAssistant() {
  history = [];
  element("chat-feed").replaceChildren();
  element("chat-feed").closest(".chat-panel").classList.remove("has-conversation");
  element("command-input").value = "";
}

function syncPrefs() {
  element("speak-replies").checked = prefs.speakReplies;
  element("assistant-language").value = prefs.language;
  const claude = state.ai?.engine === "claude";
  element("assistant-engine").textContent = claude ? "CLAUDE" : "LOCAL ENGINE";
}

function resetConversation({ announce = false } = {}) {
  history = [];
  stopSpeaking();
  element("chat-feed").replaceChildren();
  element("chat-feed").closest(".chat-panel").classList.remove("has-conversation");
  const name = firstName(state.user?.name);
  addMessage(
    "assistant",
    announce
      ? "Fresh start. What's on your mind?"
      : `Hi ${name}! Tell me what's on your mind and I'll suggest where to keep it. You can also ask me to set reminders, find notes, or read your latest one.`,
  );
}

function renderNotebooks() {
  const list = element("assistant-notebooks");
  const notes = [...state.notes].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 8);
  element("assistant-notebook-count").textContent = String(state.notes.length);
  list.replaceChildren();
  if (!notes.length) {
    list.append(h("li", { class: "empty-inline", text: "Your notes will appear here as places to file new thoughts." }));
    return;
  }
  notes.forEach((note) => {
    list.append(
      h(
        "li",
        {},
        h(
          "button",
          { class: "notebook-item", type: "button", dataset: { noteId: String(note.id) } },
          h("span", { "aria-hidden": "true", text: topicOf(note.tags).emoji }),
          h("span", { text: note.title || "Untitled note" }),
          h("small", { text: `${wordCount(note.text)} words` }),
        ),
      ),
    );
  });
}

// ------------------------------------------------------------------ listening

function setStatus(mode) {
  const label = element("assistant-status");
  label.classList.toggle("is-listening", mode === "listening");
  label.classList.toggle("is-thinking", mode === "thinking");
  label.lastElementChild.textContent = mode === "listening" ? "LISTENING" : mode === "thinking" ? "THINKING" : "READY";
  const orb = element("assistant-orb");
  orb.classList.toggle("is-listening", mode === "listening");
  orb.classList.toggle("is-thinking", mode === "thinking");
  orb.setAttribute("aria-label", mode === "listening" ? "Stop listening and send" : "Start talking to Echo");
  element("assistant-mic").classList.toggle("is-listening", mode === "listening");
  element("orb-caption").textContent =
    mode === "listening" ? "Listening… pause when you're done" : mode === "thinking" ? "Thinking it over" : "Tap the orb and start talking";
}

export function toggleListening() {
  if (voice?.isRunning) {
    voice.stop();
    return;
  }
  if (!speechSupported) {
    toast(recognitionErrorMessage("unsupported"), { type: "error" });
    element("command-input").focus();
    return;
  }
  stopSpeaking();
  let finalText = "";
  const live = element("orb-live");
  const stage = element("orb-stage");
  const scheduleSilence = () => {
    window.clearTimeout(silenceTimer);
    silenceTimer = window.setTimeout(() => voice?.stop(), SILENCE_MS);
  };
  voice = new VoiceSession({
    lang: prefs.language,
    continuous: true,
    meter: !prefersReducedMotion(),
    onStart: () => setStatus("listening"),
    onLevel: (level) => stage.style.setProperty("--level", level.toFixed(3)),
    onInterim: (words) => {
      live.textContent = [finalText, words].filter(Boolean).join(" ");
      if (words) scheduleSilence();
    },
    onFinal: (words) => {
      finalText = [finalText, words].filter(Boolean).join(" ");
      live.textContent = finalText;
      scheduleSilence();
    },
    onError: (error) => toast(recognitionErrorMessage(error), { type: error === "no-speech" ? "info" : "error" }),
    onEnd: () => {
      window.clearTimeout(silenceTimer);
      stage.style.setProperty("--level", "0");
      live.textContent = "";
      setStatus("ready");
      if (finalText.trim()) send(finalText);
    },
  });
  voice.start();
}

// ------------------------------------------------------------------ messages

function revealWords(node, text) {
  const count = text.split(/\s+/).length;
  if (prefersReducedMotion() || count > 90) {
    node.textContent = text;
    return;
  }
  let index = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) node.append(part);
    else node.append(h("span", { class: "word", style: { "--i": String(index++) } }, part));
  }
}

function scrollFeed() {
  const feed = element("chat-feed");
  window.requestAnimationFrame(() => {
    feed.scrollTop = feed.scrollHeight;
  });
}

function addMessage(role, text, { engine = "", error = false } = {}) {
  const isUser = role === "user";
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
  const bubble = h("div", { class: "bubble" });
  if (isUser) bubble.textContent = text;
  else revealWords(bubble, text);
  const body = h("div", { class: "message-body" }, h("span", { class: "message-meta", text: `${isUser ? "YOU" : "ECHO"} · ${time}` }), bubble);
  if (engine === "claude") body.append(h("span", { class: "engine-tag" }, icon("spark"), "Answered by Claude"));
  const message = h(
    "article",
    { class: `message${isUser ? " is-user" : ""}${error ? " is-error" : ""}` },
    h("span", { class: "message-avatar", "aria-hidden": "true" }, isUser ? (state.user?.name || "Y").charAt(0).toUpperCase() : icon("waveform")),
    body,
  );
  element("chat-feed").append(message);
  if (isUser) element("chat-feed").closest(".chat-panel").classList.add("has-conversation");
  scrollFeed();
  return message;
}

function addTyping() {
  const typing = h(
    "article",
    { class: "message", "aria-label": "Echo is thinking" },
    h("span", { class: "message-avatar", "aria-hidden": "true" }, icon("waveform")),
    h("div", { class: "message-body" }, h("div", { class: "bubble" }, h("span", { class: "typing-dots" }, h("span"), h("span"), h("span")))),
  );
  element("chat-feed").append(typing);
  scrollFeed();
  return typing;
}

function addCard(card) {
  element("chat-feed").append(card);
  scrollFeed();
  return card;
}

export async function send(text) {
  const message = String(text || "").trim();
  if (!message) return;
  addMessage("user", message);
  const priorHistory = history.slice(-8);
  history.push({ role: "user", text: message });
  const typing = addTyping();
  const sendButton = element("command-send");
  sendButton.disabled = true;
  setStatus("thinking");
  try {
    const result = await api("/api/command", {
      method: "POST",
      body: { text: message, lang: prefs.language, history: priorHistory },
    });
    await wait(prefersReducedMotion() ? 0 : 280);
    typing.remove();
    addMessage("assistant", result.reply, { engine: result.engine });
    history.push({ role: "assistant", text: result.reply });
    handleAction(result.action);
    if (prefs.speakReplies) speak(result.reply, prefs.language);
  } catch (error) {
    typing.remove();
    addMessage("assistant", "I couldn't reach your local studio just now. Nothing was saved; please try again.", { error: true });
    toast(error.message, { type: "error" });
  } finally {
    sendButton.disabled = false;
    setStatus("ready");
  }
}

// ------------------------------------------------------------------ actions

function handleAction(action) {
  if (!action) return;
  switch (action.type) {
    case "suggest_note":
      addCard(suggestionCard(action));
      break;
    case "tasks_created":
      upsertTasks(action.tasks);
      addCard(taskCard("REMINDER SET", action.tasks, [viewButton("View tasks", "tasks")]));
      break;
    case "task_offer":
      addCard(offerCard(action.tasks));
      break;
    case "task_list": {
      const tasks = action.task_ids.map((id) => state.tasks.find((task) => task.id === id)).filter(Boolean);
      if (tasks.length) addCard(taskCard("YOUR LIST", tasks, [viewButton("Open tasks", "tasks")]));
      break;
    }
    case "search_results": {
      const notes = action.note_ids.map((id) => noteById(id)).filter(Boolean);
      if (notes.length) addCard(noteListCard(`RESULTS FOR “${action.query.toUpperCase()}”`, notes));
      break;
    }
    case "open_note": {
      const note = noteById(action.note_id);
      if (note) addCard(noteListCard("LATEST NOTE", [note]));
      break;
    }
    case "note_appended":
      upsertNote(action.note);
      addCard(appendedCard(action));
      break;
    case "open_view":
      window.setTimeout(() => navigate(action.view), 700);
      break;
    case "clear_chat":
      window.setTimeout(() => resetConversation({ announce: true }), 500);
      break;
    default:
      break;
  }
}

function viewButton(label, view) {
  return h("button", { class: "btn btn-ghost btn-sm", type: "button", text: label, onclick: () => navigate(view) });
}

function cardShell(title, iconName = "spark") {
  return h("article", { class: "chat-card" }, h("p", { class: "chat-card-title" }, icon(iconName), title));
}

function taskRow(task) {
  return h(
    "li",
    {},
    h("div", { class: "chat-card-row" }, icon(task.done ? "check-circle" : "bell"), h("span", { text: task.text }), task.due_at ? dueChip(task.due_at, { done: task.done, completedAt: task.completed_at }) : null),
  );
}

function taskCard(title, tasks, actions = []) {
  const card = cardShell(title, "bell");
  card.append(h("ul", { class: "chat-card-list" }, tasks.map(taskRow)));
  if (actions.length) card.append(h("div", { class: "chat-card-actions" }, actions));
  return card;
}

function offerCard(tasks) {
  const card = cardShell("ADD TO TASKS?", "tasks");
  const add = h("button", { class: "btn btn-primary btn-sm", type: "button" }, icon("plus"), tasks.length === 1 ? "Add task" : `Add ${tasks.length} tasks`);
  const actions = h("div", { class: "chat-card-actions" }, add, h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Save as a note instead", onclick: () => send(`take a note: ${tasks.map((task) => task.text).join(". ")}`) }));
  card.append(h("ul", { class: "chat-card-list" }, tasks.map(taskRow)), actions);
  add.addEventListener("click", async () => {
    setBusy(add, true);
    try {
      const { tasks: created } = await api("/api/tasks", { method: "POST", body: { tasks } });
      upsertTasks(created);
      actions.replaceChildren(doneLine(`${created.length === 1 ? "Added to" : `${created.length} tasks added to`} your list.`, viewButton("View tasks", "tasks")));
    } catch (error) {
      setBusy(add, false);
      toast(error.message, { type: "error" });
    }
  });
  return card;
}

function noteListCard(title, notes) {
  const card = cardShell(title, "notes");
  card.append(
    h(
      "ul",
      { class: "chat-card-list" },
      notes.map((note) =>
        h(
          "li",
          {},
          h(
            "button",
            { class: "chat-card-row", type: "button", dataset: { openNote: String(note.id) } },
            h("span", { "aria-hidden": "true", text: topicOf(note.tags).emoji }),
            h("span", { text: note.title || "Untitled note" }),
            icon("chevron"),
          ),
        ),
      ),
    ),
  );
  return card;
}

function appendedCard({ note, previous_text: previousText }) {
  const card = cardShell("ADDED TO A NOTE", "check-circle");
  const undo = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("undo"), "Undo");
  const actions = h("div", { class: "chat-card-actions" }, h("button", { class: "btn btn-soft btn-sm", type: "button", text: "Open note", dataset: { openNote: String(note.id) } }), undo);
  undo.addEventListener("click", async () => {
    setBusy(undo, true);
    try {
      const { note: restored } = await api(`/api/notes/${note.id}`, { method: "PUT", body: { text: previousText } });
      upsertNote(restored);
      actions.replaceChildren(doneLine("Undone. The note is back the way it was."));
    } catch (error) {
      setBusy(undo, false);
      toast(error.message, { type: "error" });
    }
  });
  card.append(h("ul", { class: "chat-card-list" }, h("li", {}, h("div", { class: "chat-card-row" }, h("span", { text: topicOf(note.tags).emoji }), h("span", { text: note.title || "Untitled note" })))), actions);
  return card;
}

function doneLine(message, ...extra) {
  return h("div", { class: "suggest-done" }, h("span", { class: "suggest-done-icon" }, icon("check")), h("p", { text: message }), ...extra);
}

function handleFeedClick(event) {
  const opener = event.target.closest("[data-open-note]");
  if (opener) callbacks.openNote?.(Number(opener.dataset.openNote));
}

// ------------------------------------------------------------------ the "where should this go?" card

function suggestionCard({ text: original, polished, analysis }) {
  const recommendation = analysis.recommendation;
  let usePolished = true;
  const chosenText = () => (usePolished ? polished.text : original).trim();

  const card = h("article", { class: "chat-card suggest-card", "aria-label": "Suggestion for where to save this thought" });
  const quote = h("blockquote", { class: "suggest-quote", text: polished.text });
  const meta = h("div", { class: "suggest-meta" });
  const body = h("div", {});
  card.append(h("p", { class: "chat-card-title" }, icon("spark"), "WHERE SHOULD THIS GO?"), quote, meta, body);

  if (polished.count > 0 && polished.text !== original) {
    const label = h("span", { text: `Polished · ${polished.count} fix${polished.count === 1 ? "" : "es"}` });
    const pill = h("button", { class: "polish-pill", type: "button", title: `${capitalize(polished.summary.join(", "))}. Click to compare.` }, icon("wand"), label);
    pill.addEventListener("click", () => {
      usePolished = !usePolished;
      quote.textContent = usePolished ? polished.text : original;
      label.textContent = usePolished ? `Polished · ${polished.count} fix${polished.count === 1 ? "" : "es"}` : "Showing your exact words";
    });
    meta.append(pill);
  }
  analysis.tags.forEach((tag) => meta.append(topicBadge(topicOf([tag]))));
  if (analysis.mood && analysis.mood !== "neutral") meta.append(moodBadge(analysis.mood));

  const best = recommendation.action === "append" ? noteById(recommendation.note_id) : null;
  if (best) {
    const add = h("button", { class: "btn btn-primary btn-sm", type: "button" }, icon("plus"), "Add here");
    add.addEventListener("click", () => appendTo(best.id, add));
    const meter = h("span", {});
    body.append(
      h(
        "div",
        { class: "match-card is-best" },
        h("span", { class: "note-emoji", "aria-hidden": "true", text: topicOf(best.tags).emoji }),
        h("span", { class: "match-label", text: "BEST MATCH" }),
        add,
        h("strong", { text: best.title || "Untitled note" }),
        h("span", { class: "match-reason", text: capitalize(recommendation.reason) }),
        h("span", { class: "confidence" }, h("span", { class: "confidence-track" }, meter), `${recommendation.confidence}% match`),
      ),
    );
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      meter.style.width = `${recommendation.confidence}%`;
    }));
  } else {
    body.append(h("p", { class: "match-reason", text: `New note recommended: ${recommendation.reason}.` }));
  }

  const titleInput = h("input", {
    class: "inline-input",
    type: "text",
    maxlength: "120",
    value: analysis.title,
    "aria-label": "Title for a new note",
  });
  const create = h("button", { class: `btn ${best ? "btn-ghost" : "btn-primary"} btn-sm`, type: "button" }, icon("note-plus"), best ? "New note instead" : "Create note");
  create.addEventListener("click", () => createNote(titleInput.value.trim(), create));
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") create.click();
  });
  body.append(h("div", { class: "suggest-row" }, titleInput, create));

  const ranked = analysis.matches.map((match) => noteById(match.note_id)).filter(Boolean);
  const others = [...new Set([...ranked, ...state.notes])].filter((note) => note.id !== best?.id);
  if (others.length) {
    const select = h(
      "select",
      { "aria-label": "Add to another note" },
      h("option", { value: "", text: "Or add to another note…" }),
      others.map((note) => h("option", { value: String(note.id), text: `${topicOf(note.tags).emoji} ${note.title || "Untitled note"}` })),
    );
    const addOther = h("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: true, text: "Add" });
    select.addEventListener("change", () => {
      addOther.disabled = !select.value;
    });
    addOther.addEventListener("click", () => select.value && appendTo(Number(select.value), addOther));
    body.append(h("div", { class: "suggest-row" }, h("label", { class: "select-pill" }, select), addOther));
  }

  let todoBox = null;
  if (analysis.todos.length) {
    const count = analysis.todos.length;
    const addTodos = h("button", { class: "btn btn-soft btn-sm", type: "button" }, icon("bell"), count === 1 ? "Add reminder" : `Add ${count} reminders`);
    todoBox = h(
      "div",
      { class: "suggest-todos" },
      h("p", {}, icon("bell"), `I ALSO FOUND ${count} TO-DO${count === 1 ? "" : "S"}`),
      h("ul", {}, analysis.todos.map((todo) => h("li", {}, icon("check-circle"), h("span", { text: todo.text }), todo.due_at ? dueChip(todo.due_at) : null))),
      addTodos,
    );
    addTodos.addEventListener("click", async () => {
      setBusy(addTodos, true);
      try {
        const { tasks } = await api("/api/tasks", { method: "POST", body: { tasks: analysis.todos.map((todo) => ({ ...todo, note_id: savedNoteId })) } });
        upsertTasks(tasks);
        todoBox.replaceChildren(doneLine(`${tasks.length === 1 ? "Reminder" : `${tasks.length} reminders`} set. I'll nudge you on time.`, viewButton("View tasks", "tasks")));
        todoBox.classList.add("is-done");
      } catch (error) {
        setBusy(addTodos, false);
        toast(error.message, { type: "error" });
      }
    });
    body.append(todoBox);
  }

  const dismiss = h("button", { class: "link-btn", type: "button", text: "Not now" });
  dismiss.addEventListener("click", async () => {
    card.style.transition = "opacity 260ms ease, transform 260ms ease";
    card.style.opacity = "0";
    card.style.transform = "scale(0.97)";
    await wait(260);
    card.remove();
  });
  body.append(h("div", { class: "chat-card-actions" }, dismiss));

  let savedNoteId = null;

  async function appendTo(noteId, button) {
    setBusy(button, true);
    try {
      const { note } = await api(`/api/notes/${noteId}/append`, { method: "POST", body: { text: chosenText() } });
      upsertNote(note);
      finish(`Added to “${note.title || "your note"}”.`, note);
    } catch (error) {
      setBusy(button, false);
      toast(error.message, { type: "error" });
    }
  }

  async function createNote(title, button) {
    setBusy(button, true);
    try {
      const { note } = await api("/api/notes", {
        method: "POST",
        body: { text: chosenText(), title: title || analysis.title, tags: analysis.tags, mood: analysis.mood },
      });
      upsertNote(note);
      finish(`Saved as a new note, “${note.title}”.`, note);
    } catch (error) {
      setBusy(button, false);
      toast(error.message, { type: "error" });
    }
  }

  function finish(message, note) {
    savedNoteId = note.id;
    const open = h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Open", dataset: { openNote: String(note.id) } });
    const keep = todoBox && !todoBox.classList.contains("is-done") ? [todoBox] : [];
    body.replaceChildren(doneLine(message, open), ...keep);
    meta.remove();
    toast(message, { type: "success" });
  }

  return card;
}
