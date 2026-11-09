"""Admin model configuration and the real test endpoint.

Everything runs against local loopback HTTP servers with synthetic providers,
fictional keys and a temporary SQLite database.  No external model is called
and no real credential exists in this repository.
"""
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
for path in (_REPO_ROOT, _TESTS_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

from backend.app import create_server  # noqa: E402
from backend.store import ApiError  # noqa: E402
from synthetic_provider import SyntheticProvider, completion, http_error  # noqa: E402
from secret_fixture import install_secret_fixture  # noqa: E402

ENV_NAME = "CLAW_NEXT_TEST_UNSET_KEY"
SAVED_KEY = "synthetic-saved-key-never-real"
CLIENT_TOKEN = "c" * 40
ADMIN_PASSWORD = "synthetic-model-admin-password"


class ModelSettingsTests(unittest.TestCase):
    def setUp(self):
        install_secret_fixture(self)
        self.tmp = tempfile.TemporaryDirectory(prefix="claw-next-model-")
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = self.tmp.name
        self.primary = SyntheticProvider().start()
        self.backup = SyntheticProvider().start()
        self.addCleanup(self.backup.stop)
        self.addCleanup(self.primary.stop)
        self.config = {"shops": [{"shop_id": "demo", "name": "虚构店"}],
                       "clients": [{"shop_id": "demo", "client_id": "client", "token": CLIENT_TOKEN}],
                       "model": {"base_url": "", "model": "", "api_key_env": ENV_NAME}}
        patcher = patch.dict(os.environ, {ENV_NAME: ""})
        patcher.start()
        self.addCleanup(patcher.stop)
        self._servers = []
        self.start()
        self.addCleanup(self.stop_all)

    # -- fixture ---------------------------------------------------------
    def start(self, config=None, data_dir=None):
        server = create_server(config or self.config, data_dir or self.data_dir)
        thread = threading.Thread(target=server.serve_forever, name="claw-next-model", daemon=True)
        thread.start()
        self._servers.append((server, thread))
        self.server, self.thread = server, thread
        self.url = "http://127.0.0.1:" + str(server.server_port)
        status, login = self.request("POST", "/api/v1/admin/login",
                                     {"username": "admin", "password": ADMIN_PASSWORD})
        if status == 401:
            status, login = self.request("POST", "/api/v1/admin/login",
                                         {"username": "admin", "password": "admin"})
            self.assertEqual(status, 200, login)
            status, changed = self.request("POST", "/api/v1/admin/password", {
                "current_password": "admin", "new_password": ADMIN_PASSWORD,
                "confirm_password": ADMIN_PASSWORD,
            }, token=login["session_token"])
            self.assertEqual(status, 200, changed)
            status, login = self.request("POST", "/api/v1/admin/login",
                                         {"username": "admin", "password": ADMIN_PASSWORD})
        self.assertEqual(status, 200, login)
        self.assertIs(login["must_change_password"], False)
        self.token = login["session_token"]
        return server

    def stop(self):
        server, thread = self._servers.pop()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        return server

    def stop_all(self):
        while self._servers:
            self.stop()

    def restart(self):
        self.stop()
        self.start()

    def request(self, method="GET", path="/api/v1/admin/model", body=None, token=None, timeout=10):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(self.url + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.load(response)

    def get_config(self):
        status, value = self.request(token=self.token)
        self.assertEqual(status, 200, value)
        return value

    def save(self, primary=None, backup=None, version=None, **legacy):
        if legacy:
            body = {**legacy, "version": self.get_config()["version"] if version is None else version}
        else:
            body = {"version": self.get_config()["version"] if version is None else version,
                    "primary": primary if primary is not None else self.slot_payload(None),
                    "backup": backup if backup is not None else self.slot_payload(None)}
        return self.request("PUT", body=body, token=self.token)

    @staticmethod
    def slot_payload(provider, model="synthetic-model", timeout=5, **extra):
        return {"base_url": provider.base_url if provider else "", "model": model if provider else "",
                "timeout_seconds": timeout, **extra}

    def save_providers(self, primary_key=None, backup_key=None):
        primary = self.slot_payload(self.primary, **({"api_key": primary_key} if primary_key is not None else {}))
        backup = self.slot_payload(self.backup, **({"api_key": backup_key} if backup_key is not None else {}))
        return self.save(primary, backup)

    def call_test(self, slot, version=None):
        return self.request("POST", "/api/v1/admin/model/test",
                            {"slot": slot, "version": self.get_config()["version"] if version is None else version},
                            token=self.token)

    def test_shop_runtime_reports_effective_order_without_secrets(self):
        status, _ = self.save(
            self.slot_payload(self.primary, model="local-model", timeout=8, api_key=SAVED_KEY),
            self.slot_payload(self.backup, model="cloud-model", timeout=6))
        self.assertEqual(status, 200)
        self.server.config.update(conversation_brain=["demo"], brain_primary_slot="backup",
                                  brain_request_timeout_seconds=15)
        store = self.server.store
        settings = store.shops()[0]["settings"]
        store.update_settings("demo", {**settings, "mode": "hybrid", "enabled": True})
        status, body = self.request(path="/api/v1/admin/shops", token=self.token)
        self.assertEqual(status, 200)
        runtime = body["shops"][0]["decision_runtime"]
        self.assertEqual(runtime["mode"], "conversation_brain")
        self.assertTrue(runtime["persistent_memory"])
        self.assertEqual(runtime["total_budget_seconds"], 20)
        self.assertEqual([m["slot"] for m in runtime["models"]], ["backup", "primary"])
        self.assertEqual([m["model"] for m in runtime["models"]], ["cloud-model", "local-model"])
        self.assertEqual([m["timeout_seconds"] for m in runtime["models"]], [15, 15])
        self.assertNotIn(SAVED_KEY, json.dumps(body))
        for model in runtime["models"]:
            self.assertEqual(set(model), {"slot", "model", "configured", "timeout_seconds"})
        self.server.config["conversation_brain"] = []
        runtime = self.request(path="/api/v1/admin/shops", token=self.token)[1]["shops"][0]["decision_runtime"]
        self.assertEqual(runtime["mode"], "legacy")
        self.assertFalse(runtime["persistent_memory"])
        self.assertEqual([m["timeout_seconds"] for m in runtime["models"]], [8, 6])
        self.server.config["conversation_brain"] = ["demo"]
        store.update_settings("demo", {**store.shops()[0]["settings"], "mode": "rules", "enabled": False})
        runtime = self.request(path="/api/v1/admin/shops", token=self.token)[1]["shops"][0]["decision_runtime"]
        self.assertEqual(runtime["mode"], "rules")
        self.assertTrue(runtime["brain_configured"])
        self.assertFalse(runtime["enabled"])
        self.assertFalse(runtime["persistent_memory"])
        self.assertEqual(runtime["models"], [])
        for token, expected in ((None, 401), (CLIENT_TOKEN, 403)):
            self.assertEqual(self.request(path="/api/v1/admin/shops", token=token)[0], expected)

    # -- GET / auth ------------------------------------------------------
    def test_auth_required_and_client_token_forbidden(self):
        for token in (None, "", CLIENT_TOKEN, "z" * 40):
            with self.subTest(token=token):
                status, body = self.request(token=token)
                self.assertEqual(status, 403 if token == CLIENT_TOKEN else 401, body)
        status, body = self.request(token=CLIENT_TOKEN)
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "admin_required")

    def test_clearing_key_disables_environment_fallback_after_restart(self):
        with patch.dict(os.environ, {ENV_NAME: "synthetic-legacy-secret"}):
            self.assertTrue(self.get_config()["primary"]["key_configured"])
            status, saved = self.save(self.slot_payload(self.primary, clear_key=True))
            self.assertEqual(status, 200)
            self.assertFalse(saved["primary"]["key_configured"])
            self.restart()
            self.assertFalse(self.get_config()["primary"]["key_configured"])
            self.assertTrue(self.call_test("primary")[1]["ok"])
            self.assertIsNone(self.primary.header(0, "Authorization"))

    def test_new_local_endpoint_does_not_inherit_legacy_environment_key(self):
        with patch.dict(os.environ, {ENV_NAME: "synthetic-legacy-secret"}):
            status, saved = self.save(self.slot_payload(self.primary))
            self.assertEqual(status, 200)
            self.assertFalse(saved["primary"]["key_configured"])
            self.assertTrue(self.call_test("primary")[1]["ok"])
            self.assertIsNone(self.primary.header(0, "Authorization"))

    def test_get_exposes_two_slots_and_version_without_secrets(self):
        with patch.dict(os.environ, {ENV_NAME: "env-synthetic-key"}):
            value = self.get_config()
        self.assertEqual(set(value), {"version", "primary", "backup"})
        self.assertEqual(value["version"], 0)
        for name in ("primary", "backup"):
            self.assertEqual(set(value[name]), {"base_url", "model", "timeout_seconds", "key_configured"})
        self.assertEqual(value["primary"]["base_url"], "")
        self.assertEqual(value["primary"]["model"], "")
        self.assertEqual(value["primary"]["timeout_seconds"], 20)
        self.assertTrue(value["primary"]["key_configured"], "legacy environment key should count for primary")
        self.assertFalse(value["backup"]["key_configured"])
        rendered = json.dumps(value)
        self.assertNotIn("env-synthetic-key", rendered)
        self.assertNotIn(ENV_NAME, rendered)

    def test_saved_keys_never_returned_and_blank_key_preserves_saved_key(self):
        status, saved = self.save_providers(primary_key=SAVED_KEY, backup_key="backup-synthetic-key")
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["version"], 1)
        self.assertTrue(saved["primary"]["key_configured"])
        self.assertTrue(saved["backup"]["key_configured"])
        self.assertNotIn(SAVED_KEY, json.dumps(saved))

        # A blank/absent key keeps the stored secret.
        status, again = self.save_providers()
        self.assertEqual(status, 200, again)
        self.assertEqual(again["version"], 2)
        self.assertTrue(again["primary"]["key_configured"])
        self.assertTrue(again["backup"]["key_configured"])
        rendered = json.dumps([saved, again, self.get_config()])
        self.assertNotIn(SAVED_KEY, rendered)
        self.assertNotIn("backup-synthetic-key", rendered)

        # A real call proves the preserved key is actually used.
        self.primary.queue(completion("OK"))
        self.assertEqual(self.call_test("primary")[0], 200)
        self.assertEqual(self.primary.header(0, "Authorization"), "Bearer " + SAVED_KEY)

        # A blank key input while saving other fields also preserves it.
        self.save(primary=self.slot_payload(self.primary, api_key=""), backup=self.slot_payload(self.backup))
        self.call_test("primary")
        self.assertEqual(self.primary.header(1, "Authorization"), "Bearer " + SAVED_KEY)

    def test_explicit_clear_key_removes_only_that_slot_key(self):
        self.save_providers(primary_key=SAVED_KEY, backup_key="backup-key")
        status, cleared = self.save(primary=self.slot_payload(self.primary, clear_key=True),
                                    backup=self.slot_payload(self.backup))
        self.assertEqual(status, 200, cleared)
        self.assertFalse(cleared["primary"]["key_configured"])
        self.assertTrue(cleared["backup"]["key_configured"])
        self.primary.queue(completion("OK"))
        self.call_test("primary")
        self.assertIsNone(self.primary.header(0, "Authorization"))
        # A later blank key stays cleared (the old secret is not resurrected).
        self.save(primary=self.slot_payload(self.primary), backup=self.slot_payload(self.backup))
        self.assertFalse(self.get_config()["primary"]["key_configured"])

    def test_keys_persist_across_restart_without_api_leaks(self):
        self.save_providers(primary_key=SAVED_KEY)
        self.restart()
        value = self.get_config()
        self.assertTrue(value["primary"]["key_configured"])
        self.assertNotIn(SAVED_KEY, json.dumps(value))
        self.primary.queue(completion("OK"))
        status, result = self.call_test("primary")
        self.assertEqual(status, 200, result)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.primary.header(0, "Authorization"), "Bearer " + SAVED_KEY)

    # -- validation / compatibility --------------------------------------
    def test_invalid_configurations_are_rejected_and_preserved(self):
        self.save(primary=self.slot_payload(self.primary, api_key=SAVED_KEY))
        version = self.get_config()["version"]
        bad_urls = ["http://example.invalid/v1", "http://8.8.8.8/v1", "ftp://127.0.0.1/v1",
                    "https://u:p@api.example.invalid/v1", "https://api.example.invalid/v1?k=secret",
                    "https://api.example.invalid/v1#frag", "https://", "https://api.example.invalid:bad/v1",
                    "https://api.example.invalid/v1\n", " https://api.example.invalid/v1", "h" * 2049]
        for url in bad_urls:
            with self.subTest(url=url[:40]):
                status, body = self.save(primary={"base_url": url, "model": "m", "timeout_seconds": 5})
                self.assertEqual(status, 400, body)
        invalid = [
            ({"base_url": self.primary.base_url, "model": "", "timeout_seconds": 5}, "invalid_model_config"),
            ({"base_url": "", "model": "m", "timeout_seconds": 5}, "invalid_model_config"),
            ({"base_url": self.primary.base_url, "model": " spaced ", "timeout_seconds": 5}, "invalid_model_name"),
            ({"base_url": self.primary.base_url, "model": "m" * 129, "timeout_seconds": 5}, "invalid_model_name"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": 0}, "invalid_model_timeout"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": 61}, "invalid_model_timeout"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": "5"}, "invalid_model_timeout"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": True}, "invalid_model_timeout"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": 5, "api_key": "a\nb"}, "invalid_api_key"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": 5, "api_key": "k" * 4097}, "invalid_api_key"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": 5, "api_key": "x", "clear_key": True}, "invalid_model_config"),
            ({"base_url": self.primary.base_url, "model": "m", "timeout_seconds": 5, "unknown": 1}, "invalid_model_config"),
        ]
        for payload, code in invalid:
            with self.subTest(code=code, payload=str(payload)[:60]):
                status, body = self.save(primary=payload)
                self.assertEqual(status, 400, body)
                self.assertEqual(body["error"]["code"], code)
        for body in ({"version": version, "primary": self.slot_payload(self.primary)},
                     {"version": version, "primary": self.slot_payload(self.primary),
                      "backup": self.slot_payload(self.backup), "extra": True},
                     {"version": "0", "primary": self.slot_payload(self.primary),
                      "backup": self.slot_payload(self.backup)}):
            status, response = self.request("PUT", body=body, token=self.token)
            self.assertEqual(status, 400, response)
            self.assertEqual(response["error"]["code"], "invalid_model_config")
        self.assertEqual(self.get_config()["version"], version)
        self.assertTrue(self.get_config()["primary"]["key_configured"])

    def test_local_http_urls_are_accepted(self):
        for url in ("http://127.0.0.1:8801/v1", "http://localhost:8801/v1", "http://[::1]:8801/v1",
                    "http://192.168.1.10:8801/v1", "http://10.0.0.5/v1", "https://api.deepseek.com/v1"):
            with self.subTest(url=url):
                status, body = self.save(primary={"base_url": url, "model": "m", "timeout_seconds": 5})
                self.assertEqual(status, 200, body)
                self.assertEqual(body["primary"]["base_url"], url)

    def test_version_conflict_and_flat_legacy_put(self):
        status, saved = self.save(primary=self.slot_payload(self.primary), backup=self.slot_payload(self.backup))
        self.assertEqual(status, 200, saved)
        status, body = self.save(version=saved["version"] - 1)
        self.assertEqual(status, 409, body)
        self.assertEqual(body["error"]["code"], "model_config_changed")

        # Legacy flat submissions still work and only replace the primary slot.
        status, legacy = self.save(base_url=self.primary.base_url, model="legacy-model")
        self.assertEqual(status, 200, legacy)
        self.assertEqual(legacy["primary"]["model"], "legacy-model")
        self.assertEqual(legacy["primary"]["base_url"], self.primary.base_url)
        self.assertEqual(legacy["backup"]["base_url"], self.backup.base_url)
        self.assertEqual(legacy["version"], saved["version"] + 1)

        status, cleared = self.save(base_url="", model="")
        self.assertEqual(status, 200, cleared)
        self.assertEqual(cleared["primary"]["base_url"], "")
        self.assertEqual(cleared["backup"]["base_url"], self.backup.base_url)

    def test_legacy_flat_database_record_migrates_to_primary_on_read(self):
        self.stop()
        db = sqlite3.connect(str(pathlib.Path(self.data_dir) / "claw-next.sqlite3"))
        try:
            with db:
                db.execute("INSERT OR REPLACE INTO model_settings VALUES (1,?)",
                           (json.dumps({"base_url": self.primary.base_url, "model": "legacy-flat", "version": 7}),))
        finally:
            db.close()
        self.start()
        value = self.get_config()
        self.assertEqual(value["version"], 7)
        self.assertEqual(value["primary"]["base_url"], self.primary.base_url)
        self.assertEqual(value["primary"]["model"], "legacy-flat")
        self.assertEqual(value["primary"]["timeout_seconds"], 20)
        self.assertEqual(value["backup"]["base_url"], "")
        self.assertFalse(value["backup"]["key_configured"])

    def test_file_config_primary_migration_uses_environment_key(self):
        extra = tempfile.TemporaryDirectory(prefix="claw-next-model-migrate-")
        self.addCleanup(extra.cleanup)
        config = {"shops": [{"shop_id": "demo", "name": "虚构店"}],
                  "clients": [{"shop_id": "demo", "client_id": "client", "token": CLIENT_TOKEN}],
                  "model": {"base_url": "https://provider.invalid/v1", "model": "legacy-file", "api_key_env": "SYNTHETIC_FILE_KEY"}}
        with patch.dict(os.environ, {"SYNTHETIC_FILE_KEY": "env-only-synthetic"}):
            self.start(config=config, data_dir=extra.name)
            try:
                status, value = self.request(token=self.token)
            finally:
                self.stop()
        self.assertEqual(status, 200, value)
        self.assertEqual(value["primary"]["base_url"], "https://provider.invalid/v1")
        self.assertEqual(value["primary"]["model"], "legacy-file")
        self.assertTrue(value["primary"]["key_configured"])
        self.assertNotIn("env-only-synthetic", json.dumps(value))

    def test_model_change_invalidates_permits_and_keeps_unknown_untouched(self):
        store = self.server.store
        with store.lock:
            identity = {"shop_id": "demo", "client_id": "client"}
            lease = store.heartbeat(identity, {"instance_id": "instance", "session_id": "session"})
            store.update_settings("demo", {"enabled": True, "mode": "rules", "system_prompt": "", "rules": []})
            now = time.time()
            payload = {"event_id": "event", "instance_id": "instance", "session_id": "session", "generation": lease["generation"],
                       "conversation_id": "buyer", "message_id": "message", "context_revision": 1, "received_at": now,
                       "context": {"history_complete": True, "messages": [{"id": "message", "role": "buyer", "kind": "text", "content": "hello", "created_at": now}]}}
            store.enqueue(identity, payload)
            job = store.next_job()
            store.finish(job, {"action": "reply", "text": "hi", "reason": "test", "expires_at": now + 60})
            store.update_model_config({"version": 0,
                                       "primary": {"base_url": "https://provider.invalid", "model": "test", "timeout_seconds": 10},
                                       "backup": {"base_url": "", "model": "", "timeout_seconds": 10}}, {})
            with self.assertRaises(ApiError) as exc:
                store.claim(identity, "event", {**lease, "attempt_id": "attempt"})
            self.assertEqual(exc.exception.code, "settings_changed")
            row = store._row(identity, "event")
            store._delivery(row, {"status": "unknown", "attempt_id": "uncertain"})
            store.update_model_config({"version": 1,
                                       "primary": {"base_url": "", "model": "", "timeout_seconds": 10},
                                       "backup": {"base_url": "", "model": "", "timeout_seconds": 10}}, {})
            self.assertEqual(store.get(identity, "event")["delivery"]["status"], "unknown")

    # -- POST /api/v1/admin/model/test -----------------------------------
    def test_test_endpoint_requires_admin_and_valid_body(self):
        for token in (None, CLIENT_TOKEN):
            status, body = self.request("POST", "/api/v1/admin/model/test",
                                        {"slot": "primary", "version": 0}, token=token)
            self.assertIn(status, (401, 403), body)
        for body, code in [({"slot": "third", "version": 0}, "invalid_model_slot"),
                           ({"version": 0}, "invalid_model_test"),
                           ({"slot": "primary"}, "invalid_model_test"),
                           ({"slot": "primary", "version": "0"}, "invalid_model_test"),
                           ({"slot": "primary", "version": 0, "extra": 1}, "invalid_model_test")]:
            status, response = self.request("POST", "/api/v1/admin/model/test", body, token=self.token)
            self.assertEqual(status, 400, response)
            self.assertEqual(response["error"]["code"], code)
        self.save_providers()
        status, response = self.call_test("primary", version=self.get_config()["version"] - 1)
        self.assertEqual(status, 409, response)
        self.assertEqual(response["error"]["code"], "model_config_changed")
        self.assertEqual(self.primary.count(), 0)

    def test_test_endpoint_calls_the_selected_saved_slot_for_real(self):
        self.save_providers(primary_key=SAVED_KEY, backup_key="backup-key")
        self.primary.queue(completion("OK"))
        status, result = self.call_test("primary")
        self.assertEqual(status, 200, result)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["slot"], "primary")
        self.assertEqual(result["reason"], "ok")
        self.assertEqual(set(result), {"slot", "version", "ok", "reason", "latency_ms"})
        self.assertEqual(self.primary.count(), 1)
        self.assertEqual(self.backup.count(), 0)
        request_body = json.dumps(self.primary.body(0), ensure_ascii=False)
        self.assertIn("connectivity check", request_body)
        self.assertNotIn("Shop policy", request_body)
        self.assertNotIn("OK", json.dumps(result))

        # The backup slot is tested independently: primary is untouched.
        self.backup.queue(completion("OK"))
        status, result = self.call_test("backup")
        self.assertEqual(status, 200, result)
        self.assertTrue(result["ok"])
        self.assertEqual(self.primary.count(), 1)
        self.assertEqual(self.backup.count(), 1)
        self.assertEqual(self.backup.header(0, "Authorization"), "Bearer backup-key")

    def test_test_endpoint_failure_is_safe_and_creates_no_business_task(self):
        self.save_providers()
        self.primary.queue(http_error(503))
        status, result = self.call_test("primary")
        self.assertEqual(status, 200, result)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "http_503")
        self.assertNotIn("synthetic provider error", json.dumps(result))
        summary = self.request("GET", "/api/v1/admin/summary", token=self.token)[1]
        self.assertEqual(summary["counts"], {k: 0 for k in ("pending", "processing", "ready", "sent", "unknown")})
        self.assertEqual(self.request("GET", "/api/v1/admin/events", token=self.token)[1]["events"], [])

    def test_test_endpoint_never_uses_unconfigured_slot_or_network(self):
        self.save_providers()
        status, result = self.call_test("primary")
        self.assertEqual(status, 200, result)
        self.assertTrue(result["ok"])
        self.assertEqual(self.primary.count(), 1)
        # A cleared slot is reported as unconfigured without any call.
        self.save(primary=self.slot_payload(None), backup=self.slot_payload(self.backup))
        status, result = self.call_test("primary")
        self.assertEqual(status, 200, result)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "not_configured")
        self.assertEqual(self.primary.count(), 1)

    def test_test_endpoint_uses_snapshot_after_releasing_the_auth_lock(self):
        self.save_providers()
        self.primary.queue({"status": 200, "content": "OK", "delay": 1.0})
        results = {}
        tester = threading.Thread(target=lambda: results.update(zip(("status", "body"), self.call_test("primary"))))
        started = time.monotonic()
        tester.start()
        time.sleep(0.2)
        probe = time.monotonic()
        status, summary = self.request("GET", "/api/v1/admin/summary", token=self.token)
        elapsed = time.monotonic() - probe
        tester.join(5)
        self.assertFalse(tester.is_alive())
        self.assertEqual(status, 200, summary)
        self.assertLess(elapsed, 0.8, "admin requests must not wait for the provider call")
        self.assertEqual(results["status"], 200, results.get("body"))
        self.assertTrue(results["body"]["ok"])
        self.assertGreaterEqual(time.monotonic() - started, 0.9)


if __name__ == "__main__":
    unittest.main()
