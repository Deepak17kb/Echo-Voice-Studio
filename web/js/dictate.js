// Voice to Note: live dictation, spoken commands, automatic grammar polish, and smart saving.

import { api } from "./api.js";
import { openNote } from "./notes.js";
import { renderPermission } from "./notify.js";
import { currentView } from "./router.js";
import { noteById, on, prefs, readJson, removeStored, setPref, state, upsertNote, upsertTasks, writeJson } from "./state.js";
import {
  capitalize,
  confirmDialog,
  debounce,
  dueChip,
  element,
  flashSuccess,
  h,
  icon,
  moodBadge,
  prefersReducedMotion,
  renderDiff,
  setBusy,
  toast,
  topicBadge,
  topicOf,
  wordCount,
} from "./ui.js";
import { VoiceSession, recognitionErrorMessage, speak, speechSupported, stopSpeaking } from "./voice.js";

const PUNCTUATION = [
  [/\s*\bnew paragraph\b\s*/gi, "\n\n"],
  [/\s*\b(?:new|next) line\b\s*/gi, "\n"],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bexclamation (?:mark|point)\b/gi, "!"],
  [/\s*\b(?:full stop|period)\b/gi, "."],
  [/\s*\bsemicolon\b/gi, ";"],
  [/\s*\bcolon\b/gi, ":"],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\b(?:open|begin) quote\b\s*/gi, " “"],
  [/\s*\b(?:close|end) quote\b/gi, "”"],
];
const COMMANDS = [
  [/\b(?:scratch|delete|undo|remove) that\b[.!]?/i, "scratch"],
  [/\b(?:stop|end|pause) (?:listening|recording|dictation|dictating)\b[.!]?/i, "stop"],
  [/\b(?:save|finish) (?:the |this |my )?note\b[.!]?/i, "save"],
];

let voice = null;
let segments = [];
let recordingMs = 0;
let sessionStarted = 0;
let spokenWords = 0;
let clockTimer = 0;
let saveAfterStop = false;
let beforePolish = null;
let titleEdited = false;
let analysis = null;
let analyzeSequence = 0;
let todoChoices = new Map();
let fallbackFrame = 0;
let meterActive = false;
let waveColors = null;

const draftKey = () => `echo.draft.${state.user?.id ?? "guest"}`;

export function initDictate() {
  const textarea = element("dictate-text");
  element("dictate-record").addEventListener("click", () => toggleDictation());
  element("polish-button").addEventListener("click", () => polishNow());
  element("polish-undo").addEventListener("click", undoPolish);
  element("polish-diff-toggle").addEventListener("click", toggleDiff);
  element("read-aloud-button").addEventListener("click", () => {
    const text = textarea.value.trim();
    if (text) speak(text, element("dictate-language").value);
    else toast("There's nothing to read yet.");
  });
  element("dictate-clear").addEventListener("click", clearEditor);
  element("dictate-save").addEventListener("click", () => save());
  element("dictate-suggestion-use").addEventListener("click", useSuggestion);
  element("dictate-title").addEventListener("input", () => {
    titleEdited = element("dictate-title").value.trim().length > 0;
    saveDraft();
  });
  textarea.addEventListener("input", () => {
    hidePolish();
    updateStats();
    saveDraft();
    scheduleAnalyze();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
  element("dictate-language").addEventListener("change", (event) => setPref("language", event.target.value));
  element("auto-polish").addEventListener("change", (event) => setPref("autoPolish", event.target.checked));
  element("voice-commands").addEventListener("change", (event) => setPref("voiceCommands", event.target.checked));
  element("detect-todos").addEventListener("change", (event) => {
    setPref("detectTodos", event.target.checked);
    renderTodos();
  });
  element("detected-todos").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-todo]");
    if (!button) return;
    const key = button.dataset.todo;
    todoChoices.set(key, !todoChoices.get(key));
    renderTodos();
  });
  on("notes", renderDestinations);
  on("prefs", syncPrefs);
  on("permission", () => renderPermission(element("dictate-notify")));
  window.addEventListener("resize", () => drawWave(null));
  syncPrefs();
}

export function onShowDictate() {
  syncPrefs();
  renderDestinations();
  renderPermission(element("dictate-notify"));
  updateStats();
  renderTodos();
  waveColors = null;
  window.requestAnimationFrame(() => drawWave(null));
}

export function onHideDictate() {
  // Keep recording in the background if the user wanders off; just stop drawing.
  if (!voice?.isRunning) window.cancelAnimationFrame(fallbackFrame);
}

