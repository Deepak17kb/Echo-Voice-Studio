// Echo Studio: boot, sign-in flow, navigation, theme, and keyboard shortcuts.

import { initAccount, onShowAccount } from "./account.js";
import { api } from "./api.js";
import { initAssistant, onHideAssistant, onShowAssistant, resetAssistant, stopAssistant, toggleListening } from "./assistant.js";
import { hideAuth, initAuth, showAuth } from "./auth.js";
import { focusEditor, initDictate, onHideDictate, onShowDictate, restoreDraft, resetDictate, stopDictation, toggleDictation } from "./dictate.js";
import { initHome, onHideHome, onShowHome, updateStreak } from "./home.js";
import { markAllRead, renderBell, requestPermission, startReminders, stopReminders } from "./notify.js";
import { exportNotes, initNotes, onShowNotes, openNote } from "./notes.js";
import { initPalette, openPalette } from "./palette.js";
import { navigate, onViewChange, registerView, startRouter } from "./router.js";
import { on, prefs, setNotes, setPref, setTasks, state } from "./state.js";
import { focusTaskInput, initTasks, onHideTasks, onShowTasks } from "./tasks.js";
import {
  closeModal,
  confetti,
  element,
  firstName,
  initModals,
  initRipples,
  initials,
  openModal,
  prefersReducedMotion,
  toast,
  topModal,
} from "./ui.js";
import { stopSpeaking } from "./voice.js";

const VIEW_ORDER = ["home", "assistant", "dictate", "notes", "tasks", "account"];
const bootStarted = performance.now();
let studioReady = false;

// ------------------------------------------------------------------ theme

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme() {
  return document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");
}

function syncThemeChrome() {
  const dark = effectiveTheme() === "dark";
  element("theme-toggle").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  element("user-popover-theme-label").textContent = dark ? "Light mode" : "Dark mode";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111713" : "#f7f6f0");
}

