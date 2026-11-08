"""Bounded, read-only local vehicle table retrieval. Candidates are not fitment approval."""
import copy
import json
import os
from pathlib import Path
import re
import stat
import time
import unicodedata

from . import productlinks, vehicle_match

MAX_FILES = 5000
MAX_FILE_BYTES = 65536
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 20000
MAX_ALIASES = 20000
MAX_LOOKUP_SECONDS = 0.1
COLUMNS = ("版型", "车系", "车型", "尺码", "前挡铁圈尺寸", "前窗铁圈尺寸", "中窗铁圈尺寸",
           "侧三铁圈尺寸", "尾挡铁圈尺寸", "前挡风 上长", "前挡风 下长", "前挡风 高度", "不透光专用")
START, END = "<!-- WPS_SYNC_START -->", "<!-- WPS_SYNC_END -->"
UNSAFE_TEXT = re.compile(r"[\x00-\x1f\x7f-\x9f]|https?://|www\.|\[\[", re.I)
YEAR_RANGE = re.compile(r"(?<![a-z0-9])\d{2,4}\s*[-—–~～至到]\s*\d{2,4}\s*(?:年款|款|年)?", re.I)


class VehicleKnowledgeError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)  # Do not include source text, URLs or local paths.


def _require(condition, code):
    if not condition:
        raise VehicleKnowledgeError(code)


def _record(text):
    _require(text.count(START) == text.count(END) == 1, "invalid_vehicle_sync_block")
    _require(text.index(START) < text.index(END), "invalid_vehicle_sync_block")
    block = text.split(START, 1)[1].split(END, 1)[0]
    identifiers = re.findall(r"^- 记录编号：`([A-Za-z0-9._-]{1,64})`\s*$", block, re.M)
    _require(len(identifiers) == 1, "invalid_vehicle_record_id")
    _require(block.count("## 原始列") == 1, "invalid_vehicle_table")
    table = block.split("## 原始列", 1)[1]
    values = {}
    for line in table.splitlines():
        if not line.strip():
            continue
        cells = line.strip().split("|")
        _require(len(cells) == 4 and not cells[0] and not cells[-1], "invalid_vehicle_table")
        key, value = cells[1].strip(), cells[2].strip()
        if (key, value) in (("列名", "原文"), ("---", "---")):
            continue
        _require(key in COLUMNS and key not in values, "invalid_vehicle_column")
        _require(len(value) <= 200 and not UNSAFE_TEXT.search(value), "invalid_vehicle_value")
        values[key] = value
    _require(set(values) == set(COLUMNS) and values["车型"], "invalid_vehicle_fields")
    return {"record_id": identifiers[0], "family": values["车系"], "model": values["车型"],
            "variant": values["版型"], "specifications": {k: values[k] for k in COLUMNS[3:]}}


def _normalize(text):
    # Spaces separate an ASCII model from its brand/year. Deleting them turns
    # "Brand A6 2022" into one identifier and defeats the matcher's boundaries.
    text = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()
    # Only known brand prefixes may separate a glued ASCII model; arbitrary XA6 must not match A6.
    text = re.sub(r"\b(wey|byd)(?=[a-z]+\d)", r"\1 ", text)
    return re.sub(r"([一二三四五六七八九十])代", lambda m: str("一二三四五六七八九十".index(m[1]) + 1) + "代", text)


def _aliases(record):
    result = set()
    for name in re.split(r"[/、]", record["model"]):
        # Qualifiers are removed only from a search key. Original model/year
        # and variant remain in every result and are never auto-selected.
        key = re.sub(r"【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)", " ", name)
        key = YEAR_RANGE.sub(" ", key)
        key = re.sub(r"(?<![a-z0-9])\d{2,4}(?:款|年)", " ", key, flags=re.I)
        for value in (name, key):
            value = _normalize(value)
            if not value:
                continue
            if len(value) < 2:
                if not record["family"]:
                    continue
                value = _normalize(record["family"]) + value
            result.add(value)
            generation = re.fullmatch(r"(.+?)(\d{1,2})代", value)
            if generation:
                result.add(generation[2] + "代" + generation[1].strip())
    return tuple(sorted(result))


def _matcher(name):
    # Fixed escaped literals with ASCII boundaries; never a source-supplied regex.
    # Reject an invalid start before scanning a long repeated prefix.
    left = r"(?<![a-z0-9])" if name[0].isascii() and name[0].isalnum() else ""
    return re.compile(left + re.escape(name) + r"(?![a-z0-9])")


