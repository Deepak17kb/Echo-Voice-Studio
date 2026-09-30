// Tasks and reminders: natural-language entry, filters, snooze, and a daily progress ring.

import { api } from "./api.js";
import { permission, requestPermission, sendTest } from "./notify.js";
import { currentView } from "./router.js";
import { noteById, on, prefs, removeTask, state, taskById, upsertTasks } from "./state.js";
import {
  confetti,
  describeDue,
  dueChip,
  element,
  h,
  icon,
  iconButton,
  moveIndicator,
  setBusy,
  toast,
  wait,
} from "./ui.js";
import { VoiceSession, recognitionErrorMessage, speechSupported } from "./voice.js";

const EMPTY_STATES = {
  today: ["All clear.", "Nothing due today. Enjoy the breathing room."],
  upcoming: ["Nothing scheduled.", "Add a task with a time, like “renew passport next Friday”."],
  anytime: ["No someday tasks.", "Tasks without a time land here."],
  done: ["Nothing finished yet.", "Completed tasks collect here. Go get one!"],
};
const RING_LENGTH = 213.6;

let filter = "today";
let animateNextRender = true;
let voice = null;
let callbacks = {};

export const byDue = (a, b) => new Date(a.due_at) - new Date(b.due_at);

export function categorize(tasks = state.tasks, now = new Date()) {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const groups = { today: [], upcoming: [], anytime: [], done: [] };
  for (const task of tasks) {
    if (task.done) groups.done.push(task);
    else if (!task.due_at) groups.anytime.push(task);
    else if (new Date(task.due_at) <= endOfToday) groups.today.push(task);
    else groups.upcoming.push(task);
  }
  groups.today.sort(byDue);
  groups.upcoming.sort(byDue);
  groups.anytime.sort((a, b) => b.id - a.id);
  groups.done.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
  return groups;
}

const groupOf = (task) => Object.entries(categorize([task])).find(([, list]) => list.length)[0];

export function initTasks(options = {}) {
  callbacks = options;
  element("task-form").addEventListener("submit", addFromComposer);
  element("task-mic").addEventListener("click", listenForTask);
  element("task-filters").addEventListener("click", (event) => {
    const segment = event.target.closest(".segment");
    if (segment) setFilter(segment.dataset.filter);
  });
  element("task-list").addEventListener("click", handleListClick);
  element("notify-enable").addEventListener("click", requestPermission);
  element("notify-test").addEventListener("click", sendTest);
  window.addEventListener("resize", () => moveIndicator(element("task-filters")));
  on("tasks", () => {
    renderNavCount();
    if (currentView() === "tasks") render();
  });
  on("notes", () => {
    if (currentView() === "tasks") render();
  });
  on("permission", renderBanner);
}

export function onShowTasks() {
  animateNextRender = true;
  render();
  renderBanner();
  window.requestAnimationFrame(() => moveIndicator(element("task-filters")));
}

export function onHideTasks() {
  voice?.abort();
}

export function focusTaskInput() {
  element("task-input").focus();
}

function renderNavCount() {
  element("nav-tasks-count").textContent = String(state.tasks.filter((task) => !task.done).length);
}

function setFilter(next) {
  if (!EMPTY_STATES[next]) return;
  filter = next;
  element("task-filters").querySelectorAll(".segment").forEach((segment) => {
    const active = segment.dataset.filter === next;
    segment.classList.toggle("is-active", active);
    segment.setAttribute("aria-selected", String(active));
  });
  moveIndicator(element("task-filters"));
  animateNextRender = true;
  render();
}

function renderBanner() {
  const banner = element("notify-banner");
  const status = permission();
  const hasTimedTasks = state.tasks.some((task) => !task.done && task.due_at);
  banner.hidden = status === "granted" && !hasTimedTasks;
  element("notify-enable").hidden = status !== "default";
  const text = element("notify-banner-text");
  if (status === "granted") text.textContent = "Reminders are on. You'll get a notification the moment a task is due.";
  else if (status === "denied") text.textContent = "Notifications are blocked in this browser, so reminders will pop up inside Echo while it's open.";
  else if (status === "unsupported") text.textContent = "This browser can't show system notifications; reminders will appear inside Echo.";
  else text.textContent = "Turn on notifications to get a nudge the moment a task is due, even in another tab.";
}

