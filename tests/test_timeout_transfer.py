"""Synthetic 45/60 second state transitions; no platform or model I/O."""
import json

from backend.engine import decide
from test_reply_deadline_store import StoreTestCase


class TimeoutTransferTests(StoreTestCase):
    def setUp(self):
        super().setUp()
        settings = self.store._settings("a")
        settings.pop("version", None)
        settings["fallback"] = {"model_timeout": {"action": "transfer", "account": "fictional-agent", "allow_unmark": False}}
        self.store.update_settings("a", settings)
        self.heartbeat(("reply_deadline", "reply_timeout_transfer", "transfer_by_account"))

    def event(self, budget=60000, **kwargs):
        return self.enqueue(remaining_budget_ms=budget, timeout_transfer=True, **kwargs)

    def switch(self, budget=15000, **extra):
        body = {k: self.lease[k] for k in ("instance_id", "session_id", "generation")}
        return self.store.timeout_transfer(self.identity, "evt", {**body, "remaining_budget_ms": budget, **extra})

    def test_pending_boundary_and_total_expiry(self):
        self.event()
        self.clock.sleep(44.999)
        self.assertEqual(self.store.get(self.identity, "evt")["state"], "pending")
        self.clock.sleep(.001)
        snap = self.store.get(self.identity, "evt")
        self.assertEqual(snap["decision"]["action"], "transfer")
        self.assertEqual(snap["decision"]["transfer"]["account"], "fictional-agent")
        self.assertIsNone(self.store.next_job())
        self.clock.sleep(15)
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "reply_deadline_exceeded")
        self.assert_code("reply_deadline_exceeded", lambda: self.store.claim(self.identity, "evt", self.claim_body()))

    def test_processing_and_late_model_do_not_overwrite(self):
        self.event()
        job = self.store.next_job()
        self.assertEqual(job["deadline_monotonic"], self.clock.mono + 45)
        self.clock.sleep(45)
        self.assertFalse(self.store.job_is_active(job))
        result = self.store.finish(job, decide(job))
        self.assertEqual(result["action"], "transfer")

    def test_ready_reply_switches_at_claim_boundary(self):
        self.event()
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        self.clock.sleep(45)
        snap = self.store.claim(self.identity, "evt", self.claim_body())
        self.assertEqual(snap["decision"]["action"], "transfer")
        self.assertEqual(snap["delivery"]["attempt_id"], "attempt")

    def test_claimed_but_not_started_keeps_attempt(self):
        self.event()
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        self.clock.sleep(44)
        self.store.claim(self.identity, "evt", self.claim_body())
        self.clock.sleep(1)
        snap = self.switch(attempt_id="attempt")
        self.assertEqual(snap["decision"]["action"], "transfer")
        self.assertEqual(snap["delivery"]["attempt_id"], "attempt")
        self.assertTrue(snap["delivery"]["timeout_transfer"])
        self.assertLessEqual(snap["delivery"]["claim_expires_at"], self.clock.wall + 10)
        self.assert_code("timeout_transfer_not_allowed", lambda: self.switch(attempt_id="other"))

    def test_selected_claim_cannot_renew_after_authorization_changes(self):
        for change, expected in (("disabled", "settings_changed"), ("policy", "settings_changed"),
                                 ("latest", "superseded"), ("capability", "capability_not_confirmed")):
            with self.subTest(change=change):
                settings = self.store._settings("a")
                settings.pop("version")
                settings["enabled"] = True
                self.store.update_settings("a", settings)
                self.heartbeat(("reply_deadline", "reply_timeout_transfer", "transfer_by_account"))
                name = "evt-" + change
                self.event(name=name, conversation=name)
                self.clock.sleep(45)
                before = self.store.claim(self.identity, name, self.claim_body())["delivery"]
                self.clock.sleep(1)
                if change in ("disabled", "policy"):
                    settings = self.store._settings("a")
                    settings.pop("version")
                    if change == "disabled":
                        settings["enabled"] = False
                    else:
                        settings["fallback"]["model_timeout"]["account"] = "fictional-other"
                    self.store.update_settings("a", settings)
                elif change == "latest":
                    self.event(name="newer", conversation=name, revision=2)
                else:
                    self.heartbeat(("reply_deadline", "reply_timeout_transfer"))
                body = {**self.claim_body(), "remaining_budget_ms": 14000}
                self.assert_code(expected, lambda: self.store.timeout_transfer(self.identity, name, body))
                self.assertEqual(self.store.get(self.identity, name)["delivery"], before)

    def test_unknown_never_switches(self):
        self.event()
        job = self.store.next_job()
        self.store.finish(job, decide(job))
        self.store.claim(self.identity, "evt", self.claim_body())
        self.store.receipt(self.identity, "evt", {"attempt_id": "attempt", "status": "unknown"})
        self.clock.sleep(45)
        self.assert_code("timeout_transfer_not_allowed", lambda: self.switch(attempt_id="attempt"))
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["action"], "reply")
        self.restart()
        self.assertEqual(self.store.get(self.identity, "evt")["delivery"]["status"], "unknown")

    def test_shortening_and_replay_never_refreshes_total(self):
        payload = self.payload(remaining_budget_ms=60000, timeout_transfer=True)
        self.store.enqueue(self.identity, payload)
        self.clock.sleep(30)
        self.switch(8000)
        self.clock.sleep(7)
        self.store.enqueue(self.identity, payload)
        self.clock.sleep(1)
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "reply_deadline_exceeded")

    def test_no_target_and_policy_change_do_not_invent_transfer(self):
        settings = self.store._settings("a")
        settings.pop("version")
        settings["fallback"] = {}
        self.store.update_settings("a", settings)
        self.event()
        self.clock.sleep(45)
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "timeout_transfer_not_configured")

    def test_revoked_settings_latest_and_capability(self):
        for change, expected in (("settings", "settings_changed"), ("latest", "superseded"), ("capability", "capability_not_confirmed")):
            with self.subTest(change=change):
                name = "evt-" + change
                self.event(name=name, conversation=name)
                if change == "settings":
                    settings = self.store._settings("a")
                    settings.pop("version")
                    self.store.update_settings("a", settings)
                elif change == "latest":
                    self.event(name="newer", conversation=name, revision=2)
                else:
                    self.heartbeat(("reply_deadline",))
                self.clock.sleep(45)
                self.assertEqual(self.store.get(self.identity, name)["decision"]["reason"], expected)
                self.heartbeat(("reply_deadline", "reply_timeout_transfer", "transfer_by_account"))

    def test_old_event_is_not_upgraded_and_new_budget_requires_capability(self):
        self.enqueue(remaining_budget_ms=20000)
        self.assert_code("capability_not_confirmed", lambda: self.switch())
        self.clock.sleep(20)
        self.assertEqual(self.store.get(self.identity, "evt")["decision"]["reason"], "reply_deadline_exceeded")
        self.heartbeat(("reply_deadline",))
        self.assert_code("capability_not_confirmed", lambda: self.event(name="new"), 400)

    def test_restart_does_not_rearm_transfer(self):
        self.event()
        self.clock.sleep(45)
        self.store.get(self.identity, "evt")
        self.restart()
        snap = self.store.get(self.identity, "evt")
        self.assertEqual(snap["decision"]["reason"], "reply_deadline_exceeded")
        self.assertEqual(snap["delivery"]["status"], "unclaimed")
