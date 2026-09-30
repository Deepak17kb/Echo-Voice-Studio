"""Echo's on-device language engine.

Grammar polish, note matching, topic and mood detection, to-do extraction with
natural-language due dates, and the assistant's conversational replies. Everything
here is deterministic (apart from the odd joke), dependency-free, and runs on this
computer.
"""

from __future__ import annotations

import ast
import math
import operator
import random
import re
from collections import Counter
from datetime import datetime, time, timedelta
from typing import Callable, Iterable, Iterator, Mapping, Sequence


# --------------------------------------------------------------------------- arithmetic

_BINARY_OPERATORS: dict[type[ast.operator], Callable] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPERATORS: dict[type[ast.unaryop], Callable] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}


def _evaluate_expression(node: ast.expr) -> int | float:
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        value = node.value
    elif isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPERATORS:
        left = _evaluate_expression(node.left)
        right = _evaluate_expression(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > 6:
            raise ValueError("Powers are limited to keep calculations sensible.")
        value = _BINARY_OPERATORS[type(node.op)](left, right)
    elif isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPERATORS:
        value = _UNARY_OPERATORS[type(node.op)](_evaluate_expression(node.operand))
    else:
        raise ValueError("That expression is not supported.")

    if not math.isfinite(value) or abs(value) > 1_000_000_000_000:
        raise ValueError("That result is too large to handle.")
    return value


def calculate(expression: str) -> int | float:
    """Evaluate basic arithmetic without exposing Python execution."""
    if len(expression) > 120:
        raise ValueError("That expression is too long.")
    tree = ast.parse(expression, mode="eval")
    return _evaluate_expression(tree.body)


# --------------------------------------------------------------------------- text basics

_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:'[A-Za-z]+)?")


def words(text: str) -> list[str]:
    return _WORD_RE.findall(text)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold()).strip(" .!?,;:\t\n")


def _aware(now: datetime | None) -> datetime:
    now = now or datetime.now().astimezone()
    return now if now.tzinfo else now.astimezone()


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.astimezone()


def format_clock(moment: datetime) -> str:
    return moment.strftime("%I:%M %p").lstrip("0")


def format_due(due: datetime, now: datetime | None = None) -> str:
    now = _aware(now)
    due = due.astimezone(now.tzinfo)
    clock = format_clock(due)
    days = (due.date() - now.date()).days
    if days == 0:
        return f"today at {clock}"
    if days == 1:
        return f"tomorrow at {clock}"
    if days == -1:
        return f"yesterday at {clock}"
    if 1 < days < 7:
        return f"on {due:%A} at {clock}"
    return f"on {due:%b} {due.day} at {clock}"


def join_words(items: Sequence[str], conjunction: str = "and") -> str:
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} {conjunction} {items[-1]}"


# --------------------------------------------------------------------------- keywords

_STOPWORDS = frozenset(
    """
    a about above after again against all almost also am an and any anyone are around as at
    be because been before being below between both but by can cannot could did do does doing
    done down during each else even ever every few for from further get gets getting go going
    gonna got had has have having he her here hers herself him himself his how i if im in into
    is it its itself just keep kind know let like lot lots made make many may maybe me might
    more most much must my myself need needs never no nor not now of off oh ok okay on once one
    only or other our ours ourselves out over own please pretty put quite rather really said
    same say see she should so some something still such sure take than that the their theirs
    them themselves then there these they thing things think this those though through to
    today tomorrow tonight too um uh under until up us very want was way we well went were what
    when where which while who whom why will with would yeah yes yet you your yours yourself
    yourselves remind reminder remember note notes dont cant wont ive id ill
    """.split()
)


def _undouble(word: str) -> str:
    if len(word) > 2 and word[-1] == word[-2] and word[-1] not in "lsz":
        return word[:-1]
    return word


def stem(word: str) -> str:
    """A small suffix stripper, just enough to match "groceries" with "grocery"."""
    word = word.lower()
    if word.endswith("'s"):
        word = word[:-2]
    for _ in range(2):
        if len(word) > 4 and word.endswith("ies"):
            word = word[:-3] + "y"
        elif len(word) > 5 and word.endswith("ing"):
            word = _undouble(word[:-3])
        elif len(word) > 4 and word.endswith("ed") and not word.endswith("eed"):
            word = _undouble(word[:-2])
        elif len(word) > 4 and word.endswith(("sses", "shes", "ches", "xes", "zes")):
            word = word[:-2]
        elif len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is")):
            word = word[:-1]
        else:
            break
    if len(word) > 3 and word.endswith("e"):
        word = word[:-1]  # so "hike" and "hiking" meet at "hik"
    return word


def keywords(text: str) -> list[str]:
    return [
        stem(word)
        for word in words(text.casefold())
        if len(word) > 2 and word not in _STOPWORDS and not word.isdigit()
    ]


# --------------------------------------------------------------------------- topics and mood

TOPICS: dict[str, frozenset[str]] = {
    topic: frozenset(stem(word) for word in vocabulary.split())
    for topic, vocabulary in {
        "shopping": "buy grocery groceries milk egg bread store shop shopping market purchase "
        "vegetable fruit amazon cart supermarket butter cheese coffee rice sugar apple banana "
        "onion tomato soap shampoo snack flour oil juice tea basil pasta",
        "work": "meeting project deadline client boss office report email presentation team "
        "manager sprint colleague standup review proposal slide interview work job agenda "
        "conference quarter launch",
        "ideas": "idea concept brainstorm imagine invent startup design podcast prototype "
        "experiment creative inspiration vision",
        "health": "gym workout run doctor medicine sleep water exercise diet yoga health "
        "meditation dentist walk steps vitamin therapy stretch hospital",
        "study": "exam study class lecture homework assignment chapter learn course college "
        "school revise revision syllabus test quiz professor semester research essay",
        "finance": "pay bill rent money bank budget salary invoice expense saving loan tax emi "
        "insurance credit payment price cost fee subscription",
        "personal": "mom mum dad mother father family friend birthday home party wife husband "
        "kid son daughter brother sister anniversary gift love wedding grandma grandpa",
        "travel": "trip flight hotel travel visit train ticket pack packing vacation holiday "
        "booking airport passport luggage beach itinerary tour",
    }.items()
}


def topic_scores(text: str) -> Counter:
    scores: Counter = Counter()
    for token in (stem(word) for word in words(text.casefold())):
        for topic, vocabulary in TOPICS.items():
            if token in vocabulary:
                scores[topic] += 1
    if re.search(r"\bwhat if\b|\bmaybe we could\b", text, re.I):
        scores["ideas"] += 1
    return scores


def detect_tags(text: str, limit: int = 2) -> list[str]:
    ranked = sorted(topic_scores(text).items(), key=lambda item: (-item[1], list(TOPICS).index(item[0])))
    return [topic for topic, _ in ranked[:limit]]


_POSITIVE = frozenset(
    stem(word)
    for word in "happy great love excited awesome good wonderful amazing grateful thankful glad "
    "fantastic nice fun proud enjoy beautiful perfect yay brilliant delighted relaxed peaceful "
    "win success celebrate smile laugh".split()
)
_NEGATIVE = frozenset(
    stem(word)
    for word in "sad angry tired stressed stress worried worry anxious bad hate upset annoyed "
    "frustrated exhausted terrible awful sick lonely overwhelmed scared afraid nervous cry hurt "
    "pain problem fail failed disappointed".split()
)
_NEGATORS = frozenset("not never no don't didn't isn't wasn't aren't can't won't hardly".split())


def detect_mood(text: str) -> str:
    """Return "upbeat", "heavy", or "neutral" from a tiny sentiment lexicon."""
    tokens = [word.casefold() for word in words(text)]
    score = 0
    for index, token in enumerate(tokens):
        root = stem(token)
        value = 1 if root in _POSITIVE else -1 if root in _NEGATIVE else 0
        if value and any(previous in _NEGATORS for previous in tokens[max(0, index - 2):index]):
            value = -value
        score += value
    if score > 0:
        return "upbeat"
    if score < 0:
        return "heavy"
    return "neutral"


# --------------------------------------------------------------------------- titles

_LEAD_INS = re.compile(
    r"^(?:(?:ok(?:ay)?|so|um+|uh+|well|hey|hi|alright|right|and|also|please|just|"
    r"note(?: that)?|remember(?: that)?|remind me(?: to)?|i (?:need|have|want|got) to|"
    r"i think(?: that)?|we (?:need|have) to|we should|take a note(?: that)?|"
    r"write (?:this )?down)[\s,:;-]+)+",
    re.I,
)