function render() {
  const groups = categorize();
  Object.entries(groups).forEach(([key, list]) => {
    const counter = element("task-filters").querySelector(`[data-count="${key}"]`);
    if (counter) counter.textContent = String(list.length);
  });
  renderNavCount();
  renderProgress();

  const items = groups[filter];
  const animate = animateNextRender;
  animateNextRender = false;
  element("task-list").replaceChildren(...items.map((task, index) => taskItem(task, index, animate)));
  const empty = element("tasks-empty");
  empty.hidden = items.length > 0;
  element("tasks-empty-title").textContent = EMPTY_STATES[filter][0];
  element("tasks-empty-text").textContent = EMPTY_STATES[filter][1];
}

function renderProgress() {
  const today = new Date().toDateString();
  const isToday = (value) => value && new Date(value).toDateString() === today;
  const relevant = state.tasks.filter((task) =>
    task.done ? isToday(task.completed_at) || isToday(task.due_at) : task.due_at && new Date(task.due_at) <= endOfToday(),
  );
  const done = relevant.filter((task) => task.done).length;
  const percent = relevant.length ? Math.round((done / relevant.length) * 100) : 0;
  element("tasks-ring").style.strokeDashoffset = String(RING_LENGTH * (1 - percent / 100));
  element("tasks-progress-value").textContent = `${percent}%`;
  element("tasks-progress-label").textContent = relevant.length
    ? `${done} of ${relevant.length} done today`
    : "Nothing due today";
}

function endOfToday() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return end;
}

function taskItem(task, index, animate) {
  const note = task.note_id ? noteById(task.note_id) : null;
  const chip = task.due_at ? dueChip(task.due_at, { done: task.done, completedAt: task.completed_at }) : null;
  return h(
    "li",
    {
      class: `task-item${task.done ? " is-done" : ""}${animate ? " is-new" : ""}`,
      dataset: { taskId: String(task.id) },
      style: { "--i": String(Math.min(index, 10)) },
    },
    h(
      "button",
      {
        class: `check-btn${task.done ? " is-checked" : ""}`,
        type: "button",
        "aria-pressed": String(task.done),
        "aria-label": task.done ? `Mark “${task.text}” as not done` : `Mark “${task.text}” as done`,
        dataset: { action: "toggle" },
      },
      icon("check"),
    ),
    h(
      "div",
      { class: "task-body" },
      h("span", { class: "task-text", text: task.text }),
      chip || note
        ? h(
            "div",
            { class: "task-meta" },
            chip,
            note
              ? h(
                  "button",
                  { class: "task-source", type: "button", dataset: { action: "open-note", noteId: String(note.id) } },
                  icon("notes"),
                  note.title || "Untitled note",
                )
              : null,
          )
        : null,
    ),
    h(
      "div",
      { class: "task-actions" },
      !task.done && task.due_at ? iconButton("Snooze for an hour", "snooze", "snooze") : null,
      iconButton("Delete task", "trash", "delete", { danger: true }),
    ),
  );
}

async function handleListClick(event) {
  const button = event.target.closest("button[data-action]");
  const item = event.target.closest(".task-item");
  if (!button || !item) return;
  const task = taskById(item.dataset.taskId);
  if (!task) return;
  const action = button.dataset.action;
  if (action === "toggle") await setTaskDone(task, !task.done, item);
  else if (action === "snooze") await snooze(task, item);
  else if (action === "delete") await deleteTask(task, item);
  else if (action === "open-note") callbacks.openNote?.(Number(button.dataset.noteId));
}

