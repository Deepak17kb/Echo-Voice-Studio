"""Focused tests for Echo Studio; run with python -m unittest."""

from __future__ import annotations

import hashlib
import http.cookiejar
import itertools
import json
import os
import re
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import closing
from datetime import datetime, timedelta
from html.parser import HTMLParser
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import brain
import claude_engine
from app import AssistantHandler
from brain import calculate, respond
from store import DuplicateEmailError, EchoStore, hash_password, pbkdf2_sha256, verify_password

FIXED_NOW = datetime(2026, 9, 30, 15, 42)  # a Wednesday afternoon
WEB = Path(__file__).parent / "web"
NOTES = [
    {"id": 1, "title": "Welcome to Echo", "tags": ["welcome"], "created_at": "2026-09-30T10:00:00+00:00",
     "text": "This is your private voice notebook. Open the AI Assistant and just talk."},
    {"id": 2, "title": "Shopping list", "tags": ["shopping"], "created_at": "2026-09-30T10:01:00+00:00",
     "text": "Milk, eggs, whole-grain bread, coffee beans and fresh basil."},
    {"id": 3, "title": "Ideas", "tags": ["ideas"], "created_at": "2026-09-30T10:02:00+00:00",
     "text": "Grow a small herb garden on the balcony. Start a podcast about everyday design. "
             "Plan a sunrise hike with friends."},
]


def wall_clock(moment: datetime | None) -> datetime | None:
    return moment.replace(tzinfo=None) if moment else None


class DocumentInspector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.label_targets: set[str] = set()
        self.views: set[str] = set()
        self.icon_references: set[str] = set()

    def handle_starttag(self, tag: str, attributes: list[tuple[str, str | None]]) -> None:
        values = dict(attributes)
        if values.get("id"):
            self.ids.append(values["id"])
        if tag == "label" and values.get("for"):
            self.label_targets.add(values["for"])
        if values.get("data-view"):
            self.views.add(values["data-view"])
        if tag == "use" and (values.get("href") or "").startswith("#icon-"):
            self.icon_references.add(values["href"][6:])


class ArithmeticAndReplyTests(unittest.TestCase):
    def test_arithmetic_supports_speech_friendly_operators(self) -> None:
        self.assertEqual(calculate("24 * 6"), 144)
        self.assertEqual(respond("calculate 24 times 6"), "The answer is 144.")
        self.assertEqual(respond("what is 12 plus 8"), "The answer is 20.")
        self.assertEqual(respond("calculate 15 divided by 3"), "The answer is 5.")

    def test_calculator_rejects_code_and_unbounded_expressions(self) -> None:
        for expression in ("__import__('pathlib').Path('.')", "2 ** 999", "1 / 0", "7 / 0"):
            with self.subTest(expression=expression), self.assertRaises(
                (ValueError, SyntaxError, ZeroDivisionError)
            ):
                calculate(expression)

    def test_assistant_answers_clock_and_calendar_at_fixed_time(self) -> None:
        self.assertIn("3:42 PM", respond("current time please", FIXED_NOW))
        self.assertIn("Wednesday", respond("what day is it", FIXED_NOW))
        self.assertIn("September 30, 2026", respond("what is today's date", FIXED_NOW))
        self.assertIn("calculation", respond("can you help?"))


class PolishTests(unittest.TestCase):
    def test_polish_fixes_common_dictation_mistakes(self) -> None:
        result = brain.polish("um so i dont think the the meeting is today")
        self.assertEqual(result["text"], "So I don't think the meeting is today.")
        self.assertGreaterEqual(result["count"], 4)
        self.assertIn("removed 1 filler word", result["summary"])

    def test_polish_adds_question_marks_and_fixes_articles(self) -> None:
        self.assertEqual(brain.polish("can you send me a email")["text"], "Can you send me an email?")
        self.assertEqual(
            brain.polish("i waited a hour for a university reply")["text"],
            "I waited an hour for a university reply.",
        )
        self.assertEqual(brain.polish("when i get home i will cook")["text"], "When I get home I will cook.")

    def test_polish_splits_long_run_on_dictation(self) -> None:
        self.assertEqual(
            brain.polish("i went to the store and bought some milk and then i drove home to cook dinner")["text"],
            "I went to the store and bought some milk. Then I drove home to cook dinner.",
        )

    def test_polish_leaves_links_and_other_languages_alone(self) -> None:
        self.assertIn("https://example.com/?q=1", brain.polish("check https://example.com/?q=1 now")["text"])
        self.assertEqual(brain.polish("siete u ocho", lang="es-ES")["text"], "Siete u ocho")
        self.assertEqual(brain.polish("Buy milk")["count"], 0)


