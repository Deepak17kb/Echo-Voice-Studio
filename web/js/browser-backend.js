// Echo's in-browser backend for the static GitHub Pages build: the page's /api requests go
// to a Web Worker running the Python server code instead of over the network. The local
// Python server never loads this file.
(function () {
  "use strict";

  const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
  const SESSION_KEY = "echo.browserSession";
  const pending = new Map();
  let memorySession = null;
  let nextId = 0;

  function setBootMessage(text) {
    const note = document.querySelector("#boot-screen p");
    if (note) note.textContent = text;
  }

  function readSession() {
    for (const kind of ["sessionStorage", "localStorage"]) {
      try {
        const token = window[kind].getItem(SESSION_KEY);
        if (token) return token;
      } catch {
        // Storage is blocked; fall back to the in-memory copy.
      }
    }
    return memorySession;
  }

  // Like the server's cookie: "Keep me signed in" survives browser restarts (localStorage),
  // otherwise the session ends with the tab (sessionStorage).
  function writeSession(token, remember) {
    memorySession = token;
    for (const kind of ["sessionStorage", "localStorage"]) {
      try {
        if (token && remember === (kind === "localStorage")) window[kind].setItem(SESSION_KEY, token);
        else window[kind].removeItem(SESSION_KEY);
      } catch {
        // Storage is blocked; the session lasts until the tab closes.
      }
    }
  }

  // The engine answers with real Set-Cookie headers; keep the session token the same way.
  function rememberCookie(header) {
    const [pair, ...attributes] = header.split(";");
    const [name, ...rest] = pair.split("=");
    if (name.trim() !== "echo_session") return;
    const value = rest.join("=").trim();
    const maxAge = attributes.map((attribute) => attribute.trim().match(/^max-age\s*=\s*(\d+)$/i)).find(Boolean);
    const expired = maxAge && Number(maxAge[1]) === 0;
    writeSession(value && !expired ? value : null, Boolean(maxAge));
  }

  // Every tab would hold its own copy of the database and the last one to save would
  // overwrite the others' changes, so only one tab at a time runs the engine.
  function claimEngine() {
    if (!navigator.locks) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = setTimeout(() => setBootMessage("Echo is open in another tab. Close that tab to continue here."), 400);
      navigator.locks.request("echo-studio-engine", () => {
        clearTimeout(waiting);
        resolve();
        return new Promise(() => {}); // held until this tab closes
      });
    });
  }

  let worker = null;
  const ready = claimEngine().then(
    () =>
      new Promise((resolve, reject) => {
        worker = new Worker(`js/engine-worker.js?pyodide=${encodeURIComponent(PYODIDE_URL)}`, { type: "module" });
        worker.addEventListener("message", (event) => {
          const message = event.data;
          if (message.type === "status") setBootMessage(message.text);
          else if (message.type === "ready") resolve();
          else if (message.type === "failed") reject(new Error(message.error));
          else if (pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.raw);
          }
        });
        worker.addEventListener("error", (event) => reject(new Error(event.message || "Echo's engine failed to start.")));
      }),
  );
  ready.catch(() => {}); // callers see the failure when they await it

  function send(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, path, headers, body });
    });
  }

  async function backendFetch(path, init = {}) {
    await ready;
    const method = (init.method || "GET").toUpperCase();
    const headers = { Host: "127.0.0.1", "User-Agent": navigator.userAgent, ...(init.headers || {}) };
    const token = readSession();
    if (token) headers.Cookie = `echo_session=${token}`;
    const raw = await send(method, path, headers, typeof init.body === "string" ? init.body : "");
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) throw new Error("Echo's engine sent an unreadable response.");
    const lines = raw.slice(0, split).split("\r\n");
    const status = Number(lines[0].split(" ")[1]);
    const responseHeaders = new Headers();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "set-cookie") rememberCookie(value);
      else if (name.toLowerCase() !== "content-length") responseHeaders.append(name, value);
    }
    return new Response(status === 204 ? null : raw.slice(split + 4), { status, headers: responseHeaders });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") worker?.postMessage({ type: "flush" });
  });

  window.echoBackend = { mode: "browser", ready, fetch: backendFetch };
})();