/** Complete or reopen a task, with a little celebration when today's list is cleared. */
export async function setTaskDone(task, done, item = null) {
  const hadTodayWork = categorize().today.length > 0;
  item?.classList.toggle("is-done", done);
  item?.querySelector(".check-btn")?.classList.toggle("is-checked", done);
  try {
    const { task: saved } = await api(`/api/tasks/${task.id}`, { method: "PUT", body: { done } });
    if (item && currentView() === "tasks" && filter !== groupOf(saved)) {
      await wait(420);
      item.classList.add("is-leaving");
      await wait(340);
    }
    upsertTasks([saved]);
    if (done && hadTodayWork && categorize().today.length === 0) {
      const bounds = item?.getBoundingClientRect();
      confetti(bounds ? { x: bounds.left + 24, y: bounds.top } : {});
      toast("Everything due today is done. Take a bow!", { type: "success", title: "All clear" });
    }
  } catch (error) {
    item?.classList.toggle("is-done", !done);
    item?.querySelector(".check-btn")?.classList.toggle("is-checked", !done);
    toast(error.message, { type: "error" });
  }
}

async function snooze(task, item) {
  const due = new Date(Date.now() + 3_600_000);
  try {
    const { task: saved } = await api(`/api/tasks/${task.id}`, { method: "PUT", body: { due_at: due.toISOString() } });
    item.classList.add("is-leaving");
    await wait(300);
    upsertTasks([saved]);
    toast(`Snoozed to ${describeDue(saved.due_at).label.replace(" · ", " at ")}.`, { type: "info" });
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

async function deleteTask(task, item) {
  try {
    await api(`/api/tasks/${task.id}`, { method: "DELETE" });
    item.classList.add("is-leaving");
    await wait(340);
    removeTask(task.id);
    toast("Task removed.", {
      actions: [{ label: "Undo", onClick: () => restoreTask(task) }],
    });
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

async function restoreTask(task) {
  try {
    const { tasks } = await api("/api/tasks", {
      method: "POST",
      body: { tasks: [{ text: task.text, due_at: task.due_at, note_id: task.note_id }] },
    });
    upsertTasks(tasks);
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

async function addFromComposer(event) {
  event.preventDefault();
  const input = element("task-input");
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  const button = element("task-add");
  setBusy(button, true);
  try {
    const { tasks } = await api("/api/tasks", { method: "POST", body: { text, parse: true } });
    input.value = "";
    const task = tasks[0];
    const group = groupOf(task);
    if (group !== filter) setFilter(group);
    upsertTasks(tasks);
    window.requestAnimationFrame(() => {
      element("task-list").querySelector(`[data-task-id="${task.id}"]`)?.classList.add("is-flash");
    });
    const due = describeDue(task.due_at);
    const actions = due && permission() === "default"
      ? [{ label: "Turn on notifications", onClick: requestPermission }]
      : [];
    toast(due ? `I'll remind you ${due.label.replace(" · ", " at ").toLowerCase()}.` : "It's on your list.", {
      type: "success",
      title: `Added “${task.text}”`,
      actions,
    });
  } catch (error) {
    toast(error.message, { type: "error" });
  } finally {
    setBusy(button, false);
    input.focus();
  }
}

function listenForTask() {
  const button = element("task-mic");
  if (voice?.isRunning) {
    voice.stop();
    return;
  }
  if (!speechSupported) {
    toast(recognitionErrorMessage("unsupported"), { type: "error" });
    return;
  }
  const input = element("task-input");
  let spoken = "";
  voice = new VoiceSession({
    lang: prefs.language,
    onStart: () => {
      button.classList.add("is-listening");
      input.placeholder = "Listening… say a task and when it's due";
    },
    onInterim: (words) => {
      input.value = [spoken, words].filter(Boolean).join(" ");
    },
    onFinal: (words) => {
      spoken = [spoken, words].filter(Boolean).join(" ");
      input.value = spoken;
    },
    onError: (error) => toast(recognitionErrorMessage(error), { type: error === "no-speech" ? "info" : "error" }),
    onEnd: () => {
      button.classList.remove("is-listening");
      input.placeholder = "Add a task, e.g. “water the plants in 30 minutes”";
      if (spoken.trim()) element("task-form").requestSubmit();
    },
  });
  voice.start();
}
