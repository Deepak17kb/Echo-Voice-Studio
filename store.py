"""SQLite persistence for Echo Studio: accounts, sessions, sign-in history, notes, and tasks."""

from __future__ import annotations

import functools
import hashlib
import hmac
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Iterator, Mapping

PBKDF2_ITERATIONS = 240_000
SESSION_HOURS = 12
REMEMBER_DAYS = 30
EVENT_TYPES = ("register", "login", "logout", "failed")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    event TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    due_at TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
"""

# Columns added to the original single-user notes table.
NOTE_COLUMNS = {
    "user_id": "INTEGER",
    "title": "TEXT NOT NULL DEFAULT ''",
    "tags": "TEXT NOT NULL DEFAULT ''",
    "pinned": "INTEGER NOT NULL DEFAULT 0",
    "mood": "TEXT NOT NULL DEFAULT ''",
    "updated_at": "TEXT",
}
NOTE_FIELDS = "id, title, text, tags, pinned, mood, created_at, updated_at"
TASK_FIELDS = "id, note_id, text, due_at, done, created_at, completed_at, notified_at"

STARTER_NOTES = (
    (
        "Welcome to Echo",
        "This is your private voice notebook. Open the AI Assistant and just talk: it will "
        "suggest whether a thought deserves a new note or belongs in one you already have. "
        "Use Voice to Note for longer dictation. Grammar is polished automatically, and any "
        "to-dos you mention become reminders.",
        ("welcome",),
        "upbeat",
        True,
    ),
    (
        "Shopping list",
        "Milk, eggs, whole-grain bread, coffee beans and fresh basil.",
        ("shopping",),
        "neutral",
        False,
    ),
    (
        "Ideas",
        "Grow a small herb garden on the balcony. Start a podcast about everyday design. "
        "Plan a sunrise hike with friends.",
        ("ideas",),
        "upbeat",
        False,
    ),
)


class DuplicateEmailError(ValueError):
    """Raised when registering an email address that already has an account."""


class NoteFullError(ValueError):
    """Raised when appending would push a note past its size limit."""


def local_now() -> datetime:
    return datetime.now().astimezone()


def iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


@functools.lru_cache(maxsize=1)
def _decoy_hash() -> str:
    # Checked against unknown emails so a failed sign-in takes the same time either way.
    return hash_password(secrets.token_hex(16))


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _note(row: sqlite3.Row) -> dict:
    note = dict(row)
    note["tags"] = [tag for tag in note["tags"].split(",") if tag]
    note["pinned"] = bool(note["pinned"])
    note["updated_at"] = note["updated_at"] or note["created_at"]
    return note


def _task(row: sqlite3.Row) -> dict:
    task = dict(row)
    task["done"] = bool(task["done"])
    return task


class EchoStore:
    """All of Echo's data, kept in one local SQLite file."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            existing = {row["name"] for row in connection.execute("PRAGMA table_info(notes)")}
            for column, definition in NOTE_COLUMNS.items():
                if column not in existing:
                    connection.execute(f"ALTER TABLE notes ADD COLUMN {column} {definition}")
            connection.execute("CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id)")
            connection.execute("UPDATE notes SET updated_at = created_at WHERE updated_at IS NULL")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    # ------------------------------------------------------------------ accounts

    def create_user(self, name: str, email: str, password: str) -> dict:
        password_hash = hash_password(password)
        try:
            with self.connect() as connection:
                cursor = connection.execute(
                    "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (name, email, password_hash, iso(local_now())),
                )
                user_id = cursor.lastrowid
                # Notes from before accounts existed belong to whoever sets the studio up first.
                if connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1:
                    connection.execute("UPDATE notes SET user_id = ? WHERE user_id IS NULL", (user_id,))
        except sqlite3.IntegrityError as error:
            raise DuplicateEmailError(email) from error
        return self.get_user(user_id)

    def authenticate(self, email: str, password: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT id, password_hash FROM users WHERE email = ?", (email,)
            ).fetchone()
        if row is None:
            verify_password(password, _decoy_hash())
            return None
        if not verify_password(password, row["password_hash"]):
            return None
        return self.get_user(row["id"])

    def user_id_for_email(self, email: str) -> int | None:
        with self.connect() as connection:
            row = connection.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        return row["id"] if row else None

    def get_user(self, user_id: int) -> dict | None:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT u.id, u.name, u.email, u.created_at, u.last_login_at,
                          (SELECT COUNT(*) FROM login_events e
                            WHERE e.user_id = u.id AND e.event IN ('login', 'register')) AS login_count
                     FROM users u WHERE u.id = ?""",
                (user_id,),
            ).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------------ sessions

    def create_session(self, user_id: int, *, remember: bool, user_agent: str = "") -> str:
        token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        lifetime = timedelta(days=REMEMBER_DAYS) if remember else timedelta(hours=SESSION_HOURS)
        with self.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(now),))
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
                (_token_hash(token), user_id, iso(now), iso(now + lifetime), user_agent[:300]),
            )
        return token

    def user_for_session(self, token: str | None) -> dict | None:
        if not token or len(token) > 200:
            return None
        with self.connect() as connection:
            row = connection.execute(
                "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", (_token_hash(token),)
            ).fetchone()
        if row is None:
            return None
        if datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc):
            self.delete_session(token)
            return None
        return self.get_user(row["user_id"])

    def delete_session(self, token: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))

    # ------------------------------------------------------------------ sign-in history

    def record_event(
        self, *, user_id: int | None, email: str, event: str, ip: str = "", user_agent: str = ""
    ) -> None:
        if event not in EVENT_TYPES:
            raise ValueError(f"Unknown event type: {event}")
        now = iso(local_now())
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO login_events (user_id, email, event, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, email[:254], event, ip[:64], user_agent[:300], now),
            )
            if user_id is not None and event in ("login", "register"):
                connection.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now, user_id))

    def list_events(self, user_id: int, limit: int = 60) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT id, event, ip, user_agent, created_at FROM login_events
                    WHERE user_id = ? ORDER BY id DESC LIMIT ?""",
                (user_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def event_counts(self, user_id: int) -> dict[str, int]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT event, COUNT(*) AS total FROM login_events WHERE user_id = ? GROUP BY event",
                (user_id,),
            ).fetchall()
        counts = {event: 0 for event in EVENT_TYPES}
        counts.update({row["event"]: row["total"] for row in rows})
        return counts

    # ------------------------------------------------------------------ notes

    def list_notes(self, user_id: int) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT {NOTE_FIELDS} FROM notes WHERE user_id = ? ORDER BY id DESC", (user_id,)
            ).fetchall()
        return [_note(row) for row in rows]

    def get_note(self, user_id: int, note_id: int) -> dict | None:
        with self.connect() as connection:
            row = connection.execute(
                f"SELECT {NOTE_FIELDS} FROM notes WHERE id = ? AND user_id = ?", (note_id, user_id)
            ).fetchone()
        return _note(row) if row else None

    def add_note(
        self,
        user_id: int,
        text: str,
        *,
        title: str = "",
        tags: Iterable[str] = (),
        mood: str = "",
        pinned: bool = False,
        created_at: datetime | None = None,
    ) -> dict:
        stamp = iso(created_at or local_now())
        with self.connect() as connection:
            cursor = connection.execute(
                """INSERT INTO notes (user_id, title, text, tags, pinned, mood, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (user_id, title, text, ",".join(tags), int(pinned), mood, stamp, stamp),
            )
            row = connection.execute(
                f"SELECT {NOTE_FIELDS} FROM notes WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return _note(row)

    def update_note(self, user_id: int, note_id: int, **fields: object) -> dict | None:
        columns = {key: value for key, value in fields.items() if key in ("title", "text", "tags", "pinned", "mood")}
        if "tags" in columns:
            columns["tags"] = ",".join(columns["tags"])  # type: ignore[arg-type]
        if "pinned" in columns:
            columns["pinned"] = int(bool(columns["pinned"]))
        if {"title", "text", "tags"} & columns.keys():
            columns["updated_at"] = iso(local_now())
        if not columns:
            return self.get_note(user_id, note_id)
        assignments = ", ".join(f"{column} = ?" for column in columns)
        with self.connect() as connection:
            cursor = connection.execute(
                f"UPDATE notes SET {assignments} WHERE id = ? AND user_id = ?",
                (*columns.values(), note_id, user_id),
            )
            if cursor.rowcount == 0:
                return None
        return self.get_note(user_id, note_id)

    def append_to_note(self, user_id: int, note_id: int, text: str, *, max_chars: int) -> dict | None:
        note = self.get_note(user_id, note_id)
        if note is None:
            return None
        combined = f"{note['text'].rstrip()}\n\n{text.strip()}"
        if len(combined) > max_chars:
            raise NoteFullError("That note is full. Save this as a new note instead.")
        return self.update_note(user_id, note_id, text=combined)

    def delete_note(self, user_id: int, note_id: int) -> bool:
        with self.connect() as connection:
            connection.execute(
                "UPDATE tasks SET note_id = NULL WHERE note_id = ? AND user_id = ?", (note_id, user_id)
            )
            cursor = connection.execute(
                "DELETE FROM notes WHERE id = ? AND user_id = ?", (note_id, user_id)
            )
        return cursor.rowcount > 0

    # ------------------------------------------------------------------ tasks

    def list_tasks(self, user_id: int) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                f"""SELECT {TASK_FIELDS} FROM tasks WHERE user_id = ?
                     ORDER BY done, due_at IS NULL, due_at, id DESC""",
                (user_id,),
            ).fetchall()
        return [_task(row) for row in rows]

    def add_tasks(self, user_id: int, items: Iterable[Mapping]) -> list[dict]:
        now = iso(local_now())
        created_ids = []
        with self.connect() as connection:
            for item in items:
                note_id = item.get("note_id")
                if note_id is not None and connection.execute(
                    "SELECT 1 FROM notes WHERE id = ? AND user_id = ?", (note_id, user_id)
                ).fetchone() is None:
                    note_id = None
                cursor = connection.execute(
                    "INSERT INTO tasks (user_id, note_id, text, due_at, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user_id, note_id, item["text"], item.get("due_at"), now),
                )
                created_ids.append(cursor.lastrowid)
            rows = connection.execute(
                f"SELECT {TASK_FIELDS} FROM tasks WHERE id IN ({','.join('?' * len(created_ids))}) ORDER BY id",
                created_ids,
            ).fetchall() if created_ids else []
        return [_task(row) for row in rows]

    def update_task(self, user_id: int, task_id: int, **fields: object) -> dict | None:
        columns: dict[str, object] = {}
        now = iso(local_now())
        if "text" in fields:
            columns["text"] = fields["text"]
        if "due_at" in fields:
            columns["due_at"] = fields["due_at"]
            columns["notified_at"] = None
        if "done" in fields:
            columns["done"] = int(bool(fields["done"]))
            columns["completed_at"] = now if fields["done"] else None
        if "notified" in fields:
            columns["notified_at"] = now if fields["notified"] else None
        with self.connect() as connection:
            if columns:
                assignments = ", ".join(f"{column} = ?" for column in columns)
                connection.execute(
                    f"UPDATE tasks SET {assignments} WHERE id = ? AND user_id = ?",
                    (*columns.values(), task_id, user_id),
                )
            row = connection.execute(
                f"SELECT {TASK_FIELDS} FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id)
            ).fetchone()
        return _task(row) if row else None

    def delete_task(self, user_id: int, task_id: int) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id)
            )
        return cursor.rowcount > 0

    # ------------------------------------------------------------------ onboarding

    def seed_starter_content(self, user_id: int) -> None:
        """Give a brand-new studio a few notes and tasks so it never starts empty."""
        now = local_now()
        for offset, (title, text, tags, mood, pinned) in enumerate(STARTER_NOTES):
            self.add_note(
                user_id,
                text,
                title=title,
                tags=tags,
                mood=mood,
                pinned=pinned,
                created_at=now - timedelta(minutes=len(STARTER_NOTES) - offset),
            )
        self.add_tasks(
            user_id,
            [
                {"text": "Record your first voice note", "due_at": iso((now + timedelta(minutes=30)).replace(second=0))},
                {"text": "Ask the assistant “What's on my list today?”", "due_at": None},
                {"text": "Try saying “remind me to stretch in 20 minutes”", "due_at": None},
            ],
        )