_TITLE_VERBS = frozenset(
    "is are was were will has have had moved needs need should can could might starts ends got "
    "gets costs went goes looks seems feels opens closes".split()
)
_TITLE_DETERMINERS = frozenset("the a an my our your their this that".split())
_PRONOUNS = frozenset("i we you they he she it this that there".split())


def suggest_title(text: str, tags: Sequence[str] = ()) -> str:
    first = re.split(r"(?<=[.!?])\s+|\n+", text.strip(), maxsplit=1)[0]
    first = _REPEAT_RE.sub(lambda match: match.group(1), _FILLER_RE.sub(" ", first))
    first = _LEAD_INS.sub("", re.sub(r"\s+", " ", first).strip()).strip(" .,!?;:-")
    tokens = first.split()
    if tags and tags[0] == "shopping" and (
        len(tokens) <= 2 or "," in first or re.match(r"(?i)(?:buy|get|pick up)\b", first)
    ):
        return "Shopping list"
    if not tokens:
        return f"{tags[0].title()} note" if tags else "Quick note"
    # "The wifi password is on the fridge" -> "Wifi password"
    lowered = [token.lower().strip(",;:") for token in tokens]
    verb = next((index for index, token in enumerate(lowered[:7]) if token in _TITLE_VERBS), None)
    if verb and lowered[0] not in _PRONOUNS:
        subject = tokens[:verb]
        while subject and subject[0].lower() in _TITLE_DETERMINERS:
            subject = subject[1:]
        if 1 <= len(subject) <= 5:
            title = " ".join(subject).rstrip(",;:")
            return (title[:1].upper() + title[1:])[:80]
    title = " ".join(tokens[:6]).rstrip(",;:")
    if len(tokens) > 6:
        title += "…"
    return (title[:1].upper() + title[1:])[:80]


# --------------------------------------------------------------------------- note matching

APPEND_THRESHOLD = 0.18


def rank_notes(text: str, notes: Iterable[Mapping], limit: int = 3) -> list[dict]:
    """Rank existing notes by TF-IDF similarity plus a bonus for sharing a topic."""
    notes = list(notes)
    query_words = [word for word in words(text.casefold()) if len(word) > 2 and word not in _STOPWORDS]
    query = Counter(stem(word) for word in query_words if not word.isdigit())
    if not query or not notes:
        return []

    originals: dict[str, str] = {}
    for word in query_words:
        originals.setdefault(stem(word), word)

    documents = []
    for note in notes:
        tags = note.get("tags") or []
        document = Counter(keywords(note.get("text", "")))
        for token in keywords(f"{note.get('title', '')} {' '.join(tags)}"):
            document[token] += 2
        documents.append(document)

    frequency: Counter = Counter()
    for document in [*documents, query]:
        frequency.update(set(document))
    total = len(documents) + 1
    idf = {term: math.log((total + 1) / (count + 0.5)) + 1 for term, count in frequency.items()}

    def weigh(counts: Counter) -> dict[str, float]:
        return {term: (1 + math.log(count)) * idf[term] for term, count in counts.items()}

    query_vector = weigh(query)
    query_norm = math.sqrt(sum(value * value for value in query_vector.values()))
    query_topics = detect_tags(text, limit=3)

    ranked = []
    for note, document in zip(notes, documents):
        vector = weigh(document)
        norm = math.sqrt(sum(value * value for value in vector.values())) or 1.0
        contributions = {
            term: query_vector[term] * vector[term] for term in query_vector if term in vector
        }
        score = sum(contributions.values()) / (query_norm * norm)
        shared_count = len(contributions)
        if shared_count >= 2:
            # How much of the new thought this note already covers; long notes dilute cosine.
            coverage = sum(query_vector[term] for term in contributions) / sum(query_vector.values())
            score = max(score, 0.6 * coverage, 0.55 * shared_count / len(query_vector))
        # Several specific words in common is strong evidence; longer notes must share more.
        needed = 3 if len(document) <= 60 else 4 if len(document) <= 150 else 5
        if shared_count >= needed:
            score = max(score, APPEND_THRESHOLD + 0.01 + 0.03 * (shared_count - needed))

        note_topics = list(note.get("tags") or []) or detect_tags(note.get("text", ""))
        topic = ""
        if query_topics and query_topics[0] in note_topics:
            topic = query_topics[0]
            score += 0.25
        elif any(candidate in note_topics for candidate in query_topics):
            topic = next(candidate for candidate in query_topics if candidate in note_topics)
            score += 0.05

        shared = [
            originals.get(term, term)
            for term, _ in sorted(contributions.items(), key=lambda item: -item[1])[:3]
        ]
        if score <= 0:
            continue
        ranked.append(
            {
                "note_id": note.get("id"),
                "title": note.get("title") or suggest_title(note.get("text", "")),
                "score": round(score, 3),
                "confidence": max(1, min(99, round(100 * (1 - math.exp(-score * 4.2))))),
                "shared": shared,
                "topic": topic,
                "reason": _match_reason(shared, topic),
            }
        )
    ranked.sort(key=lambda item: -item["score"])
    return ranked[:limit]


def _match_reason(shared: Sequence[str], topic: str) -> str:
    quoted = [f"“{word}”" for word in shared]
    if quoted and topic:
        return f"shares {join_words(quoted)} and the {topic} topic"
    if quoted:
        return f"shares {join_words(quoted)}"
    if topic:
        return f"it's on the same topic ({topic})"
    return "it looks loosely related"


# --------------------------------------------------------------------------- due dates

_NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15,
    "twenty": 20, "thirty": 30, "forty": 40, "forty-five": 45, "forty five": 45, "sixty": 60,
    "ninety": 90, "a couple of": 2, "a few": 3, "half an": 0.5, "half a": 0.5,
}
_NUMBER = (
    r"(?:\d{1,3}(?:\.\d+)?|a couple of|a few|half an?|an?|one|two|three|four|five|six|seven|"
    r"eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty[- ]five|forty|sixty|ninety)"
)
_HOUR = r"(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_PART_TIMES = {"morning": (9, 0), "afternoon": (14, 0), "evening": (18, 0), "night": (20, 0)}

_RELATIVE_RE = re.compile(
    rf"\b(?:in|after|within)\s+({_NUMBER})\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b(?:\s+from now)?",
    re.I,
)
_DAY_RE = re.compile(
    r"(?:\b(?:on|this|next|by|until|till|for|coming)\s+)?\b(day after tomorrow|tomorrow|tmrw|today|"
    r"tonight|this weekend|weekend|next week|monday|tuesday|wednesday|thursday|friday|saturday|"
    r"sunday)\b(?:\s+(morning|afternoon|evening|night))?",
    re.I,
)
_PART_RE = re.compile(r"\b(?:this|in the|at|during the)\s+(morning|afternoon|evening|night)\b", re.I)
_TIME_AMPM_RE = re.compile(rf"(?:\b(?:at|by|around|before)\s+|@\s*)?\b{_HOUR}(?:[:.](\d{{2}}))?\s*([ap])m\b", re.I)
_TIME_24_RE = re.compile(r"(?:\b(?:at|by|around|before)\s+)?\b(\d{1,2}):(\d{2})\b", re.I)
_TIME_NAMED_RE = re.compile(r"(?:\b(?:at|by|around|before)\s+)?\b(noon|midday|midnight)\b", re.I)
_TIME_AT_RE = re.compile(
    rf"\b(?:at|by|around|before)\s+{_HOUR}(?:[:.](\d{{2}}))?(?:\s*o'?\s?clock)?\b"
    r"(?!\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|percent|%|people|persons|"
    r"items?|kg|km|miles?|dollars?|rupees?|euros?|times?|pages?|things?)\b)",
    re.I,
)
_OCLOCK_RE = re.compile(rf"\b{_HOUR}\s*o'?\s?clock\b", re.I)


def _amount(value: str) -> float:
    key = re.sub(r"\s+", " ", value.lower())
    return _NUMBER_WORDS[key] if key in _NUMBER_WORDS else float(key)


def _hour_value(value: str) -> int:
    return int(value) if value.isdigit() else int(_NUMBER_WORDS[value.lower()])


def _cut(text: str, match: re.Match) -> str:
    return f"{text[:match.start()]} {text[match.end():]}"