function syncPrefs() {
  element("dictate-language").value = prefs.language;
  element("auto-polish").checked = prefs.autoPolish;
  element("voice-commands").checked = prefs.voiceCommands;
  element("detect-todos").checked = prefs.detectTodos;
}

export function focusEditor() {
  element("dictate-text").focus();
}

// ------------------------------------------------------------------ drafts

const saveDraft = debounce(() => {
  const text = element("dictate-text").value;
  const title = element("dictate-title").value;
  if (text.trim() || title.trim()) writeJson(draftKey(), { text, title, titleEdited });
  else removeStored(draftKey());
}, 400);

export function restoreDraft() {
  resetDictate();
  const draft = readJson(draftKey(), null);
  if (!draft || typeof draft !== "object" || !draft.text) return;
  element("dictate-text").value = String(draft.text);
  element("dictate-title").value = String(draft.title || "");
  titleEdited = Boolean(draft.titleEdited);
  updateStats();
  scheduleAnalyze();
}

export function resetDictate() {
  voice?.abort();
  segments = [];
  recordingMs = 0;
  spokenWords = 0;
  beforePolish = null;
  titleEdited = false;
  analysis = null;
  todoChoices = new Map();
  element("dictate-text").value = "";
  element("dictate-title").value = "";
  element("dictate-interim").textContent = "";
  element("dictate-tags").replaceChildren();
  element("dictate-suggestion").hidden = true;
  hidePolish();
  updateStats();
  renderTodos();
}

// ------------------------------------------------------------------ recording

export function stopDictation() {
  voice?.abort();
}

export function toggleDictation(forceStart = false) {
  if (voice?.isRunning) {
    if (!forceStart) voice.stop();
    return;
  }
  if (!speechSupported) {
    toast(recognitionErrorMessage("unsupported"), { type: "error" });
    focusEditor();
    return;
  }
  stopSpeaking();
  hidePolish();
  const stage = element("studio-stage");
  const status = element("dictate-status");
  voice = new VoiceSession({
    lang: element("dictate-language").value,
    continuous: true,
    keepAlive: true,
    meter: !prefersReducedMotion(),
    onStart: () => {
      sessionStarted = Date.now();
      stage.classList.add("is-recording");
      setRecordingIndicators(true);
      element("dictate-record").setAttribute("aria-label", "Stop dictating");
      status.textContent = "Listening… speak naturally. Say “stop listening” when you're done.";
      window.clearInterval(clockTimer);
      clockTimer = window.setInterval(updateStats, 250);
      startFallbackWave();
    },
    onLevel: (level, bins) => {
      stage.style.setProperty("--level", level.toFixed(3));
      if (bins) {
        meterActive = true;
        drawWave(bins);
      }
    },
    onMeterUnavailable: () => {
      meterActive = false;
    },
    onInterim: (words) => {
      element("dictate-interim").textContent = words;
    },
    onFinal: handleFinal,
    onError: (error) => {
      if (error !== "no-speech") toast(recognitionErrorMessage(error), { type: "error" });
    },
    onEnd: finishRecording,
  });
  voice.start();
}

function setRecordingIndicators(recording) {
  document.querySelectorAll('[data-view="dictate"]').forEach((node) => node.classList.toggle("is-recording", recording));
}

async function finishRecording() {
  recordingMs += sessionStarted ? Date.now() - sessionStarted : 0;
  sessionStarted = 0;
  meterActive = false;
  window.clearInterval(clockTimer);
  window.cancelAnimationFrame(fallbackFrame);
  element("studio-stage").classList.remove("is-recording");
  element("studio-stage").style.setProperty("--level", "0");
  element("dictate-record").setAttribute("aria-label", "Start dictating");
  element("dictate-interim").textContent = "";
  setRecordingIndicators(false);
  drawWave(null);
  updateStats();
  const text = element("dictate-text").value.trim();
  element("dictate-status").textContent = text
    ? "Review your words, then save when you're ready."
    : "Tap the button and start speaking";
  if (text && prefs.autoPolish) await polishNow({ automatic: true });
  if (saveAfterStop) {
    saveAfterStop = false;
    await save();
  }
}

function applyVoiceCommands(segment) {
  const commands = [];
  let text = segment;
  for (const [pattern, command] of COMMANDS) {
    if (pattern.test(text)) {
      commands.push(command);
      text = text.replace(pattern, " ");
    }
  }
  for (const [pattern, symbol] of PUNCTUATION) text = text.replace(pattern, symbol);
  text = text
    .replace(/[ \t]+([,.;:?!”])/g, "$1")
    .replace(/([,.;:?!])(?=[A-Za-z“])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/^[ \t]+|[ \t]+$/g, "");
  return { text, commands };
}

