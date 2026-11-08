"""Negotiated deadlines use fictional HTTP providers and reaped child processes."""
import json
import multiprocessing
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from backend import diagnostics
from backend.engine import ProviderFailure, model_decide
from backend.modelworker import bounded_decide
from synthetic_provider import SyntheticProvider, completion, http_error, timeout


def model_config(provider, backup=None):
    def slot(p):
        return {"base_url": p.base_url, "model": "synthetic", "timeout_seconds": 20, "api_key": ""}
    return {"primary": slot(provider), "backup": slot(backup) if backup else {},
            "api_key_env": "CLAW_NEXT_SYNTHETIC_UNUSED_KEY"}


def job(seconds=3):
    now = time.time()
    return {"shop_id": "fictional", "event_id": "event", "deadline_monotonic": time.monotonic() + seconds,
            "settings": {"enabled": True, "mode": "model", "system_prompt": "Fictional", "rules": []},
            "payload": {"received_at": now, "context": {"history_complete": True, "messages": [
                {"id": "message", "role": "buyer", "kind": "text", "content": "Fictional question", "created_at": now}]}}}


class DeadlineModelTests(unittest.TestCase):
    def setUp(self):
        self.primary = SyntheticProvider().start()
        self.backup = SyntheticProvider().start()
        self.addCleanup(self.primary.stop)
        self.addCleanup(self.backup.stop)

    def test_expired_budget_never_calls_provider(self):
        work, timing = job(-1), {}
        result = model_decide(work["payload"]["context"], work["settings"], model_config(self.primary),
                              deadline_monotonic=work["deadline_monotonic"], timing=timing)
        self.assertEqual(result["reason"], "reply_deadline_exceeded")
        self.assertEqual(self.primary.count(), 0)
        self.assertNotIn("primary_ms", timing)

    def test_primary_failure_uses_only_remaining_budget_and_reports_backup(self):
        self.primary.queue(http_error(503))
        work, timing = job(), {}
        result = model_decide(work["payload"]["context"], work["settings"], model_config(self.primary, self.backup),
                              deadline_monotonic=work["deadline_monotonic"], timing=timing)
        self.assertEqual(result["action"], "reply")
        self.assertEqual(timing["model_slot"], "backup")
        self.assertTrue(timing["fallback_used"])
        self.assertNotIn("failure_class", timing)
        for key in ("primary_ms", "backup_ms"):
            self.assertIs(type(timing[key]), int)
            self.assertGreaterEqual(timing[key], 0)

    def test_primary_exhausting_budget_does_not_start_backup(self):
        work, timing = job(.02), {}
        def slow(_spec, _body):
            time.sleep(.03)
            raise ProviderFailure("timeout")
        with patch("backend.engine._post", side_effect=slow) as post:
            result = model_decide(work["payload"]["context"], work["settings"], model_config(self.primary, self.backup),
                                  deadline_monotonic=work["deadline_monotonic"], timing=timing)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(result["reason"], "reply_deadline_exceeded")
        self.assertFalse(timing["fallback_used"])
        self.assertNotIn("backup_ms", timing)

    def test_process_returns_success_and_safe_timing(self):
        work = job()
        result = bounded_decide(work, model_config(self.primary), lambda: True, threading.Event())
        self.assertEqual(result["action"], "reply")
        self.assertEqual(work["timing"]["model_slot"], "primary")
        self.assertNotIn("backup_ms", work["timing"])
        self.assertFalse(multiprocessing.active_children())

    def test_deadline_terminates_and_reaps_slow_provider(self):
        self.primary.queue(timeout(delay=5))
        work = job(.4)
        started = time.monotonic()
        result = bounded_decide(work, model_config(self.primary, self.backup), lambda: True, threading.Event())
        self.assertEqual(result["reason"], "reply_deadline_exceeded")
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(self.backup.count(), 0)
        self.assertFalse(multiprocessing.active_children())

    def test_cancel_stops_inflight_call_and_frees_process(self):
        self.primary.queue(timeout(delay=5))
        cancelled, done = threading.Event(), threading.Event()
        def cancel_after_request():
            end = time.monotonic() + 2
            while time.monotonic() < end and not done.is_set():
                if self.primary.count():
                    cancelled.set()
                    return
                time.sleep(.01)
        watcher = threading.Thread(target=cancel_after_request)
        watcher.start()
        try:
            started = time.monotonic()
            result = bounded_decide(job(5), model_config(self.primary), lambda: not cancelled.is_set(), done)
            self.assertTrue(cancelled.is_set())
            self.assertEqual(result["reason"], "reply_deadline_exceeded")
            self.assertLess(time.monotonic() - started, 2)
            self.assertFalse(multiprocessing.active_children())
        finally:
            done.set()
            watcher.join(2)

    def test_child_exit_between_poll_and_alive_still_consumes_result(self):
        receiver, sender, child = Mock(), Mock(), Mock()
        receiver.poll.side_effect = [False, True, True, False]
        receiver.recv.return_value = ("result", {"action": "reply", "text": "Synthetic", "reason": "model:primary:ok"}, {"model_slot": "primary"})
        child.is_alive.return_value = False
        context = Mock()
        context.Pipe.return_value = (receiver, sender)
        context.Process.return_value = child
        with patch("backend.modelworker.multiprocessing.get_context", return_value=context):
            work = job()
            result = bounded_decide(work, {}, lambda: True, threading.Event())
        self.assertEqual(result["action"], "reply")
        self.assertEqual(work["timing"], {"model_slot": "primary"})
        child.join.assert_called_once()
        child.close.assert_called_once()

    def logged(self, work, config):
        with tempfile.TemporaryDirectory() as directory:
            log = diagnostics.Diagnostics(directory)
            with diagnostics.scope(log, event_ref="synthetic-ref"):
                result = bounded_decide(work, config, lambda: True, threading.Event())
            log.close()
            raw = (Path(directory) / "logs/backend.jsonl").read_text(encoding="utf-8")
        return result, [json.loads(line) for line in raw.splitlines()]

    def test_child_process_model_calls_reach_the_parent_log(self):
        # The live service decides in a spawned child; its slot records must still be written.
        self.primary.queue(http_error(503))
        config = model_config(self.primary, self.backup)
        config["backup"]["model"] = "synthetic-backup"
        result, records = self.logged(job(), config)
        self.assertEqual(result["action"], "reply")
        self.assertEqual([(r["event"], r["slot"], r["model"]) for r in records],
                         [("model_attempt", "primary", "synthetic"), ("model_failed", "primary", "synthetic"),
                          ("model_attempt", "backup", "synthetic-backup"), ("model_succeeded", "backup", "synthetic-backup")])
        self.assertTrue(all(r["event_ref"] == "synthetic-ref" for r in records))
        self.assertEqual(records[1]["code"], "http_503")
        self.assertTrue(records[-1]["fallback"])
        self.assertFalse(multiprocessing.active_children())

    def test_attempt_cut_off_by_the_deadline_is_still_logged(self):
        self.primary.queue(timeout(delay=5))
        result, records = self.logged(job(.6), model_config(self.primary))
        self.assertEqual(result["reason"], "reply_deadline_exceeded")
        self.assertEqual([(r["event"], r["slot"]) for r in records], [("model_attempt", "primary")])

    def test_invalid_model_output_has_fixed_failure_class(self):
        self.primary.queue(completion("fictional private invalid output"))
        work, timing = job(), {}
        result = model_decide(work["payload"]["context"], work["settings"], model_config(self.primary),
                              deadline_monotonic=work["deadline_monotonic"], timing=timing)
        self.assertEqual(result["action"], "handoff")
        self.assertEqual(timing["failure_class"], "model_invalid_output")
        self.assertNotIn("private", str(timing))


if __name__ == "__main__":
    unittest.main()
