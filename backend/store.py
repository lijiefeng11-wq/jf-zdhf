"""Durable decisions and single-attempt delivery state, isolated from platform I/O."""
import copy
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from . import conversation_actions, deadlines, diagnostics, goods_snapshot, modelconfig, modelsecrets, senditems
from .content import validate_content
from .orders import validate_orders
from .lock import DataLock


class ApiError(Exception):
    def __init__(self, status, code, message=None):
        self.status, self.code = status, code
        super().__init__(message or code)


def require(condition, code, status=400):
    if not condition:
        raise ApiError(status, code)


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value) is not None


def number(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and abs(value) < 1e12


def validate_event(p):
    require(isinstance(p, dict), "invalid_event")
    for name in ("event_id", "conversation_id", "message_id", "instance_id", "session_id"):
        require(identifier(p.get(name)), "invalid_" + name)
    for name in ("generation", "context_revision"):
        require(type(p.get(name)) is int and p[name] > 0, "invalid_" + name)
    require(number(p.get("received_at")), "invalid_received_at")
    ctx = p.get("context")
    require(isinstance(ctx, dict) and type(ctx.get("history_complete")) is bool, "invalid_context")
    msgs = ctx.get("messages")
    require(isinstance(msgs, list) and 1 <= len(msgs) <= 200, "invalid_messages")
    seen, previous = set(), 0
    for msg in msgs:
        require(isinstance(msg, dict) and identifier(msg.get("id")), "invalid_message_id")
        require(msg["id"] not in seen, "duplicate_context_message")
        seen.add(msg["id"])
        require(msg.get("role") in ("buyer", "agent", "system"), "invalid_role")
        require(msg.get("kind") in ("text", "image", "card", "unsupported"), "invalid_kind")
        require(isinstance(msg.get("content"), str) and len(msg["content"]) <= 8000, "invalid_content")
        require(number(msg.get("created_at")) and msg["created_at"] >= previous, "invalid_message_time")
        previous = msg["created_at"]
    require(msgs[-1]["id"] == p["message_id"] and msgs[-1]["role"] == "buyer", "latest_message_mismatch")
    validate_content(msgs, require)
    validate_orders(ctx, require)
    goods_snapshot.validate_goods(ctx, require)
    goods_snapshot.validate_references(ctx, require)
    senditems.validate_options(ctx, require)
    conversation_actions.validate_context(ctx, require)


def validate_settings(p):
    require(isinstance(p, dict) and type(p.get("enabled")) is bool, "invalid_enabled")
    require(p.get("mode") in ("rules", "model", "hybrid"), "invalid_mode")
    require(isinstance(p.get("system_prompt"), str) and len(p["system_prompt"]) <= 8000, "invalid_system_prompt")
    rules = p.get("rules")
    require(isinstance(rules, list) and len(rules) <= 100, "invalid_rules")
    seen = set()
    clean = []
    for rule in rules:
        require(isinstance(rule, dict) and identifier(rule.get("id")) and rule["id"] not in seen, "invalid_rule_id")
        seen.add(rule["id"])
        require(isinstance(rule.get("contains"), str) and 0 < len(rule["contains"].strip()) <= 500, "invalid_rule_contains")
        require("reply" in rule or "send" in rule or "handling" in rule, "invalid_rule_reply")
        require("handling" not in rule or not ({"reply", "send"} & set(rule)), "invalid_rule_handling")
        item = {k: rule[k] for k in ("id", "contains")}
        if "handling" in rule:
            item["handling"] = conversation_actions.validate_policy(rule["handling"], require)
        if "reply" in rule:
            require(isinstance(rule["reply"], str) and 0 < len(rule["reply"].strip()) <= 2000, "invalid_rule_reply")
            item["reply"] = rule["reply"]
        if "send" in rule:
            item["send"] = senditems.validate_target(rule["send"], require)
        if "description" in rule:
            require(isinstance(rule["description"], str) and len(rule["description"]) <= 500, "invalid_rule_description")
            item["description"] = rule["description"]
        clean.append(item)
    result = {"enabled": p["enabled"], "mode": p["mode"], "system_prompt": p["system_prompt"], "rules": clean}
    if "fallback" in p:
        result["fallback"] = conversation_actions.validate_fallback(p["fallback"], require)
    return result


DEFAULT_SETTINGS = {"enabled": False, "mode": "rules", "system_prompt": "仅根据已知店铺规则回答；无法确认则转人工。", "rules": [], "version": 1}
TEMPLATE_FIELDS = ("mode", "system_prompt", "rules")


class Store:
    def __init__(self, data_dir, shops):
        Path(data_dir).mkdir(parents=True, exist_ok=True)
        self.data_lock = DataLock(data_dir)
        self.lock = threading.RLock()
        self._clocks = {}  # Process-local monotonic readings, never restored from disk.
        self.db = sqlite3.connect(str(Path(data_dir) / "claw-next.sqlite3"), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS shops (shop_id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reply_templates (
          template_id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS shop_reply_templates (shop_id TEXT PRIMARY KEY, template_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS leases (shop_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS model_settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS delivery_verifications (
          shop_id TEXT NOT NULL, event_id TEXT NOT NULL, administrator TEXT NOT NULL,
          outcome TEXT NOT NULL, note TEXT NOT NULL, verified_at REAL NOT NULL,
          PRIMARY KEY(shop_id,event_id));
        CREATE TABLE IF NOT EXISTS events (
          shop_id TEXT NOT NULL, event_id TEXT NOT NULL, client_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
          revision INTEGER NOT NULL, settings_version INTEGER NOT NULL, created_at REAL NOT NULL,
          digest TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
          decision TEXT, delivery TEXT NOT NULL,
          PRIMARY KEY(shop_id,event_id), UNIQUE(shop_id,conversation_id,message_id));
        CREATE INDEX IF NOT EXISTS events_pending ON events(state,created_at);
        CREATE INDEX IF NOT EXISTS events_conversation ON events(shop_id,conversation_id,session_id,revision);
        CREATE INDEX IF NOT EXISTS events_claimed ON events(json_extract(delivery,'$.status')) WHERE state='ready';
        CREATE TABLE IF NOT EXISTS event_runtime (
          shop_id TEXT NOT NULL, event_id TEXT NOT NULL,
          accepted_wall REAL, budget_ms INTEGER, wall_deadline REAL,
          checkpoint_wall REAL, timing TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY(shop_id,event_id));
        """)
        try:
            self._migrate_model_secrets()
        except BaseException:
            self.db.close()
            self.data_lock.close()
            raise
        self.shop_ids = {s["shop_id"] for s in shops}
        with self.db:
            for shop in shops:
                self.db.execute("INSERT INTO shops VALUES (?,?,?) ON CONFLICT(shop_id) DO UPDATE SET name=excluded.name", (shop["shop_id"], shop["name"], json.dumps(DEFAULT_SETTINGS)))
            # A claimed send may or may not have reached the platform: it is
            # uncertain and must never be retried automatically.
            for row in self.db.execute("SELECT * FROM events").fetchall():
                delivery = json.loads(row["delivery"])
                if delivery["status"] == "claimed":
                    delivery.update(status="unknown", reason="backend_restarted")
                    self._delivery(row, delivery)
            # Never-evaluated or interrupted decisions stay pending, but they are
            # only evaluated again after the original client+instance+session
            # authenticates with a heartbeat. Payload and digest are untouched.
            for row in self.db.execute("SELECT * FROM events WHERE state IN ('pending','processing')").fetchall():
                delivery, p = json.loads(row["delivery"]), json.loads(row["payload"])
                if delivery["status"] != "unclaimed":
                    # Terminal/uncertain delivery: never re-enter the decision loop.
                    self.db.execute("UPDATE events SET state='ready' WHERE shop_id=? AND event_id=?", (row["shop_id"], row["event_id"]))
                    continue
                if self._runtime(row["shop_id"], row["event_id"]):
                    # An interrupted judgment did not complete; its queue timing
                    # cannot be paired with a new judgment after this restart.
                    self._save_timing(row["shop_id"], row["event_id"], {})
                delivery["recovered"] = {"client_id": row["client_id"], "instance_id": p["instance_id"], "session_id": p["session_id"], "generation": p["generation"]}
                self.db.execute("UPDATE events SET state='pending',delivery=? WHERE shop_id=? AND event_id=?", (json.dumps(delivery), row["shop_id"], row["event_id"]))
            # Expire leases on restart, retaining generation as a fencing counter.
            # The persisted marker lets the original owner resume without a new
            # generation; ordinary expiry still fences with a new one.
            for row in self.db.execute("SELECT * FROM leases").fetchall():
                lease = json.loads(row["payload"])
                lease["expires_at"] = 0
                lease["restart_pending"] = True
                self.db.execute("UPDATE leases SET payload=? WHERE shop_id=?", (json.dumps(lease), row["shop_id"]))

            # A wall clock cannot prove elapsed time across restarts. Conservatively
            # expire every unclaimed budget event, including missing/corrupt metadata.
            # Claimed sends were already made unknown above and are never rewritten.
            for row in self.db.execute("SELECT * FROM events").fetchall():
                if "remaining_budget_ms" in json.loads(row["payload"]):
                    self._terminate_deadline(row, "deadline_exceeded")

    def close(self):
        with self.lock:
            self.db.close()
            self.data_lock.close()

    @staticmethod
    def _secret_slots(payload):
        return [payload] + [payload[name] for name in modelconfig.SLOTS if isinstance(payload.get(name), dict)]

    @classmethod
    def _secret_refs(cls, payload):
        return {slot["api_key_ref"] for slot in cls._secret_slots(payload)
                if isinstance(slot.get("api_key_ref"), str)}

    @staticmethod
    def _cleanup_secrets(refs):
        for reference in refs:
            try:
                modelsecrets.delete(reference)
            except modelsecrets.SecretError:
                # A failed cleanup leaves an unreachable encrypted item, not
                # a false rollback of the already committed configuration.
                diagnostics.emit("secret_cleanup_failed")

    def _protect_secrets(self, payload):
        protected, created = copy.deepcopy(payload), []
        try:
            for slot in self._secret_slots(protected):
                key = slot.pop("api_key", "")
                if key:
                    if "api_key_ref" in slot or "api_key_dpapi" in slot:
                        raise modelsecrets.SecretError("secret_decrypt_failed")
                    reference = modelsecrets.create(key)
                    created.append(reference)
                    slot["api_key_ref"] = reference
                    slot["use_environment_key"] = False
            return protected, created
        except BaseException:
            self._cleanup_secrets(created)
            raise

    def _migrate_model_secrets(self):
        row = self.db.execute("SELECT payload FROM model_settings WHERE id=1").fetchone()
        if not row:
            return
        payload = json.loads(row[0])
        if not isinstance(payload, dict):
            return
        if any(s.get("api_key") for s in self._secret_slots(payload)):
            protected, created = self._protect_secrets(payload)
            protected["_secret_cleanup_pending"] = True
            try:
                with self.db:
                    self.db.execute("UPDATE model_settings SET payload=? WHERE id=1", (json.dumps(protected),))
            except BaseException:
                self._cleanup_secrets(created)
                raise
            payload = protected
        if payload.get("_secret_cleanup_pending"):
            # Durable marker ensures an interrupted scrub is retried before serving.
            self._scrub_legacy_secrets()
            del payload["_secret_cleanup_pending"]
            with self.db:
                self.db.execute("UPDATE model_settings SET payload=? WHERE id=1", (json.dumps(payload),))

    def _scrub_legacy_secrets(self):
        # Cannot erase backups, filesystem snapshots or copies elsewhere.
        try:
            if self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                raise modelsecrets.SecretError("secret_migration_cleanup_failed")
            self.db.execute("VACUUM")
            if self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                raise modelsecrets.SecretError("secret_migration_cleanup_failed")
        except sqlite3.DatabaseError:
            raise modelsecrets.SecretError("secret_migration_cleanup_failed") from None

    def model_config(self, fallback):
        """Internal config retains references; keys open only at provider use."""
        with self.lock:
            row = self.db.execute("SELECT payload FROM model_settings WHERE id=1").fetchone()
            try:
                saved = json.loads(row[0]) if row else {}
            except ValueError:
                saved = {}
            return modelconfig.stored_config(saved, fallback)

    def update_model_config(self, payload, fallback):
        with self.lock:
            require(isinstance(payload, dict), "invalid_model_config")
            current = self.model_config(fallback)
            require(type(payload.get("version")) is int, "invalid_model_config")
            require(payload["version"] == current["version"], "model_config_changed", 409)
            try:
                slots = modelconfig.parse_update(payload, current)
            except modelconfig.ModelConfigError as exc:
                raise ApiError(400, exc.code) from None
            try:
                saved, created = self._protect_secrets({**slots, "version": current["version"] + 1})
            except modelsecrets.SecretError as exc:
                raise ApiError(503, exc.code) from None
            try:
                with self.db:
                    self.db.execute("INSERT OR REPLACE INTO model_settings VALUES (1,?)", (json.dumps(saved),))
                    # Old decisions must not receive new send permits.
                    for row in self.db.execute("SELECT shop_id, settings FROM shops").fetchall():
                        settings = json.loads(row["settings"])
                        settings["version"] += 1
                        self.db.execute("UPDATE shops SET settings=? WHERE shop_id=?", (json.dumps(settings), row["shop_id"]))
            except BaseException:
                self._cleanup_secrets(created)
                raise
            self._cleanup_secrets(self._secret_refs(current) - self._secret_refs(saved))
            return modelconfig.stored_config(saved, fallback)

    def _lease(self, shop_id):
        row = self.db.execute("SELECT payload FROM leases WHERE shop_id=?", (shop_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def _public_lease(self, shop_id):
        lease = self._lease(shop_id)
        if lease:
            lease = {k: lease.get(k) for k in ("shop_id", "client_id", "instance_id", "session_id", "generation", "expires_at", "capabilities")}
        return lease

    def _check_lease(self, identity, p):
        lease = self._lease(identity["shop_id"])
        require(lease and lease["expires_at"] > time.time(), "lease_expired", 409)
        require(lease["client_id"] == identity["client_id"] and all(lease[k] == p.get(k) for k in ("instance_id", "session_id", "generation")), "lease_mismatch", 409)
        return lease

    def _resolve_recovery(self, shop_id, lease, now):
        """Release recovered events for the original owner; supersede the rest."""
        for row in self.db.execute("SELECT * FROM events WHERE shop_id=? AND state='pending'", (shop_id,)).fetchall():
            delivery = json.loads(row["delivery"])
            if not delivery.get("recovered"):
                continue
            delivery.pop("recovered")
            self._delivery(row, delivery)
            p = json.loads(row["payload"])
            same_owner = row["client_id"] == lease["client_id"] and p["instance_id"] == lease["instance_id"] and p["session_id"] == lease["session_id"]
            if not same_owner:
                # A different instance/session must never execute this event, and
                # it must not block the conversation forever either.
                self._finish(shop_id, row["event_id"], {"action": "none", "text": "", "reason": "superseded", "expires_at": now})
                self._clocks.pop((shop_id, row["event_id"]), None)

    def heartbeat(self, identity, p):
        require(isinstance(p, dict) and identifier(p.get("instance_id")) and identifier(p.get("session_id")), "invalid_heartbeat")
        caps = p.get("capabilities", [])
        require(isinstance(caps, list) and len(caps) <= 10 and all(isinstance(cap, str) and 0 < len(cap) <= 32 for cap in caps), "invalid_capabilities")
        require(len(set(caps)) == len(caps), "invalid_capabilities")
        with self.lock, self.db:
            old, now = self._lease(identity["shop_id"]), time.time()
            owner = old and old["client_id"] == identity["client_id"] and old["instance_id"] == p["instance_id"]
            require(not old or old["expires_at"] <= now or owner, "lease_busy", 409)
            same = owner and old["session_id"] == p["session_id"] and old["expires_at"] > now
            # Resuming right after a restart keeps the fencing generation so that
            # pre-restart pending events from this exact session stay claimable.
            resumed = owner and old["session_id"] == p["session_id"] and bool(old.get("restart_pending"))
            gen = old["generation"] if same or resumed else (old["generation"] + 1 if old else 1)
            lease = {"shop_id": identity["shop_id"], "client_id": identity["client_id"], "instance_id": p["instance_id"], "session_id": p["session_id"], "generation": gen, "expires_at": now + 60}
            lease["capabilities"] = [cap for cap in (senditems.CAPABILITY, deadlines.CAPABILITY, goods_snapshot.CAPABILITY, "product_knowledge",
                                                    *conversation_actions.READY_CAPABILITIES) if cap in caps]
            settings = self._settings(identity["shop_id"])
            policies = [rule.get("handling", {}) for rule in settings["rules"]] + list(settings.get("fallback", {}).values())
            if conversation_actions.TRANSFER_CAPABILITY in lease["capabilities"] and not any(policy.get("action") == "transfer" for policy in policies):
                lease["capabilities"].remove(conversation_actions.TRANSFER_CAPABILITY)
            self.db.execute("INSERT OR REPLACE INTO leases VALUES (?,?)", (identity["shop_id"], json.dumps(lease)))
            self._resolve_recovery(identity["shop_id"], lease, now)
            return lease

    def _settings(self, shop):
        require(shop in self.shop_ids, "shop_not_found", 404)
        return json.loads(self.db.execute("SELECT settings FROM shops WHERE shop_id=?", (shop,)).fetchone()[0])

    def update_settings(self, shop, p):
        clean = validate_settings(p)
        with self.lock, self.db:
            current = self._settings(shop)
            binding = self._template_binding(shop)
            template_id = p.get("template_id", binding["template_id"] if binding else None)
            if not template_id:
                require(template_id is None or template_id == "", "invalid_template")
                require(p.get("template_version") is None, "invalid_template")
                self.db.execute("DELETE FROM shop_reply_templates WHERE shop_id=?", (shop,))
            else:
                require(identifier(template_id), "invalid_template")
                template = self.db.execute("SELECT * FROM reply_templates WHERE template_id=?", (template_id,)).fetchone()
                require(template is not None, "template_not_found", 404)
                content = self._template_content(clean)
                clean.update(content)
                previous = json.loads(template["content"])
                if "template_id" not in p:
                    # Old forms may change local switches, but cannot edit a shared template unknowingly.
                    require(content == previous, "template_changed", 409)
                else:
                    require(type(p.get("template_version")) is int and p["template_version"] == template["version"],
                            "template_changed", 409)
                if content != previous:
                    self.db.execute("UPDATE reply_templates SET content=?,version=version+1 WHERE template_id=?",
                                    (json.dumps(content, ensure_ascii=False), template_id))
                    for row in self.db.execute("SELECT s.shop_id,s.settings FROM shops s JOIN shop_reply_templates b "
                                               "ON s.shop_id=b.shop_id WHERE b.template_id=? AND s.shop_id<>?",
                                               (template_id, shop)).fetchall():
                        settings = json.loads(row["settings"])
                        settings.update(content)
                        settings["version"] += 1
                        self.db.execute("UPDATE shops SET settings=? WHERE shop_id=?", (json.dumps(settings), row["shop_id"]))
                self.db.execute("INSERT OR REPLACE INTO shop_reply_templates VALUES (?,?)", (shop, template_id))
            clean["version"] = current["version"] + 1
            self.db.execute("UPDATE shops SET settings=? WHERE shop_id=?", (json.dumps(clean), shop))
            return self._admin_settings(shop, clean)

    def _template_binding(self, shop):
        return self.db.execute("SELECT t.template_id,t.version FROM reply_templates t JOIN shop_reply_templates b "
                               "ON t.template_id=b.template_id WHERE b.shop_id=?", (shop,)).fetchone()

    def _admin_settings(self, shop, settings):
        binding = self._template_binding(shop)
        return {**settings, "template_id": binding["template_id"], "template_version": binding["version"]} if binding else settings

    @staticmethod
    def _template_view(row):
        return {"template_id": row["template_id"], "name": row["name"], "version": row["version"], **json.loads(row["content"])}

    @staticmethod
    def _template_content(settings):
        content = {key: copy.deepcopy(settings[key]) for key in TEMPLATE_FIELDS}
        for rule in content["rules"]:
            if rule.get("description") == "":
                rule.pop("description")
        return content

    def reply_templates(self):
        with self.lock:
            return [self._template_view(row) for row in self.db.execute("SELECT * FROM reply_templates ORDER BY name,template_id")]

    def create_reply_template(self, p):
        require(isinstance(p, dict) and set(p) == {"name", *TEMPLATE_FIELDS}, "invalid_template")
        name = p["name"]
        require(isinstance(name, str) and 1 <= len(name.strip()) <= 80, "invalid_template_name")
        clean = validate_settings({**p, "enabled": False})
        content = self._template_content(clean)
        with self.lock, self.db:
            require(not self.db.execute("SELECT 1 FROM reply_templates WHERE name=?", (name.strip(),)).fetchone(),
                    "template_name_exists", 409)
            template_id = uuid.uuid4().hex
            self.db.execute("INSERT INTO reply_templates VALUES (?,?,?,1)",
                            (template_id, name.strip(), json.dumps(content, ensure_ascii=False)))
            return {"template_id": template_id, "name": name.strip(), "version": 1, **content}

    def update_reply_template(self, template_id, p):
        require(isinstance(template_id, str) and re.fullmatch(r"[0-9a-f]{32}", template_id), "invalid_template")
        require(isinstance(p, dict) and set(p) == {"name", "version", *TEMPLATE_FIELDS}, "invalid_template")
        require(type(p["version"]) is int and p["version"] > 0, "invalid_template")
        name = p["name"]
        require(isinstance(name, str) and 1 <= len(name.strip()) <= 80, "invalid_template_name")
        content = self._template_content(validate_settings({**p, "enabled": False}))
        with self.lock, self.db:
            row = self.db.execute("SELECT * FROM reply_templates WHERE template_id=?", (template_id,)).fetchone()
            require(row is not None, "template_not_found", 404)
            require(p["version"] == row["version"], "template_changed", 409)
            require(not self.db.execute("SELECT 1 FROM reply_templates WHERE name=? AND template_id<>?",
                                        (name.strip(), template_id)).fetchone(), "template_name_exists", 409)
            changed = content != json.loads(row["content"])
            if changed or name.strip() != row["name"]:
                self.db.execute("UPDATE reply_templates SET name=?,content=?,version=version+1 WHERE template_id=?",
                                (name.strip(), json.dumps(content, ensure_ascii=False), template_id))
                if changed:
                    for shop in self.db.execute("SELECT s.shop_id,s.settings FROM shops s JOIN shop_reply_templates b "
                                                "ON s.shop_id=b.shop_id WHERE b.template_id=?", (template_id,)).fetchall():
                        settings = json.loads(shop["settings"])
                        settings.update(content)
                        settings["version"] += 1
                        self.db.execute("UPDATE shops SET settings=? WHERE shop_id=?",
                                        (json.dumps(settings, ensure_ascii=False), shop["shop_id"]))
            return self._template_view(self.db.execute("SELECT * FROM reply_templates WHERE template_id=?",
                                                       (template_id,)).fetchone())

    def shops(self):
        with self.lock:
            return [{"shop_id": r["shop_id"], "name": r["name"], "settings": self._admin_settings(r["shop_id"], json.loads(r["settings"])), "lease": self._public_lease(r["shop_id"])} for r in self.db.execute("SELECT * FROM shops ORDER BY shop_id") if r["shop_id"] in self.shop_ids]

    def _runtime(self, shop, event):
        row = self.db.execute("SELECT * FROM event_runtime WHERE shop_id=? AND event_id=?", (shop, event)).fetchone()
        if row is None:
            return None
        meta = dict(row)
        try:
            meta["timing"] = deadlines.sanitize_timing(json.loads(meta["timing"]))
        except (ValueError, TypeError):
            meta["timing"] = {}
        return meta

    def _save_timing(self, shop, event, timing):
        # Cancellation can also cover an old event that predates runtime metadata.
        self.db.execute("INSERT INTO event_runtime(shop_id,event_id,timing) VALUES (?,?,?) "
                        "ON CONFLICT(shop_id,event_id) DO UPDATE SET timing=excluded.timing",
                        (shop, event, json.dumps(deadlines.sanitize_timing(timing))))

    @staticmethod
    def _cancellable(row):
        delivery = json.loads(row["delivery"])
        result = json.loads(row["decision"]) if row["decision"] else {}
        return (delivery["status"] == "unclaimed" and delivery.get("attempt_id") is None
                and (row["state"] in ("pending", "processing")
                     or (row["state"] == "ready" and result.get("action") in ("reply", "send_item", "mark", "transfer"))))

    @staticmethod
    def _deadline_terminal(row):
        delivery = json.loads(row["delivery"])
        result = json.loads(row["decision"]) if row["decision"] else {}
        return (row["state"] == "ready" and result.get("action") == "handoff"
                and result.get("reason") == deadlines.REASON
                and delivery["status"] == "unclaimed" and delivery.get("attempt_id") is None)

    def _terminate_deadline(self, row, failure):
        if not self._cancellable(row):
            return
        shop, event = row["shop_id"], row["event_id"]
        self._finish(shop, event, {"action": "handoff", "text": "", "reason": deadlines.REASON, "expires_at": time.time()})
        timing = (self._runtime(shop, event) or {}).get("timing", {})
        timing["failure_class"] = failure
        self._save_timing(shop, event, timing)
        self._clocks.pop((shop, event), None)

    def _expire_deadline(self, row):
        clock = self._clocks.get((row["shop_id"], row["event_id"]))
        if clock and clock.get("deadline") is not None and time.monotonic() >= clock["deadline"]:
            self._terminate_deadline(row, "deadline_exceeded")
            self._clocks.pop((row["shop_id"], row["event_id"]), None)

    def _expire_deadlines(self):
        now = time.monotonic()
        for key, clock in list(self._clocks.items()):
            if clock.get("deadline") is not None and now >= clock["deadline"]:
                row = self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", key).fetchone()
                if row:
                    self._expire_deadline(row)

    def expire_deadlines(self):
        with self.lock, self.db:
            self._expire_deadlines()

    def job_is_active(self, job):
        with self.lock, self.db:
            row = self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (job["shop_id"], job["event_id"])).fetchone()
            self._expire_deadline(row)
            row = self.db.execute("SELECT state FROM events WHERE shop_id=? AND event_id=?", (job["shop_id"], job["event_id"])).fetchone()
            return row["state"] == "processing"

    def _row(self, identity, event_id):
        row = self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=? AND client_id=?", (identity["shop_id"], event_id, identity["client_id"])).fetchone()
        require(row is not None, "event_not_found", 404)
        return row

    def _view(self, row):
        p = json.loads(row["payload"])
        delivery = json.loads(row["delivery"])
        delivery.pop("recovered", None)
        delivery.setdefault("verification", None)
        view = {**{k: row[k] for k in ("event_id", "shop_id", "client_id", "conversation_id", "message_id", "session_id", "state", "created_at")}, "context_revision": row["revision"], "generation": p["generation"], "decision": json.loads(row["decision"]) if row["decision"] else None, "delivery": delivery}

        meta = self._runtime(row["shop_id"], row["event_id"])
        if meta:
            if "remaining_budget_ms" in p and deadlines.finite(meta["wall_deadline"]):
                view["event_deadline"] = meta["wall_deadline"]
            if meta["timing"]:
                view["timing"] = meta["timing"]
        return view

    def _delivery(self, row, value):
        self.db.execute("UPDATE events SET delivery=? WHERE shop_id=? AND event_id=?", (json.dumps(value), row["shop_id"], row["event_id"]))

    def _expire_claims(self):
        for row in self.db.execute("SELECT shop_id,event_id,delivery FROM events WHERE state='ready' "
                                   "AND json_extract(delivery,'$.status')='claimed'").fetchall():
            d = json.loads(row["delivery"])
            if d["claim_expires_at"] <= time.time():
                d.update(status="unknown", reason="claim_expired")
                self._delivery(row, d)

    def _is_latest(self, row):
        revision = self.db.execute("SELECT MAX(revision) FROM events WHERE shop_id=? AND conversation_id=? AND session_id=?", (row["shop_id"], row["conversation_id"], row["session_id"])).fetchone()[0]
        return revision == row["revision"]

    def verify(self, identity, event, p, shop=None):
        require(identity.get("role") == "admin", "admin_required", 403)
        require(isinstance(p, dict), "invalid_verification")
        require(p.get("outcome") in ("sent", "not_sent"), "invalid_verification_outcome")
        note = p.get("note")
        require(isinstance(note, str) and 1 <= len(note.strip()) <= 200, "invalid_verification_note")
        with self.lock, self.db:
            self._expire_claims()
            if shop is not None:
                self._settings(shop)
            rows = self.db.execute("SELECT * FROM events WHERE event_id=? AND (? IS NULL OR shop_id=?)", (event, shop, shop)).fetchall()
            rows = [row for row in rows if row["shop_id"] in self.shop_ids]
            require(rows, "event_not_found", 404)
            require(len(rows) == 1, "ambiguous_event", 409)
            row = rows[0]
            delivery = json.loads(row["delivery"])
            require(delivery["status"] == "unknown" and delivery.get("verification") is None, "verification_conflict", 409)
            verification = {"outcome": p["outcome"], "note": note.strip(), "verified_at": time.time()}
            self.db.execute("INSERT INTO delivery_verifications VALUES (?,?,?,?,?,?)", (row["shop_id"], event, identity["username"], verification["outcome"], verification["note"], verification["verified_at"]))
            delivery["verification"] = verification
            self._delivery(row, delivery)
            return self._view(self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (row["shop_id"], event)).fetchone())

    def enqueue(self, identity, p):
        require(isinstance(p, dict), "invalid_event")
        require("timing" not in p, "invalid_field")
        has_budget = "remaining_budget_ms" in p
        require(not has_budget or deadlines.valid_budget(p["remaining_budget_ms"]), "invalid_remaining_budget")
        validate_event(p)
        digest = hashlib.sha256(json.dumps(p, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        with self.lock, self.db:
            # The same payload returns the stored event before any lease or
            # capability check, so an older client keeps its original idempotence.
            row = self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (identity["shop_id"], p["event_id"])).fetchone()
            if row:
                require(row["client_id"] == identity["client_id"] and row["digest"] == digest, "event_conflict", 409)
                self._expire_deadline(row)
                return self._view(self._row(identity, p["event_id"]))
            lease = self._check_lease(identity, p)
            caps = lease.get("capabilities", [])
            has_mark = "mark_conversation" in caps
            if "conv_state" in p["context"]:
                require(has_mark, "capability_not_confirmed")
            if has_mark:
                require("conv_state" in p["context"], "conv_state_required")
            if "goods" in p["context"] or any("items" in order for order in p["context"].get("orders", [])):
                require(goods_snapshot.CAPABILITY in lease.get("capabilities", []), "capability_not_confirmed")
            if any(g.get("product_key") for g in p["context"].get("goods", [])) or any((m.get("card") or {}).get("product_key") for m in p["context"]["messages"]):
                require("product_knowledge" in lease.get("capabilities", []), "capability_not_confirmed")
            if has_budget:
                require(deadlines.CAPABILITY in lease.get("capabilities", []), "capability_not_confirmed")
            if "send_options" in p["context"]:
                require(senditems.CAPABILITY in lease.get("capabilities", []), "capability_not_confirmed")
            prior = self.db.execute("SELECT MAX(revision) FROM events WHERE shop_id=? AND conversation_id=? AND session_id=?", (identity["shop_id"], p["conversation_id"], p["session_id"])).fetchone()[0]
            require(prior is None or p["context_revision"] > prior, "stale_revision", 409)
            settings = self._settings(identity["shop_id"])
            delivery = {"status": "unclaimed", "attempt_id": None, "platform_message_id": None}
            accepted_wall, accepted_mono = time.time(), time.monotonic()
            budget = p.get("remaining_budget_ms")
            wall_deadline = accepted_wall + budget / 1000 if has_budget else None
            try:
                self.db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identity["shop_id"], p["event_id"], identity["client_id"], p["conversation_id"], p["message_id"], p["session_id"], p["context_revision"], settings["version"], accepted_wall, digest, json.dumps(p, ensure_ascii=False), "pending", None, json.dumps(delivery)))
            except sqlite3.IntegrityError:
                raise ApiError(409, "message_duplicate") from None
            self.db.execute("INSERT INTO event_runtime VALUES (?,?,?,?,?,?,?)",
                            (identity["shop_id"], p["event_id"], accepted_wall, budget, wall_deadline, accepted_wall, "{}"))
            self._clocks[(identity["shop_id"], p["event_id"])] = {
                "accepted": accepted_mono, "deadline": accepted_mono + budget / 1000 if has_budget else None}
            row = self._row(identity, p["event_id"])
            if has_budget and budget == 0:
                self._finish(identity["shop_id"], p["event_id"], {"action": "handoff", "text": "", "reason": deadlines.REASON, "expires_at": accepted_wall})
                self._save_timing(identity["shop_id"], p["event_id"], {"failure_class": "deadline_exceeded"})
                self._clocks.pop((identity["shop_id"], p["event_id"]), None)
            else:
                self._expire_deadline(row)
            return self._view(self._row(identity, p["event_id"]))

    def next_job(self, accept=None, after_shop=None):
        """Claim one eligible job; an optional pure predicate leaves others pending."""
        with self.lock, self.db:
            self._expire_claims()
            self._expire_deadlines()
            query = "SELECT shop_id,event_id,delivery FROM events WHERE state='pending' ORDER BY "
            order, params = ("created_at", ()) if after_shop is None else ("shop_id <= ?, shop_id, created_at", (after_shop,))
            candidates = self.db.execute(query + order, params)
        try:
            examined = 0
            while True:
                # Release the lock between candidates so a full model pool's
                # backlog scan cannot hold up ingress/heartbeats for the whole queue.
                if examined and examined % 16 == 0:
                    # RLock reacquisition is not fair; let waiting HTTP threads run.
                    time.sleep(0.001)
                examined += 1
                with self.lock, self.db:
                    candidate = candidates.fetchone()
                    if candidate is None:
                        return None
                    # Recovered image payloads remain unread until their owner resumes.
                    if json.loads(candidate["delivery"]).get("recovered"):
                        continue
                    row = self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=? AND state='pending'", (candidate["shop_id"], candidate["event_id"])).fetchone()
                    if row is None:
                        continue
                    self._expire_deadline(row)
                    if self._deadline_terminal(self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (row["shop_id"], row["event_id"])).fetchone()):
                        continue
                    p = json.loads(row["payload"])
                    settings = self._settings(row["shop_id"])
                    reason, capabilities = None, []
                    if not self._is_latest(row):
                        reason = "superseded"
                    elif settings["version"] != row["settings_version"]:
                        reason = "settings_changed"
                    else:
                        try:
                            lease = self._check_lease({"shop_id": row["shop_id"], "client_id": row["client_id"]}, p)
                            capabilities = lease.get("capabilities", [])
                        except ApiError as exc:
                            reason = exc.code
                    job = {"shop_id": row["shop_id"], "event_id": row["event_id"], "payload": p, "settings": settings, "block_reason": reason, "capabilities": capabilities}
                    if accept is not None and not accept(job):
                        continue
                    self.db.execute("UPDATE events SET state='processing' WHERE shop_id=? AND event_id=?", (row["shop_id"], row["event_id"]))
                    clock = self._clocks.setdefault((row["shop_id"], row["event_id"]), {})
                    clock["started"] = time.monotonic()
                    if "accepted" in clock:
                        self._save_timing(row["shop_id"], row["event_id"], {"queue_wait_ms": deadlines.elapsed_ms(clock["accepted"], clock["started"])})
                    if clock.get("deadline") is not None:
                        job["deadline_monotonic"] = clock["deadline"]
                    return job
        finally:
            with self.lock:
                candidates.close()

    def _finish(self, shop, event, decision):
        self.db.execute("UPDATE events SET state='ready',decision=? WHERE shop_id=? AND event_id=?", (json.dumps(decision, ensure_ascii=False), shop, event))

    def finish(self, job, decision):
        with self.lock, self.db:
            row = self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (job["shop_id"], job["event_id"])).fetchone()
            self._expire_deadline(row)
            row = self.db.execute("SELECT * FROM events WHERE shop_id=? AND event_id=?", (job["shop_id"], job["event_id"])).fetchone()
            if row["state"] != "processing":
                # A duplicate/late completion cannot overwrite an existing decision or delivery.
                return json.loads(row["decision"]) if row["decision"] else {"action": "none", "text": "", "reason": "superseded", "expires_at": time.time()}
            decision = self._action_fallback(job, decision)
            if decision.get("action") in ("reply", "send_item", "mark", "transfer"):
                # Re-read all permission inputs after asynchronous model work.
                identity = {"shop_id": row["shop_id"], "client_id": row["client_id"]}
                original = json.loads(row["payload"])
                reason = None
                try:
                    require(self._is_latest(row), "superseded", 409)
                    settings = self._settings(row["shop_id"])
                    require(settings["enabled"] and settings["version"] == row["settings_version"], "settings_changed", 409)
                    lease = self._check_lease(identity, original)
                    if decision["action"] == "send_item":
                        require(senditems.CAPABILITY in lease.get("capabilities", []), "capability_not_confirmed", 409)
                        require(senditems.valid_item(decision.get("item"), original["context"]), "invalid_send_item", 409)
                    elif decision["action"] in ("mark", "transfer"):
                        require(self._valid_conversation_decision(decision, original["context"],
                                                                 lease.get("capabilities", []), settings),
                                "invalid_conversation_action", 409)
                except ApiError as exc:
                    reason = exc.code
                if reason:
                    decision = {"action": "none", "text": "", "reason": reason, "expires_at": time.time()}
            self._finish(job["shop_id"], job["event_id"], decision)
            key = (job["shop_id"], job["event_id"])
            clock = self._clocks.get(key, {})
            timing = (self._runtime(*key) or {}).get("timing", {})
            supplied = deadlines.sanitize_timing(job.get("timing"))
            timing.update({k: v for k, v in supplied.items() if k not in ("queue_wait_ms", "decision_ms")})
            if "started" in clock:
                timing["decision_ms"] = deadlines.elapsed_ms(clock["started"], time.monotonic())
            if decision["action"] != "handoff":
                timing.pop("failure_class", None)
            elif "failure_class" not in timing:
                failure = deadlines.failure_class_for_reason(decision.get("reason"))
                if failure:
                    timing["failure_class"] = failure
            self._save_timing(*key, timing)
            if decision["action"] not in ("reply", "send_item", "mark", "transfer") or clock.get("deadline") is None:
                self._clocks.pop(key, None)
            return decision

    @staticmethod
    def _valid_conversation_decision(result, context, capabilities, settings):
        if not conversation_actions.valid_decision(result, context, capabilities, settings["version"]):
            return False
        source, _, key = result["reason"].partition(":")
        if source == "fallback":
            policy = settings.get("fallback", {}).get(key)
        elif source in ("rule", "rule_semantic"):
            policy = next((rule.get("handling") for rule in settings["rules"] if rule["id"] == key), None)
        else:
            policy = None
        if policy is None:
            return False
        expected = conversation_actions.resolve(policy, context, capabilities, settings["version"], result["reason"])
        return expected == {key: value for key, value in result.items() if key != "expires_at"}

    @staticmethod
    def _action_fallback(job, result):
        """Only saved server policies turn an eligible judgment into an action."""
        if (result.get("action") != "handoff" or job.get("block_reason")
                or not job["settings"]["enabled"]):
            return result
        reason = result.get("reason", "")
        if reason == deadlines.REASON:
            return result
        if reason == "no_matching_rule" or reason.startswith(("model:", "vehicle_handoff:")):
            kind = "unhandled"
        elif reason == "decision_internal_error" or reason == "model_not_configured" or reason == "vehicle_knowledge_unavailable":
            kind = "error"
        elif reason.startswith("model_unavailable:"):
            failures = [item.rpartition("=")[2] for item in reason.removeprefix("model_unavailable:").split(",")
                        if not item.endswith("=not_configured")]
            kind = "model_timeout" if failures and failures[-1] == "timeout" else "error"
        else:
            return result
        policy = job["settings"].get("fallback", {}).get(kind)
        if policy is None or policy["action"] == "handoff":
            return result
        resolved = conversation_actions.resolve(policy, job["payload"]["context"], job.get("capabilities", []),
                                                job["settings"]["version"], "fallback:" + kind)
        return {**resolved, "expires_at": result["expires_at"]}

    def get(self, identity, event):
        with self.lock, self.db:
            self._expire_claims()
            self._expire_deadline(self._row(identity, event))
            return self._view(self._row(identity, event))

    def cancel(self, identity, event, p):
        require(isinstance(p, dict), "invalid_cancel")
        require("timing" not in p, "invalid_field")
        require(set(p) == {"instance_id", "session_id", "generation", "reason"}, "invalid_cancel")
        require(identifier(p["instance_id"]) and identifier(p["session_id"]), "invalid_cancel")
        require(type(p["generation"]) is int and p["generation"] > 0 and p["reason"] == deadlines.REASON, "invalid_cancel")
        with self.lock:
            # Commit automatic expiry even if a later permission check rejects cancel.
            with self.db:
                row = self._row(identity, event)
                original = json.loads(row["payload"])
                require(all(original[k] == p[k] for k in ("instance_id", "session_id", "generation")), "cancel_owner_mismatch", 409)
                self._expire_deadline(row)
            with self.db:
                row = self._row(identity, event)
                if self._deadline_terminal(row):
                    return self._view(row)
                lease = self._lease(identity["shop_id"])
                require(lease and deadlines.CAPABILITY in lease.get("capabilities", [])
                        and lease["client_id"] == identity["client_id"]
                        and all(lease[k] == p[k] for k in ("instance_id", "session_id", "generation")), "capability_not_confirmed", 409)
                self._check_lease(identity, p)
                require(self._cancellable(row), "cancel_not_allowed", 409)
                self._terminate_deadline(row, "cancelled")
                return self._view(self._row(identity, event))

    def claim(self, identity, event, p):
        require(isinstance(p, dict) and identifier(p.get("attempt_id")), "invalid_attempt_id")
        with self.lock:
            with self.db:
                row = self._row(identity, event)
                original = json.loads(row["payload"])
                require(all(original[k] == p.get(k) for k in ("instance_id", "session_id", "generation")), "event_session_mismatch", 409)
                self._expire_claims()
                self._expire_deadline(row)
            with self.db:
                row = self._row(identity, event)
                d = json.loads(row["delivery"])
                require(d["status"] in ("unclaimed", "claimed"), "delivery_terminal", 409)
                require(d["attempt_id"] is None or d["attempt_id"] == p["attempt_id"], "attempt_conflict", 409)
                require(not self._deadline_terminal(row), deadlines.REASON, 409)
                lease = self._check_lease(identity, p)
                decision = json.loads(row["decision"]) if row["decision"] else None
                require(row["state"] == "ready" and decision and decision["action"] in ("reply", "send_item", "mark", "transfer"), "not_reply", 409)
                if decision["action"] == "send_item":
                    require(senditems.CAPABILITY in lease.get("capabilities", []), "capability_not_confirmed", 409)
                    require(senditems.valid_item(decision.get("item"), original["context"]), "invalid_send_item", 409)
                require(decision["expires_at"] > time.time(), "decision_expired", 409)
                require(self._is_latest(row), "superseded", 409)
                settings = self._settings(identity["shop_id"])
                require(settings["enabled"] and settings["version"] == row["settings_version"], "settings_changed", 409)
                if decision["action"] in ("mark", "transfer"):
                    require(self._valid_conversation_decision(decision, original["context"],
                                                             lease.get("capabilities", []), settings),
                            "invalid_conversation_action", 409)
                if d["status"] == "unclaimed":
                    d.update(status="claimed", attempt_id=p["attempt_id"], claim_expires_at=time.time() + 10)
                    self._delivery(row, d)
                    self._clocks.pop((row["shop_id"], event), None)
                return self._view(self._row(identity, event))

    def receipt(self, identity, event, p):
        require(isinstance(p, dict) and identifier(p.get("attempt_id")), "invalid_attempt_id")
        require(p.get("status") in ("sent", "not_sent", "unknown"), "invalid_receipt_status")
        with self.lock, self.db:
            self._expire_claims()
            row = self._row(identity, event)
            d = json.loads(row["delivery"])
            require(d["attempt_id"] == p["attempt_id"], "attempt_mismatch", 409)
            result = json.loads(row["decision"]) if row["decision"] else {}
            if result.get("action") in ("mark", "transfer"):
                clean = conversation_actions.receipt(result["action"], result, p, require)
                if d["status"] != "claimed":
                    require(d["status"] == clean["status"], "receipt_conflict", 409)
                    if "steps" in d:
                        require(all(d.get(key) == clean.get(key) for key in ("steps", "page_observed", "reason")),
                                "receipt_conflict", 409)
                    else:
                        require(d["status"] == "unknown", "receipt_conflict", 409)
                    return self._view(row)
                d.update(clean, platform_message_id=None, recorded_at=time.time())
                self._delivery(row, d)
                return self._view(self._row(identity, event))
            require("steps" not in p, "invalid_receipt_steps")
            if p["status"] == "sent":
                require(identifier(p.get("platform_message_id")), "platform_message_id_required")
            platform_id = p.get("platform_message_id") if p["status"] == "sent" else None
            if d["status"] != "claimed":
                require(d["status"] == p["status"] and d.get("platform_message_id") == platform_id, "receipt_conflict", 409)
            else:
                d.update(status=p["status"], platform_message_id=platform_id, recorded_at=time.time())
                self._delivery(row, d)
            return self._view(self._row(identity, event))

    def events(self, shop=None, limit=50):
        with self.lock, self.db:
            self._expire_claims()
            self._expire_deadlines()
            if shop:
                self._settings(shop)
            rows = self.db.execute("SELECT * FROM events WHERE (? IS NULL OR shop_id=?) ORDER BY created_at DESC LIMIT ?", (shop, shop, limit)).fetchall()
            return [self._view(row) for row in rows if row["shop_id"] in self.shop_ids]

    def summary(self):
        counts = {k: 0 for k in ("pending", "processing", "ready", "sent", "unknown")}
        with self.lock, self.db:
            self._expire_claims()
            self._expire_deadlines()
            if self.shop_ids:
                shops = tuple(sorted(self.shop_ids))
                placeholders = ",".join("?" for _ in shops)
                for row in self.db.execute(
                    "SELECT state,json_extract(delivery,'$.status') AS delivery_status,COUNT(*) AS total "
                    f"FROM events WHERE shop_id IN ({placeholders}) GROUP BY state,delivery_status", shops):
                    counts[row["state"]] += row["total"]
                    if row["delivery_status"] in ("sent", "unknown"):
                        counts[row["delivery_status"]] += row["total"]
        return {"counts": counts, "protocol_version": "1.0"}
