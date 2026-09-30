// Small DOM, formatting, and feedback helpers shared by every part of the studio.

export const element = (id) => document.getElementById(id);

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const SVG = "http://www.w3.org/2000/svg";

export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

/** Build an element: h("button", { class: "btn", onclick: go }, icon("plus"), "Add"). */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.entries(value).forEach(([property, setting]) => node.style.setProperty(property, setting));
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function iconButton(label, iconName, action, { danger = false, small = true } = {}) {
  return h(
    "button",
    {
      class: `icon-btn${small ? " icon-btn-sm" : ""}${danger ? " is-danger" : ""}`,
      type: "button",
      "aria-label": label,
      title: label,
      dataset: { action },
    },
    icon(iconName),
  );
}

export function setBusy(button, busy) {
  button.classList.toggle("is-loading", busy);
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

export async function flashSuccess(button, label = "Saved") {
  const original = button.innerHTML;
  button.classList.add("is-success");
  button.replaceChildren(icon("check"), h("span", { text: label }));
  await wait(1200);
  button.classList.remove("is-success");
  button.innerHTML = original;
}

// ------------------------------------------------------------------ toasts

const TOAST_ICONS = { success: "check", error: "alert", info: "spark", reminder: "bell" };

export function toast(message, { type = "info", title = "", actions = [], duration } = {}) {
  const stack = element("toast-stack");
  const lifetime = duration ?? (type === "error" ? 6500 : actions.length ? 8000 : 4200);
  const item = h("div", { class: `toast is-${type}`, role: type === "error" ? "alert" : "status" });
  let timer = 0;
  let remaining = lifetime;
  let startedAt = Date.now();

  const close = () => {
    if (item.classList.contains("is-leaving")) return;
    window.clearTimeout(timer);
    item.classList.add("is-leaving");
    window.setTimeout(() => item.remove(), 340);
  };

  const body = h("div", { class: "toast-body" }, title ? h("strong", { text: title }) : null, h("span", { text: message }));
  if (actions.length) {
    body.append(
      h(
        "div",
        { class: "toast-actions" },
        actions.map((action) =>
          h("button", {
            class: "toast-action",
            type: "button",
            text: action.label,
            onclick: () => {
              close();
              action.onClick();
            },
          }),
        ),
      ),
    );
  }
  item.append(
    h("span", { class: "toast-icon" }, icon(TOAST_ICONS[type] || "spark")),
    body,
    h("button", { class: "toast-close", type: "button", "aria-label": "Dismiss notification", onclick: close }, icon("x")),
    h("span", { class: "toast-timer", style: { "animation-duration": `${lifetime}ms` } }),
  );
  item.addEventListener("mouseenter", () => {
    window.clearTimeout(timer);
    remaining -= Date.now() - startedAt;
  });
  item.addEventListener("mouseleave", () => {
    startedAt = Date.now();
    timer = window.setTimeout(close, Math.max(remaining, 900));
  });
  timer = window.setTimeout(close, lifetime);
  stack.append(item);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  return close;
}

// ------------------------------------------------------------------ dialogs

const openModals = [];

export const topModal = () => openModals[openModals.length - 1] || null;

export function openModal(modal, { focus } = {}) {
  if (!openModals.includes(modal)) {
    modal.returnFocus = document.activeElement;
    openModals.push(modal);
  }
  modal.hidden = false;
  document.body.classList.add("has-modal");
  window.requestAnimationFrame(() => modal.classList.add("is-open"));
  const target = focus || modal.querySelector("input, textarea, button:not([data-close])");
  window.setTimeout(() => target?.focus({ preventScroll: true }), 50);
}

export function closeModal(modal) {
  const index = openModals.indexOf(modal);
  if (index === -1) return;
  openModals.splice(index, 1);
  modal.classList.remove("is-open");
  window.setTimeout(() => {
    if (!modal.classList.contains("is-open")) modal.hidden = true;
  }, 260);
  if (!openModals.length) document.body.classList.remove("has-modal");
  modal.returnFocus?.focus?.({ preventScroll: true });
  modal.dispatchEvent(new CustomEvent("modal:close"));
}

function trapFocus(event, modal) {
  const focusable = [...modal.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea, select, [tabindex='0']")]
    .filter((node) => node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function initModals() {
  document.addEventListener("click", (event) => {
    const closer = event.target.closest("[data-close]");
    const modal = closer?.closest(".modal");
    if (modal) closeModal(modal);
  });
  document.addEventListener("keydown", (event) => {
    const modal = topModal();
    if (!modal) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal(modal);
    } else if (event.key === "Tab") {
      trapFocus(event, modal);
    }
  });
}

/** A friendlier window.confirm that resolves to true or false. */
export function confirmDialog({ title, message, confirmLabel = "Delete", danger = true }) {
  const modal = element("confirm-modal");
  const ok = element("confirm-ok");
  const cancel = element("confirm-cancel");
  element("confirm-title").textContent = title;
  element("confirm-message").textContent = message;
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      ok.removeEventListener("click", accept);
      cancel.removeEventListener("click", decline);
      modal.removeEventListener("modal:close", decline);
      closeModal(modal);
      resolve(answer);
    };
    const accept = () => finish(true);
    const decline = () => finish(false);
    ok.addEventListener("click", accept);
    cancel.addEventListener("click", decline);
    modal.addEventListener("modal:close", decline);
    openModal(modal, { focus: cancel });
  });
}

