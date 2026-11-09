"""Real loopback HTTP and synthetic models; never platform or shop traffic."""
import http.client
import json
import tempfile
import threading
import time
import unittest

from backend.app import create_server
from synthetic_provider import SyntheticProvider, timeout


class DeadlineHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.provider = SyntheticProvider().start()
        self.addCleanup(self.provider.stop)
        self.server = create_server({"shops": [{"shop_id": "demo", "name": "Fictional"}],
            "clients": [{"shop_id": "demo", "client_id": "client", "token": "synthetic-token-for-deadline-tests-only"}],
            "model": {"primary": {"base_url": self.provider.base_url, "model": "synthetic",
                                  "timeout_seconds": 20, "api_key": ""}, "backup": {},
                      "api_key_env": "CLAW_NEXT_SYNTHETIC_UNUSED_KEY"}}, self.temp.name)
        self.http_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http_thread.start()
        self.addCleanup(self.close)
        self.server.store.update_settings("demo", {"enabled": True, "mode": "model", "rules": [], "system_prompt": "Fictional"})
        self.lease = self.request("POST", "/api/v1/heartbeat", {"instance_id": "i", "session_id": "s", "capabilities": ["reply_deadline"]})[1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.http_thread.join(3)

    def request(self, method, path, body=None, token="synthetic-token-for-deadline-tests-only"):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def payload(self, event="e1", budget=1000, revision=1):
        now = time.time()
        return {"event_id": event, "conversation_id": "buyer", "message_id": event,
                **{k: self.lease[k] for k in ("instance_id", "session_id", "generation")},
                "context_revision": revision, "received_at": now, "remaining_budget_ms": budget,
                "context": {"history_complete": True, "messages": [
                    {"id": event, "role": "buyer", "kind": "text", "content": "Fictional question", "created_at": now}]}}

    def cancel(self, event="e1"):
        return self.request("POST", "/api/v1/events/" + event + "/cancel",
                            {**{k: self.lease[k] for k in ("instance_id", "session_id", "generation")},
                             "reason": "reply_deadline_exceeded"})

    def wait_for(self, check, seconds=3):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            value = check()
            if value:
                return value
            time.sleep(.01)
        self.fail("Synthetic condition did not complete")

    def ready(self, event):
        def read():
            value = self.request("GET", "/api/v1/events/" + event)[1]
            return value if value["state"] == "ready" else None
        return self.wait_for(read)

    def test_timeout_transfer_http_stops_slow_model_on_original_event(self):
        settings = {"enabled": True, "mode": "model", "rules": [], "system_prompt": "Fictional",
                    "fallback": {"model_timeout": {"action": "transfer", "account": "fictional-agent"}}}
        self.server.store.update_settings("demo", settings)
        self.request("POST", "/api/v1/heartbeat", {"instance_id": "i", "session_id": "s",
                     "capabilities": ["reply_deadline", "reply_timeout_transfer", "transfer_by_account"]})
        self.provider.queue(timeout(delay=5))
        payload = {**self.payload(budget=60000), "timeout_transfer": True}
        self.assertEqual(self.request("POST", "/api/v1/events", payload)[0], 202)
        self.wait_for(lambda: self.provider.count() == 1)
        owner = {k: self.lease[k] for k in ("instance_id", "session_id", "generation")}
        code, snap = self.request("POST", "/api/v1/events/e1/timeout_transfer", {**owner, "remaining_budget_ms": 15000})
        self.assertEqual(code, 200)
        self.assertEqual(snap["event_id"], "e1")
        self.assertEqual(snap["decision"]["transfer"]["account"], "fictional-agent")
        self.wait_for(lambda: not self.server.model_workers)
        claimed = self.request("POST", "/api/v1/events/e1/claim", {**owner, "attempt_id": "attempt"})[1]
        self.assertEqual(claimed["decision"]["action"], "transfer")
        code, snap = self.request("POST", "/api/v1/events/e1/receipt", {"attempt_id": "attempt", "status": "unknown",
                                  "steps": [{"step": "transfer", "status": "unknown"}]})
        self.assertEqual(code, 200)
        self.assertEqual(self.request("POST", "/api/v1/events/e1/timeout_transfer",
                         {**owner, "attempt_id": "attempt", "remaining_budget_ms": 15000})[0], 409)
        self.assertEqual(self.request("GET", "/api/v1/events/e1")[1]["delivery"]["status"], "unknown")

    def test_zero_budget_no_model_no_attempt_and_read_only_cancel(self):
        code, snapshot = self.request("POST", "/api/v1/events", self.payload(budget=0))
        self.assertEqual(code, 202)
        self.assertEqual(snapshot["state"], "ready")
        self.assertEqual(snapshot["decision"]["expires_at"], snapshot["created_at"])
        self.assertEqual(snapshot["decision"]["reason"], "reply_deadline_exceeded")
        self.assertIsNone(snapshot["delivery"]["attempt_id"])
        self.assertEqual(self.provider.count(), 0)
        self.assertNotIn("decision_ms", snapshot.get("timing", {}))
        self.assertEqual(self.cancel()[0], 200)
        code, error = self.request("POST", "/api/v1/events/e1/claim", {**self.lease, "attempt_id": "a1"})
        self.assertEqual((code, error["error"]["code"]), (409, "reply_deadline_exceeded"))

    def test_automatic_expiry_discards_late_model_and_next_message_runs(self):
        self.provider.queue(timeout(delay=5))
        self.assertEqual(self.request("POST", "/api/v1/events", self.payload(budget=500))[0], 202)
        self.wait_for(lambda: self.provider.count() == 1)
        first = self.ready("e1")
        self.assertEqual(first["decision"]["reason"], "reply_deadline_exceeded")
        self.assertEqual(self.request("POST", "/api/v1/events", self.payload("e2", 2500, 2))[0], 202)
        second = self.ready("e2")
        self.assertEqual(second["decision"]["action"], "reply")
        self.assertEqual(second["timing"]["model_slot"], "primary")
        self.assertEqual(self.request("GET", "/api/v1/events/e1")[1], first)

    def test_cancel_aborts_inflight_model_and_is_idempotent_after_capability_withdrawal(self):
        self.provider.queue(timeout(delay=5))
        self.request("POST", "/api/v1/events", self.payload(budget=3000))
        self.wait_for(lambda: self.provider.count() == 1)
        code, first = self.cancel()
        self.assertEqual(code, 200)
        self.assertEqual(first["timing"]["failure_class"], "cancelled")
        self.wait_for(lambda: not self.server.model_workers)
        self.request("POST", "/api/v1/heartbeat", {"instance_id": "i", "session_id": "s"})
        self.assertEqual(self.cancel(), (200, first))
        self.assertIsNone(first["delivery"]["attempt_id"])

    def test_invalid_or_unnegotiated_budget_and_request_timing_are_rejected(self):
        for budget in (True, None, 1.5, "3", -1, 20001):
            code, body = self.request("POST", "/api/v1/events", self.payload(budget=budget))
            self.assertEqual((code, body["error"]["code"]), (400, "invalid_remaining_budget"))
        payload = self.payload()
        payload["timing"] = {"primary_ms": 0}
        self.assertEqual(self.request("POST", "/api/v1/events", payload)[1]["error"]["code"], "invalid_field")
        self.request("POST", "/api/v1/heartbeat", {"instance_id": "i", "session_id": "s"})
        code, body = self.request("POST", "/api/v1/events", self.payload())
        self.assertEqual((code, body["error"]["code"]), (400, "capability_not_confirmed"))
        self.assertEqual(self.request("GET", "/api/v1/events/e1")[0], 404)


if __name__ == "__main__":
    unittest.main()
