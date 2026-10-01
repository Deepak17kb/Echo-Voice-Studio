"""Build the static GitHub Pages version of Echo Studio.

The page, styles and scripts are copied unchanged. The Python engine is copied next to
them and runs in the visitor's browser through Pyodide, so the site needs no server:

    python tools/build_static.py site
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE_FILES = ("app.py", "brain.py", "store.py", "claude_engine.py", "browser_bridge.py")
MAIN_SCRIPT = '<script type="module" src="js/main.js"></script>'
BACKEND_SCRIPT = '<script defer src="js/browser-backend.js"></script>'


def build(output: Path) -> Path:
    output = output.resolve()
    if output == ROOT or ROOT.is_relative_to(output):
        raise SystemExit("Choose an output folder other than the project folder or one that contains it.")
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(ROOT / "web", output)

    engine = output / "engine"
    engine.mkdir()
    for name in ENGINE_FILES:
        shutil.copy2(ROOT / name, engine / name)

    index = output / "index.html"
    html = index.read_text(encoding="utf-8")
    if MAIN_SCRIPT not in html:
        raise SystemExit("index.html no longer loads js/main.js the way this build expects.")
    # Deferred scripts run in order, so the in-browser backend is ready before the app starts.
    index.write_text(html.replace(MAIN_SCRIPT, f"{BACKEND_SCRIPT}\n  {MAIN_SCRIPT}"), encoding="utf-8")
    (output / ".nojekyll").write_text("", encoding="utf-8")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("output", nargs="?", default="site", help="folder to write the site to (default: site)")
    output = build(Path(parser.parse_args().output))
    print(f"Built the static site in {output}")


if __name__ == "__main__":
    main()
