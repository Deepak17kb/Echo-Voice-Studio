// The home dashboard: greeting, live clock, stats, streak, activity heatmap, and tips.

import { currentView } from "./router.js";
import { on, state, taskById } from "./state.js";
import {
  animateNumber,
  dayKey,
  dueChip,
  element,
  excerpt,
  firstName,
  h,
  icon,
  relativeTime,
  startOfDay,
  toDate,
  topicOf,
  wordCount,
} from "./ui.js";
import { categorize, setTaskDone } from "./tasks.js";

const QUOTES = [
  "The palest ink is better than the best memory.",
  "Your mind is for having ideas, not holding them.",
  "Small deeds done are better than great deeds planned.",
  "Start where you are. Use what you have. Do what you can.",
  "Well begun is half done.",
  "The secret of getting ahead is getting started.",
  "It always seems impossible until it's done.",
  "Simplicity is the ultimate sophistication.",
  "Say it out loud; it becomes real.",
  "A thought captured is a thought kept.",
  "Done is better than perfect.",
  "What you write down, you can let go of.",
];
const TIPS = [
  "“Remind me to call mom tomorrow at 6 pm.”",
  "“Take a note that the Wi-Fi password is on the fridge.”",
  "“Add oat milk to my shopping list.”",
  "“What's on my list today?”",
  "In Voice to Note, say “new paragraph” or “scratch that”.",
  "Say “save note” to finish a dictation hands-free.",
  "Press Ctrl K to search every note and command.",
  "Press ? anytime to see keyboard shortcuts.",
  "“Find notes about travel.”",
];
const RING_LENGTH = 339.3;

let tipIndex = 0;
let tipTimer = 0;
let clockTimer = 0;
let callbacks = {};

export function initHome(options = {}) {
  callbacks = options;
  element("home-tip-next").addEventListener("click", () => showTip(tipIndex + 1));
  element("home-tip-prev").addEventListener("click", () => showTip(tipIndex - 1));
  element("home-tasks").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-task-id]");
    if (!button) return;
    const task = taskById(button.dataset.taskId);
    if (!task) return;
    button.classList.add("is-checked");
    button.closest(".mini-task").style.opacity = "0.5";
    await setTaskDone(task, true);
  });
  element("home-notes").addEventListener("click", (event) => {
    const item = event.target.closest("[data-note-id]");
    if (item) callbacks.openNote?.(Number(item.dataset.noteId));
  });
  const refresh = () => {
    updateStreak();
    if (currentView() === "home") render();
  };
  on("notes", refresh);
  on("tasks", refresh);
}

export function onShowHome() {
  element("home-view").querySelectorAll(".stat-value").forEach((node) => {
    node.dataset.value = "0";
  });
  render({ animate: true });
  tickClock();
  window.clearInterval(clockTimer);
  clockTimer = window.setInterval(tickClock, 10_000);
  showTip(tipIndex, { instant: true });
  window.clearInterval(tipTimer);
  tipTimer = window.setInterval(() => showTip(tipIndex + 1), 7000);
}

export function onHideHome() {
  window.clearInterval(clockTimer);
  window.clearInterval(tipTimer);
}

// ------------------------------------------------------------------ activity and streaks