class DueDateTests(unittest.TestCase):
    def due(self, text: str) -> tuple[str, datetime | None]:
        cleaned, moment = brain.parse_due(text, FIXED_NOW)
        return cleaned, wall_clock(moment)

    def test_relative_named_and_clock_times(self) -> None:
        self.assertEqual(self.due("call mom at 5 pm"), ("call mom", datetime(2026, 9, 30, 17, 0)))
        self.assertEqual(self.due("water plants in 20 minutes"), ("water plants", datetime(2026, 9, 30, 16, 2)))
        self.assertEqual(self.due("submit report tomorrow"), ("submit report", datetime(2026, 10, 1, 9, 0)))
        self.assertEqual(self.due("pay rent on friday at 10"), ("pay rent", datetime(2026, 10, 2, 10, 0)))
        self.assertEqual(self.due("team sync tonight"), ("team sync", datetime(2026, 9, 30, 20, 0)))
        self.assertEqual(self.due("gym at 7"), ("gym", datetime(2026, 9, 30, 19, 0)))
        self.assertEqual(self.due("lunch at noon"), ("lunch", datetime(2026, 10, 1, 12, 0)))

    def test_text_without_a_time_is_untouched(self) -> None:
        self.assertEqual(brain.parse_due("book tickets for 5 people", FIXED_NOW), ("book tickets for 5 people", None))

    def test_extracts_tasks_with_shared_and_separate_due_times(self) -> None:
        tasks = brain.extract_tasks(
            "Remind me to buy milk and call mom at 5. I need to finish the report by friday. "
            "Also, don't forget to water the plants.",
            FIXED_NOW,
        )
        self.assertEqual([task["text"] for task in tasks], ["Buy milk", "Call mom", "Finish the report", "Water the plants"])
        self.assertEqual(wall_clock(brain.parse_iso(tasks[0]["due_at"])), datetime(2026, 9, 30, 17, 0))
        self.assertEqual(wall_clock(brain.parse_iso(tasks[2]["due_at"])), datetime(2026, 10, 2, 9, 0))
        self.assertIsNone(tasks[3]["due_at"])


class MatchingTests(unittest.TestCase):
    def test_shared_topic_recommends_the_existing_list(self) -> None:
        analysis = brain.analyze("buy apples and oranges on the way home", NOTES, FIXED_NOW)
        self.assertEqual(analysis["recommendation"]["action"], "append")
        self.assertEqual(analysis["recommendation"]["note_id"], 2)

    def test_unrelated_thought_gets_a_new_titled_note(self) -> None:
        analysis = brain.analyze("The wifi password is on the fridge", NOTES, FIXED_NOW)
        self.assertEqual(analysis["recommendation"]["action"], "create")
        self.assertEqual(analysis["title"], "Wifi password")

    def test_word_forms_still_match(self) -> None:
        self.assertEqual(brain.rank_notes("hiking with friends", NOTES)[0]["note_id"], 3)