function insertSegment(segment) {
  const textarea = element("dictate-text");
  const current = textarea.value;
  let joiner = "";
  if (current && !/\s$/.test(current) && !/^[,.;:?!”\n]/.test(segment)) joiner = " ";
  let addition = segment;
  if (!current.trim() || /[.!?]\s*$/.test(current) || /\n$/.test(current)) {
    addition = segment.replace(/^(\s*)([a-z])/, (_, space, letter) => space + letter.toUpperCase());
  }
  textarea.value = current + joiner + addition;
  segments.push(joiner + addition);
  textarea.scrollTop = textarea.scrollHeight;
}

function handleFinal(raw) {
  let segment = raw;
  let commands = [];
  if (prefs.voiceCommands) ({ text: segment, commands } = applyVoiceCommands(raw));
  if (commands.includes("scratch")) scratchThat();
  if (segment) {
    insertSegment(segment);
    spokenWords += wordCount(segment);
  }
  updateStats();
  saveDraft();
  scheduleAnalyze();
  if (commands.includes("save")) {
    saveAfterStop = true;
    voice?.stop();
  } else if (commands.includes("stop")) {
    voice?.stop();
  }
}

function scratchThat() {
  const textarea = element("dictate-text");
  const last = segments.pop();
  if (last && textarea.value.endsWith(last)) {
    textarea.value = textarea.value.slice(0, -last.length);
    spokenWords = Math.max(0, spokenWords - wordCount(last));
    toast("Scratched that.", { duration: 1800 });
  } else {
    toast("There's nothing recent to scratch.", { duration: 2200 });
  }
}

function updateStats() {
  const text = element("dictate-text").value;
  const live = sessionStarted ? Date.now() - sessionStarted : 0;
  const elapsed = recordingMs + live;
  const seconds = Math.floor(elapsed / 1000);
  element("dictate-words").textContent = String(wordCount(text));
  element("dictate-time").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  element("dictate-wpm").textContent = elapsed > 5000 && spokenWords ? String(Math.round(spokenWords / (elapsed / 60_000))) : "—";
}

// ------------------------------------------------------------------ waveform

function readWaveColors() {
  const styles = getComputedStyle(document.documentElement);
  return { idle: styles.getPropertyValue("--line-2").trim(), live: styles.getPropertyValue("--coral").trim(), calm: styles.getPropertyValue("--moss").trim() };
}

function drawWave(bins, phase = 0) {
  const canvas = element("dictate-wave");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  waveColors ||= readWaveColors();
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const recording = Boolean(voice?.isRunning);
  const bars = Math.max(24, Math.floor(width / 9));
  const gap = 4;
  const barWidth = (width - gap * (bars - 1)) / bars;
  for (let index = 0; index < bars; index += 1) {
    const distance = Math.abs(index - (bars - 1) / 2) / (bars / 2);
    let value = 0.05;
    if (bins) value = bins[Math.min(bins.length - 1, Math.floor((1 - distance) * bins.length * 0.55))] / 255;
    else if (recording) value = (0.18 + 0.32 * Math.abs(Math.sin(phase / 260 + index * 0.65))) * (1 - distance * 0.45);
    const barHeight = Math.max(3, value * height * (1 - distance * 0.3));
    context.globalAlpha = 0.25 + 0.6 * (1 - distance);
    context.fillStyle = recording ? (index % 3 === 0 ? waveColors.calm : waveColors.live) : waveColors.idle;
    const x = index * (barWidth + gap);
    const y = (height - barHeight) / 2;
    context.beginPath();
    if (context.roundRect) context.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 3));
    else context.rect(x, y, barWidth, barHeight);
    context.fill();
  }
  context.globalAlpha = 1;
}

