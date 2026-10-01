"""Serve Echo's API inside the browser for the static GitHub Pages build.

Browsers have no sockets, so the in-browser engine (Pyodide, in a Web Worker) hands each
request from the page to the same AssistantHandler the local server uses and passes the
raw HTTP response back. Every visitor gets their own database, stored in their browser.
"""

from __future__ import annotations

import io
import json
import os
from email.message import Message
from pathlib import Path

os.environ.setdefault("ECHO_AI", "local")  # API keys never belong in a web page

import app
from store import EchoStore


class BrowserHandler(app.AssistantHandler):
    """An AssistantHandler that reads a request from memory instead of a socket."""

    def __init__(self, method: str, path: str, headers: dict[str, str], body: bytes) -> None:
        self.command = method
        self.path = path
        self.request_version = "HTTP/1.1"
        self.requestline = f"{method} {path} HTTP/1.1"
        self.client_address = ("127.0.0.1", 0)
        self.close_connection = True
        self.headers = Message()
        for name, value in headers.items():
            if name.lower() != "content-length":
                self.headers[name] = value
        self.headers["Content-Length"] = str(len(body))
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()

    def log_message(self, format: str, *args: object) -> None:
        pass


def start(database: str) -> None:
    """Open (or create and migrate) the visitor's database."""
    app.AssistantHandler.store = EchoStore(Path(database))


def handle(method: str, path: str, headers_json: str, body: str = "") -> str:
    """Answer one API request and return the full HTTP response as text."""
    handler = BrowserHandler(method.upper(), path, json.loads(headers_json), body.encode("utf-8"))
    handler.dispatch(handler.command)
    return handler.wfile.getvalue().decode("utf-8")