function applyTheme(choice, origin) {
  const root = document.documentElement;
  const update = () => {
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
    syncThemeChrome();
  };
  if (!origin || !document.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  let { clientX: x, clientY: y } = origin;
  if (!x && !y) {
    const bounds = element("theme-toggle").getBoundingClientRect();
    x = bounds.left + bounds.width / 2;
    y = bounds.top + bounds.height / 2;
  }
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(update);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 560, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
}

function chooseTheme(choice, origin) {
  setPref("theme", choice);
  applyTheme(choice, origin);
}

function toggleTheme(origin) {
  chooseTheme(effectiveTheme() === "dark" ? "light" : "dark", origin);
}

systemDark.addEventListener("change", syncThemeChrome);

// ------------------------------------------------------------------ chrome

const popovers = () => [
  [element("notif-button"), element("notif-popover")],
  [element("user-button"), element("user-popover")],
];

function closePopovers() {
  popovers().forEach(([button, popover]) => {
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
  });
}

function togglePopover(button, popover) {
  const opening = popover.hidden;
  closePopovers();
  if (!opening) return;
  popover.hidden = false;
  button.setAttribute("aria-expanded", "true");
  if (popover.id === "notif-popover") {
    renderBell();
    window.setTimeout(markAllRead, 1500);
  }
}

function showShortcuts() {
  closePopovers();
  openModal(element("shortcuts-modal"));
}

function newNote() {
  navigate("dictate");
  window.setTimeout(focusEditor, 120);
}

function renderIdentity() {
  const user = state.user;
  if (!user) return;
  const letter = initials(user.name);
  ["sidebar-avatar", "topbar-avatar", "user-popover-avatar"].forEach((id) => {
    element(id).textContent = letter;
  });
  element("sidebar-name").textContent = user.name;
  element("sidebar-email").textContent = user.email;
  element("user-popover-name").textContent = user.name;
  element("user-popover-email").textContent = user.email;
}

function renderEngine() {
  const claude = state.ai?.engine === "claude";
  element("engine-label").textContent = claude ? "Claude AI" : "Local AI";
  element("engine-badge").classList.toggle("is-claude", claude);
  element("engine-badge").title = claude
    ? `Grammar polish and open questions use Claude (${state.ai.model}); everything else runs on this computer.`
    : "Echo's on-device engine handles polish, suggestions, and reminders. Nothing leaves this computer.";
}

function positionIndicators() {
  document.querySelectorAll(".side-nav").forEach((nav) => {
    const indicator = nav.querySelector(".nav-indicator");
    const active = nav.querySelector(".nav-link.is-active");
    if (!active) {
      indicator.style.opacity = "0";
      return;
    }
    indicator.style.opacity = "1";
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translateY(${active.offsetTop}px)`;
  });
}

function updateNavigation(name, view) {
  document.querySelectorAll(".nav-link[data-view], .tab[data-view]").forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  positionIndicators();
  element("breadcrumb-current").textContent = view?.title || "";
  document.title = `${view?.title || "Home"} · Echo Studio`;
  closePopovers();
}

function initChrome() {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-view]");
    if (trigger && !trigger.closest(".modal")) {
      event.preventDefault();
      navigate(trigger.dataset.view);
    }
    if (!event.target.closest(".popover-anchor")) closePopovers();
  });
  element("palette-trigger").addEventListener("click", openPalette);
  element("theme-toggle").addEventListener("click", (event) => toggleTheme(event));
  element("notif-button").addEventListener("click", () => togglePopover(element("notif-button"), element("notif-popover")));
  element("user-button").addEventListener("click", () => togglePopover(element("user-button"), element("user-popover")));
  element("notif-mark-read").addEventListener("click", markAllRead);
  element("user-popover-account").addEventListener("click", () => navigate("account"));
  element("user-popover-shortcuts").addEventListener("click", showShortcuts);
  element("user-popover-theme").addEventListener("click", (event) => {
    closePopovers();
    toggleTheme(event);
  });
  element("user-popover-logout").addEventListener("click", logout);
  element("sidebar-logout").addEventListener("click", logout);
  window.addEventListener("resize", positionIndicators);
  window.addEventListener("echo:unauthorized", () => {
    if (state.user) signOutLocally("Your session ended. Please sign in again.");
  });
  document.addEventListener("keydown", handleShortcut);
  syncThemeChrome();
}

function handleShortcut(event) {
  if (!state.user) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (topModal()) return;
  if (event.key === "Escape") {
    closePopovers();
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    const digit = event.code.match(/^Digit([1-6])$/);
    const actions = {
      KeyM: () => {
        navigate("assistant");
        toggleListening();
      },
      KeyR: () => {
        navigate("dictate");
        toggleDictation();
      },
      KeyN: newNote,
      KeyT: () => toggleTheme(),
    };
    if (digit) {
      event.preventDefault();
      navigate(VIEW_ORDER[Number(digit[1]) - 1]);
    } else if (actions[event.code]) {
      event.preventDefault();
      actions[event.code]();
    }
    return;
  }
  const typing = event.target.closest?.("input, textarea, select, [contenteditable='true']");
  if (!typing && event.key === "?") {
    event.preventDefault();
    showShortcuts();
  }
}

// ------------------------------------------------------------------ views

function initViews() {
  initHome({ openNote });
  initAssistant({ openNote });
  initDictate();
  initNotes({
    onNewNote: newNote,
    onRecordNote: () => {
      navigate("dictate");
      window.setTimeout(() => toggleDictation(true), 150);
    },
  });
  initTasks({ openNote });
  initAccount({ onLogout: logout, onTheme: chooseTheme });
  initPalette({
    navigate,
    openNote,
    newNote,
    logout,
    exportNotes,
    showShortcuts,
    enableReminders: requestPermission,
    toggleTheme: () => toggleTheme(),
    startDictation: () => {
      navigate("dictate");
      window.setTimeout(() => toggleDictation(true), 150);
    },
    talk: () => {
      navigate("assistant");
      window.setTimeout(toggleListening, 150);
    },
    addTask: () => {
      navigate("tasks");
      window.setTimeout(focusTaskInput, 150);
    },
  });

  registerView("home", { title: "Home", onShow: onShowHome, onHide: onHideHome });
  registerView("assistant", { title: "AI Assistant", onShow: onShowAssistant, onHide: onHideAssistant });
  registerView("dictate", { title: "Voice to Note", onShow: onShowDictate, onHide: onHideDictate });
  registerView("notes", { title: "Notes", onShow: onShowNotes });
  registerView("tasks", { title: "Tasks", onShow: onShowTasks, onHide: onHideTasks });
  registerView("account", { title: "Account & security", onShow: onShowAccount });
  onViewChange(updateNavigation);
  on("prefs", ({ key }) => {
    if (key === "theme") syncThemeChrome();
  });
}

// ------------------------------------------------------------------ sign in and out

async function enterStudio(user, { isNew = false, fromBoot = false } = {}) {
  state.user = user;
  const [notes, tasks, health] = await Promise.all([
    api("/api/notes"),
    api("/api/tasks"),
    api("/api/health").catch(() => null),
  ]);
  state.ai = health?.ai || { engine: "local" };
  if (!studioReady) {
    initViews();
    studioReady = true;
  }
  setNotes(notes.notes);
  setTasks(tasks.tasks);
  renderIdentity();
  renderEngine();
  updateStreak();
  resetAssistant();
  restoreDraft();

  if (fromBoot) element("auth-screen").hidden = true;
  else await hideAuth();
  const shell = element("app-shell");
  shell.hidden = false;
  shell.classList.remove("is-entering");
  void shell.offsetWidth;
  shell.classList.add("is-entering");
  startRouter();
  window.requestAnimationFrame(positionIndicators);
  startReminders();

  if (isNew) {
    window.setTimeout(() => confetti(), 350);
    toast(`We've added a few notes and tasks so you can explore. Try the AI Assistant first!`, {
      type: "success",
      title: `Welcome to Echo, ${firstName(user.name)}!`,
      duration: 7000,
    });
  } else if (!fromBoot) {
    toast(`Welcome back, ${firstName(user.name)}.`, { type: "success" });
  }
}

function signOutLocally(message) {
  stopAssistant();
  stopDictation();
  stopSpeaking();
  stopReminders();
  closePopovers();
  const open = topModal();
  if (open) closeModal(open);
  resetDictate();
  resetAssistant();
  state.user = null;
  setNotes([]);
  setTasks([]);
  element("app-shell").hidden = true;
  showAuth({ mode: "login" });
  toast(message, { type: "info" });
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    // Even if the server is unreachable, leave the studio on this screen.
  }
  signOutLocally(`Signed out. See you soon${state.user ? `, ${firstName(state.user.name)}` : ""}!`);
}

function finishBoot() {
  const delay = Math.max(0, 600 - (performance.now() - bootStarted));
  window.setTimeout(() => {
    const boot = element("boot-screen");
    boot.classList.add("is-done");
    window.setTimeout(() => boot.remove(), 600);
  }, delay);
}

async function boot() {
  applyTheme(prefs.theme);
  initModals();
  initRipples();
  initChrome();
  initAuth({ onAuthenticated: enterStudio });
  try {
    const { user } = await api("/api/auth/me");
    if (user) await enterStudio(user, { fromBoot: true });
    else showAuth();
  } catch (error) {
    showAuth();
    if (error.status === 0) toast(error.message, { type: "error", duration: 9000 });
  } finally {
    finishBoot();
  }
}

boot();