// ------------------------------------------------------------------ dates and words

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const weekdayLong = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function startOfDay(date = new Date()) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

export const daysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);

export const formatClock = (date) => clockFormat.format(date);

export const formatDate = (value) => {
  const date = toDate(value);
  return date ? longDate.format(date) : "—";
};

export function formatStamp(value) {
  const date = toDate(value);
  if (!date) return "Just now";
  const days = daysBetween(date, new Date());
  if (days === 0) return `Today · ${clockFormat.format(date)}`;
  if (days === 1) return `Yesterday · ${clockFormat.format(date)}`;
  if (days > 1 && days < 7) return `${weekdayLong.format(date)} · ${clockFormat.format(date)}`;
  return longDate.format(date);
}

/** Describe a due time for a chip: label plus "overdue" | "soon" | "later". */
export function describeDue(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return null;
  const days = daysBetween(now, date);
  const time = clockFormat.format(date);
  let label;
  if (days === 0) label = `Today · ${time}`;
  else if (days === 1) label = `Tomorrow · ${time}`;
  else if (days === -1) label = `Yesterday · ${time}`;
  else if (days > 1 && days < 7) label = `${weekdayShort.format(date)} · ${time}`;
  else label = `${shortDate.format(date)} · ${time}`;
  const until = date - now;
  return { date, label, state: until < 0 ? "overdue" : until < 3_600_000 ? "soon" : "later" };
}

