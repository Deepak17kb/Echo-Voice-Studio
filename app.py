"""Echo Studio: a private, local-first voice assistant and notes server."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from collections import Counter
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Mapping
from urllib.parse import urlparse
from webbrowser import open as open_browser

import brain
from claude_engine import ClaudeEngine
from store import REMEMBER_DAYS, DuplicateEmailError, EchoStore, NoteFullError, iso, local_now

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
DATABASE = Path(
    os.environ.get("VOICE_ASSISTANT_DB", str(ROOT / "data" / "voice_assistant.sqlite3"))
)
MAX_REQUEST_BYTES = 262_144
MAX_NOTE_CHARS = 20_000
MAX_SEGMENT_CHARS = 5_000
MAX_TASK_CHARS = 300
COOKIE_NAME = "echo_session"
EXPIRED_COOKIE = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
LANG_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$")
TAG_RE = re.compile(r"[^a-z0-9]+")
MOODS = frozenset({"upbeat", "neutral", "heavy"})
LOGIN_WINDOW_SECONDS = 600
LOGIN_ATTEMPTS = 8

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; "
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)

ROUTES = tuple(
    (method, re.compile(pattern), handler, needs_auth)
    for method, pattern, handler, needs_auth in (
        ("GET", r"/api/health", "health", False),
        ("POST", r"/api/auth/register", "register", False),
        ("POST", r"/api/auth/login", "login", False),
        ("POST", r"/api/auth/logout", "logout", False),
        ("GET", r"/api/auth/me", "me", False),
        ("GET", r"/api/auth/activity", "activity", True),
        ("GET", r"/api/notes", "list_notes", True),
        ("POST", r"/api/notes", "create_note", True),
        ("PUT", r"/api/notes/(?P<note_id>\d+)", "update_note", True),
        ("DELETE", r"/api/notes/(?P<note_id>\d+)", "delete_note", True),
        ("POST", r"/api/notes/(?P<note_id>\d+)/append", "append_note", True),
        ("GET", r"/api/tasks", "list_tasks", True),
        ("POST", r"/api/tasks", "create_tasks", True),
        ("PUT", r"/api/tasks/(?P<task_id>\d+)", "update_task", True),
        ("DELETE", r"/api/tasks/(?P<task_id>\d+)", "delete_task", True),
        ("POST", r"/api/command", "command", True),
        ("POST", r"/api/ai/polish", "polish", True),
        ("POST", r"/api/ai/analyze", "analyze", True),
    )
)


class ApiError(Exception):
    def __init__(self, status: HTTPStatus, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.field = field


def require_text(payload: Mapping, key: str, *, limit: int, label: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{label} can't be empty.", key)
    value = value.strip()
    if len(value) > limit:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{label} must be {limit:,} characters or fewer.", key)
    return value


def optional_text(payload: Mapping, key: str, *, limit: int, label: str) -> str:
    value = payload.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{label} must be text.", key)
    value = value.strip()
    if len(value) > limit:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{label} must be {limit:,} characters or fewer.", key)
    return value


def clean_tags(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Tags must be a list.", "tags")
    tags: list[str] = []
    for tag in value:
        if not isinstance(tag, str):
            continue
        cleaned = TAG_RE.sub("-", tag.strip().lower().lstrip("#")).strip("-")[:24]
        if cleaned and cleaned not in tags:
            tags.append(cleaned)
    return tags[:8]


def clean_due(value: object) -> str | None:
    if value in (None, ""):
        return None
    moment = brain.parse_iso(value)
    if moment is None:
        raise ApiError(HTTPStatus.BAD_REQUEST, "The due time must be an ISO date and time.", "due_at")
    return iso(moment.astimezone())


def session_cookie(token: str, remember: bool) -> str:
    parts = [f"{COOKIE_NAME}={token}", "Path=/", "HttpOnly", "SameSite=Strict"]
    if remember:
        parts.append(f"Max-Age={REMEMBER_DAYS * 86_400}")
    return "; ".join(parts)


class AssistantHandler(BaseHTTPRequestHandler):
    store: EchoStore
    ai: ClaudeEngine = ClaudeEngine(mode="local")
    server_version = "EchoStudio/2.0"
    sys_version = ""
    _failed_logins: dict[str, list[float]] = {}
    _failed_lock = threading.Lock()

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.log_date_time_string()} {format % args}")

    # ------------------------------------------------------------------ plumbing

    def do_GET(self) -> None:
        self.dispatch("GET")

    def do_POST(self) -> None:
        self.dispatch("POST")

    def do_PUT(self) -> None:
        self.dispatch("PUT")

    def do_DELETE(self) -> None:
        self.dispatch("DELETE")

    def do_PATCH(self) -> None:
        self.dispatch("PATCH")

    def dispatch(self, method: str) -> None:
        try:
            # Read the body before any early rejection: answering without draining it makes
            # Windows reset the connection, and the browser never sees the error message.
            raw_body = self.read_body()
        except ApiError as error:
            self.send_json({"error": error.message}, error.status, headers={"Connection": "close"})
            return
        if not self.host_allowed():
            self.send_json(
                {"error": "Echo only answers requests addressed to this computer."},
                HTTPStatus.MISDIRECTED_REQUEST,
            )
            return
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            if method == "GET":
                self.serve_static(path)
            else:
                self.send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
            return

        allowed: set[str] = set()
        for route_method, pattern, handler, needs_auth in ROUTES:
            match = pattern.fullmatch(path)
            if match is None:
                continue
            allowed.add(route_method)
            if route_method != method:
                continue
            try:
                user = self.current_user() if needs_auth else None
                if needs_auth and user is None:
                    raise ApiError(HTTPStatus.UNAUTHORIZED, "Please sign in to continue.")
                payload = self.parse_json(raw_body) if method in ("POST", "PUT") else {}
                params = {key: int(value) for key, value in match.groupdict().items()}
                getattr(self, f"api_{handler}")(user, payload, **params)
            except ApiError as error:
                body = {"error": error.message}
                if error.field:
                    body["field"] = error.field
                self.send_json(body, error.status)
            return

        if allowed:
            self.send_json(
                {"error": "That method isn't supported here."},
                HTTPStatus.METHOD_NOT_ALLOWED,
                headers={"Allow": ", ".join(sorted(allowed))},
            )
        else:
            self.send_json({"error": "API route not found."}, HTTPStatus.NOT_FOUND)

    def host_allowed(self) -> bool:
        # Refuse DNS-rebinding requests aimed at this local server from other sites.
        host = self.headers.get("Host")
        if not host:
            return True
        hostname = host.split("]")[0] + "]" if host.startswith("[") else host.rsplit(":", 1)[0]
        return hostname.lower() in ALLOWED_HOSTS

    def read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "The request has an invalid length.") from None
        if length > MAX_REQUEST_BYTES:
            remaining = min(length, 8 * MAX_REQUEST_BYTES)  # drain a little, then give up
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65_536))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "That request is too large.")
        return self.rfile.read(length) if length > 0 else b""

    def parse_json(self, raw: bytes) -> dict:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Send the request body as JSON.")
        if not raw:
            return {}
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "The request body must be valid JSON.") from None
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Expected a JSON object.")
        return payload

    def send_json(
        self,
        payload: object,
        status: HTTPStatus = HTTPStatus.OK,
        *,
        headers: Mapping[str, str] | None = None,
        cookies: tuple[str, ...] | list[str] = (),
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, *, cookies: tuple[str, ...] | list[str] = ()) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Cache-Control", "no-store")
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def session_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except CookieError:
            return None
        morsel = cookie.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def current_user(self) -> dict | None:
        return self.store.user_for_session(self.session_token())

    def client_details(self) -> tuple[str, str]:
        return self.client_address[0], self.headers.get("User-Agent", "")[:300]

    def read_email(self, payload: Mapping) -> str:
        email = payload.get("email")
        email = email.strip().lower() if isinstance(email, str) else ""
        if len(email) > 254 or not EMAIL_RE.match(email):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Enter a valid email address.", "email")
        return email

    def read_lang(self, payload: Mapping) -> str:
        lang = payload.get("lang")
        return lang if isinstance(lang, str) and LANG_RE.match(lang) else "en"

    def read_history(self, payload: Mapping) -> list[dict]:
        history = payload.get("history")
        if not isinstance(history, list):
            return []
        turns = []
        for turn in history[-10:]:
            if isinstance(turn, dict) and turn.get("role") in ("user", "assistant") and isinstance(turn.get("text"), str):
                turns.append({"role": turn["role"], "text": turn["text"][:2000]})
        return turns

    @classmethod
    def too_many_attempts(cls, key: str) -> bool:
        cutoff = time.monotonic() - LOGIN_WINDOW_SECONDS
        with cls._failed_lock:
            recent = [stamp for stamp in cls._failed_logins.get(key, []) if stamp > cutoff]
            if recent:
                cls._failed_logins[key] = recent
            else:
                cls._failed_logins.pop(key, None)
            return len(recent) >= LOGIN_ATTEMPTS

    @classmethod
    def record_failure(cls, key: str) -> None:
        with cls._failed_lock:
            cls._failed_logins.setdefault(key, []).append(time.monotonic())

    @classmethod
    def clear_failures(cls, key: str) -> None:
        with cls._failed_lock:
            cls._failed_logins.pop(key, None)

    def polish_text(self, text: str, lang: str = "en") -> dict:
        if self.ai.available:
            result = self.ai.polish(text)
            if result is not None:
                counts = Counter(change["kind"] for change in result["changes"])
                return {
                    **result,
                    "summary": brain.summarize_changes(counts),
                    "count": sum(counts.values()),
                    "engine": "claude",
                }
        return {**brain.polish(text, lang=lang), "engine": "local"}

    # ------------------------------------------------------------------ accounts

    def api_health(self, user: dict | None, payload: dict) -> None:
        self.send_json({"name": "Echo", "status": "ready", "storage": "local", "ai": self.ai.describe()})

    def api_register(self, user: dict | None, payload: dict) -> None:
        name = require_text(payload, "name", limit=60, label="Your name")
        email = self.read_email(payload)
        password = payload.get("password")
        if not isinstance(password, str) or len(password) < 8:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Use at least 8 characters for your password.", "password")
        if len(password) > 128:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Passwords can be up to 128 characters.", "password")
        remember = payload.get("remember", True) is not False
        try:
            account = self.store.create_user(name, email, password)
        except DuplicateEmailError:
            raise ApiError(
                HTTPStatus.CONFLICT, "An account with this email already exists. Try signing in instead.", "email"
            ) from None
        self.store.seed_starter_content(account["id"])
        ip, agent = self.client_details()
        self.store.record_event(user_id=account["id"], email=email, event="register", ip=ip, user_agent=agent)
        token = self.store.create_session(account["id"], remember=remember, user_agent=agent)
        self.send_json(
            {"user": self.store.get_user(account["id"])},
            HTTPStatus.CREATED,
            cookies=[session_cookie(token, remember)],
        )

    def api_login(self, user: dict | None, payload: dict) -> None:
        email = self.read_email(payload)
        password = payload.get("password")
        if not isinstance(password, str) or not password:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Enter your password.", "password")
        ip, agent = self.client_details()
        key = f"{ip}|{email}"
        if self.too_many_attempts(key):
            raise ApiError(
                HTTPStatus.TOO_MANY_REQUESTS, "Too many attempts. Take a short break and try again in a few minutes."
            )
        account = self.store.authenticate(email, password[:256])
        if account is None:
            self.record_failure(key)
            self.store.record_event(
                user_id=self.store.user_id_for_email(email), email=email, event="failed", ip=ip, user_agent=agent
            )
            raise ApiError(HTTPStatus.UNAUTHORIZED, "That email and password don't match.", "password")
        self.clear_failures(key)
        remember = payload.get("remember", True) is not False
        self.store.record_event(user_id=account["id"], email=account["email"], event="login", ip=ip, user_agent=agent)
        token = self.store.create_session(account["id"], remember=remember, user_agent=agent)
        self.send_json({"user": self.store.get_user(account["id"])}, cookies=[session_cookie(token, remember)])

    def api_logout(self, user: dict | None, payload: dict) -> None:
        token = self.session_token()
        if token:
            account = self.store.user_for_session(token)
            if account is not None:
                ip, agent = self.client_details()
                self.store.record_event(
                    user_id=account["id"], email=account["email"], event="logout", ip=ip, user_agent=agent
                )
            self.store.delete_session(token)
        self.send_empty(cookies=[EXPIRED_COOKIE])

    def api_me(self, user: dict | None, payload: dict) -> None:
        # Signed-out visitors get {"user": null} rather than a 401, keeping the console quiet.
        self.send_json({"user": self.current_user()})

    def api_activity(self, user: dict, payload: dict) -> None:
        self.send_json(
            {
                "user": user,
                "events": self.store.list_events(user["id"]),
                "counts": self.store.event_counts(user["id"]),
            }
        )

    # ------------------------------------------------------------------ notes

    def api_list_notes(self, user: dict, payload: dict) -> None:
        self.send_json({"notes": self.store.list_notes(user["id"])})

    def api_create_note(self, user: dict, payload: dict) -> None:
        text = require_text(payload, "text", limit=MAX_NOTE_CHARS, label="Your note")
        tags = clean_tags(payload.get("tags")) or brain.detect_tags(text)
        title = optional_text(payload, "title", limit=120, label="The title") or brain.suggest_title(text, tags)
        mood = payload.get("mood")
        if not isinstance(mood, str) or mood not in MOODS:
            mood = brain.detect_mood(text)
        note = self.store.add_note(
            user["id"], text, title=title, tags=tags, mood=mood, pinned=bool(payload.get("pinned"))
        )
        self.send_json({"note": note}, HTTPStatus.CREATED)

    def api_update_note(self, user: dict, payload: dict, note_id: int) -> None:
        fields: dict[str, object] = {}
        if "text" in payload:
            fields["text"] = require_text(payload, "text", limit=MAX_NOTE_CHARS, label="Your note")
        if "title" in payload:
            fields["title"] = optional_text(payload, "title", limit=120, label="The title")
        if "tags" in payload:
            fields["tags"] = clean_tags(payload["tags"])
        if "pinned" in payload:
            fields["pinned"] = bool(payload["pinned"])
        if "mood" in payload:
            if not isinstance(payload["mood"], str) or payload["mood"] not in MOODS:
                raise ApiError(HTTPStatus.BAD_REQUEST, "That mood isn't one Echo knows.", "mood")
            fields["mood"] = payload["mood"]
        if not fields:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Nothing to update.")
        note = self.store.update_note(user["id"], note_id, **fields)
        if note is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Note not found.")
        self.send_json({"note": note})

    def api_append_note(self, user: dict, payload: dict, note_id: int) -> None:
        text = require_text(payload, "text", limit=MAX_SEGMENT_CHARS, label="The new text")
        try:
            note = self.store.append_to_note(user["id"], note_id, text, max_chars=MAX_NOTE_CHARS)
        except NoteFullError as error:
            raise ApiError(HTTPStatus.BAD_REQUEST, str(error)) from None
        if note is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Note not found.")
        self.send_json({"note": note})

    def api_delete_note(self, user: dict, payload: dict, note_id: int) -> None:
        if not self.store.delete_note(user["id"], note_id):
            raise ApiError(HTTPStatus.NOT_FOUND, "Note not found.")
        self.send_empty()

    # ------------------------------------------------------------------ tasks

    def api_list_tasks(self, user: dict, payload: dict) -> None:
        self.send_json({"tasks": self.store.list_tasks(user["id"])})

    def api_create_tasks(self, user: dict, payload: dict) -> None:
        raw_items = payload.get("tasks") if "tasks" in payload else [payload]
        if not isinstance(raw_items, list) or not raw_items:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Send at least one task.")
        if len(raw_items) > 20:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Add up to 20 tasks at a time.")
        now = local_now()
        items = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Each task must be an object.")
            text = require_text(raw, "text", limit=MAX_TASK_CHARS, label="A task")
            due = clean_due(raw.get("due_at"))
            if raw.get("parse") and due is None:
                cleaned, moment = brain.parse_due(text, now)
                if moment is not None:
                    due = iso(moment)
                    text = cleaned[:1].upper() + cleaned[1:] if cleaned else text
            note_id = raw.get("note_id")
            valid_note = isinstance(note_id, int) and not isinstance(note_id, bool)
            items.append({"text": text, "due_at": due, "note_id": note_id if valid_note else None})
        self.send_json({"tasks": self.store.add_tasks(user["id"], items)}, HTTPStatus.CREATED)

    def api_update_task(self, user: dict, payload: dict, task_id: int) -> None:
        fields: dict[str, object] = {}
        if "text" in payload:
            fields["text"] = require_text(payload, "text", limit=MAX_TASK_CHARS, label="A task")
        if "due_at" in payload:
            fields["due_at"] = clean_due(payload["due_at"])
        if "done" in payload:
            fields["done"] = bool(payload["done"])
        if "notified" in payload:
            fields["notified"] = bool(payload["notified"])
        if not fields:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Nothing to update.")
        task = self.store.update_task(user["id"], task_id, **fields)
        if task is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Task not found.")
        self.send_json({"task": task})

    def api_delete_task(self, user: dict, payload: dict, task_id: int) -> None:
        if not self.store.delete_task(user["id"], task_id):
            raise ApiError(HTTPStatus.NOT_FOUND, "Task not found.")
        self.send_empty()

    # ------------------------------------------------------------------ assistant

    def api_polish(self, user: dict, payload: dict) -> None:
        text = require_text(payload, "text", limit=MAX_NOTE_CHARS, label="Text to polish")
        self.send_json(self.polish_text(text, self.read_lang(payload)))

    def api_analyze(self, user: dict, payload: dict) -> None:
        text = require_text(payload, "text", limit=MAX_NOTE_CHARS, label="Text to analyze")
        self.send_json(brain.analyze(text, self.store.list_notes(user["id"]), local_now()))

    def api_command(self, user: dict, payload: dict) -> None:
        text = require_text(payload, "text", limit=MAX_SEGMENT_CHARS, label="Your message")
        lang = self.read_lang(payload)
        notes = self.store.list_notes(user["id"])
        tasks = self.store.list_tasks(user["id"])
        now = local_now()
        result = brain.converse(
            text,
            notes=notes,
            tasks=tasks,
            name=user["name"],
            now=now,
            polish_text=lambda body: self.polish_text(body, lang),
        )
        reply, action, engine = result["reply"], result["action"], "local"

        if result["intent"] == "create_tasks":
            action["tasks"] = self.store.add_tasks(user["id"], action["tasks"])
        elif result["intent"] == "append_note":
            previous = self.store.get_note(user["id"], action["note_id"])
            try:
                note = self.store.append_to_note(user["id"], action["note_id"], action["text"], max_chars=MAX_NOTE_CHARS)
            except NoteFullError as error:
                reply, action = str(error), None
            else:
                action = {"type": "note_appended", "note": note, "previous_text": previous["text"] if previous else ""}
        elif result["intent"] == "chat" and self.ai.available:
            answer = self.ai.chat(
                text,
                history=self.read_history(payload),
                context=brain.chat_context(user["name"], notes, tasks, now),
            )
            if answer:
                reply, engine = answer, "claude"
        elif action and action.get("type") == "suggest_note":
            engine = action["polished"].get("engine", "local")

        self.send_json({"reply": reply, "intent": result["intent"], "action": action, "engine": engine})

    # ------------------------------------------------------------------ files

    def serve_static(self, requested_path: str) -> None:
        relative_path = "index.html" if requested_path in ("", "/") else requested_path.lstrip("/")
        target = (WEB_ROOT / relative_path).resolve()
        content_type = STATIC_TYPES.get(target.suffix.lower())
        try:
            target.relative_to(WEB_ROOT.resolve())
            if content_type is None or not target.is_file():
                raise FileNotFoundError(relative_path)
            body = target.read_bytes()
        except (OSError, ValueError):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "microphone=(self)")
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    port = int(os.environ.get("PORT", "8000"))
    AssistantHandler.store = EchoStore(DATABASE)
    AssistantHandler.ai = ClaudeEngine()
    server = ThreadingHTTPServer(("127.0.0.1", port), AssistantHandler)
    url = f"http://127.0.0.1:{port}"
    print(f"Echo Voice Studio is ready at {url}")
    engine = AssistantHandler.ai.describe()
    if engine["engine"] == "claude":
        print(f"AI engine: Claude ({engine['model']}), with Echo's local engine as a fallback.")
    elif engine["sdk_installed"]:
        print("AI engine: Echo's local engine. Set ANTHROPIC_API_KEY to use Claude for polish and questions.")
    else:
        print("AI engine: Echo's local engine. Optional: `pip install anthropic` and set ANTHROPIC_API_KEY to use Claude.")
    print("Press Ctrl+C to stop the server.")
    if os.environ.get("ECHO_OPEN_BROWSER") == "1":
        threading.Timer(0.8, open_browser, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEcho is taking a little break. See you soon!")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
