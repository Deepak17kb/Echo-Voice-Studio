// Account and security: profile, preferences, and the full sign-in history.

import { api } from "./api.js";
import { on, prefs, setPref, state } from "./state.js";
import { download, element, formatDate, formatStamp, h, icon, initials, moveIndicator, relativeTime, toast } from "./ui.js";

const EVENTS = {
  register: { icon: "spark", label: "Created your studio" },
  login: { icon: "login", label: "Signed in" },
  logout: { icon: "logout", label: "Signed out" },
  failed: { icon: "alert", label: "Failed sign-in attempt" },
};
const TOGGLES = {
  "pref-autopolish": "autoPolish",
  "pref-voicecommands": "voiceCommands",
  "pref-todos": "detectTodos",
  "pref-speak": "speakReplies",
  "pref-sound": "sound",
};

let events = [];
let callbacks = {};

export function initAccount(options = {}) {
  callbacks = options;
  element("account-logout").addEventListener("click", () => callbacks.onLogout?.());
  element("activity-download").addEventListener("click", downloadActivity);
  element("pref-language").addEventListener("change", (event) => setPref("language", event.target.value));
  Object.entries(TOGGLES).forEach(([id, key]) => {
    element(id).addEventListener("change", (event) => setPref(key, event.target.checked));
  });
  element("pref-theme").addEventListener("click", (event) => {
    const choice = event.target.closest("[data-theme-choice]");
    if (choice) callbacks.onTheme?.(choice.dataset.themeChoice, event);
  });
  window.addEventListener("resize", () => moveIndicator(element("pref-theme")));
  on("prefs", renderPrefs);
}

export async function onShowAccount() {
  renderProfile();
  renderPrefs();
  try {
    const result = await api("/api/auth/activity");
    events = result.events;
    state.user = result.user;
    renderProfile(result.counts);
    renderActivity();
  } catch (error) {
    toast(error.message, { type: "error" });
  }
}

export function describeDevice(agent) {
  if (!agent) return "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge"
    : /OPR\//.test(agent) ? "Opera"
    : /Firefox\//.test(agent) ? "Firefox"
    : /Chrome\//.test(agent) ? "Chrome"
    : /Safari\//.test(agent) ? "Safari"
    : /python|curl/i.test(agent) ? "Script"
    : "Browser";
  const system = /Windows/.test(agent) ? "Windows"
    : /Android/.test(agent) ? "Android"
    : /iPhone|iPad/.test(agent) ? "iOS"
    : /Mac OS X/.test(agent) ? "macOS"
    : /Linux/.test(agent) ? "Linux"
    : "";
  return system ? `${browser} on ${system}` : browser;
}

const describeAddress = (ip) => (ip === "127.0.0.1" || ip === "::1" ? "This computer" : ip || "Unknown address");

function renderProfile(counts = null) {
  const user = state.user;
  if (!user) return;
  element("account-name").textContent = user.name.split(/\s+/)[0];
  element("account-display-name").textContent = user.name;
  element("account-email").textContent = user.email;
  element("account-avatar").textContent = initials(user.name);
  element("account-since").textContent = formatDate(user.created_at);
  element("account-logins").textContent = String(user.login_count ?? 0);
  const signIns = events.filter((event) => event.event === "login" || event.event === "register");
  element("account-last").textContent = signIns[1] ? relativeTime(signIns[1].created_at) : "This is your first";
  if (counts) element("account-failed").textContent = String(counts.failed ?? 0);
}

function renderPrefs() {
  element("pref-language").value = prefs.language;
  Object.entries(TOGGLES).forEach(([id, key]) => {
    element(id).checked = Boolean(prefs[key]);
  });
  element("pref-theme").querySelectorAll("[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === prefs.theme;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  });
  window.requestAnimationFrame(() => moveIndicator(element("pref-theme")));
}

function renderActivity() {
  const list = element("activity-list");
  element("activity-count").textContent = events.length ? `Showing the latest ${events.length}.` : "";
  list.replaceChildren();
  if (!events.length) {
    list.append(h("li", { class: "empty-inline", text: "No activity yet." }));
    return;
  }
  const currentIndex = events.findIndex((event) => event.event === "login" || event.event === "register");
  events.forEach((event, index) => {
    const details = EVENTS[event.event] || { icon: "info", label: event.event };
    list.append(
      h(
        "li",
        { class: `activity-item is-${event.event}`, style: { "--i": String(Math.min(index, 14)) } },
        h("span", { class: "activity-icon", "aria-hidden": "true" }, icon(details.icon)),
        h(
          "div",
          {},
          h("strong", {}, details.label, index === currentIndex ? h("span", { class: "activity-current", text: "THIS SESSION" }) : null),
          h("small", { text: `${describeDevice(event.user_agent)} · ${describeAddress(event.ip)}` }),
        ),
        h("time", { datetime: event.created_at, title: formatStamp(event.created_at), text: relativeTime(event.created_at) }),
      ),
    );
  });
}

function downloadActivity() {
  if (!events.length) {
    toast("There's no activity to download yet.");
    return;
  }
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [["event", "time", "device", "ip", "user_agent"]].concat(
    events.map((event) => [EVENTS[event.event]?.label || event.event, event.created_at, describeDevice(event.user_agent), event.ip, event.user_agent]),
  );
  download(`echo-sign-in-activity-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((row) => row.map(escape).join(",")).join("\n"), "text/csv;charset=utf-8");
  toast("Downloaded your sign-in history.", { type: "success" });
}
