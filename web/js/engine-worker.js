// Runs Echo's Python engine in the browser (Pyodide) for the static GitHub Pages build.
// It lives in a module Web Worker so the page stays smooth, and keeps each visitor's
// database in their own browser (IndexedDB). Only the static build loads this file.

const PYODIDE_URL = new URL(self.location.href).searchParams.get("pyodide");
const DATA_DIR = "/echo-data";
const ENGINE_DIR = "/echo-engine";
const ENGINE_FILES = ["app.py", "brain.py", "store.py", "claude_engine.py", "browser_bridge.py"];
// Password hashing runs in pure Python here, so it uses fewer rounds than the local server.
const PBKDF2_ITERATIONS = "100000";

let persistTimer = 0;
let saving = Promise.resolve();

const status = (text) => self.postMessage({ type: "status", text });

function syncFs(pyodide, populate) {
  return new Promise((resolve, reject) => {
    pyodide.FS.syncfs(populate, (error) => (error ? reject(error) : resolve()));
  });
}

function persist(pyodide) {
  // One save at a time; each write to IndexedDB captures everything changed so far.
  saving = saving.then(() => syncFs(pyodide, false)).catch(() => {});
  return saving;
}

function schedulePersist(pyodide) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persist(pyodide), 120);
}

const engine = (async () => {
  status("Downloading Echo's engine… the first visit takes a few seconds.");
  const { loadPyodide } = await import(`${PYODIDE_URL}pyodide.mjs`);
  const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });

  status("Opening your studio…");
  pyodide.FS.mkdirTree(DATA_DIR);
  pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, DATA_DIR);
  await syncFs(pyodide, true);
  pyodide.FS.mkdirTree(ENGINE_DIR);
  await Promise.all(
    ENGINE_FILES.map(async (name) => {
      const response = await fetch(new URL(`../engine/${name}`, self.location.href), { cache: "no-cache" });
      if (!response.ok) throw new Error(`Couldn't load engine/${name} (HTTP ${response.status}).`);
      pyodide.FS.writeFile(`${ENGINE_DIR}/${name}`, await response.text());
    }),
  );
  pyodide.runPython(`
import os, sys
sys.path.insert(0, "${ENGINE_DIR}")
os.environ["ECHO_PBKDF2_ITERATIONS"] = "${PBKDF2_ITERATIONS}"
import browser_bridge
browser_bridge.start("${DATA_DIR}/echo.sqlite3")
`);
  await persist(pyodide);
  return { pyodide, handle: pyodide.globals.get("browser_bridge").handle };
})();

engine.then(
  () => self.postMessage({ type: "ready" }),
  (error) => self.postMessage({ type: "failed", error: String(error?.message || error) }),
);

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (message.type === "flush") {
    const { pyodide } = await engine;
    clearTimeout(persistTimer);
    await persist(pyodide);
    return;
  }
  const { id, method, path, headers, body } = message;
  try {
    const { pyodide, handle } = await engine;
    const raw = handle(method, path, JSON.stringify(headers), body || "");
    if (method !== "GET") schedulePersist(pyodide);
    self.postMessage({ id, raw });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
});