class ConversationTests(unittest.TestCase):
    def converse(self, message: str, tasks: list[dict] | None = None) -> dict:
        return brain.converse(message, notes=NOTES, tasks=tasks or [], name="Asha Rao", now=FIXED_NOW)

    def test_reminders_become_tasks(self) -> None:
        result = self.converse("remind me at 6 pm to take my medicine")
        self.assertEqual(result["intent"], "create_tasks")
        self.assertEqual(result["action"]["tasks"][0]["text"], "Take my medicine")
        self.assertEqual(result["reply"], "Done. I'll remind you to take your medicine today at 6:00 PM.")

    def test_statements_get_a_note_recommendation(self) -> None:
        result = self.converse("We should plan a weekend hike with friends and try that new trail")
        self.assertEqual(result["intent"], "suggest_note")
        self.assertEqual(result["action"]["analysis"]["recommendation"]["note_id"], 3)
        self.assertIn("Ideas", result["reply"])

    def test_adding_to_a_named_note_appends(self) -> None:
        result = self.converse("add oat milk to my shopping list")
        self.assertEqual(result["action"], {"type": "append_note", "note_id": 2, "text": "Oat milk"})

    def test_questions_and_lookups(self) -> None:
        tasks = [{"id": 7, "text": "Call the bank", "due_at": None, "done": False}]
        self.assertEqual(self.converse("what's on my list", tasks)["action"], {"type": "task_list", "task_ids": [7]})
        self.assertEqual(self.converse("find notes about hiking")["action"]["note_ids"], [3])
        self.assertEqual(self.converse("calculate 24 times 6")["reply"], "The answer is 144.")
        self.assertEqual(self.converse("open my notes")["action"], {"type": "open_view", "view": "notes"})
        self.assertEqual(self.converse("what is the capital of France")["intent"], "chat")


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "nested" / "echo.sqlite3"

    def test_accounts_hash_passwords_sessions_and_sign_in_history(self) -> None:
        store = EchoStore(self.path)
        user = store.create_user("Asha", "asha@example.com", "correct horse")
        with store.connect() as connection:
            stored = connection.execute("SELECT password_hash FROM users").fetchone()[0]
        self.assertNotIn("correct horse", stored)
        self.assertTrue(verify_password("correct horse", stored))
        self.assertIsNone(store.authenticate("asha@example.com", "wrong password"))
        self.assertEqual(store.authenticate("ASHA@example.com", "correct horse")["id"], user["id"])
        with self.assertRaises(DuplicateEmailError):
            store.create_user("Someone", "asha@example.com", "another one")

        store.record_event(user_id=user["id"], email="asha@example.com", event="login", ip="127.0.0.1", user_agent="Test")
        self.assertEqual(store.list_events(user["id"])[0]["event"], "login")
        self.assertEqual(store.get_user(user["id"])["login_count"], 1)

        token = store.create_session(user["id"], remember=False)
        self.assertEqual(store.user_for_session(token)["id"], user["id"])
        store.delete_session(token)
        self.assertIsNone(store.user_for_session(token))

    def test_password_hashing_works_without_openssl(self) -> None:
        # The browser build's Python has no OpenSSL, so hashing falls back to pure Python.
        cases = [(b"correct horse", b"salt-1234567890ab", 1000), (b"x" * 100, bytes(16), 50), ("pässwörd".encode(), b"nacl", 1)]
        expected = [hashlib.pbkdf2_hmac("sha256", *case) for case in cases]
        with mock.patch("store.hashlib", SimpleNamespace(sha256=hashlib.sha256)):
            self.assertEqual([pbkdf2_sha256(*case) for case in cases], expected)
            stored = hash_password("correct horse", iterations=1000)
        self.assertTrue(verify_password("correct horse", stored))

    def test_original_notes_database_is_migrated_to_the_first_account(self) -> None:
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)")
            connection.execute("INSERT INTO notes (text, created_at) VALUES ('An old thought', '2026-01-01T09:00:00+00:00')")
        store = EchoStore(self.path)
        first = store.create_user("First", "first@example.com", "password one")
        second = store.create_user("Second", "second@example.com", "password two")
        self.assertEqual([note["text"] for note in store.list_notes(first["id"])], ["An old thought"])
        self.assertEqual(store.list_notes(second["id"]), [])

    def test_notes_and_tasks_are_private_to_each_account(self) -> None:
        store = EchoStore(self.path)
        owner = store.create_user("Owner", "owner@example.com", "password one")
        other = store.create_user("Other", "other@example.com", "password two")
        note = store.add_note(owner["id"], "Private plans", title="Plans", tags=["personal"])
        self.assertEqual(store.list_notes(other["id"]), [])
        self.assertIsNone(store.update_note(other["id"], note["id"], text="Hijacked"))
        self.assertFalse(store.delete_note(other["id"], note["id"]))
        task = store.add_tasks(other["id"], [{"text": "Sneaky", "note_id": note["id"]}])[0]
        self.assertIsNone(task["note_id"])

        updated = store.append_to_note(owner["id"], note["id"], "More detail", max_chars=1000)
        self.assertEqual(updated["text"], "Private plans\n\nMore detail")
        done = store.update_task(other["id"], task["id"], done=True)
        self.assertTrue(done["done"])
        self.assertIsNotNone(done["completed_at"])

    def test_starter_content_fills_a_new_studio(self) -> None:
        store = EchoStore(self.path)
        user = store.create_user("New", "new@example.com", "password one")
        store.seed_starter_content(user["id"])
        notes = store.list_notes(user["id"])
        self.assertEqual({note["title"] for note in notes}, {"Welcome to Echo", "Shopping list", "Ideas"})
        self.assertTrue(next(note for note in notes if note["title"] == "Welcome to Echo")["pinned"])
        self.assertEqual(len(store.list_tasks(user["id"])), 3)