function startFallbackWave() {
  window.cancelAnimationFrame(fallbackFrame);
  if (prefersReducedMotion()) return;
  const loop = (time) => {
    if (!voice?.isRunning) return;
    if (!meterActive && currentView() === "dictate") drawWave(null, time);
    fallbackFrame = window.requestAnimationFrame(loop);
  };
  fallbackFrame = window.requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ polish

function hidePolish() {
  element("polish-bar").hidden = true;
  element("polish-diff").hidden = true;
  beforePolish = null;
}

async function polishNow({ automatic = false } = {}) {
  const textarea = element("dictate-text");
  const text = textarea.value.trim();
  if (!text) {
    if (!automatic) toast("Say or type something first, then I'll polish it.");
    return;
  }
  const button = element("polish-button");
  const editor = textarea.closest(".editor");
  setBusy(button, true);
  editor.classList.add("is-polishing");
  element("dictate-status").textContent = "Polishing grammar and punctuation…";
  try {
    const result = await api("/api/ai/polish", { method: "POST", body: { text, lang: element("dictate-language").value } });
    if (result.text === text) {
      if (!automatic) toast("Looks great already. Nothing needed fixing.", { type: "success" });
      element("dictate-status").textContent = "Your words look great. Save when you're ready.";
      return;
    }
    const original = textarea.value;
    textarea.value = result.text;
    beforePolish = original;
    segments = [];
    const engine = result.engine === "claude" ? "Claude" : "Echo's local engine";
    element("polish-summary").textContent = `Polished by ${engine} · ${result.count} fix${result.count === 1 ? "" : "es"}`;
    element("polish-detail").textContent = capitalize(result.summary.join(", ")) || "Tidied spacing";
    const diff = element("polish-diff");
    diff.replaceChildren(renderDiff(original, result.text));
    element("polish-bar").hidden = false;
    diff.hidden = false;
    element("polish-diff-toggle").textContent = "Hide changes";
    element("polish-diff-toggle").setAttribute("aria-expanded", "true");
    element("dictate-status").textContent = "Polished. Review the changes, then save.";
    updateStats();
    saveDraft();
    scheduleAnalyze(true);
  } catch (error) {
    toast(error.message, { type: "error" });
  } finally {
    setBusy(button, false);
    editor.classList.remove("is-polishing");
  }
}

function undoPolish() {
  if (beforePolish === null) return;
  element("dictate-text").value = beforePolish;
  hidePolish();
  updateStats();
  saveDraft();
  scheduleAnalyze(true);
  toast("Restored your original wording.");
}

function toggleDiff() {
  const diff = element("polish-diff");
  diff.hidden = !diff.hidden;
  element("polish-diff-toggle").textContent = diff.hidden ? "Show changes" : "Hide changes";
  element("polish-diff-toggle").setAttribute("aria-expanded", String(!diff.hidden));
}

// ------------------------------------------------------------------ analysis

const scheduleAnalyzeSoon = debounce(analyzeNow, 900);

function scheduleAnalyze(immediately = false) {
  if (immediately) {
    scheduleAnalyzeSoon.cancel();
    analyzeNow();
  } else {
    scheduleAnalyzeSoon();
  }
}

async function analyzeNow() {
  const text = element("dictate-text").value.trim();
  const sequence = ++analyzeSequence;
  if (wordCount(text) < 3) {
    analysis = null;
    renderInsights();
    return;
  }
  try {
    const result = await api("/api/ai/analyze", { method: "POST", body: { text } });
    if (sequence !== analyzeSequence) return;
    analysis = result;
    renderInsights();
  } catch {
    // Suggestions are a bonus; dictation keeps working without them.
  }
}

function renderInsights() {
  const title = element("dictate-title");
  if (analysis && !titleEdited && title.value !== analysis.title) {
    title.value = analysis.title;
    title.classList.remove("is-suggested");
    void title.offsetWidth;
    title.classList.add("is-suggested");
  }
  const tags = element("dictate-tags");
  tags.replaceChildren();
  if (analysis) {
    analysis.tags.forEach((tag) => tags.append(topicBadge(topicOf([tag]))));
    if (analysis.mood !== "neutral") tags.append(moodBadge(analysis.mood));
  }
  renderTodos();
  renderSuggestion();
}

function renderSuggestion() {
  const box = element("dictate-suggestion");
  const recommendation = analysis?.recommendation;
  const destination = element("dictate-destination").value;
  if (!recommendation || recommendation.action !== "append" || destination === String(recommendation.note_id)) {
    box.hidden = true;
    return;
  }
  const note = noteById(recommendation.note_id);
  if (!note) {
    box.hidden = true;
    return;
  }
  element("dictate-suggestion-text").textContent =
    `This sounds like it belongs in “${note.title || "Untitled note"}” (${recommendation.confidence}% match: ${recommendation.reason}). Add it there instead of a new note?`;
  box.hidden = false;
}

function useSuggestion() {
  const recommendation = analysis?.recommendation;
  if (!recommendation?.note_id) return;
  element("dictate-destination").value = String(recommendation.note_id);
  element("dictate-suggestion").hidden = true;
  toast("Got it. This will be added to that note when you save.", { type: "success" });
}

function renderDestinations() {
  const select = element("dictate-destination");
  const previous = select.value;
  const notes = [...state.notes].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  select.replaceChildren(
    h("option", { value: "new", text: "✦ Save as a new note" }),
    ...notes.map((note) => h("option", { value: String(note.id), text: `Add to ${topicOf(note.tags).emoji} ${note.title || "Untitled note"}` })),
  );
  select.value = [...select.options].some((option) => option.value === previous) ? previous : "new";
  renderSuggestion();
}

function renderTodos() {
  const list = element("detected-todos");
  const todos = prefs.detectTodos && analysis ? analysis.todos : [];
  todos.forEach((todo) => {
    if (!todoChoices.has(todo.text)) todoChoices.set(todo.text, true);
  });
  element("todo-count").textContent = String(todos.filter((todo) => todoChoices.get(todo.text)).length);
  list.replaceChildren();
  if (!prefs.detectTodos) {
    list.append(h("li", { class: "empty-inline", text: "To-do detection is off. Turn it on in the toolbar." }));
    return;
  }
  if (!todos.length) {
    list.append(h("li", { class: "empty-inline", text: "Say things like “remind me to call mom at 6 pm” or “I need to renew my passport” and they'll appear here." }));
    return;
  }
  todos.forEach((todo) => {
    const chosen = todoChoices.get(todo.text);
    list.append(
      h(
        "li",
        { class: `todo-item${chosen ? "" : " is-off"}` },
        h(
          "button",
          {
            class: `check-btn${chosen ? " is-checked" : ""}`,
            type: "button",
            "aria-pressed": String(Boolean(chosen)),
            "aria-label": chosen ? `Don't create a reminder for “${todo.text}”` : `Create a reminder for “${todo.text}”`,
            dataset: { todo: todo.text },
          },
          icon("check"),
        ),
        h("div", {}, h("strong", { text: todo.text }), todo.due_at ? dueChip(todo.due_at) : h("span", { class: "due-chip", text: "No time · lands in Anytime" })),
      ),
    );
  });
}

// ------------------------------------------------------------------ saving

async function clearEditor() {
  const text = element("dictate-text").value.trim();
  if (text && !(await confirmDialog({ title: "Clear this draft?", message: "Your transcript hasn't been saved yet.", confirmLabel: "Clear" }))) return;
  resetDictate();
  removeStored(draftKey());
  element("dictate-status").textContent = "Tap the button and start speaking";
  drawWave(null);
}

async function save() {
  if (voice?.isRunning) {
    saveAfterStop = true;
    voice.stop();
    return;
  }
  const textarea = element("dictate-text");
  const text = textarea.value.trim();
  if (!text) {
    toast("Say or type a few words before saving.", { type: "error" });
    textarea.focus();
    return;
  }
  const button = element("dictate-save");
  const destination = element("dictate-destination").value;
  setBusy(button, true);
  try {
    let note;
    if (destination === "new") {
      ({ note } = await api("/api/notes", {
        method: "POST",
        body: {
          text,
          title: element("dictate-title").value.trim() || analysis?.title || "",
          tags: analysis?.tags || [],
          mood: analysis?.mood || "",
        },
      }));
    } else {
      ({ note } = await api(`/api/notes/${destination}/append`, { method: "POST", body: { text } }));
    }
    upsertNote(note);
    const chosen = prefs.detectTodos && analysis ? analysis.todos.filter((todo) => todoChoices.get(todo.text)) : [];
    let reminders = 0;
    if (chosen.length) {
      const { tasks } = await api("/api/tasks", {
        method: "POST",
        body: { tasks: chosen.map((todo) => ({ text: todo.text, due_at: todo.due_at, note_id: note.id })) },
      });
      upsertTasks(tasks);
      reminders = tasks.length;
    }
    setBusy(button, false);
    flashSuccess(button, "Saved!");
    resetDictate();
    removeStored(draftKey());
    element("dictate-status").textContent = "Saved. Ready for the next thought.";
    const where = destination === "new" ? `Saved “${note.title}”` : `Added to “${note.title}”`;
    toast(reminders ? `${reminders} reminder${reminders === 1 ? "" : "s"} set too.` : "Your words are safe.", {
      type: "success",
      title: where,
      actions: [{ label: "Open note", onClick: () => openNote(note.id) }],
    });
  } catch (error) {
    setBusy(button, false);
    toast(error.message, { type: "error" });
  }
}
