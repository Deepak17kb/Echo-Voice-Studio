// Sign in and create-account screen.

import { api } from "./api.js";
import { element, setBusy, wait } from "./ui.js";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const STRENGTH_LABELS = [
  "Use 8 or more characters.",
  "Too weak. Keep going.",
  "Fair. Add length, numbers, or symbols.",
  "Good. Nearly there.",
  "Strong. Nicely done!",
];

let mode = "login";
let featureTimer = 0;
let onAuthenticated = async () => {};

export function initAuth(options) {
  onAuthenticated = options.onAuthenticated;
  element("tab-login").addEventListener("click", () => setMode("login"));
  element("tab-register").addEventListener("click", () => setMode("register"));
  element("auth-screen").querySelectorAll("[data-auth-switch]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.authSwitch));
  });
  element("auth-screen").querySelector(".auth-tabs").addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      setMode(mode === "login" ? "register" : "login");
    }
  });
  wirePasswordToggle("login-password", "login-password-toggle");
  wirePasswordToggle("register-password", "register-password-toggle");
  element("register-password").addEventListener("input", (event) => updateStrength(event.target.value));
  element("login-form").addEventListener("submit", submitLogin);
  element("register-form").addEventListener("submit", submitRegister);
  element("auth-screen").addEventListener("input", (event) => {
    event.target.closest(".float-field")?.classList.remove("is-invalid");
  });
}

export function showAuth({ mode: initialMode = "login" } = {}) {
  const screen = element("auth-screen");
  screen.classList.remove("is-leaving");
  screen.hidden = false;
  setMode(initialMode, { animate: false });
  ["login-password", "register-password"].forEach((id) => {
    element(id).value = "";
  });
  updateStrength("");
  startFeatureTour();
}

export async function hideAuth() {
  const screen = element("auth-screen");
  window.clearInterval(featureTimer);
  if (screen.hidden) return;
  screen.classList.add("is-leaving");
  await wait(480);
  screen.hidden = true;
  screen.classList.remove("is-leaving");
}

function setMode(next, { animate = true } = {}) {
  const forward = next === "register";
  mode = next;
  element("auth-screen").querySelector(".auth-tabs").classList.toggle("is-register", forward);
  [["login", "tab-login", "login-form"], ["register", "tab-register", "register-form"]].forEach(([name, tabId, formId]) => {
    const active = name === next;
    const tab = element(tabId);
    const form = element(formId);
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    form.classList.remove("is-entering-forward", "is-entering-back");
    if (active && animate && form.hidden) {
      void form.offsetWidth;
      form.classList.add(forward ? "is-entering-forward" : "is-entering-back");
    }
    form.hidden = !active;
    form.querySelector(".form-error").hidden = true;
  });
  const first = element(next === "login" ? "login-email" : "register-name");
  window.setTimeout(() => first.focus({ preventScroll: true }), animate ? 120 : 0);
}

function wirePasswordToggle(inputId, buttonId) {
  const input = element(inputId);
  const button = element(buttonId);
  button.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    button.querySelector("use").setAttribute("href", show ? "#icon-eye-off" : "#icon-eye");
    input.focus();
  });
}

function scorePassword(password) {
  if (!password) return 0;
  let score = password.length >= 8 ? 1 : 0;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  else if (/[\d\W]/.test(password) && password.length >= 10) score += 0.5;
  if (password.length < 8) return 1;
  return Math.max(1, Math.min(4, Math.round(score)));
}

function updateStrength(password) {
  const score = scorePassword(password);
  element("password-meter").dataset.score = String(score);
  element("password-meter-label").textContent = STRENGTH_LABELS[score];
}

function startFeatureTour() {
  const features = [...element("auth-feature-list").children];
  let index = 0;
  window.clearInterval(featureTimer);
  featureTimer = window.setInterval(() => {
    features[index].classList.remove("is-active");
    index = (index + 1) % features.length;
    features[index].classList.add("is-active");
  }, 4200);
}

function showError(formId, message, fieldId) {
  const error = element(`${formId === "login-form" ? "login" : "register"}-error`);
  error.hidden = true;
  void error.offsetWidth; // replay the shake
  error.textContent = message;
  error.hidden = false;
  if (fieldId) {
    const field = element(fieldId);
    field.closest(".float-field")?.classList.add("is-invalid");
    field.focus();
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const email = element("login-email").value.trim();
  const password = element("login-password").value;
  if (!EMAIL_PATTERN.test(email)) return showError("login-form", "Enter the email you signed up with.", "login-email");
  if (!password) return showError("login-form", "Enter your password.", "login-password");
  const button = element("login-submit");
  setBusy(button, true);
  try {
    const { user } = await api("/api/auth/login", {
      method: "POST",
      body: { email, password, remember: element("login-remember").checked },
    });
    await onAuthenticated(user, { isNew: false });
  } catch (error) {
    const field = error.field === "email" ? "login-email" : error.status === 429 ? null : "login-password";
    showError("login-form", error.message, field);
  } finally {
    setBusy(button, false);
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const name = element("register-name").value.trim();
  const email = element("register-email").value.trim();
  const password = element("register-password").value;
  if (!name) return showError("register-form", "Tell us what to call you.", "register-name");
  if (!EMAIL_PATTERN.test(email)) return showError("register-form", "That email doesn't look quite right.", "register-email");
  if (password.length < 8) return showError("register-form", "Use at least 8 characters for your password.", "register-password");
  const button = element("register-submit");
  setBusy(button, true);
  try {
    const { user } = await api("/api/auth/register", { method: "POST", body: { name, email, password, remember: true } });
    await onAuthenticated(user, { isNew: true });
  } catch (error) {
    const fields = { name: "register-name", email: "register-email", password: "register-password" };
    showError("register-form", error.message, fields[error.field] || null);
  } finally {
    setBusy(button, false);
  }
}
