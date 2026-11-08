"""Small standalone HTTP service; bind privately, publish only behind HTTPS."""
import copy
import hmac
import json
import os
import time
import uuid
import threading
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import parse_qs, urlsplit

from . import chatbatch, chatrules, diagnostics, importjobs, modelconfig, modelworker, promptdraft, promptmerge, vehicle_knowledge
from . import productcatalog, productmodel
from .auth import AdminAuth
from .backups import BackupManager
from .operations import Operations
from .content import MAX_EVENT_BYTES
from .engine import ProviderFailure, decide, decision, immediate_decision, test_slot
from .localshops import LocalShops
from .store import ApiError, Store, identifier, require, validate_settings

PROTOCOL_VERSION = "1.0"
STATIC = Path(__file__).parent / "static"
MODEL_CONCURRENCY = 2
# Routes an administrator may use while the initial default password is pending
# replacement. Every other /api/v1/admin route is refused before touching data.
FIRST_LOGIN_ROUTES = {
    ("/api/v1/admin/password", "POST"),
    ("/api/v1/admin/logout", "POST"),
}


def validate_config(config):
    require(isinstance(config, dict), "invalid_config")
    admin = config.get("admin_token")
    shops, clients = config.get("shops"), config.get("clients")
    require(isinstance(shops, list) and len(shops) > 0 and isinstance(clients, list), "invalid_config_lists")
    # Legacy administrator tokens never authenticate. Reserve the value so it
    # cannot accidentally become a client credential during migration.
    require(admin is None or isinstance(admin, str), "invalid_admin_token")
    shop_ids, client_ids, tokens = set(), set(), {admin} if admin else set()
    for shop in shops:
        require(isinstance(shop, dict) and identifier(shop.get("shop_id")) and shop["shop_id"] not in shop_ids, "invalid_shop_config")
        require(isinstance(shop.get("name"), str) and 0 < len(shop["name"]) <= 128, "invalid_shop_name")
        shop_ids.add(shop["shop_id"])
    for client in clients:
        require(isinstance(client, dict) and identifier(client.get("client_id")) and client["client_id"] not in client_ids, "invalid_client_config")
        require(client.get("shop_id") in shop_ids, "invalid_client_shop")
        token = client.get("token")
        require(isinstance(token, str) and len(token) >= 32 and token.isascii() and token not in tokens, "invalid_client_token")
        client_ids.add(client["client_id"])
        tokens.add(token)
    require(isinstance(config.get("model", {}), dict), "invalid_model_config")
    knowledge = config.get("vehicle_knowledge", {})
    require(isinstance(knowledge, dict) and set(knowledge) <= shop_ids,
            "invalid_vehicle_knowledge_config")
    require(all(isinstance(path, str) and Path(path).is_absolute()
                for path in knowledge.values()), "invalid_vehicle_knowledge_config")
    # Shops whose replies use the tested vehicle logic (vehicle_lookup_v2); absent means the original lookup.
    v2 = config.get("vehicle_lookup_v2", [])
    require(isinstance(v2, list) and all(isinstance(shop, str) and shop in knowledge for shop in v2)
            and len(set(v2)) == len(v2), "invalid_vehicle_lookup_v2_config")


def reject_constant(_):
    raise ValueError("non_finite_json")


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate_json_key")
        obj[key] = value
    return obj