function activityByDay() {
  const counts = new Map();
  const bump = (value) => {
    const date = toDate(value);
    if (!date) return;
    const key = dayKey(date);
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  state.notes.forEach((note) => {
    bump(note.created_at);
    if (note.updated_at && note.updated_at.slice(0, 10) !== note.created_at.slice(0, 10)) bump(note.updated_at);
  });
  state.tasks.forEach((task) => bump(task.completed_at));
  return counts;
}

function streakInfo(counts) {
  const cursor = startOfDay();
  const activeToday = counts.has(dayKey(cursor));
  if (!activeToday) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (counts.has(dayKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  let best = 0;
  let run = 0;
  const day = startOfDay();
  day.setDate(day.getDate() - 365);
  for (let index = 0; index <= 365; index += 1) {
    run = counts.has(dayKey(day)) ? run + 1 : 0;
    best = Math.max(best, run);
    day.setDate(day.getDate() + 1);
  }
  return { current, best, activeToday };
}

export function updateStreak() {
  const { current, activeToday } = streakInfo(activityByDay());
  element("sidebar-streak").textContent = current ? `${current}-day streak` : "Start a streak";
  element("sidebar-streak-label").textContent = !current
    ? "Capture one thought today."
    : activeToday
      ? "You showed up today. Lovely."
      : "Capture something today to keep it going.";
  element("sidebar-streak").closest(".streak-card").classList.toggle("is-hot", current >= 3);
}

// ------------------------------------------------------------------ rendering

function greeting(hour) {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Good night";
}

function tickClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).formatToParts(now);
  element("home-clock").textContent = parts.filter((part) => part.type !== "dayPeriod").map((part) => part.value).join("").trim();
  element("home-ampm").textContent = parts.find((part) => part.type === "dayPeriod")?.value || "";
  const elapsed = (now - startOfDay(now)) / 86_400_000;
  element("home-day-ring").style.strokeDashoffset = String(RING_LENGTH * (1 - elapsed));
  element("home-day-label").textContent = `${Math.floor(elapsed * 100)}% of today behind you`;
  element("home-greeting").textContent = greeting(now.getHours());
  element("home-date").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
    .format(now)
    .toUpperCase();
}

function render({ animate = false } = {}) {
  const user = state.user;
  element("home-name").textContent = `${firstName(user?.name)}.`;
  const dayOfYear = Math.floor((startOfDay() - new Date(new Date().getFullYear(), 0, 0)) / 86_400_000);
  element("home-quote").textContent = QUOTES[dayOfYear % QUOTES.length];

  const counts = activityByDay();
  const weekAgo = Date.now() - 7 * 86_400_000;
  const words = state.notes.reduce((total, note) => total + wordCount(note.text), 0);
  const groups = categorize();
  const overdue = groups.today.filter((task) => new Date(task.due_at) < Date.now()).length;
  const streak = streakInfo(counts);

  animateNumber(element("stat-notes"), state.notes.length);
  const thisWeek = state.notes.filter((note) => new Date(note.created_at) >= weekAgo).length;
  element("stat-notes-sub").textContent = thisWeek ? `${thisWeek} added this week` : "Nothing new this week";
  animateNumber(element("stat-words"), words);
  element("stat-words-sub").textContent = words ? `≈ ${Math.max(1, Math.round(words / 130))} min of speaking` : "Your words will add up";
  animateNumber(element("stat-due"), groups.today.length);
  element("stat-due-sub").textContent = overdue
    ? `${overdue} overdue`
    : groups.today.length
      ? "All on track"
      : groups.upcoming.length
        ? `${groups.upcoming.length} coming up later`
        : "Nothing scheduled";
  animateNumber(element("stat-streak"), streak.current);
  element("stat-streak-sub").textContent = streak.best > streak.current ? `Best: ${streak.best} days` : streak.current ? "Your best yet" : "Start today";

  renderUpNext(groups);
  renderRecent();
  renderHeatmap(counts, animate);
  renderTopics();
}

function renderUpNext(groups) {
  const list = element("home-tasks");
  const tasks = [...groups.today, ...groups.upcoming, ...groups.anytime].slice(0, 5);
  list.replaceChildren();
  if (!tasks.length) {
    list.append(h("li", { class: "empty-inline", text: "Nothing on your list. Say “remind me to…” to the assistant." }));
    return;
  }
  tasks.forEach((task) => {
    list.append(
      h(
        "li",
        { class: "mini-task" },
        h(
          "button",
          { class: "check-btn", type: "button", "aria-label": `Mark “${task.text}” as done`, dataset: { taskId: String(task.id) } },
          icon("check"),
        ),
        h("span", { class: "mini-task-text", text: task.text }),
        task.due_at ? dueChip(task.due_at) : null,
      ),
    );
  });
}

function renderRecent() {
  const container = element("home-notes");
  const notes = [...state.notes].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 4);
  container.replaceChildren();
  if (!notes.length) {
    container.append(h("p", { class: "empty-inline", text: "Your next good thought goes here." }));
    return;
  }
  notes.forEach((note) => {
    container.append(
      h(
        "button",
        { class: "mini-note", type: "button", dataset: { noteId: String(note.id) } },
        h("span", { class: "note-emoji", "aria-hidden": "true", text: topicOf(note.tags).emoji }),
        h("strong", { text: note.title || "Untitled note" }),
        h("time", { datetime: note.updated_at, text: relativeTime(note.updated_at) }),
        h("p", { text: excerpt(note.text, 90) }),
      ),
    );
  });
}

function renderHeatmap(counts, animate) {
  const container = element("home-heatmap");
  const today = startOfDay();
  const start = new Date(today);
  start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - 7 * 11); // Monday, 11 weeks back
  const cells = [];
  let total = 0;
  for (let index = 0; index < 84; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const count = counts.get(dayKey(date)) || 0;
    total += date <= today ? count : 0;
    const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4;
    const label = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
    cells.push(
      h("span", {
        class: `heat-cell${level ? ` level-${level}` : ""}${date.getTime() === today.getTime() ? " is-today" : ""}${date > today ? " is-future" : ""}`,
        title: `${count} ${count === 1 ? "capture" : "captures"} · ${label}`,
        style: animate ? { "--delay": `${Math.floor(index / 7) * 28 + (index % 7) * 6}ms` } : { animation: "none" },
      }),
    );
  }
  container.replaceChildren(...cells);
  container.setAttribute("aria-label", `${total} notes, edits and finished tasks over the last 12 weeks`);
  element("home-rhythm-meta").textContent = `${total} IN 12 WEEKS`;
}

function renderTopics() {
  const list = element("home-topics");
  const counts = new Map();
  state.notes.forEach((note) => (note.tags.length ? note.tags : ["untagged"]).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  list.replaceChildren();
  if (!top.length) {
    list.append(h("li", { class: "empty-inline", text: "Topics appear as you capture notes." }));
    return;
  }
  const max = top[0][1];
  top.forEach(([tag, count]) => {
    const topic = tag === "untagged" ? { emoji: "📝", label: "Untagged", hue: 80 } : topicOf([tag]);
    const fill = h("span", { style: { "--hue": String(topic.hue) } });
    list.append(
      h(
        "li",
        {},
        h("div", { class: "topic-bar-head" }, h("span", { text: topic.emoji, "aria-hidden": "true" }), h("strong", { text: topic.label }), h("span", { text: `${count} ${count === 1 ? "note" : "notes"}` })),
        h("div", { class: "topic-bar-track" }, fill),
      ),
    );
    window.requestAnimationFrame(() => {
      fill.style.width = `${Math.max(8, (count / max) * 100)}%`;
    });
  });
}

function showTip(index, { instant = false } = {}) {
  tipIndex = (index + TIPS.length) % TIPS.length;
  const text = element("home-tip");
  const dots = element("home-tip-dots");
  const apply = () => {
    text.textContent = TIPS[tipIndex];
    text.classList.remove("is-changing");
    dots.replaceChildren(...TIPS.map((_, dot) => h("span", { class: dot === tipIndex ? "is-active" : "" })));
  };
  if (instant) {
    apply();
    return;
  }
  text.classList.add("is-changing");
  window.setTimeout(apply, 260);
}