def _tidy(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip(" \t,;:-")
    return re.sub(r"(?:\s+(?:at|on|by|in|for|this|next|around|before|until|till))+$", "", text, flags=re.I).strip()


def _read_time(regex: re.Pattern, match: re.Match) -> tuple[int, int, bool] | None:
    if regex is _TIME_NAMED_RE:
        return (23, 59, True) if match.group(1).lower() == "midnight" else (12, 0, True)
    hour = _hour_value(match.group(1))
    minute = int(match.group(2)) if regex is not _OCLOCK_RE and match.group(2) else 0
    explicit = False
    if regex is _TIME_AMPM_RE:
        if hour > 12:
            return None
        meridiem = match.group(3).lower()
        if meridiem == "p" and hour < 12:
            hour += 12
        elif meridiem == "a" and hour == 12:
            hour = 0
        explicit = True
    elif hour >= 13 or (regex is _TIME_24_RE and hour == 0):
        explicit = True
    if hour > 23 or minute > 59:
        return None
    return hour, minute, explicit


def parse_due(text: str, now: datetime | None = None) -> tuple[str, datetime | None]:
    """Find a natural-language due time ("tomorrow at 5 pm", "in 20 minutes") in text.

    Returns the text with the time phrase removed, and the due moment (or None).
    """
    now = _aware(now)
    work = re.sub(r"(?i)\b([ap])\.\s?m\b\.?", r"\1m", text)

    match = _RELATIVE_RE.search(work)
    if match:
        amount = _amount(match.group(1))
        unit = match.group(2).lower()
        if unit.startswith("min"):
            delta = timedelta(minutes=amount)
        elif unit.startswith(("hour", "hr")):
            delta = timedelta(hours=amount)
        elif unit.startswith("day"):
            delta = timedelta(days=amount)
        else:
            delta = timedelta(weeks=amount)
        return _tidy(_cut(work, match)), (now + delta).replace(second=0, microsecond=0)

    found = False
    day_offset: int | None = None
    weekday_named = False
    part: str | None = None

    match = _DAY_RE.search(work)
    if match:
        word = match.group(1).lower()
        part = (match.group(2) or "").lower() or None
        if word == "today":
            day_offset = 0
        elif word == "tonight":
            day_offset, part = 0, part or "night"
        elif word in ("tomorrow", "tmrw"):
            day_offset = 1
        elif word == "day after tomorrow":
            day_offset = 2
        elif word == "next week":
            day_offset = 7
        elif word.endswith("weekend"):
            day_offset = (5 - now.weekday()) % 7
        else:
            day_offset = (_WEEKDAYS.index(word) - now.weekday()) % 7
            weekday_named = True
        work, found = _cut(work, match), True

    match = _PART_RE.search(work)
    if match:
        part = part or match.group(1).lower()
        work, found = _cut(work, match), True

    hour: int | None = None
    minute = 0
    explicit = False
    for regex in (_TIME_AMPM_RE, _TIME_24_RE, _TIME_NAMED_RE, _TIME_AT_RE, _OCLOCK_RE):
        match = regex.search(work)
        if match is None:
            continue
        reading = _read_time(regex, match)
        if reading is None:
            continue
        hour, minute, explicit = reading
        work, found = _cut(work, match), True
        break

    if not found:
        return text, None

    if hour is not None and not explicit:
        if part in ("afternoon", "evening", "night") and hour < 12:
            hour += 12
        elif part != "morning" and 1 <= hour <= 7:
            hour += 12

    base = now.date() + timedelta(days=day_offset or 0)
    if hour is None:
        if part:
            hour, minute = _PART_TIMES[part]
        elif day_offset == 0:
            if now.hour < 17:
                hour, minute = 18, 0
            else:
                soon = now + timedelta(hours=1)
                return _tidy(work), soon.replace(minute=soon.minute - soon.minute % 5, second=0, microsecond=0)
        else:
            hour, minute = 9, 0

    if day_offset is None and datetime.combine(base, time(hour, minute)).astimezone() <= now:
        base += timedelta(days=1)
    elif weekday_named and day_offset == 0 and datetime.combine(base, time(hour, minute)).astimezone() <= now:
        base += timedelta(days=7)
    # Build the wall-clock time in local time so dates across a DST change stay right.
    return _tidy(work), datetime.combine(base, time(hour, minute)).astimezone()


# --------------------------------------------------------------------------- to-do extraction

_IMPERATIVES = (
    "buy|call|email|e-mail|text|message|send|pay|book|finish|submit|pick up|schedule|clean|fix|"
    "order|renew|return|write|prepare|check|cancel|complete|review|visit|water|feed|wash|cook|"
    "get|grab|meet|reply|ring|drop off|collect|print|sign|file|study|practice|practise|read|"
    "take|bring|update|organize|organise|plan|ask|tell|invite|confirm|register|apply|charge|"
    "empty|pack|post|mail|sort|walk|go to|call back|stretch|drink"
)
_TASK_TRIGGER_RE = re.compile(
    r"\b(?:remind me (?:to|about|that i (?:need|have) to)|(?:don't|do not|dont) forget(?: to)?|"
    r"(?:i|we) (?:really |still |also )?(?:need|have|ought) to|(?:i|we) (?:must|should|gotta)|"
    r"make sure (?:to|i|we)|remember to|(?:to-?do|todo)\s*:?)\s+",
    re.I,
)
_REMIND_AT_RE = re.compile(
    r"\bremind me\s+((?:at|in|on|by|tomorrow|today|tonight|this|next)\b.*?)\s+to\s+(.+)", re.I
)
_ADD_TO_TASKS_RE = re.compile(
    r"\badd\s+(?P<body>.+?)\s+(?:to|on)\s+(?:my\s+|the\s+)?(?:to-?do|todo|task|tasks|reminders?)(?:\s+list)?\b",
    re.I,
)
_SPLIT_TASKS_RE = re.compile(
    rf"(?:\s*,\s*(?:and\s+|then\s+)?|\s+(?:and|then|also)\s+(?:also\s+|then\s+)?)(?=(?:{_IMPERATIVES})\b)",
    re.I,
)
# Unpunctuated dictation runs clauses together; a to-do ends where the next thought begins
# ("renew my passport next week it was a long day"), unless another action follows.
_CLAUSE_END_RE = re.compile(
    r"\s+(?:because|since|so that|although|though|while|anyway|but)\s+"
    rf"|\s+(?:also|and then|then)(?:\s+|$)(?!(?:{_IMPERATIVES})\b)"
    r"|,\s+(?:which|because|since|but)\s+"
    r"|\s+(?=(?:it|this|that|there)\s+(?:was|is|were|are|'s|feels?|felt|looks?|seems?)\b)",
    re.I,
)
_IMPERATIVE_START_RE = re.compile(
    rf"^(?:(?:please|and|also|then|oh|ok(?:ay)?|so)[\s,]+)*(?:{_IMPERATIVES})\b", re.I
)
_TASK_LEAD_RE = re.compile(
    r"^(?:(?:to|that|please|also|just|really|probably|maybe|definitely|actually|still|quickly|"
    r"then|and)\s+)+",
    re.I,
)


def _sentences(text: str) -> Iterator[tuple[str, bool]]:
    for line in re.split(r"\n+", text):
        line = line.strip()
        if not line:
            continue
        bullet = re.match(r"^(?:[-•*]|\[\s?\]|\d+[.)])\s+", line)
        if bullet:
            yield line[bullet.end():], True
            continue
        for sentence in re.split(r"(?<=[.!?;])\s+", line):
            if sentence.strip():
                yield sentence.strip(), False


def _clean_task_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip(" \t,.;:!?-—")
    text = _TASK_LEAD_RE.sub("", text)
    text = re.sub(r"\s+(?:please|thanks|thank you|okay|ok)$", "", text, flags=re.I)
    text = text.strip(" \t,.;:!?-—")
    tokens = text.split()
    if not tokens or not re.search(r"[A-Za-z]{2,}", text):
        return ""
    if len(tokens) > 18:
        text = " ".join(tokens[:14]) + "…"
    return text[:1].upper() + text[1:]


def tasks_from_body(body: str, now: datetime | None = None) -> list[dict]:
    """Turn "buy milk and call mom at 5" into individual tasks with due times."""
    now = _aware(now)
    body = re.sub(r"(?i)\b([ap])\.\s?m\b\.?", r"\1m", body)
    body = _CLAUSE_END_RE.split(body, maxsplit=1)[0]
    items = []
    for piece in _SPLIT_TASKS_RE.split(body):
        if not piece or not piece.strip():
            continue
        cleaned, due = parse_due(piece, now)
        text = _clean_task_text(cleaned)
        if text:
            items.append({"text": text, "due": due})
    dues = [item["due"] for item in items if item["due"]]
    if len(dues) == 1:
        for item in items:
            item["due"] = item["due"] or dues[0]
    return [
        {"text": item["text"], "due_at": _iso(item["due"]) if item["due"] else None}
        for item in items
    ]


def extract_tasks(text: str, now: datetime | None = None, limit: int = 10) -> list[dict]:
    """Find to-dos in free text: "remind me to…", "I need to…", bullet lines, imperatives."""
    now = _aware(now)
    results: list[dict] = []
    seen: set[str] = set()
    normalized = re.sub(r"(?i)\b([ap])\.\s?m\b\.?", r"\1m", text)
    for sentence, is_bullet in _sentences(normalized):
        sentence = _REMIND_AT_RE.sub(r"remind me to \2 \1", sentence)
        bodies: list[str] = []
        triggers = list(_TASK_TRIGGER_RE.finditer(sentence))
        if triggers:
            for index, match in enumerate(triggers):
                end = triggers[index + 1].start() if index + 1 < len(triggers) else len(sentence)
                bodies.append(sentence[match.end():end])
        else:
            listed = _ADD_TO_TASKS_RE.search(sentence)
            if listed:
                bodies.append(listed.group("body"))
            elif is_bullet or (_IMPERATIVE_START_RE.match(sentence) and len(sentence.split()) <= 16):
                bodies.append(sentence)
        for body in bodies:
            for item in tasks_from_body(body, now):
                key = item["text"].casefold()
                if key not in seen:
                    seen.add(key)
                    results.append(item)
    return results[:limit]


# --------------------------------------------------------------------------- grammar polish

_URL_RE = re.compile(r"\b(?:https?://|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_FILLER_RE = re.compile(r"(?i)(?<![\w'-])(?:u+m+|u+h+m*|e+r+m+|h+m{2,}|m{2,})(?![\w'-])[,.]?[ \t]*")
_REPEAT_RE = re.compile(r"(?i)\b([a-z']+)((?:\s+\1\b)+)")
_REPEAT_OK = frozenset(
    "had that very so bye ha no yeah really far knock tut ho la go many more blah boo cha hip "
    "hush pom tsk yes ok okay again over round on".split()
)
_WORD_TOKEN_RE = re.compile(r"(?<![\w'-])([A-Za-z]+(?:'[A-Za-z]+)?)(?![\w'-])")

_WORD_FIXES: dict[str, tuple[str, str]] = {}


def _register(kind: str, mapping: str) -> None:
    for pair in mapping.split(","):
        wrong, right = (part.strip() for part in pair.split("="))
        _WORD_FIXES[wrong] = (right, kind)


_register("capital", "i=I, i'm=I'm, i've=I've, i'll=I'll, i'd=I'd")
_register(
    "contraction",
    "im=I'm, ive=I've, dont=don't, cant=can't, wont=won't, didnt=didn't, doesnt=doesn't, "
    "isnt=isn't, arent=aren't, wasnt=wasn't, werent=weren't, havent=haven't, hasnt=hasn't, "
    "hadnt=hadn't, couldnt=couldn't, shouldnt=shouldn't, wouldnt=wouldn't, mustnt=mustn't, "
    "thats=that's, whats=what's, theres=there's, heres=here's, wheres=where's, whos=who's, "
    "youre=you're, theyre=they're, youve=you've, theyve=they've, weve=we've, youll=you'll, "
    "theyll=they'll, shes=she's, hes=he's",
)
_register(
    "style",
    "alot=a lot, gonna=going to, wanna=want to, gotta=got to, kinda=kind of, sorta=sort of, "
    "dunno=don't know, lemme=let me, gimme=give me, cuz=because, coz=because, u=you, pls=please, "
    "plz=please, thx=thanks, tmrw=tomorrow, irregardless=regardless",
)
_register(
    "spelling",
    "teh=the, recieve=receive, recieved=received, seperate=separate, definately=definitely, "
    "occured=occurred, untill=until, tommorow=tomorrow, tomorow=tomorrow, tommorrow=tomorrow, "
    "wierd=weird, beleive=believe, accomodate=accommodate, adress=address, begining=beginning, "
    "calender=calendar, goverment=government, neccessary=necessary, necessery=necessary, "
    "occassion=occasion, publically=publicly, reccomend=recommend, recomend=recommend, "
    "thier=their, truely=truly, becuase=because, becasue=because, freind=friend, freinds=friends, "
    "wich=which, arguement=argument, embarass=embarrass, existance=existence, "
    "experiance=experience, finaly=finally, happend=happened, independant=independent, "
    "knowlege=knowledge, noticable=noticeable, persue=pursue, posession=possession, "
    "prefered=preferred, realy=really, sucess=success, suprise=surprise, suprised=surprised, "
    "tounge=tongue, writting=writing, wednsday=Wednesday, febuary=February, "
    "restaraunt=restaurant, resturant=restaurant, buisness=business, bussiness=business, "
    "enviroment=environment, grammer=grammar, remeber=remember, rember=remember, "
    "tho=though, thru=through, basicly=basically, completly=completely, "
    "immediatly=immediately, probly=probably, sincerly=sincerely, garentee=guarantee",
)
_register(
    "capital",
    "monday=Monday, tuesday=Tuesday, wednesday=Wednesday, thursday=Thursday, friday=Friday, "
    "saturday=Saturday, sunday=Sunday, january=January, february=February, april=April, "
    "june=June, july=July, august=August, september=September, october=October, "
    "november=November, december=December, english=English, hindi=Hindi, spanish=Spanish, "
    "french=French, german=German, indian=Indian, american=American, british=British, "
    "christmas=Christmas, diwali=Diwali, google=Google, youtube=YouTube, iphone=iPhone",
)

_PHRASE_FIXES: list[tuple[re.Pattern, Callable[[re.Match], str], str]] = [
    (re.compile(r"(?i)\b(could|should|would|must|might)\s+of\b"), lambda m: f"{m.group(1)} have", "grammar"),
    (re.compile(r"(?i)\b(you|we|they)\s+was\b"), lambda m: f"{m.group(1)} were", "grammar"),
    (re.compile(r"(?i)\b(he|she|it)\s+don't\b"), lambda m: f"{m.group(1)} doesn't", "grammar"),
    (re.compile(r"(?i)\bmore better\b"), lambda m: "better", "grammar"),
    (re.compile(r"(?i)\b(am|are|is|was|were) suppose to\b"), lambda m: f"{m.group(1)} supposed to", "grammar"),
    (re.compile(r"(?i)\bfor all intensive purposes\b"), lambda m: "for all intents and purposes", "grammar"),
]

_ARTICLE_RE = re.compile(r"\b(an|a|An|A|AN)(\s+)([A-Za-z][\w'-]*)")
_SILENT_H = ("hour", "honest", "honor", "honour", "heir")
_YOO_SOUND = (
    "union", "unique", "unit", "univers", "uniform", "unicorn", "unison", "unify", "unifi",
    "unilateral", "use", "usu", "uten", "util", "utop", "ure", "uri", "uro", "ufo", "ubiq",
    "ukulele", "ukrain", "unanim", "eu", "ewe", "one", "once", "ouija",
)
_ARTICLE_SKIP = frozenset("is was are were or and to of in on at for with the a an".split())

_RUNON_RE = re.compile(
    r"\s+(and then|after that|also|anyway|however|besides|meanwhile|otherwise)\s+"
    r"(?=(?:i|we|you|they|he|she|it|my|our|there|this|that|let's|lets|the)\b)",
    re.I,
)
_RUNON_REPLACEMENTS = {
    "and then": "Then",
    "after that": "After that,",
    "also": "Also,",
    "anyway": "Anyway,",
    "however": "However,",
    "besides": "Besides,",
    "meanwhile": "Meanwhile,",
    "otherwise": "Otherwise,",
}
_CLAUSE_RE = re.compile(
    r"(?<=[A-Za-z])\s+(but|so)\s+(?=(?:i|we|you|they|he|she|it|there|this|my|our|the)\b)", re.I
)
_CLAUSE_SKIP = frozenset("and or not even just think hope guess said told".split())
_INTRO_RE = re.compile(
    r"(?:^|(?<=[.!?] ))(however|anyway|actually|basically|honestly|okay|ok|yes|yeah|finally|"
    r"firstly|secondly|thirdly|lastly|meanwhile|unfortunately|fortunately|luckily|sadly|"
    r"obviously|personally|besides|also|alright|otherwise|hopefully|ideally|instead)"
    r"(?=\s+[A-Za-z']+\s+[A-Za-z])",
    re.I | re.M,
)
_AUXILIARIES = frozenset(
    "is are am was were do does did can could would should will shall may might have has had "
    "must isn't aren't wasn't weren't don't doesn't didn't can't couldn't wouldn't shouldn't "
    "won't haven't hasn't".split()
)
_QUESTION_WORDS = frozenset("who what when where why how which whose whom".split())
_SUBJECTS = frozenset(
    "i you we they he she it there this that anyone someone anybody somebody everyone everybody u".split()
)
_HOW_QUESTIONS = frozenset(
    "many much long often far old come about are is do does did can could would should was were will".split()
)
_LIST_LINE_RE = re.compile(r"^\s*(?:[-•*]|\[\s?\]|\d+[.)])\s+")
_CAPITAL_RE = re.compile(r"(^|[.!?][\"”’')\]]*[ \t]+|\n[ \t]*(?:[-•*][ \t]+|\d+[.)][ \t]+)?)([a-zà-ÿ])")
_ABBREVIATIONS = frozenset("e.g i.e vs mr mrs ms dr st approx a.m p.m no fig cf al".split())

_SUMMARY_LABELS = [
    ("filler", "removed {n} filler word{s}"),
    ("repeat", "removed {n} repeated word{s}"),
    ("spelling", "fixed {n} spelling{s}"),
    ("contraction", "restored {n} apostrophe{s}"),
    ("grammar", "corrected {n} grammar slip{s}"),
    ("article", "fixed {n} a/an article{s}"),
    ("style", "expanded {n} casual word{s}"),
    ("sentence", "split {n} run-on sentence{s}"),
    ("capital", "capitalized {n} word{s}"),
    ("punctuation", "added {n} punctuation mark{s}"),
]
CHANGE_KINDS = tuple(kind for kind, _ in _SUMMARY_LABELS)


def is_question(sentence: str) -> bool:
    tokens = [token.lower() for token in words(sentence)]
    if not tokens:
        return False
    first = tokens[0]
    if first in ("what's", "who's", "where's", "when's", "how's", "why's", "who"):
        return True
    if first in _QUESTION_WORDS:
        if first == "how" and len(tokens) > 1 and tokens[1] in _HOW_QUESTIONS:
            return True
        return any(token in _AUXILIARIES or token.endswith("'s") for token in tokens[1:4])
    if first in _AUXILIARIES:
        return len(tokens) > 1 and tokens[1] in _SUBJECTS
    return False


class _Edits:
    def __init__(self) -> None:
        self.counts: Counter = Counter()
        self.changes: list[dict] = []

    def add(self, kind: str, before: str, after: str) -> None:
        self.counts[kind] += 1
        if len(self.changes) < 60:
            self.changes.append({"kind": kind, "from": before, "to": after})


def _match_case(original: str, replacement: str) -> str:
    if replacement == "I" or replacement.startswith("I'"):
        return replacement
    if len(original) > 1 and original.isupper():
        return replacement.upper()
    if original[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def _fix_words(text: str, edits: _Edits) -> str:
    def lets_go(match: re.Match) -> str:
        fixed = _match_case(match.group(0), "let's go")
        edits.add("contraction", match.group(0), fixed)
        return fixed

    text = re.sub(r"(?i)\blets go\b", lets_go, text)

    def replace(match: re.Match) -> str:
        word = match.group(1)
        lower = word.lower()
        fix = _WORD_FIXES.get(lower)
        if fix is None:
            return word
        if lower == "i":
            following = match.string[match.end():match.end() + 2]
            if following[:1] == "." and following[1:2].isalpha():
                return word
        replacement = _match_case(word, fix[0])
        if replacement == word:
            return word
        edits.add(fix[1], word, replacement)
        return replacement

    return _WORD_TOKEN_RE.sub(replace, text)


def _wants_an(word: str) -> bool | None:
    lower = word.lower()
    if len(word) > 1 and word.isupper():
        return None
    if lower.startswith(_SILENT_H):
        return True
    if lower.startswith(_YOO_SOUND):
        return False
    return lower[0] in "aeiou"


def _fix_articles(text: str, edits: _Edits) -> str:
    def replace(match: re.Match) -> str:
        article, space, word = match.groups()
        if len(word) == 1 or word.lower() in _ARTICLE_SKIP:
            return match.group(0)
        if article == "A":
            before = match.string[:match.start()].rstrip()
            if before and re.search(r"[A-Za-z0-9,]$", before):
                return match.group(0)
        wants_an = _wants_an(word)
        if wants_an is None:
            return match.group(0)
        correct = "an" if wants_an else "a"
        if article.lower() == correct:
            return match.group(0)
        new = correct.upper() if article.isupper() and len(article) > 1 else (
            correct.capitalize() if article[0].isupper() else correct
        )
        edits.add("article", f"{article} {word}", f"{new} {word}")
        return f"{new}{space}{word}"

    return _ARTICLE_RE.sub(replace, text)


def _per_sentence(text: str, fix: Callable[[str], str]) -> str:
    lines = []
    for line in text.split("\n"):
        parts = re.split(r"(?<=[.!?])(\s+)", line)
        lines.append("".join(part if index % 2 else fix(part) for index, part in enumerate(parts)))
    return "\n".join(lines)


def _split_run_ons(text: str, edits: _Edits) -> str:
    def fix(sentence: str) -> str:
        pieces: list[str] = []
        cursor = 0
        for match in _RUNON_RE.finditer(sentence):
            if len(sentence[cursor:match.start()].split()) < 6:
                continue
            pieces.append(sentence[cursor:match.start()].rstrip(" ,"))
            marker = match.group(1).lower()
            pieces.append(f". {_RUNON_REPLACEMENTS[marker]} ")
            edits.add("sentence", match.group(0).strip(), f". {_RUNON_REPLACEMENTS[marker]}")
            cursor = match.end()
        pieces.append(sentence[cursor:])
        return "".join(pieces)

    return _per_sentence(text, fix)


def _add_clause_commas(text: str, edits: _Edits) -> str:
    def fix(sentence: str) -> str:
        def replace(match: re.Match) -> str:
            before = sentence[:match.start()].split()
            if len(before) < 4 or before[-1].lower().strip(",") in _CLAUSE_SKIP:
                return match.group(0)
            edits.add("punctuation", match.group(1), f", {match.group(1)}")
            return f", {match.group(1)} "

        return _CLAUSE_RE.sub(replace, sentence)

    text = _per_sentence(text, fix)

    def intro(match: re.Match) -> str:
        edits.add("punctuation", match.group(1), f"{match.group(1)},")
        return f"{match.group(1)},"

    return _INTRO_RE.sub(intro, text)


def _tidy_spacing(text: str) -> str:
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r" +([,.;:!?%)\]”’])", r"\1", text)
    text = re.sub(r"([(\[“‘]) +", r"\1", text)
    text = re.sub(r"([,;!?])(?=[A-Za-z(“])", r"\1 ", text)
    text = re.sub(r":(?=[A-Za-z(“])", ": ", text)
    text = re.sub(r"(?<=[a-z]{2})\.(?=[A-Z][a-z])", ". ", text)
    text = re.sub(r"([,;:])\1+", r"\1", text)
    text = re.sub(r",(?=[.!?])", "", text)
    text = re.sub(r"\.{4,}", "...", text)
    text = re.sub(r"(?<!\.)\.\.(?!\.)", ".", text)
    text = re.sub(r"^[ \t]*[,;:]+[ \t]*", "", text, flags=re.M)
    text = re.sub(r"[ \t]+$|^[ \t]+", "", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _terminal_punctuation(text: str, edits: _Edits, english: bool) -> str:
    lines = []
    for line in text.split("\n"):
        stripped = line.rstrip()
        last_sentence = re.split(r"(?<=[.!?])\s+", stripped)[-1] if stripped else ""
        question = english and is_question(last_sentence)
        if (
            stripped
            and re.search(r"[A-Za-z0-9À-ɏ)]$", stripped)
            and not _LIST_LINE_RE.match(stripped)
            and (len(stripped.split()) > 3 or question)
        ):
            mark = "?" if question else "."
            edits.add("punctuation", last_sentence.split()[-1], last_sentence.split()[-1] + mark)
            stripped += mark
        lines.append(stripped)
    return "\n".join(lines)


def _capitalize(text: str, edits: _Edits) -> str:
    def replace(match: re.Match) -> str:
        prefix, letter = match.groups()
        if prefix[:1] == ".":
            token = re.search(r"([A-Za-z.]+)$", match.string[:match.start()])
            if token and token.group(1).lower().rstrip(".") in _ABBREVIATIONS:
                return match.group(0)
        edits.add("capital", letter, letter.upper())
        return prefix + letter.upper()

    return _CAPITAL_RE.sub(replace, text)


def summarize_changes(counts: Mapping[str, int]) -> list[str]:
    summary = [
        label.format(n=counts[kind], s="" if counts[kind] == 1 else "s")
        for kind, label in _SUMMARY_LABELS
        if counts.get(kind)
    ]
    if counts.get("spacing") and not summary:
        summary.append("tidied spacing")
    return summary


def polish(text: str, lang: str = "en") -> dict:
    """Clean up dictated text: fillers, repeats, spelling, articles, punctuation, capitals.

    Rule-based and conservative: it fixes what speech recognition and quick typing get
    wrong most often, and leaves anything it isn't sure about alone.
    """
    edits = _Edits()
    english = lang.lower().startswith("en")
    work = text.replace("\r\n", "\n").replace("\r", "\n")

    protected: list[str] = []

    def protect(match: re.Match) -> str:
        protected.append(match.group(0))
        return f"{len(protected) - 1}"

    work = _URL_RE.sub(protect, work)
    work = _tidy_spacing(work)
    if english:
        def filler(match: re.Match) -> str:
            edits.add("filler", match.group(0).strip(" \t,."), "")
            return " "

        work = _FILLER_RE.sub(filler, work)

    def dedupe(match: re.Match) -> str:
        if match.group(1).lower() in _REPEAT_OK:
            return match.group(0)
        edits.add("repeat", match.group(0), match.group(1))
        return match.group(1)

    work = _REPEAT_RE.sub(dedupe, work)
    if english:
        work = _fix_words(work, edits)
        for pattern, replacement, kind in _PHRASE_FIXES:
            def phrase(match: re.Match, replacement=replacement, kind=kind) -> str:
                fixed = _match_case(match.group(0), replacement(match))
                edits.add(kind, match.group(0), fixed)
                return fixed

            work = pattern.sub(phrase, work)
        work = _fix_articles(work, edits)
        work = _split_run_ons(_tidy_spacing(work), edits)
        work = _add_clause_commas(_tidy_spacing(work), edits)
    work = _tidy_spacing(work)
    if not lang.lower().startswith(("hi", "ja", "zh", "th")):
        work = _terminal_punctuation(work, edits, english)
    work = _tidy_spacing(_capitalize(work, edits))
    work = re.sub("(\\d+)", lambda m: protected[int(m.group(1))], work)

    if work != text.strip() and not edits.counts:
        edits.counts["spacing"] += 1
    return {
        "text": work,
        "changes": edits.changes,
        "summary": summarize_changes(edits.counts),
        "count": sum(count for kind, count in edits.counts.items() if kind != "spacing"),
    }


# --------------------------------------------------------------------------- analysis

def analyze(
    text: str, notes: Iterable[Mapping] = (), now: datetime | None = None, hint: str = ""
) -> dict:
    """Everything Echo needs to recommend where a thought should live.

    `hint` is extra context for matching only, such as the list name in
    "add pasta to my groceries list".
    """
    now = _aware(now)
    notes = list(notes)
    tags = detect_tags(f"{text} {hint}")
    title = _title_case(hint) if hint else suggest_title(text, tags)
    matches = rank_notes(f"{text} {hint}".strip(), notes)
    best = matches[0] if matches else None
    if best and best["score"] >= APPEND_THRESHOLD:
        recommendation = {
            "action": "append",
            "note_id": best["note_id"],
            "title": best["title"],
            "confidence": best["confidence"],
            "reason": best["reason"],
        }
    else:
        reason = "none of your notes is a close match" if notes else "it's your first note"
        if tags:
            reason += f", and it reads like a {tags[0]} note"
        recommendation = {"action": "create", "title": title, "reason": reason}
    return {
        "title": title,
        "tags": tags,
        "mood": detect_mood(text),
        "todos": extract_tasks(text, now),
        "matches": matches,
        "recommendation": recommendation,
        "words": len(words(text)),
    }


# --------------------------------------------------------------------------- conversation

HELP_TEXT = (
    "I can suggest where to save a thought, set reminders, find your notes, and tell you the "
    "time or date or work out a calculation. Give me a try."
)
_FALLBACK = (
    "I can help with the time, today's date, and arithmetic, or you can save that as a voice "
    "note. Try asking me to calculate 24 times 6."
)
_OFFLINE_FALLBACK = (
    "That one is beyond what I can answer offline. I can file your thoughts into notes, set "
    "reminders, search what you've saved, and handle the time, date, and quick maths. Try "
    "“take a note that…” or “remind me to… at 5 pm”."
)
JOKES = [
    "Why did the notebook break up with the pencil? It found someone more permanent: a pen.",
    "I told my to-do list a joke. It didn't laugh, but it did add “work on material”.",
    "Why don't secrets last in a voice notes app? Because the walls have mics.",
    "My memory is so good I only need to write down the things I want to remember. Which is everything.",
    "What do you call a reminder that shows up late? A remind-her-later.",
    "Why was the microphone so calm? It had plenty of feedback, and it listened to all of it.",
    "I asked for a quick note. You're not going to believe how sharp it was: a C sharp.",
    "Procrastinators unite! Tomorrow.",
]
QUOTES = [
    "“The palest ink is better than the best memory.” (Chinese proverb)",
    "“You don't have to see the whole staircase, just take the first step.” (Martin Luther King Jr.)",
    "“Small deeds done are better than great deeds planned.” (Peter Marshall)",
    "“Your mind is for having ideas, not holding them.” (David Allen)",
    "“Start where you are. Use what you have. Do what you can.” (Arthur Ashe)",
    "“It always seems impossible until it's done.” (Nelson Mandela)",
    "“Well begun is half done.” (Aristotle)",
    "“Simplicity is the ultimate sophistication.” (Leonardo da Vinci)",
    "“Done is better than perfect.” (Sheryl Sandberg)",
    "“The secret of getting ahead is getting started.” (Mark Twain)",
]

_GREETING_RE = re.compile(
    r"^(?:hello|hi|hey|hiya|howdy|yo|namaste|good (?:morning|afternoon|evening))(?: there)?(?: echo)?$"
)
_THANKS_RE = re.compile(r"\b(?:thanks|thank you|thx|cheers|appreciate it)\b")
_HOW_ARE_YOU_RE = re.compile(r"\bhow are you\b|\bhow's it going\b|\bhow are things\b")
_IDENTITY_RE = re.compile(r"\bwho are you\b|\bwhat are you\b|\byour name\b")
_CLEAR_RE = re.compile(r"\b(?:clear|reset|wipe)\b.*\b(?:chat|conversation)\b")
_NOTE_CAPTURE_RE = re.compile(
    r"^(?:(?:hey|ok(?:ay)?|so)[\s,]+)?(?:echo[\s,]+)?(?:please\s+)?"
    r"(?:(?:can you\s+)?(?:take|make|write|jot|save|add|create|start)(?:\s+down)?(?:\s+(?:me|a|this|the|new|quick))*"
    r"\s+(?:note|memo|thought)|note(?:\s+down)?|jot\s+(?:this\s+|that\s+)?down|write\s+(?:this\s+|that\s+)?down|"
    r"remember(?!\s+to\b)|save\s+(?:this|that))(?:\s+(?:that|saying|about|of))?[\s:,-]+(?P<body>.+)$",
    re.I | re.S,
)
_ADD_TO_NOTE_RE = re.compile(
    r"^(?:please\s+)?(?:add|append)\s+(?P<body>.+?)\s+to\s+(?:my\s+|the\s+)?"
    r"(?P<target>[\w' -]+?)(?:\s+(?:note|list))?[.!]?$",
    re.I,
)
_REMINDER_RE = re.compile(
    r"\b(?:remind me(?:\s+to|\s+about|\s+that)?|set (?:a |an )?(?:reminder|alarm)(?:\s+to|\s+for)?|"
    r"add (?:a |an )?(?:task|to-?do|todo|reminder)(?:\s+to|\s+for)?|create (?:a |an )?(?:task|reminder)"
    r"(?:\s+to|\s+for)?|new (?:task|reminder)(?:\s+to|\s+for)?)[\s:,]+(?P<body>.+)",
    re.I,
)
_TASK_QUERY_RE = re.compile(
    r"\b(?:what|what's|whats|show|list|read|tell me|any|do i have|how many|check)\b.*"
    r"\b(?:tasks?|to-?dos?|todos?|reminders?|my list|agenda|schedule|plans?)\b"
    r"|\bwhat do i (?:have|need) to do\b|\bwhat(?:'s| is) (?:on|next)\b|\bwhat do i have\b",
    re.I,
)
_NAVIGATION_RE = re.compile(
    r"^(?:please\s+)?(?:open|go to|show(?:\s+me)?|take me to|switch to)\s+(?:the\s+|my\s+)?"
    r"(home|dashboard|notes?|library|tasks?|to-?dos?|to-?do list|reminders|dictation|voice to note|"
    r"dictate|account|settings|profile|assistant)(?:\s+(?:page|view|screen|tab))?$",
    re.I,
)
_NAVIGATION_TARGETS = {
    "home": "home", "dashboard": "home", "note": "notes", "notes": "notes", "library": "notes",
    "task": "tasks", "tasks": "tasks", "todo": "tasks", "todos": "tasks", "to-do": "tasks",
    "to-dos": "tasks", "todo list": "tasks", "to-do list": "tasks", "reminders": "tasks",
    "dictation": "dictate", "voice to note": "dictate", "dictate": "dictate",
    "account": "account", "settings": "account", "profile": "account", "assistant": "assistant",
}
_SEARCH_RE = re.compile(
    r"^(?:please\s+)?(?:(?:can you\s+)?(?:find|search(?:\s+for)?|look\s+(?:up|for)|pull up)|show(?:\s+me)?|do i have)\s+"
    r"(?:(?:my|any|all|the)\s+)*(?:notes?\s+)?(?:about|for|on|with|mentioning|related to|that mention)\s+(?P<query>.+)$"
    r"|^(?:please\s+)?(?:find|search(?:\s+for)?|look\s+(?:up|for))\s+(?:(?:my|any|all|the)\s+)*(?:notes?\s+)?(?P<query2>.+)$",
    re.I,
)
_LAST_NOTE_RE = re.compile(
    r"\b(?:read|show|open|what (?:was|is)|what's)\b.*\b(?:last|latest|newest|most recent|recent)\s+note\b", re.I
)
_COUNT_NOTES_RE = re.compile(r"\bhow many notes\b|\bcount (?:my )?notes\b", re.I)
_QUESTION_START_RE = re.compile(r"^(?:tell me|explain|define|describe|give me)\b", re.I)


def _known_reply(normalized: str, current: datetime, allow_clock: bool = True) -> str | None:
    if re.search(r"\b(hello|hi|hey|good morning|good afternoon|good evening)\b", normalized) and len(
        normalized.split()
    ) <= 4:
        return "Hey! I'm Echo, your voice-powered little productivity studio. What can I help with?"
    if allow_clock and re.search(r"\b(time|clock)\b", normalized):
        return f"It's {format_clock(current)}."
    if allow_clock and re.search(r"\b(date|day|today)\b", normalized):
        return f"Today is {current.strftime('%A, %B')} {current.day}, {current.year}."
    if re.search(r"\b(help|what can you do|commands)\b", normalized):
        return HELP_TEXT

    expression = re.sub(
        r"^(?:please\s+)?(?:calculate|compute|what(?:'s|\s+is)|solve)\s+",
        "",
        normalized,
    )
    expression = re.sub(r"\b(?:multiplied\s+by|times|x)\b", "*", expression)
    expression = re.sub(r"\b(?:divided\s+by|over)\b", "/", expression)
    expression = re.sub(r"\bplus\b", "+", expression)
    expression = re.sub(r"\bminus\b", "-", expression)
    expression = expression.replace("×", "*").replace("÷", "/")
    if re.search(r"\d", expression):
        try:
            answer = calculate(expression)
        except (ValueError, SyntaxError, ZeroDivisionError, OverflowError, TypeError):
            pass
        else:
            formatted = f"{answer:g}" if isinstance(answer, float) else str(answer)
            return f"The answer is {formatted}."
    return None


def respond(message: str, now: datetime | None = None) -> str:
    """Answer a simple command (time, date, help, arithmetic) with a local reply."""
    normalized = normalize(message)
    return _known_reply(normalized, now or datetime.now().astimezone()) or _FALLBACK


def _question_like(text: str) -> bool:
    stripped = text.strip()
    return stripped.endswith("?") or is_question(stripped) or bool(_QUESTION_START_RE.match(stripped))


_SECOND_PERSON = {"my": "your", "me": "you", "myself": "yourself", "mine": "yours", "i": "you", "i'm": "you're"}


def _second_person(text: str) -> str:
    """"take my medicine" -> "take your medicine", for replies spoken back to the user.

    Quoted phrases are left exactly as written.
    """
    parts = re.split(r"(“[^”]*”|\"[^\"]*\")", text)
    return "".join(
        part if index % 2 else re.sub(
            r"\b(myself|mine|my|me|I'm|I)\b",
            lambda match: _SECOND_PERSON[match.group(1).lower()],
            part,
            flags=re.I,
        )
        for index, part in enumerate(parts)
    )


def _task_phrase(task: Mapping, now: datetime) -> str:
    due = parse_iso(task.get("due_at"))
    text = _second_person(task["text"][:1].lower() + task["text"][1:])
    if not due:
        return text
    if due < now:
        return f"{text} (overdue)"
    return f"{text} ({format_due(due, now)})"


def _reply(intent: str, reply: str, action: dict | None = None) -> dict:
    return {"intent": intent, "reply": reply, "action": action}


def suggestion_reply(analysis: Mapping) -> str:
    recommendation = analysis["recommendation"]
    if recommendation["action"] == "append":
        reply = (
            f"This fits your note “{recommendation['title']}”: {recommendation['reason']}. "
            "Shall I add it there, or start a new note?"
        )
    else:
        reply = f"That feels like a fresh thought, so I'd start a new note called “{recommendation['title']}”."
    todos = analysis.get("todos") or []
    if todos:
        count = len(todos)
        reply += f" I also spotted {count} to-do{'s' if count != 1 else ''} I can turn into reminders."
    return reply


def converse(
    message: str,
    *,
    notes: Sequence[Mapping] = (),
    tasks: Sequence[Mapping] = (),
    name: str = "",
    now: datetime | None = None,
    polish_text: Callable[[str], Mapping] | None = None,
) -> dict:
    """Work out what the user wants and reply.

    Returns {"intent", "reply", "action"}. Actions that change data (creating tasks,
    appending to a note) are described, not performed; the caller persists them.
    """
    now = _aware(now)
    text = message.strip()
    normalized = normalize(text)
    first_name = name.split()[0] if name.strip() else ""
    word_count = len(normalized.split())
    question = _question_like(text)

    def suggest(body: str, hint: str = "") -> dict:
        polished = polish_text(body) if polish_text else {"text": body, "summary": [], "count": 0, "engine": "none"}
        analysis = analyze(polished["text"], notes, now, hint=hint)
        if hint and analysis["recommendation"]["action"] == "create":
            analysis["recommendation"]["reason"] = f"you don't have a “{analysis['title']}” note yet"
        return _reply(
            "suggest_note",
            suggestion_reply(analysis),
            {"type": "suggest_note", "text": body, "polished": dict(polished), "analysis": analysis},
        )

    if not normalized:
        return _reply("chat", "I'm listening whenever you're ready.")
    if _GREETING_RE.match(normalized):
        greeting = random.choice(["Hey", "Hello", "Hi there"])
        who = f", {first_name}" if first_name else ""
        return _reply(
            "greeting",
            f"{greeting}{who}! Tell me what's on your mind and I'll find it a home, or ask me what's on your list.",
        )
    if word_count <= 6 and _THANKS_RE.search(normalized):
        return _reply("thanks", random.choice(["Anytime!", "Happy to help.", "You got it."]))
    if word_count <= 8 and _HOW_ARE_YOU_RE.search(normalized):
        return _reply("smalltalk", "Doing great, and all ears. What would you like to capture?")
    if word_count <= 8 and _IDENTITY_RE.search(normalized):
        return _reply(
            "identity",
            "I'm Echo, the assistant in your private voice studio. " + HELP_TEXT,
        )
    if _CLEAR_RE.search(normalized):
        return _reply("clear_chat", "Fresh start. What's next?", {"type": "clear_chat"})

    capture = _NOTE_CAPTURE_RE.match(text)
    if capture and capture.group("body").strip():
        return suggest(capture.group("body").strip())

    reminder = _REMINDER_RE.search(text)
    if reminder:
        body = _REMIND_AT_RE.sub(r"remind me to \2 \1", f"remind me {reminder.group('body')}")
        items = tasks_from_body(re.sub(r"(?i)^remind me\s+(?:to\s+)?", "", body), now)
        if items:
            return _reply("create_tasks", _tasks_created_reply(items, now), {"type": "tasks_created", "tasks": items})

    added = _ADD_TO_NOTE_RE.match(text)
    if added:
        target = added.group("target").strip().lower()
        if re.fullmatch(r"(?:to-?do|todo|task|tasks|reminders?)(?:\s+list)?", target):
            items = tasks_from_body(added.group("body"), now)
            if items:
                return _reply("create_tasks", _tasks_created_reply(items, now), {"type": "tasks_created", "tasks": items})
        else:
            match = _find_note_by_title(target, notes)
            if match is not None:
                body = added.group("body").strip()
                return _reply(
                    "append_note",
                    f"Added to “{match.get('title') or 'your note'}”.",
                    {"type": "append_note", "note_id": match["id"], "text": body[:1].upper() + body[1:]},
                )
            return suggest(added.group("body").strip(), hint=target)

    if word_count <= 14 and _TASK_QUERY_RE.search(normalized):
        return _tasks_reply(tasks, normalized, now)

    navigation = _NAVIGATION_RE.match(normalized)
    if navigation:
        view = _NAVIGATION_TARGETS.get(navigation.group(1).lower(), "home")
        labels = {"home": "your home", "notes": "your notes", "tasks": "your tasks", "dictate": "Voice to Note",
                  "account": "your account", "assistant": "the assistant"}
        return _reply("navigate", f"Opening {labels[view]}.", {"type": "open_view", "view": view})

    if _COUNT_NOTES_RE.search(normalized):
        total = len(notes)
        word_total = sum(len(words(note.get("text", ""))) for note in notes)
        if not total:
            return _reply("count_notes", "You haven't saved any notes yet. Tell me something worth keeping!")
        return _reply(
            "count_notes",
            f"You have {total} note{'s' if total != 1 else ''} holding {word_total:,} words. Nicely done.",
        )

    search = _SEARCH_RE.match(normalized)
    if search:
        query = (search.group("query") or search.group("query2") or "").strip(" ?.")
        if query:
            return _search_reply(query, notes)

    if _LAST_NOTE_RE.search(normalized):
        if not notes:
            return _reply("last_note", "There's nothing saved yet. Your first note is one sentence away.")
        latest = max(notes, key=lambda note: (note.get("created_at") or "", note.get("id") or 0))
        excerpt = latest.get("text", "")
        if len(excerpt) > 320:
            excerpt = excerpt[:317].rstrip() + "…"
        return _reply(
            "last_note",
            f"Your latest note is “{latest.get('title') or 'Untitled'}”: {excerpt}",
            {"type": "open_note", "note_id": latest.get("id")},
        )

    if re.search(r"\b(?:joke|make me laugh|something funny)\b", normalized):
        return _reply("fun", random.choice(JOKES))
    if re.search(r"\b(?:quote|motivat\w*|inspire me|inspiration)\b", normalized):
        return _reply("fun", random.choice(QUOTES))
    if re.search(r"\b(?:flip|toss) a coin\b|\bheads or tails\b", normalized):
        return _reply("fun", f"It's {random.choice(['heads', 'tails'])}!")
    if re.search(r"\broll (?:a |the )?(?:die|dice)\b", normalized):
        return _reply("fun", f"You rolled a {random.randint(1, 6)}.")

    known = _known_reply(normalized, now, allow_clock=question or word_count <= 7)
    if known:
        return _reply("known", known)

    if not question:
        offered = extract_tasks(text, now) if word_count <= 12 else []
        if offered:
            if len(offered) == 1:
                due = parse_iso(offered[0]["due_at"])
                when = f" for {format_due(due, now)}" if due else ""
                reply = f"Want me to add “{offered[0]['text']}” to your tasks{when}?"
            else:
                quoted = [f"“{task['text']}”" for task in offered]
                reply = f"Want me to add {join_words(quoted)} to your tasks?"
            return _reply("offer_tasks", reply, {"type": "task_offer", "tasks": offered})
        if word_count >= 5:
            return suggest(text)

    return _reply("chat", _OFFLINE_FALLBACK)


def _title_case(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    return value[:1].upper() + value[1:] if value else "New note"


def _find_note_by_title(target: str, notes: Sequence[Mapping]) -> Mapping | None:
    target = target.casefold().strip()
    if not target:
        return None
    best = None
    for note in notes:
        title = (note.get("title") or "").casefold()
        if not title:
            continue
        if title == target or title.removesuffix(" list") == target.removesuffix(" list"):
            return note
        if best is None and (target in title or title in target):
            best = note
    return best


def _tasks_created_reply(items: Sequence[Mapping], now: datetime) -> str:
    phrases = [_task_phrase(item, now) for item in items]
    if len(items) == 1:
        due = parse_iso(items[0].get("due_at"))
        text = _second_person(items[0]["text"][:1].lower() + items[0]["text"][1:])
        if due:
            return f"Done. I'll remind you to {text} {format_due(due, now)}."
        return f"Added “{items[0]['text']}” to your tasks."
    return f"Done. I added {len(items)} tasks: {join_words(phrases)}."


def _tasks_reply(tasks: Sequence[Mapping], normalized: str, now: datetime) -> dict:
    pending = [task for task in tasks if not task.get("done")]
    if "today" in normalized or "tonight" in normalized:
        end_of_day = now.replace(hour=23, minute=59, second=59)
        pending = [
            task for task in pending
            if (due := parse_iso(task.get("due_at"))) is not None and due <= end_of_day
        ]
        if not pending:
            return _reply("list_tasks", "Nothing is due today. Enjoy the breathing room.", {"type": "task_list", "task_ids": []})

    def order(task: Mapping) -> tuple:
        due = parse_iso(task.get("due_at"))
        return (due is None, due or now, task.get("id") or 0)

    pending.sort(key=order)
    if not pending:
        return _reply("list_tasks", "Your list is clear. Want to add something?", {"type": "task_list", "task_ids": []})
    shown = pending[:5]
    phrases = [_task_phrase(task, now) for task in shown]
    reply = f"You have {len(pending)} thing{'s' if len(pending) != 1 else ''} on your list: {join_words(phrases)}"
    if len(pending) > len(shown):
        reply += f", plus {len(pending) - len(shown)} more"
    return _reply("list_tasks", reply + ".", {"type": "task_list", "task_ids": [task.get("id") for task in shown]})


def _search_reply(query: str, notes: Sequence[Mapping]) -> dict:
    lowered = query.casefold()
    found: list[Mapping] = [
        note for note in notes
        if lowered in (note.get("title") or "").casefold() or lowered in (note.get("text") or "").casefold()
    ]
    ranked_ids = {match["note_id"] for match in rank_notes(query, notes, limit=5) if match["score"] >= 0.08}
    for note in notes:
        if note.get("id") in ranked_ids and note not in found:
            found.append(note)
    found = found[:5]
    if not found:
        return _reply(
            "search",
            f"I couldn't find anything about “{query}”. Want to start a note about it?",
            {"type": "search_results", "query": query, "note_ids": []},
        )
    titles = [f"“{note.get('title') or 'Untitled'}”" for note in found]
    plural = "s" if len(found) != 1 else ""
    return _reply(
        "search",
        f"I found {len(found)} note{plural} about “{query}”: {join_words(titles)}.",
        {"type": "search_results", "query": query, "note_ids": [note.get("id") for note in found]},
    )


def chat_context(name: str, notes: Sequence[Mapping], tasks: Sequence[Mapping], now: datetime | None = None) -> str:
    """A compact, factual summary of the user's workspace for a language model."""
    now = _aware(now)
    lines = [
        f"User's first name: {name.split()[0] if name.strip() else 'unknown'}",
        f"Local time: {now:%A, %B} {now.day}, {now.year}, {format_clock(now)}",
        f"Saved notes: {len(notes)}",
    ]
    titles = [note.get("title") or suggest_title(note.get("text", "")) for note in list(notes)[:8]]
    if titles:
        lines.append("Recent note titles: " + "; ".join(titles))
    pending = [task for task in tasks if not task.get("done")][:8]
    if pending:
        lines.append("Open tasks: " + "; ".join(_task_phrase(task, now) for task in pending))
    return "\n".join(lines)