class Handler(BaseHTTPRequestHandler):
    server_version = "ClawNext/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        # Request paths, bodies and credentials are not written to general logs.
        pass

    def _send(self, status, value, content_type="application/json; charset=utf-8"):
        self.response_status = status
        if isinstance(value, dict) and "event_id" in value and "shop_id" in value:
            diagnostics.emit("event_snapshot", event_ref=diagnostics.reference(value["shop_id"], value["event_id"]),
                             state=value.get("state"), delivery=value.get("delivery", {}).get("status"))
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() if isinstance(value, (dict, list)) else value
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self):
        require(self.headers.get("Content-Type", "").split(";")[0].strip().lower() == "application/json", "json_required", 415)
        require(not self.headers.get("Transfer-Encoding"), "transfer_encoding_unsupported")
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "invalid_content_length") from None
        limit = MAX_EVENT_BYTES if self.command == "POST" and urlsplit(self.path).path == "/api/v1/events" else 262144
        if self.command == "POST" and urlsplit(self.path).path in (
                "/api/v1/admin/chat-import", "/api/v1/admin/chat-import/jobs"):
            # JSON escaping can expand a 10 MiB text file. Only this authenticated
            # import endpoint accepts the larger envelope; decoded text is capped.
            limit = 4 * chatrules.MAX_INPUT_BYTES
        elif self.command == "POST" and urlsplit(self.path).path in (
                "/api/v1/admin/rule-draft", "/api/v1/admin/rule-draft/jobs"):
            limit = 4 * 1024 * 1024
        require(0 < size <= limit, "body_too_large" if size > limit else "body_required", 413 if size > limit else 400)
        try:
            value = json.loads(self.rfile.read(size), parse_constant=reject_constant, object_pairs_hook=unique_object)
        except (ValueError, UnicodeError):
            raise ApiError(400, "invalid_json") from None
        require(isinstance(value, dict), "object_required")
        return value

    def _identity(self):
        header = self.headers.get("Authorization", "")
        require(header.startswith("Bearer ") and len(header) <= 1024 and header.isascii(), "unauthorized", 401)
        token = header[7:]
        config = self.server.config
        for client in config["clients"]:
            if hmac.compare_digest(token, client["token"]):
                return {"role": "client", "client_id": client["client_id"], "shop_id": client["shop_id"]}
        identity = self.server.local_shops.identity(token)
        if identity is not None:
            return identity
        return self.server.auth.identity(token)

    def _require_local_handoff(self):
        # Proxy headers do not prove a local caller or replace its credential.
        require(self.client_address[0] in ("127.0.0.1", "::1"), "local_only", 403)

    def _model_test(self, store):
        """Authorize and snapshot under the auth lock, then call the provider outside it."""
        with self.server.auth.lock:
            identity = self._identity()
            require(identity["role"] == "admin", "admin_required", 403)
            require(not identity["must_change_password"], "admin_password_change_required", 403)
            payload = self._json()
            require(isinstance(payload, dict) and set(payload) == {"slot", "version"}, "invalid_model_test")
            slot, version = payload.get("slot"), payload.get("version")
            require(slot in modelconfig.SLOTS, "invalid_model_slot")
            require(type(version) is int and version >= 0, "invalid_model_test")
            config = store.model_config(self.server.config.get("model", {}))
            # A stale page must never test (or display) a configuration that changed.
            require(version == config["version"], "model_config_changed", 409)
            snapshot = copy.deepcopy(config)
        result = test_slot(snapshot, slot)
        current = store.model_config(self.server.config.get("model", {}))
        if current["version"] != snapshot["version"]:
            result = {**result, "ok": False, "reason": "stale_test_result", "version": snapshot["version"]}
        return self._send(200, result)

    def _prompt_draft(self, store):
        with self.server.auth.lock:
            identity = self._identity()
            require(identity["role"] == "admin", "admin_required", 403)
            require(not identity["must_change_password"], "admin_password_change_required", 403)
            payload = self._json()
            require(set(payload) == {"shop_id", "brief", "version"}, "invalid_prompt_draft")
            require(identifier(payload["shop_id"]), "invalid_shop_id")
            require(any(s["shop_id"] == payload["shop_id"] for s in store.shops()), "shop_not_found", 404)
            brief = payload["brief"]
            require(isinstance(brief, str) and 1 <= len(brief.strip()) <= promptdraft.MAX_BRIEF,
                    "invalid_prompt_brief")
            config = copy.deepcopy(store.model_config(self.server.config.get("model", {})))
            require(type(payload["version"]) is int and payload["version"] >= 0, "invalid_prompt_draft")
            require(payload["version"] == config["version"], "model_config_changed", 409)
        # A slow provider must not block logout, password changes or shop settings.
        require(self.server.prompt_draft_slot.acquire(blocking=False), "prompt_draft_busy", 429)
        try:
            try:
                draft = promptdraft.generate(brief.strip(), config)
            except ProviderFailure as exc:
                # Never return provider bodies, credentials or the brief in errors.
                diagnostics.emit("prompt_draft_failed", code=exc.code)
                raise ApiError(502, "prompt_draft_unavailable") from None
            with self.server.auth.lock:
                identity = self._identity()
                require(identity["role"] == "admin" and not identity["must_change_password"], "admin_required", 403)
                require(store.model_config(self.server.config.get("model", {}))["version"] == config["version"],
                        "model_config_changed", 409)
                return self._send(200, {"draft": draft, "shop_id": payload["shop_id"],
                                        "version": config["version"]})
        finally:
            self.server.prompt_draft_slot.release()

    def _admin_assist(self, path, store):
        """Import/preview only; never persist uploaded conversations or drafts."""
        importing = path.endswith("/chat-import")
        merging = path.endswith("/prompt-merge")
        with self.server.auth.lock:
            identity = self._identity()
            require(identity["role"] == "admin", "admin_required", 403)
            require(not identity["must_change_password"], "admin_password_change_required", 403)
            payload = self._json()
            common = {"shop_id", "version", "shop_version"}
            expected = {"shop_id", "filename", "text"} if importing else common | (
                {"current_prompt", "supplement"} if merging else {"pairs", "existing_rules"})
            require(set(payload) == expected, "invalid_assist_request")
            require(identifier(payload["shop_id"]), "invalid_shop_id")
            shop = next((s for s in store.shops() if s["shop_id"] == payload["shop_id"]), None)
            require(shop is not None, "shop_not_found", 404)
            shop_version = shop["settings"]["version"]
            config = None
            if not importing:
                require(type(payload["shop_version"]) is int and payload["shop_version"] == shop_version,
                        "shop_settings_changed", 409)
                config = copy.deepcopy(store.model_config(self.server.config.get("model", {})))
                require(type(payload["version"]) is int and payload["version"] == config["version"],
                        "model_config_changed", 409)
            if importing:
                require(isinstance(payload["filename"], str) and len(payload["filename"]) <= 255,
                        "invalid_chat_import")
                require(isinstance(payload["text"], str), "invalid_chat_import")
                try:
                    text_size = len(payload["text"].encode("utf-8"))
                except UnicodeError:
                    raise ApiError(400, "invalid_chat_import") from None
                require(0 < text_size <= chatrules.MAX_INPUT_BYTES, "invalid_chat_import")
            elif merging:
                for name, limit in (("current_prompt", 8000), ("supplement", 4000)):
                    require(isinstance(payload[name], str) and 1 <= len(payload[name].strip()) <= limit,
                            "invalid_prompt_merge")
            else:
                rules = validate_settings({"enabled": False, "mode": "rules", "system_prompt": "",
                                           "rules": payload["existing_rules"]})["rules"]
        require(self.server.prompt_draft_slot.acquire(blocking=False), "prompt_draft_busy", 429)
        try:
            try:
                if importing:
                    result = chatrules.parse_import(payload["filename"], payload["text"])
                elif merging:
                    result = promptmerge.generate(payload["current_prompt"], payload["supplement"], config)
                else:
                    pairs = chatrules.validate_pairs(payload["pairs"])
                    result = chatrules.generate(pairs, rules, config)
            except ValueError:
                raise ApiError(400, "invalid_chat_import") from None
            except ProviderFailure as exc:
                diagnostics.emit("admin_assist_failed", code=exc.code)
                raise ApiError(502, "assist_unavailable") from None
            with self.server.auth.lock:
                identity = self._identity()
                require(identity["role"] == "admin" and not identity["must_change_password"], "admin_required", 403)
                current = next((s for s in store.shops() if s["shop_id"] == payload["shop_id"]), None)
                require(current is not None and current["settings"]["version"] == shop_version,
                        "shop_settings_changed", 409)
                if config is not None:
                    require(store.model_config(self.server.config.get("model", {}))["version"] == config["version"],
                            "model_config_changed", 409)
                    result["version"] = config["version"]
                return self._send(200, {**result, "shop_id": payload["shop_id"], "shop_version": shop_version})
        finally:
            self.server.prompt_draft_slot.release()

    def _assist_job(self, kind, method, job_id, store):
        manager = self.server.assist_jobs
        with self.server.auth.lock:
            identity = self._identity()
            require(identity["role"] == "admin", "admin_required", 403)
            require(not identity["must_change_password"], "admin_password_change_required", 403)
            token = self.headers["Authorization"][7:]
            owner = manager.owner(token)
            if job_id is not None:
                require(method in ("GET", "DELETE"), "not_found", 404)
                value = manager.get(job_id, owner, kind)
                require(value is not None, "chat_import_not_found", 404)
                shop = next((s for s in store.shops() if s["shop_id"] == value["shop_id"]), None)
                if shop is None or shop["settings"]["version"] != value["shop_version"]:
                    manager.cancel(job_id, owner, kind)
                    raise ApiError(409, "shop_settings_changed")
                if kind == "rules" and store.model_config(self.server.config.get("model", {}))["version"] != value["version"]:
                    manager.cancel(job_id, owner, kind)
                    raise ApiError(409, "model_config_changed")
                if method == "DELETE":
                    value = manager.cancel(job_id, owner, kind)
                return self._send(200, value)
            require(method == "POST", "not_found", 404)
            payload = self._json()
            expected = {"shop_id", "filename", "text"} if kind == "import" else {
                "shop_id", "shop_version", "version", "import_job_id", "existing_rules"}
            require(set(payload) == expected, "invalid_assist_request")
            require(identifier(payload["shop_id"]), "invalid_shop_id")
            shop = next((s for s in store.shops() if s["shop_id"] == payload["shop_id"]), None)
            require(shop is not None, "shop_not_found", 404)
            shop_id, shop_version = payload["shop_id"], shop["settings"]["version"]
            config = None
            if kind == "import":
                require(isinstance(payload["filename"], str) and 0 < len(payload["filename"]) <= 255,
                        "invalid_chat_import")
                require(isinstance(payload["text"], str), "invalid_chat_import")
                try:
                    size = len(payload["text"].encode("utf-8"))
                except UnicodeError:
                    raise ApiError(400, "invalid_chat_import") from None
                require(0 < size <= chatrules.MAX_INPUT_BYTES, "invalid_chat_import")
            else:
                require(type(payload["shop_version"]) is int and payload["shop_version"] == shop_version,
                        "shop_settings_changed", 409)
                config = copy.deepcopy(store.model_config(self.server.config.get("model", {})))
                require(type(payload["version"]) is int and payload["version"] == config["version"],
                        "model_config_changed", 409)
                require(isinstance(payload["import_job_id"], str), "invalid_assist_request")
                imported = manager.get(payload["import_job_id"], owner, "import")
                require(imported is not None, "chat_import_not_found", 404)
                require(imported["shop_id"] == shop_id and imported["shop_version"] == shop_version,
                        "shop_settings_changed", 409)
                require(imported["status"] == "completed", "chat_import_not_ready", 409)
                rules = validate_settings({"enabled": False, "mode": "rules", "system_prompt": "",
                                           "rules": payload["existing_rules"]})["rules"]

            def current():
                # Called between local batches and BEFORE every subsequent model
                # call, so revoked/stale work cannot keep starting API requests.
                with self.server.auth.lock:
                    try:
                        auth = self.server.auth.identity(token)
                    except ApiError:
                        return False
                    live = next((s for s in store.shops() if s["shop_id"] == shop_id), None)
                    return (not auth["must_change_password"] and live is not None
                            and live["settings"]["version"] == shop_version
                            and (config is None or store.model_config(self.server.config.get("model", {}))["version"] == config["version"]))

            def run(progress, cancelled):
                stop = lambda: cancelled() or not current()
                if kind == "import":
                    return chatrules.parse_import(payload["filename"], payload["text"], full=True,
                                                  progress=progress, cancelled=stop)
                return chatbatch.analyze(imported["result"]["pairs"], rules, config,
                                         progress=progress, cancelled=stop)
            try:
                value = manager.start(kind, owner, shop_id, shop_version, run,
                                      version=None if config is None else config["version"])
            except ValueError as exc:
                code = str(exc)
                raise ApiError(429 if code == "prompt_draft_busy" else 503,
                               code if code in ("prompt_draft_busy", "assist_cancelled") else "assist_failed") from None
            return self._send(202, value)

    def _admin_route(self, path, method, parts, store):
        if len(parts) in (5, 6) and parts[3] in ("chat-import", "rule-draft") and parts[4] == "jobs":
            return self._assist_job("import" if parts[3] == "chat-import" else "rules", method,
                                    parts[5] if len(parts) == 6 else None, store)
        if method == "POST" and path in ("/api/v1/admin/chat-import", "/api/v1/admin/rule-draft",
                                         "/api/v1/admin/prompt-merge"):
            return self._admin_assist(path, store)
        if path == "/api/v1/admin/prompt-draft" and method == "POST":
            return self._prompt_draft(store)
        if path == "/api/v1/admin/model/test" and method == "POST":
            return self._model_test(store)
        # Serialize authorization and administrative mutations with password
        # changes, so a revoked session cannot race a settings update.
        with self.server.auth.lock:
            identity = self._identity()
            require(identity["role"] == "admin", "admin_required", 403)
            # A session still using the initial default password may only read
            # its own identity, log out or set a new password.
            require(not identity["must_change_password"] or (path, method) in FIRST_LOGIN_ROUTES,
                    "admin_password_change_required", 403)
            token = self.headers["Authorization"][7:]
            if path == "/api/v1/admin/handoff/grants" and method in ("GET", "POST"):
                if method == "POST":
                    require(self._json() == {}, "invalid_handoff_request")
                    result = self.server.auth.create_handoff_grant(token)
                else:
                    result = self.server.auth.list_handoff_grants(token)
                return self._send(200, {**result, "protocol_version": PROTOCOL_VERSION})
            if len(parts) == 6 and parts[3:5] == ["handoff", "grants"] and method == "DELETE":
                self.server.auth.revoke_handoff_grant(token, parts[5])
                return self._send(200, {"ok": True, "protocol_version": PROTOCOL_VERSION})
            if path == "/api/v1/admin/model" and method in ("GET", "PUT"):
                fallback = self.server.config.get("model", {})
                if method == "PUT":
                    config = store.update_model_config(self._json(), fallback)
                else:
                    config = store.model_config(fallback)
                return self._send(200, modelconfig.public_config(config, os.environ))
            if path == "/api/v1/admin/logout" and method == "POST":
                self._json()
                self.server.auth.logout(token)
                return self._send(200, {"ok": True})
            if path == "/api/v1/admin/password" and method == "POST":
                self.server.auth.change_password(token, self._json(), self.client_address[0])
                return self._send(200, {"ok": True, "reauthenticate": True})
            if path == "/api/v1/admin/summary" and method == "GET":
                summary = store.summary()
                summary["maintenance"] = {**self.server.operations.snapshot(),
                                          "worker_alive": self.server.worker.is_alive(),
                                          "backup": self.server.backups.snapshot()}
                return self._send(200, summary)
            if path == "/api/v1/admin/shops" and method == "GET":
                return self._send(200, {"shops": store.shops(), "templates": store.reply_templates()})
            if path == "/api/v1/admin/reply-templates" and method == "POST":
                return self._send(201, store.create_reply_template(self._json()))
            if len(parts) == 5 and parts[3] == "reply-templates" and method == "PUT":
                return self._send(200, store.update_reply_template(parts[4], self._json()))
            if len(parts) == 6 and parts[3] == "shops" and parts[5] == "product-learning" and method in ("GET", "POST"):
                if method == "GET":
                    return self._send(200, self.server.products.status(parts[4]))
                payload = self._json()
                require(set(payload) == {"source_url"}, "invalid_product_request")
                return self._send(202, self.server.products.request(parts[4], payload["source_url"]))
            if path == "/api/v1/admin/events" and method == "GET":
                query = parse_qs(urlsplit(self.path).query)
                try:
                    limit = int(query.get("limit", ["50"])[0])
                except ValueError:
                    raise ApiError(400, "invalid_limit") from None
                require(1 <= limit <= 200, "invalid_limit")
                return self._send(200, {"events": store.events(query.get("shop_id", [None])[0], limit)})
            if len(parts) == 6 and parts[3] == "events" and identifier(parts[4]) and parts[5] == "verify" and method == "POST":
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                shops = query.get("shop_id", [None])
                require(len(shops) == 1 and (shops[0] is None or identifier(shops[0])), "invalid_shop_id")
                return self._send(200, store.verify(identity, parts[4], self._json(), shops[0]))
            if len(parts) == 6 and parts[3] == "shops" and parts[5] == "settings" and method == "PUT":
                return self._send(200, store.update_settings(parts[4], self._json()))
            raise ApiError(404, "not_found")

    def _route(self):
        parsed = urlsplit(self.path)
        path, method = parsed.path, self.command
        if path == "/health" and method == "GET":
            return self._send(200, {"service": "claw-next", "protocol_version": PROTOCOL_VERSION, "status": "ok"})
        static = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "/products.js": ("products.js", "text/javascript; charset=utf-8"),
                  "/assist.js": ("assist.js", "text/javascript; charset=utf-8"), "/style.css": ("style.css", "text/css; charset=utf-8")}
        if path in static and method == "GET":
            name, mime = static[path]
            require((STATIC / name).is_file(), "ui_not_installed", 503)
            return self._send(200, (STATIC / name).read_bytes(), mime)
        require(path.startswith("/api/v1/"), "not_found", 404)
        if path == "/api/v1/admin/handoff" or path.startswith("/api/v1/admin/handoff/"):
            self._require_local_handoff()
        if path == "/api/v1/admin/login" and method == "POST":
            result = self.server.auth.login(self._json(), self.client_address[0])
            return self._send(200, {**result, "protocol_version": PROTOCOL_VERSION})
        if path == "/api/v1/admin/handoff/shops" and method == "POST":
            header = self.headers.get("Authorization", "")
            token = header[7:] if header.startswith("Bearer ") and len(header) <= 1024 and header.isascii() else None
            with self.server.auth.lock:
                payload = self._json()
                self.server.auth.authorize_local_shop(token, self.client_address[0], payload.get("client_token"))
                result = self.server.local_shops.register(payload)
            return self._send(200, {**result, "protocol_version": PROTOCOL_VERSION})
        if method == "POST" and path in ("/api/v1/admin/handoff", "/api/v1/admin/handoff/redeem"):
            payload = self._json()
            if path.endswith("/redeem"):
                result = self.server.auth.redeem_handoff_ticket(payload, self.client_address[0])
            else:
                require(payload == {}, "invalid_handoff_request")
                header = self.headers.get("Authorization", "")
                token = header[7:] if header.startswith("Bearer ") and len(header) <= 1024 and header.isascii() else None
                result = self.server.auth.issue_handoff_ticket(token, self.client_address[0])
            return self._send(200, {**result, "protocol_version": PROTOCOL_VERSION})
        identity, store = self._identity(), self.server.store
        if path == "/api/v1/me" and method == "GET":
            return self._send(200, {**identity, "protocol_version": PROTOCOL_VERSION})
        parts = path.strip("/").split("/")
        if len(parts) >= 3 and parts[2] == "admin":
            return self._admin_route(path, method, parts, store)
        require(identity["role"] == "client", "client_required", 403)
        if path == "/api/v1/heartbeat" and method == "POST":
            lease = store.heartbeat(identity, self._json())
            pending = self.server.products.pending(identity, lease)
            return self._send(200, {**lease, **({"product_learning": pending} if pending else {})})
        if len(parts) == 4 and parts[2] == "product-learning" and method == "POST":
            payload = self._json()
            products = self.server.products.begin(identity, parts[3], payload)
            if products is None:
                return self._send(200, self.server.products.status(identity["shop_id"]))
            error, learned = None, []
            if products and not payload["error"]:
                config = copy.deepcopy(store.model_config(self.server.config.get("model", {})))
                try:
                    learned = productmodel.learn(products, config)
                except ProviderFailure:
                    error = "product_learning_failed"
            current = self._identity()
            require(current == identity, "product_source_changed", 409)
            return self._send(200, self.server.products.finish(identity, parts[3], payload, learned, error))
        if path == "/api/v1/events" and method == "POST":
            value = store.enqueue(identity, self._json())
            self.server.wake.set()
            return self._send(202, value)
        if len(parts) in (4, 5) and parts[2] == "events" and identifier(parts[3]):
            if len(parts) == 4 and method == "GET":
                return self._send(200, store.get(identity, parts[3]))
            if len(parts) == 5 and method == "POST" and parts[4] in ("claim", "receipt", "cancel"):
                action = getattr(store, parts[4])
                value = action(identity, parts[3], self._json())
                if parts[4] == "cancel":
                    self.server.wake.set()
                return self._send(200, value)
        raise ApiError(404, "not_found")

    def _handle(self):
        started = time.monotonic()
        self.response_status = None
        words = {"api", "v1", "admin", "events", "shops", "model", "test", "login", "logout",
                 "password", "summary", "settings", "heartbeat", "me", "claim", "receipt", "cancel", "verify", "health"}
        route = "/".join(part if part in words else "*" for part in urlsplit(self.path).path.split("/")[:8])
        with diagnostics.scope(self.server.diagnostics, request_id=uuid.uuid4().hex, route=route, method=self.command):
            try:
                self._handle_request()
            except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
                diagnostics.failure("response_disconnected", exc)
            finally:
                diagnostics.emit("request_finished", status=self.response_status,
                                 duration_ms=int((time.monotonic() - started) * 1000))

    def _handle_request(self):
        try:
            self._route()
        except ApiError as exc:
            diagnostics.emit("request_rejected", code=exc.code, status=exc.status)
            self._send(exc.status, {"error": {"code": exc.code, "message": str(exc)}})
        except (BrokenPipeError, ConnectionResetError, TimeoutError) as exc:
            diagnostics.failure("request_disconnected", exc)
        except Exception as exc:
            diagnostics.failure("request_internal_error", exc)
            self._send(500, {"error": {"code": "internal_error", "message": "Request failed; check service health."}})

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = _handle


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # HTTPServer reverse-resolves the bound address, which can stall startup
        # on macOS. This service only needs the actual listening address/port.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def __init__(self, config, data_dir, host, port, startup_check=None):
        validate_config(config)
        super().__init__((host, port), Handler)
        self.config = config
        try:
            self.vehicle_catalogs = {shop: vehicle_knowledge.load_directory(path)
                                     for shop, path in config.get("vehicle_knowledge", {}).items()}
            self.store = Store(data_dir, config["shops"])
            self.products = productcatalog.ProductCatalog(self.store)
            if startup_check is not None:
                startup_check()
            self.auth = AdminAuth(data_dir)
            self.local_shops = LocalShops(self.store, config["clients"], [config["admin_token"]] if config.get("admin_token") else ())
            self.diagnostics = diagnostics.Diagnostics(data_dir)
            self.diagnostics.write("service_started")
        except Exception:
            if hasattr(self, "auth"):
                self.auth.close()
            if hasattr(self, "store"):
                self.store.close()
            super().server_close()
            raise
        self.stop, self.wake = threading.Event(), threading.Event()
        self.prompt_draft_slot = threading.BoundedSemaphore(1)
        self.assist_jobs = importjobs.JobManager(self.prompt_draft_slot)
        self.model_workers = {}
        self.operations = Operations()
        self.backups = BackupManager(data_dir)
        self.backups.start()
        self.worker = threading.Thread(target=self._work, name="claw-next-decisions", daemon=True)
        self.worker.start()

    def _work(self):
        with diagnostics.scope(self.diagnostics):
            try:
                self._work_loop()
            except Exception as exc:
                diagnostics.failure("worker_stopped_unexpectedly", exc)

    def _work_loop(self):
        last_shop = ""
        while not self.stop.is_set():
            self.wake.clear()
            self.assist_jobs.purge()
            self.store.expire_deadlines()
            for shop, (worker, future, job, started) in list(self.model_workers.items()):
                if not worker.is_alive():
                    if not future.done():
                        raise RuntimeError("model_worker_stopped")
                    self._finish_job(job, future.result(), started)
                    del self.model_workers[shop]

            immediate, model_config = None, None

            def available(job):
                nonlocal immediate, model_config
                try:
                    immediate = immediate_decision(job)
                except Exception:
                    immediate = decision("handoff", "decision_internal_error")
                if immediate is not None:
                    return True
                if len(self.model_workers) >= MODEL_CONCURRENCY or job["shop_id"] in self.model_workers:
                    return False
                # next_job invokes this while holding the same lock as its job snapshot.
                model_config = self.store.model_config(self.config.get("model", {}))
                return True

            job = self.store.next_job(accept=available, after_shop=last_shop)
            if self.stop.is_set():
                break
            if job:
                last_shop = job["shop_id"]
                started = time.monotonic()
                if immediate is not None:
                    with diagnostics.scope(self.diagnostics, event_ref=diagnostics.reference(job["shop_id"], job["event_id"])):
                        diagnostics.emit("decision_started")
                    self._finish_job(job, immediate, started)
                else:
                    # No executor backlog: excess work stays durable and pending in SQLite.
                    future = Future()
                    worker = threading.Thread(target=self._model_work, args=(job, model_config, future),
                                              name="claw-next-model", daemon=True)
                    worker.start()
                    self.model_workers[job["shop_id"]] = (worker, future, job, started)
            else:
                self.wake.wait(0.25)

    def _model_work(self, job, model_config, future):
        with diagnostics.scope(self.diagnostics, event_ref=diagnostics.reference(job["shop_id"], job["event_id"])):
            diagnostics.emit("decision_started")
            try:
                goods = job["payload"]["context"].get("goods", [])
                knowledge = self.products.knowledge(job["shop_id"], goods) if any(g.get("product_key") for g in goods) else []
                if knowledge:
                    job["product_knowledge"] = knowledge
                catalog = self.vehicle_catalogs.get(job["shop_id"])
                forced = None
                if catalog is not None and job["shop_id"] in self.config.get("vehicle_lookup_v2", []):
                    context = job["payload"]["context"]
                    found = catalog.conversation(context["messages"], context.get("orders", []))
                    if found is not None:
                        forced = found.pop("forced")
                        job["vehicle_knowledge"] = {**found, "version": 2}
                elif catalog is not None:
                    # Run in this shop's worker, outside the global store lock and
                    # scheduler. Only authenticated shop ownership selects a catalog.
                    job["vehicle_knowledge"] = catalog.lookup_context(
                        job["payload"]["context"]["messages"])
                if forced:
                    # The program's own stop (needs_human / ask limit / order with an unclear car): a person takes over.
                    result = decision("handoff", "vehicle_handoff:" + forced)
                elif job.get("vehicle_knowledge", {}).get("status") == "unavailable":
                    result = decision("handoff", "vehicle_knowledge_unavailable")
                elif job.get("deadline_monotonic") is not None:
                    result = modelworker.bounded_decide(
                        job, model_config, lambda: self.store.job_is_active(job), self.stop)
                else:
                    result = decide(job, model_config)
            except Exception as exc:
                diagnostics.failure("decision_internal_error", exc)
                result = decision("handoff", "decision_internal_error")
            self.operations.model_finished(job["shop_id"], result)
            future.set_result(result)
        self.wake.set()

    def _finish_job(self, job, result, started):
        with diagnostics.scope(self.diagnostics, event_ref=diagnostics.reference(job["shop_id"], job["event_id"])):
            result = self.store.finish(job, result)
            # Model explanations and rule IDs may contain private text.
            reason = result["reason"].split(":", 1)[0]
            diagnostics.emit("decision_finished", action=result["action"], reason=reason,
                             duration_ms=int((time.monotonic() - started) * 1000))

    def server_close(self):
        super().server_close()
        if hasattr(self, "stop"):
            self.assist_jobs.close()
            self.backups.close()
            self.stop.set()
            self.wake.set()
            deadline = time.monotonic() + 25
            self.worker.join(timeout=max(0, deadline - time.monotonic()))
            if not self.worker.is_alive():
                workers = [item[0] for item in self.model_workers.values()]
                for worker in workers:
                    worker.join(timeout=max(0, deadline - time.monotonic()))
                if any(worker.is_alive() for worker in workers):
                    return
                for _, future, job, started in self.model_workers.values():
                    if future.done():
                        self._finish_job(job, future.result(), started)
                self.model_workers.clear()
                self.auth.close()
                self.store.close()
                self.diagnostics.write("service_stopped")
                self.diagnostics.close()


def create_server(config, data_dir, host="127.0.0.1", port=0, startup_check=None):
    return Server(config, data_dir, host, port, startup_check=startup_check)