class FakeClaude:
    available = True

    def describe(self) -> dict:
        return {"engine": "claude", "model": "test-model", "sdk_installed": True}

    def polish(self, text: str) -> dict:
        return {"text": text.upper(), "changes": [{"kind": "capital", "from": text, "to": text.upper()}]}

    def chat(self, message: str, *, history: list, context: str) -> str:
        return "Paris is the capital of France."


class ClaudeEngineTests(unittest.TestCase):
    def test_engine_stays_local_without_credentials(self) -> None:
        self.assertFalse(claude_engine.ClaudeEngine(mode="local").available)
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": ""}):
            self.assertFalse(claude_engine.ClaudeEngine(mode="auto").available)

    def test_polish_requests_structured_output_and_falls_back_on_refusal(self) -> None:
        if claude_engine.anthropic is None:
            self.skipTest("The optional anthropic package is not installed.")
        engine = claude_engine.ClaudeEngine(mode="claude")
        client = mock.Mock()
        client.beta.messages.create.return_value = SimpleNamespace(
            stop_reason="end_turn",
            content=[
                SimpleNamespace(type="thinking", thinking=""),
                SimpleNamespace(type="text", text=json.dumps(
                    {"text": "Hello, world.", "changes": [{"kind": "punctuation", "from": "hello", "to": "Hello,"}]}
                )),
            ],
        )
        engine._client = client
        self.assertEqual(engine.polish("hello world")["text"], "Hello, world.")
        request = client.beta.messages.create.call_args.kwargs
        self.assertEqual(request["model"], claude_engine.MODEL)
        self.assertEqual(request["output_config"]["format"]["type"], "json_schema")
        self.assertEqual(request["extra_body"], {"fallbacks": "default"})

        client.beta.messages.create.return_value = SimpleNamespace(stop_reason="refusal", content=[])
        self.assertIsNone(engine.polish("hello world"))


