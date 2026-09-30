// Hash-based navigation between the studio's views (#/home, #/assistant, ...).

import { element } from "./ui.js";

const views = new Map();
const listeners = new Set();
let current = null;
let started = false;

export function registerView(name, { title, onShow, onHide } = {}) {
  views.set(name, { name, title, onShow, onHide });
}

export function onViewChange(listener) {
  listeners.add(listener);
}

export const currentView = () => current;

export const viewTitle = (name) => views.get(name)?.title || "";

function fromHash() {
  const name = window.location.hash.replace(/^#\/?/, "");
  return views.has(name) ? name : "home";
}

export function navigate(name) {
  const target = views.has(name) ? name : "home";
  if (window.location.hash !== `#/${target}`) window.location.hash = `/${target}`;
  else show(target);
}

/** Start listening for navigation (once) and show the view in the address bar. */
export function startRouter() {
  if (!started) {
    window.addEventListener("hashchange", () => show(fromHash()));
    started = true;
  }
  show(fromHash(), { force: true });
}

function show(name, { force = false } = {}) {
  if (name === current && !force) return;
  if (current && current !== name) {
    const previous = element(`${current}-view`);
    previous.hidden = true;
    previous.classList.remove("is-entering");
    views.get(current)?.onHide?.();
  }
  const section = element(`${name}-view`);
  section.hidden = false;
  section.classList.remove("is-entering");
  void section.offsetWidth; // restart the entrance animation
  section.classList.add("is-entering");
  current = name;
  window.scrollTo({ top: 0, behavior: "instant" });
  const view = views.get(name);
  listeners.forEach((listener) => listener(name, view));
  view?.onShow?.();
}
