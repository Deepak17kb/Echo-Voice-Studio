// Reminders: fire due tasks as system notifications, in-app toasts, and a soft chime.

import { api } from "./api.js";
import { navigate } from "./router.js";
import { emit, on, prefs, readJson, state, upsertTasks, writeJson } from "./state.js";
import { describeDue, element, formatClock, h, icon, relativeTime, toast } from "./ui.js";

const CHECK_EVERY_MS = 15_000;
let inbox = [];
let timer = 0;
let audio = null;

export const notificationsSupported = "Notification" in window;

export const permission = () => (notificationsSupported ? Notification.permission : "unsupported");

export async function requestPermission() {
  if (!notificationsSupported) {
    toast("This browser can't show system notifications, but Echo will still remind you here.", { type: "error" });
    return "unsupported";
  }
  const result = await Notification.requestPermission();
  emit("permission", { result });
  if (result === "granted") {
    toast("Reminders are on. Echo will nudge you the moment something's due.", { type: "success" });
  } else if (result === "denied") {
    toast("Notifications are blocked. You can allow them from the lock icon in the address bar.", { type: "error" });
  }
  return result;
}

export function renderPermission(container) {
  if (!container) return;
  const status = permission();
  const note = (iconName, text, warning) =>
    h("div", { class: `permission-note${warning ? " is-warning" : ""}` }, icon(iconName), h("p", { text }));
  container.replaceChildren();
  if (status === "granted") {
    container.append(note("check-circle", "Notifications are on. You'll get a nudge when a reminder is due.", false));
  } else if (status === "denied") {
    container.append(note("alert", "Notifications are blocked here, so reminders will pop up inside Echo instead.", true));
  } else if (status === "unsupported") {
    container.append(note("info", "This browser can't show system notifications; reminders will appear inside Echo.", true));
  } else {
    const row = note("bell", "Get a notification when a to-do is due.", true);
    row.append(h("button", { class: "btn btn-primary btn-sm", type: "button", text: "Enable", onclick: requestPermission }));
    container.append(row);
  }
}

// ------------------------------------------------------------------ sound

function audioContext() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!audio && Context) audio = new Context();
  audio?.resume?.().catch(() => {});
  return audio;
}

// Browsers only allow audio after a user gesture; warm the context on the first one.
document.addEventListener("pointerdown", () => audioContext(), { once: true });

export function chime() {
  if (!prefs.sound) return;
  try {
    const context = audioContext();
    if (!context) return;
    const now = context.currentTime;
    [[659.25, 0], [880, 0.13], [1318.5, 0.26]].forEach(([frequency, offset]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.55);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.6);
    });
  } catch {
    // Audio isn't available; the visual reminder still shows.
  }
}

// ------------------------------------------------------------------ inbox and bell

const inboxKey = () => `echo.inbox.${state.user?.id ?? "guest"}`;

function saveInbox() {
  writeJson(inboxKey(), inbox.slice(0, 30));
}

export function markAllRead() {
  inbox = inbox.map((entry) => ({ ...entry, read: true }));
  saveInbox();
  renderBell();
}

const byDue = (a, b) => new Date(a.due_at) - new Date(b.due_at);

export function renderBell() {
  const unread = inbox.filter((entry) => !entry.read).length;
  const badge = element("notif-badge");
  badge.hidden = unread === 0;
  badge.textContent = unread > 9 ? "9+" : String(unread);

  const recent = element("notif-list");
  recent.replaceChildren();
  if (!inbox.length) recent.append(h("li", { class: "notif-empty", text: "No reminders yet. They'll collect here." }));
  inbox.slice(0, 8).forEach((entry) => {
    recent.append(
      h(
        "li",
        { class: `notif-item${entry.read ? "" : " is-unread"}` },
        icon("bell"),
        h("div", {}, h("strong", { text: entry.text }), h("small", { text: relativeTime(entry.at) })),
      ),
    );
  });

  const upcoming = element("notif-upcoming");
  upcoming.replaceChildren();
  const soon = state.tasks
    .filter((task) => !task.done && task.due_at && new Date(task.due_at) > Date.now())
    .sort(byDue)
    .slice(0, 4);
  if (!soon.length) upcoming.append(h("li", { class: "notif-empty", text: "Nothing scheduled. Add a task with a time." }));
  soon.forEach((task) => {
    upcoming.append(
      h(
        "li",
        { class: "notif-item" },
        icon("clock"),
        h("div", {}, h("strong", { text: task.text }), h("small", { text: describeDue(task.due_at).label })),
      ),
    );
  });
  renderPermission(element("notif-permission"));
}

// ------------------------------------------------------------------ scheduling

export async function completeTask(id) {
  try {
    const { task } = await api(`/api/tasks/${id}`, { method: "PUT", body: { done: true } });
    upsertTasks([task]);
    toast(`Nicely done: “${task.text}”.`, { type: "success" });
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

export async function snoozeTask(id, minutes) {
  const due = new Date(Date.now() + minutes * 60_000);
  try {
    const { task } = await api(`/api/tasks/${id}`, { method: "PUT", body: { due_at: due.toISOString() } });
    upsertTasks([task]);
    toast(`Snoozed until ${formatClock(due)}.`, { type: "info" });
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

function systemNotification(title, body, onClick) {
  if (permission() !== "granted") return;
  try {
    const notification = new Notification(title, { body, icon: "/icon.svg", tag: `echo-${title}-${body}` });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Some platforms only allow notifications from a service worker; the toast still shows.
  }
}

async function fire(task) {
  task.notified_at = new Date().toISOString(); // prevents a double fire while the request is in flight
  inbox.unshift({ id: `${task.id}-${Date.now()}`, taskId: task.id, text: task.text, at: new Date().toISOString(), read: false });
  inbox = inbox.slice(0, 30);
  saveInbox();
  renderBell();
  chime();
  toast(task.text, {
    type: "reminder",
    title: "Reminder",
    duration: 15_000,
    actions: [
      { label: "Done", onClick: () => completeTask(task.id) },
      { label: "Snooze 10 min", onClick: () => snoozeTask(task.id, 10) },
    ],
  });
  systemNotification("Echo reminder", task.text, () => navigate("tasks"));
  try {
    const { task: saved } = await api(`/api/tasks/${task.id}`, { method: "PUT", body: { notified: true } });
    upsertTasks([saved]);
  } catch {
    // Stay marked locally; the server will learn about it on the next change.
  }
}

function checkDue() {
  const now = Date.now();
  state.tasks
    .filter((task) => !task.done && task.due_at && !task.notified_at && new Date(task.due_at).getTime() <= now)
    .forEach(fire);
}

export function sendTest() {
  chime();
  toast("This is how your reminders will look and sound.", { type: "reminder", title: "Test reminder" });
  systemNotification("Echo reminder", "This is a test. Your reminders are working.");
}

export function startReminders() {
  stopReminders();
  const saved = readJson(inboxKey(), []);
  inbox = Array.isArray(saved) ? saved.slice(0, 30) : [];
  renderBell();
  checkDue();
  timer = window.setInterval(checkDue, CHECK_EVERY_MS);
}

export function stopReminders() {
  window.clearInterval(timer);
  timer = 0;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && timer) checkDue();
});
on("tasks", () => {
  if (timer) renderBell();
});
on("permission", () => renderBell());