class VehicleCatalog:
    def __init__(self, records, directories=None):
        self._records = tuple(records)
        self.record_count = len(self._records)
        # vehicle_lookup_v2: the shop's tested matcher, using each record's brand folder and the shipped word lists.
        folders = tuple(directories) if directories is not None else ("",) * len(self._records)
        _require(len(folders) == len(self._records), "invalid_vehicle_directory")
        try:
            self._v2 = vehicle_match.Catalog(
                [{"record_id": r["record_id"], "family": r["family"], "model": r["model"], "directory": d}
                 for r, d in zip(self._records, folders)], vehicle_match.load_aliases())
        except vehicle_match.CatalogError:
            raise VehicleKnowledgeError("invalid_vehicle_aliases") from None
        aliases = {}
        for index, record in enumerate(self._records):
            for name in _aliases(record):
                aliases.setdefault(name, set()).add(index)
                _require(len(aliases) <= MAX_ALIASES, "too_many_vehicle_aliases")
        self._matchers = tuple((_matcher(name), indexes) for name, indexes in aliases.items())
        self._links = {}

    def lookup(self, text):
        query = _normalize(text) if isinstance(text, str) and len(text) <= 8000 else ""
        # A longer name must not hide another car mentioned in the same question.
        # Keep all exact alias matches; overlaps remain candidates to clarify.
        deadline, matched = time.monotonic() + MAX_LOOKUP_SECONDS, set()
        for pattern, indexes in self._matchers if query else ():
            if pattern.search(query):
                matched.update(indexes)
            if time.monotonic() >= deadline:
                # Never return a partial catalog scan as a unique fitment candidate.
                return {"status": "unavailable", "reason": "lookup_budget_exceeded", "candidates": [],
                        "total_matches": None, "truncated": True}
        matches = [self._records[index] for index in sorted(matched)]
        return {"status": "not_found" if not matches else "matched" if len(matches) == 1 else "ambiguous",
                "candidates": copy.deepcopy(matches[:5]), "total_matches": len(matches), "truncated": len(matches) > 5}

    def conversation(self, messages, orders=()):
        """vehicle_lookup_v2: the latest buyer turn's status, hint and program stop; None without a text turn."""
        return vehicle_match.conversation(self._v2, messages, orders)

    def describe_link(self, doc):
        """The learned goods as a main link, a dedicated link naming table cars, or neither (cached per text)."""
        key = (doc["product_key"], json.dumps([doc.get("title"), doc.get("facts")], ensure_ascii=False))
        if key not in self._links:
            if len(self._links) >= 2000:
                self._links.clear()
            self._links[key] = productlinks.describe(doc, self._v2)
        return self._links[key]

    def recommend_link(self, context, vehicle, docs):
        """The link a matched car needs when the buyer came in through another car's dedicated link, or None."""
        return productlinks.recommend(context, vehicle, docs, self.describe_link, self._v2)

    def card_greeting(self, context, docs):
        """The fixed sentence for a sunshade goods card the buyer sent, unless they already named a car the table has."""
        texts = [text for _, text in vehicle_match._buyer_turns(context.get("messages") or [])][-vehicle_match.MAX_TURNS:]
        if texts and vehicle_match._turn(self._v2, texts)[0]["status"] in (*vehicle_match.MATCH_STATUSES, "needs_year", "year_mismatch"):
            return None
        return productlinks.card_greeting(context, docs, self.describe_link)

    def link_card(self, context, docs):
        """The goods card of the link the previous reply recommended, when sendable now, or None."""
        return productlinks.card_after_recommendation(context, docs, self.describe_link)

    def lookup_context(self, messages):
        """Keep a recent buyer's model for a bare year/window/greeting, never guess a new model."""
        visible = [m for m in messages if isinstance(m, dict) and m.get("role") == "buyer"
                   and m.get("kind") in ("text", "card") and isinstance(m.get("content"), str)][-6:] if isinstance(messages, list) else []
        deadline = time.monotonic() + MAX_LOOKUP_SECONDS
        result = self.lookup("")
        for message in reversed(visible):
            text = message["content"]
            if time.monotonic() >= deadline:
                return {"status": "unavailable", "reason": "lookup_budget_exceeded", "candidates": [],
                        "total_matches": None, "truncated": True}
            result = self.lookup(text)
            if result["status"] != "not_found":
                if result.get("candidates") and re.search(r"不是|并非|不要这个|not this", text, re.I):
                    return {**result, "status": "ambiguous"}
                return result
            if message["kind"] != "text" or len(text) > 128:
                break
            # Carry only short follow-ups; an unknown new car must not inherit the old one.
            rest = re.sub(r"\d+(?:\.\d+)?(?:年款|年|款|座)?", "", _normalize(text))
            rest = re.sub(r"我的是|我的|就是|请问|您好|你好|谢谢|好的|在吗|在么|在的|能用吗|能装吗|可以吗|前挡风|后挡风|前挡|前窗|后窗|中窗|侧三|尾挡|后挡|侧窗|小窗|挡风|窗位|年份|年款|尺寸|的|是|呢|吗|款", "", rest)
            if re.sub(r"[\s，。？！,.?!~～]", "", rest):
                break
        return result


def load_directory(path):
    """Read only the explicitly configured directory; no link following or URL fetching."""
    try:
        root = Path(path)
        _require(root.is_absolute() and root.is_dir() and not root.is_symlink(), "invalid_vehicle_directory")
        root = root.resolve()  # macOS /var is itself a system directory alias.
        records, folders, ids, total, entries = [], [], set(), 0, 0

        def walk_error(_):
            raise VehicleKnowledgeError("unreadable_vehicle_directory")

        for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
            entries += len(dirs) + len(files)
            _require(entries <= MAX_ENTRIES, "vehicle_directory_too_large")
            dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
            for name in sorted(files):
                file = Path(directory) / name
                if file.suffix != ".md" or file.is_symlink():
                    continue
                _require(len(records) < MAX_FILES, "too_many_vehicle_records")
                fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "rb") as stream:
                    info = os.fstat(stream.fileno())
                    _require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE_BYTES, "vehicle_file_too_large")
                    data = stream.read(MAX_FILE_BYTES + 1)
                total += len(data)
                _require(len(data) <= MAX_FILE_BYTES and total <= MAX_TOTAL_BYTES, "vehicle_data_too_large")
                record = _record(data.decode("utf-8-sig"))
                _require(record["record_id"] not in ids, "duplicate_vehicle_record")
                ids.add(record["record_id"])
                records.append(record)
                folders.append(Path(directory).name)
        _require(records, "empty_vehicle_directory")
        return VehicleCatalog(records, folders)
    except VehicleKnowledgeError:
        raise
    except (OSError, UnicodeError, TypeError, ValueError):
        raise VehicleKnowledgeError("unreadable_vehicle_directory") from None