class HttpTests(unittest.TestCase):
    emails = itertools.count(1)

    @classmethod
    def setUpClass(cls) -> None:
        cls.quiet_log = mock.patch.object(AssistantHandler, "log_message", lambda *args: None)
        cls.quiet_log.start()
        cls.directory = tempfile.TemporaryDirectory()
        cls.store = EchoStore(Path(cls.directory.name) / "http.sqlite3")
        AssistantHandler.store = cls.store
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), AssistantHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.directory.cleanup()
        cls.quiet_log.stop()

    def setUp(self) -> None:
        AssistantHandler._failed_logins.clear()
        self.opener = self.new_browser()

    @staticmethod
    def new_browser() -> urllib.request.OpenerDirector:
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, method: str, path: str, payload: object = None, *, headers: dict | None = None,
                opener: urllib.request.OpenerDirector | None = None, raw: bytes | None = None):
        data = raw if raw is not None else json.dumps(payload).encode("utf-8") if payload is not None else None
        request_headers = {"Content-Type": "application/json"} if data is not None else {}
        request_headers.update(headers or {})
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=request_headers, method=method)
        try:
            response = (opener or self.opener).open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            content_type = response.headers.get("Content-Type", "")
            result = json.loads(body) if body and "json" in content_type else body.decode("utf-8") if body else None
            return response.status, result, response.headers

    def register(self, opener: urllib.request.OpenerDirector | None = None, **fields: object) -> dict:
        payload = {"name": "Asha Rao", "email": f"user{next(self.emails)}@example.com", "password": "correct horse"}
        payload.update(fields)
        status, body, _ = self.request("POST", "/api/auth/register", payload, opener=opener)
        self.assertEqual(status, 201, body)
        return {**body["user"], "password": payload["password"]}

    def test_app_assets_and_security_headers_are_served(self) -> None:
        status, page, headers = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("Echo Studio", page)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(headers["Permissions-Policy"], "microphone=(self)")
        for path, content_type in (("/styles.css", "text/css"), ("/js/main.js", "text/javascript"), ("/icon.svg", "image/svg+xml")):
            with self.subTest(path=path):
                asset_status, _, asset_headers = self.request("GET", path)
                self.assertEqual(asset_status, 200)
                self.assertTrue(asset_headers["Content-Type"].startswith(content_type))
        self.assertEqual(self.request("GET", "/../app.py")[0], 404)
        self.assertEqual(self.request("GET", "/missing.js")[0], 404)

    def test_api_requires_a_signed_in_account(self) -> None:
        self.assertEqual(self.request("GET", "/api/notes")[0], 401)
        self.assertEqual(self.request("POST", "/api/command", {"text": "hello"})[0], 401)
        self.assertEqual(self.request("GET", "/api/health")[0], 200)

    def test_register_login_logout_records_every_sign_in(self) -> None:
        user = self.register()
        status, me, _ = self.request("GET", "/api/auth/me")
        self.assertEqual((status, me["user"]["email"]), (200, user["email"]))
        self.assertEqual(len(self.request("GET", "/api/notes")[1]["notes"]), 3)

        self.assertEqual(self.request("POST", "/api/auth/logout", {})[0], 204)
        self.assertEqual(self.request("GET", "/api/auth/me")[:2], (200, {"user": None}))
        self.assertEqual(self.request("GET", "/api/notes")[0], 401)
        status, failed, _ = self.request("POST", "/api/auth/login", {"email": user["email"], "password": "not it"})
        self.assertEqual((status, failed["field"]), (401, "password"))
        status, _, headers = self.request("POST", "/api/auth/login", {"email": user["email"].upper(), "password": "correct horse"})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])

        status, activity, _ = self.request("GET", "/api/auth/activity")
        self.assertEqual(status, 200)
        self.assertEqual([event["event"] for event in activity["events"]], ["login", "failed", "logout", "register"])
        self.assertEqual(activity["events"][0]["ip"], "127.0.0.1")
        self.assertEqual(activity["counts"]["failed"], 1)

    def test_registration_validation_and_duplicates(self) -> None:
        user = self.register()
        status, body, _ = self.request("POST", "/api/auth/register", {"name": "Twin", "email": user["email"], "password": "long enough"})
        self.assertEqual((status, body["field"]), (409, "email"))
        status, body, _ = self.request("POST", "/api/auth/register", {"name": "A", "email": "not-an-email", "password": "long enough"})
        self.assertEqual((status, body["field"]), (400, "email"))
        status, body, _ = self.request("POST", "/api/auth/register", {"name": "A", "email": "a@example.com", "password": "short"})
        self.assertEqual((status, body["field"]), (400, "password"))

    def test_repeated_failed_sign_ins_are_slowed_down(self) -> None:
        user = self.register(opener=self.new_browser())
        for _ in range(8):
            self.assertEqual(self.request("POST", "/api/auth/login", {"email": user["email"], "password": "guess"})[0], 401)
        self.assertEqual(self.request("POST", "/api/auth/login", {"email": user["email"], "password": "correct horse"})[0], 429)

    def test_notes_can_be_created_edited_appended_and_deleted(self) -> None:
        self.register()
        status, created, _ = self.request("POST", "/api/notes", {"text": "Buy pasta, olive oil and parmesan."})
        self.assertEqual(status, 201)
        note = created["note"]
        self.assertEqual((note["title"], note["tags"]), ("Shopping list", ["shopping"]))

        status, updated, _ = self.request("PUT", f"/api/notes/{note['id']}", {"title": "Dinner party", "pinned": True, "tags": ["#Food", "food"]})
        self.assertEqual((status, updated["note"]["title"], updated["note"]["pinned"], updated["note"]["tags"]), (200, "Dinner party", True, ["food"]))
        status, appended, _ = self.request("POST", f"/api/notes/{note['id']}/append", {"text": "Also candles."})
        self.assertEqual((status, appended["note"]["text"]), (200, "Buy pasta, olive oil and parmesan.\n\nAlso candles."))

        status, body, _ = self.request("POST", "/api/notes", {"text": "x" * 20_001})
        self.assertEqual(status, 400)
        self.assertIn("20,000", body["error"])
        self.assertEqual(self.request("DELETE", f"/api/notes/{note['id']}")[0], 204)
        status, missing, _ = self.request("DELETE", f"/api/notes/{note['id']}")
        self.assertEqual((status, missing["error"]), (404, "Note not found."))

    def test_accounts_cannot_touch_each_others_notes(self) -> None:
        self.register()
        note = self.request("POST", "/api/notes", {"text": "My private diary entry."})[1]["note"]
        stranger = self.new_browser()
        self.register(opener=stranger)
        self.assertEqual(self.request("PUT", f"/api/notes/{note['id']}", {"text": "Hacked"}, opener=stranger)[0], 404)
        self.assertEqual(self.request("DELETE", f"/api/notes/{note['id']}", opener=stranger)[0], 404)
        stranger_notes = self.request("GET", "/api/notes", opener=stranger)[1]["notes"]
        self.assertNotIn(note["id"], [item["id"] for item in stranger_notes])

    def test_tasks_understand_natural_language_due_times(self) -> None:
        self.register()
        status, created, _ = self.request("POST", "/api/tasks", {"text": "call mom tomorrow at 6 pm", "parse": True})
        self.assertEqual(status, 201)
        task = created["tasks"][0]
        due = brain.parse_iso(task["due_at"])
        self.assertEqual(task["text"], "Call mom")
        self.assertEqual((due.hour, due.minute), (18, 0))
        self.assertEqual(due.date(), (datetime.now() + timedelta(days=1)).date())

        status, updated, _ = self.request("PUT", f"/api/tasks/{task['id']}", {"done": True, "notified": True})
        self.assertEqual(status, 200)
        self.assertTrue(updated["task"]["done"])
        self.assertIsNotNone(updated["task"]["notified_at"])
        self.assertEqual(self.request("DELETE", f"/api/tasks/{task['id']}")[0], 204)
        self.assertEqual(self.request("PUT", f"/api/tasks/{task['id']}", {"done": False})[0], 404)

    def test_assistant_commands_create_tasks_append_notes_and_suggest(self) -> None:
        self.register()
        status, body, _ = self.request("POST", "/api/command", {"text": "calculate 24 times 6"})
        self.assertEqual((status, body["reply"]), (200, "The answer is 144."))

        body = self.request("POST", "/api/command", {"text": "remind me to stretch in 20 minutes"})[1]
        self.assertEqual(body["action"]["type"], "tasks_created")
        self.assertIn("id", body["action"]["tasks"][0])

        body = self.request("POST", "/api/command", {"text": "add oat milk to my shopping list"})[1]
        self.assertEqual(body["action"]["type"], "note_appended")
        self.assertTrue(body["action"]["note"]["text"].endswith("Oat milk"))
        self.assertNotIn("Oat milk", body["action"]["previous_text"])

        body = self.request("POST", "/api/command", {"text": "take a note that the wifi password is on the fridge"})[1]
        self.assertEqual(body["action"]["type"], "suggest_note")
        self.assertEqual(body["action"]["analysis"]["title"], "Wifi password")
        self.assertEqual(body["action"]["polished"]["text"], "The wifi password is on the fridge.")

    def test_polish_and_analyze_endpoints(self) -> None:
        self.register()
        status, polished, _ = self.request("POST", "/api/ai/polish", {"text": "i recieve alot of email", "lang": "en-US"})
        self.assertEqual((status, polished["text"], polished["engine"]), (200, "I receive a lot of email.", "local"))
        status, analysis, _ = self.request("POST", "/api/ai/analyze", {"text": "grab bread and cheese"})
        self.assertEqual(status, 200)
        self.assertEqual(analysis["recommendation"]["action"], "append")
        self.assertEqual(analysis["recommendation"]["title"], "Shopping list")

    def test_claude_engine_is_used_when_available(self) -> None:
        self.register()
        with mock.patch.object(AssistantHandler, "ai", FakeClaude()):
            polished = self.request("POST", "/api/ai/polish", {"text": "hello"})[1]
            self.assertEqual((polished["text"], polished["engine"], polished["summary"]), ("HELLO", "claude", ["capitalized 1 word"]))
            reply = self.request("POST", "/api/command", {"text": "what is the capital of France"})[1]
            self.assertEqual((reply["reply"], reply["engine"]), ("Paris is the capital of France.", "claude"))
            self.assertEqual(self.request("GET", "/api/health")[1]["ai"]["engine"], "claude")

    def test_requests_must_be_json_and_addressed_to_this_computer(self) -> None:
        self.register()
        status, body, _ = self.request("POST", "/api/notes", raw=b"text=hi", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, body, _ = self.request("GET", "/api/health", headers={"Host": "evil.example"})
        self.assertEqual(status, 421)
        self.assertEqual(self.request("PATCH", "/api/notes/1", {"text": "x"})[0], 405)


class BrowserBridgeTests(unittest.TestCase):
    """The GitHub Pages build runs the same handler in the browser through browser_bridge."""

    @staticmethod
    def call(method: str, path: str, headers: dict, body: str = "") -> tuple[str, dict]:
        import browser_bridge

        head, _, payload = browser_bridge.handle(method, path, json.dumps(headers), body).partition("\r\n\r\n")
        return head, json.loads(payload)

    def test_the_api_answers_without_a_socket(self) -> None:
        with mock.patch.dict(os.environ), mock.patch.object(AssistantHandler, "store", None, create=True), \
                tempfile.TemporaryDirectory() as directory:
            import browser_bridge

            browser_bridge.start(str(Path(directory) / "browser.sqlite3"))
            account = {"name": "Asha Rao", "email": "asha@example.com", "password": "correct horse"}
            headers = {"Host": "127.0.0.1", "Content-Type": "application/json"}
            head, body = self.call("POST", "/api/auth/register", headers, json.dumps(account))
            self.assertEqual(head.split(" ")[1], "201", head)
            self.assertEqual(body["user"]["email"], "asha@example.com")

            token = re.search(r"Set-Cookie: echo_session=([^;]+)", head).group(1)
            head, body = self.call("GET", "/api/auth/me", {"Host": "127.0.0.1", "Cookie": f"echo_session={token}"})
            self.assertEqual(head.split(" ")[1], "200", head)
            self.assertEqual(body["user"]["name"], "Asha Rao")


class FrontendConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.page = (WEB / "index.html").read_text(encoding="utf-8")
        cls.parser = DocumentInspector()
        cls.parser.feed(cls.page)
        cls.scripts = {path.name: path.read_text(encoding="utf-8") for path in sorted((WEB / "js").glob("*.js"))}

    def test_ids_are_unique_and_labels_resolve(self) -> None:
        ids = self.parser.ids
        self.assertEqual(len(ids), len(set(ids)), "HTML element IDs must be unique")
        self.assertTrue(self.parser.label_targets <= set(ids), self.parser.label_targets - set(ids))

    def test_scripts_only_reference_elements_and_icons_that_exist(self) -> None:
        ids = set(self.parser.ids)
        for name, script in self.scripts.items():
            with self.subTest(script=name):
                referenced = set(re.findall(r'\belement\("([^"]+)"\)', script))
                self.assertTrue(referenced <= ids, f"{name} needs missing elements: {referenced - ids}")
                icons = set(re.findall(r'\bicon\("([a-z-]+)"', script))
                self.assertTrue(icons <= {i[5:] for i in ids if i.startswith("icon-")}, f"{name} uses missing icons: {icons}")
        self.assertTrue(
            self.parser.icon_references <= {i[5:] for i in ids if i.startswith("icon-")},
            "Every <use href='#icon-…'> needs a matching symbol",
        )

    def test_every_navigation_target_has_a_view(self) -> None:
        for view in self.parser.views:
            with self.subTest(view=view):
                self.assertIn(f'id="{view}-view"', self.page)
        self.assertIn("Passwords are hashed", self.page)


if __name__ == "__main__":
    unittest.main()