export function relativeTime(value) {
  const date = toDate(value);
  if (!date) return "";
  const seconds = Math.round((date - Date.now()) / 1000);
  const size = Math.abs(seconds);
  if (size < 45) return seconds > 0 ? "in a moment" : "just now";
  if (size < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (size < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (size < 86_400 * 7) return relative.format(Math.round(seconds / 86_400), "day");
  return longDate.format(date);
}

export const wordCount = (text) => (String(text || "").trim().match(/\S+/g) || []).length;

export const initials = (name) => (String(name || "").trim().charAt(0) || "E").toUpperCase();

export const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "friend";

export const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");

export function excerpt(text, length = 220) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean;
}

// ------------------------------------------------------------------ topics and moods

export const TOPICS = {
  shopping: { emoji: "🛒", label: "Shopping", hue: 28 },
  work: { emoji: "💼", label: "Work", hue: 210 },
  ideas: { emoji: "💡", label: "Ideas", hue: 48 },
  health: { emoji: "🌿", label: "Health", hue: 130 },
  study: { emoji: "📚", label: "Study", hue: 262 },
  finance: { emoji: "💰", label: "Finance", hue: 95 },
  personal: { emoji: "💛", label: "Personal", hue: 340 },
  travel: { emoji: "✈️", label: "Travel", hue: 192 },
  welcome: { emoji: "👋", label: "Welcome", hue: 75 },
};

export const MOODS = {
  upbeat: { emoji: "☀️", label: "Upbeat" },
  neutral: { emoji: "🌤️", label: "Even" },
  heavy: { emoji: "🌧️", label: "Heavy" },
};

function hashHue(text) {
  let hue = 0;
  for (const character of text) hue = (hue * 31 + character.charCodeAt(0)) % 360;
  return hue;
}

export function topicOf(tags = []) {
  const known = tags.find((tag) => TOPICS[tag]);
  if (known) return { key: known, ...TOPICS[known] };
  if (tags[0]) return { key: tags[0], emoji: "🏷️", label: capitalize(tags[0]), hue: hashHue(tags[0]) };
  return { key: "", emoji: "📝", label: "Note", hue: 80 };
}

export function topicBadge(topic) {
  return h("span", { class: "topic-badge", style: { "--hue": String(topic.hue) } }, topic.emoji, " ", topic.label);
}

export function moodBadge(mood, { compact = false } = {}) {
  const details = MOODS[mood];
  if (!details) return null;
  return h(
    "span",
    { class: "mood-badge", title: `Mood: ${details.label}`, "aria-label": `Mood: ${details.label}` },
    details.emoji,
    compact ? null : ` ${details.label}`,
  );
}

export function dueChip(value, { done = false, completedAt = null } = {}) {
  const due = describeDue(value);
  if (!due) return null;
  const state = done ? "is-done" : due.state === "overdue" ? "is-overdue" : due.state === "soon" ? "is-soon" : "";
  const label = done ? `Done ${relativeTime(completedAt) || ""}`.trim() : due.state === "overdue" ? `Overdue · ${due.label}` : due.label;
  return h("span", { class: `due-chip ${state}`.trim() }, icon("clock"), label);
}

// ------------------------------------------------------------------ motion helpers

export function animateNumber(node, target, { duration = 900 } = {}) {
  const from = Number(node.dataset.value || 0);
  node.dataset.value = String(target);
  if (prefersReducedMotion() || from === target) {
    node.textContent = target.toLocaleString();
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    node.textContent = Math.round(from + (target - from) * eased).toLocaleString();
    if (progress < 1) window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}

/** Animate children of `container` from their old positions after `mutate` re-renders it. */
export function flip(container, mutate) {
  if (prefersReducedMotion()) {
    mutate();
    return;
  }
  const before = new Map();
  for (const child of container.children) {
    if (child.dataset.key) before.set(child.dataset.key, child.getBoundingClientRect());
  }
  mutate();
  for (const child of container.children) {
    const previous = before.get(child.dataset.key);
    if (!previous) continue;
    const current = child.getBoundingClientRect();
    const dx = previous.left - current.left;
    const dy = previous.top - current.top;
    if (dx || dy) {
      child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 440,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
  }
}

export function moveIndicator(group) {
  const indicator = group?.querySelector(".segment-indicator");
  const active = group?.querySelector(".segment.is-active");
  if (!indicator || !active || !active.offsetWidth) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

export function initRipples() {
  document.addEventListener("pointerdown", (event) => {
    const target = event.target.closest(".btn, .chip, .launch-card");
    if (!target || target.disabled || prefersReducedMotion()) return;
    const bounds = target.getBoundingClientRect();
    const size = Math.max(bounds.width, bounds.height) * 2.2;
    const wave = h("span", {
      class: "ripple-wave",
      style: {
        width: `${size}px`,
        height: `${size}px`,
        left: `${event.clientX - bounds.left - size / 2}px`,
        top: `${event.clientY - bounds.top - size / 2}px`,
      },
    });
    target.append(wave);
    wave.addEventListener("animationend", () => wave.remove());
  });
}

export function confetti({ x = window.innerWidth / 2, y = window.innerHeight / 3, count = 80 } = {}) {
  if (prefersReducedMotion()) return;
  const layer = h("div", { class: "confetti-layer", "aria-hidden": "true" });
  document.body.append(layer);
  const colors = ["#304b39", "#e6edbe", "#d18269", "#88a36a", "#f2c46d", "#9bb7d4", "#f0dccd"];
  for (let index = 0; index < count; index += 1) {
    const piece = h("span", {
      class: "confetti-piece",
      style: { left: `${x}px`, top: `${y}px`, background: colors[index % colors.length] },
    });
    layer.append(piece);
    const angle = Math.random() * Math.PI * 2;
    const speed = 140 + Math.random() * 280;
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed - 160;
    const spin = Math.random() * 900 - 450;
    piece.animate(
      [
        { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
        { transform: `translate(${dx * 0.7}px, ${dy}px) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${dx}px, ${dy + 520}px) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: 1600 + Math.random() * 900, easing: "cubic-bezier(0.2, 0.6, 0.4, 1)", fill: "forwards" },
    );
  }
  window.setTimeout(() => layer.remove(), 2700);
}

// ------------------------------------------------------------------ text helpers

/** Word-level diff: deleted words struck through, inserted words highlighted. */
export function renderDiff(before, after) {
  const a = before.match(/\S+|\n/g) || [];
  const b = after.match(/\S+|\n/g) || [];
  const fragment = document.createDocumentFragment();
  if (a.length * b.length > 1_500_000) {
    fragment.append(after);
    return fragment;
  }
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      parts.push(["same", a[i]]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      parts.push(["del", a[i]]);
      i += 1;
    } else {
      parts.push(["ins", b[j]]);
      j += 1;
    }
  }
  while (i < a.length) parts.push(["del", a[i++]]);
  while (j < b.length) parts.push(["ins", b[j++]]);

  let atLineStart = true;
  for (const [kind, token] of parts) {
    if (token === "\n") {
      if (kind !== "del") {
        fragment.append(document.createElement("br"));
        atLineStart = true;
      }
      continue;
    }
    if (!atLineStart) fragment.append(" ");
    fragment.append(kind === "same" ? token : h(kind, { text: token }));
    atLineStart = false;
  }
  return fragment;
}

export function highlight(text, query) {
  const fragment = document.createDocumentFragment();
  if (!query) {
    fragment.append(text);
    return fragment;
  }
  const lower = text.toLocaleLowerCase();
  let cursor = 0;
  let index = lower.indexOf(query);
  while (index !== -1 && query) {
    fragment.append(text.slice(cursor, index), h("mark", { text: text.slice(index, index + query.length) }));
    cursor = index + query.length;
    index = lower.indexOf(query, cursor);
  }
  fragment.append(text.slice(cursor));
  return fragment;
}

export function debounce(callback, delay) {
  let timer = 0;
  const debounced = (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
  debounced.cancel = () => window.clearTimeout(timer);
  return debounced;
}

export function download(filename, content, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. It's yours to take anywhere.", { type: "success" });
  } catch {
    toast("Clipboard access isn't available here. Try selecting the text instead.", { type: "error" });
  }
}
