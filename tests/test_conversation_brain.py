"""Fictional multi-turn decisions, evidence memory and killable tool workers."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from backend import brain, conversation_memory, engine, modelworker, vehicle_knowledge
from backend.app import create_server, validate_config
from backend.store import ApiError, Store
from synthetic_provider import SyntheticProvider
from test_vehicle_lookup_v2 import write_table, SLOT


def message(key, text, role="buyer", when=None):
    return {"id": key, "role": role, "kind": "text", "content": text, "created_at": when if when is not None else time.time() - 1}


def answer(text="您好", intent="greeting", **extra):
    return {"action": "reply", "text": text, "reason": "synthetic", "intent": intent, "memory": [], **extra}


def completion(output):
    return {"choices": [{"message": {"content": json.dumps(output, ensure_ascii=False)}}]}


def tool(name="lookup_vehicle", args=None, quote="示例车A 22款"):
    return {"choices": [{"message": {"content": None, "tool_calls": [
        {"id": "call-1", "type": "function", "function": {"name": name, "arguments": json.dumps(args if args is not None else {"parts": [{"source_id": "m1", "quote": quote}]})}}]}}]}


def job(*messages):
    return {"shop_id": "a", "event_id": "event", "conversation_brain": True,
            "settings": {"enabled": True, "mode": "hybrid", "rules": [], "system_prompt": "自写回复最多20字", "version": 1},
            "payload": {"received_at": time.time(), "context": {"messages": list(messages), "history_complete": True}},
            "capabilities": []}


class BrainTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        write_table(Path(tmp.name))
        self.catalog = vehicle_knowledge.load_directory(Path(tmp.name))

    def run_brain(self, work, *outputs):
        work["brain_catalog"] = self.catalog
        scripted = list(outputs) + ([outputs[-1]] * 2 if outputs else [])
        with patch("backend.engine._post", side_effect=scripted) as post:
            result = engine.decide(work, {"primary": SLOT})
        return result, post

    def test_vehicle_lookup_is_model_requested_and_grounded(self):
        work = job(message("m1", "示例车A 22款"))
        output = answer("", "vehicle_fitment", rule_id="vehicle_fit", memory=[{"field": "vehicle", "source_id": "m1", "quote": "示例车A"},
                                                                                  {"field": "year", "source_id": "m1", "quote": "22款"}])
        result, post = self.run_brain(work, tool(), completion(output))
        self.assertEqual(result["text"], engine.vehicle_match.FIT_REPLY)
        self.assertEqual(result["_conversation_memory"]["year"]["quote"], "22款")
        first = json.loads(post.call_args_list[0].args[1]["messages"][1]["content"])
        self.assertNotIn("vehicle_knowledge", first)
        queried = json.loads(post.call_args_list[1].args[1]["messages"][-1]["content"])
        self.assertEqual(queried["status"], "matched")
        self.assertEqual(queried["rules"][0]["reply"], result["text"])

    def test_multi_turn_purchase_retains_vehicle_without_requery(self):
        work = job(message("m1", "示例车A 22款", when=1))
        memory = conversation_memory.update({}, [{"field": "vehicle", "source_id": "m1", "quote": "示例车A"},
                                                  {"field": "year", "source_id": "m1", "quote": "22款"}], work["payload"]["context"])
        for n, (text, intent, reply) in enumerate((("我看看咋下单", "purchase", "选择需要的窗位规格下单即可"),
                                                  ("买好了，你备注下138元", "remark", "嗯嗯 已记录"),
                                                  ("尽快发货", "shipping", "48小时内发货")), 2):
            work = job(message("m" + str(n), text, when=n))
            work["conversation_memory"] = memory
            work["settings"]["rules"] = [{"id": "business", "contains": intent, "reply": reply}]
            result, post = self.run_brain(work, completion(answer("", intent, rule_id="business")))
            self.assertEqual(result["text"], reply)
            self.assertEqual(post.call_count, 1)
            memory = result["_conversation_memory"]
            self.assertEqual(memory["vehicle"]["quote"], "示例车A")
            supplied = json.loads(post.call_args.args[1]["messages"][1]["content"])
            self.assertEqual(supplied["conversation_memory"]["year"]["quote"], "22款")
            self.assertIn(reply, post.call_args.args[1]["messages"][0]["content"])

    def test_short_answer_can_query_persisted_vehicle_after_history_gap(self):
        before = {"messages": [message("old", "示例车A", when=1)]}
        saved = conversation_memory.update({}, [{"field": "vehicle", "source_id": "old", "quote": "示例车A"}], before)
        work = job(message("new", "22款", when=2)); work["conversation_memory"] = saved
        result, _ = self.run_brain(work, tool(args={"parts": [{"source_id": "new", "quote": "22款"}, {"source_id": "old", "quote": "示例车A"}]}), completion(answer("", "vehicle_fitment", rule_id="vehicle_fit")))
        self.assertEqual(result["text"], engine.vehicle_match.FIT_REPLY)

    def test_equal_timestamp_lookup_uses_history_order_not_tool_part_order(self):
        work = job(message("old", "示例车A 22款", when=1), message("new", "18款", when=1))
        work["brain_catalog"] = self.catalog
        args = {"parts": [{"source_id": "new", "quote": "18款"}, {"source_id": "old", "quote": "示例车A 22款"}]}
        facts = conversation_memory.sources(work["payload"]["context"], {})
        found = brain._lookup(work, args, facts)
        self.assertEqual(found["status"], "year_mismatch")
        with self.assertRaises(engine.ProviderFailure):
            brain._final(work, completion(answer("", "vehicle_fitment", rule_id="vehicle_fit"))["choices"][0]["message"], found["rules"], found)
        work["payload"]["context"]["messages"] = [facts["new"]]
        with self.assertRaisesRegex(engine.ProviderFailure, "ambiguous_evidence_order"):
            brain._lookup(work, args, facts)

    def test_car_quote_excludes_unrelated_business_language(self):
        work = job(message("m1", "前面的事已经处理好了。我另外一辆示例车A也想买，22款的能用吗"))
        parts = [{"source_id": "m1", "quote": "示例车A"}, {"source_id": "m1", "quote": "22款"}]
        result, _ = self.run_brain(work, tool(args={"parts": parts}), completion(answer("", "vehicle_fitment", rule_id="vehicle_fit")))
        self.assertEqual(result["text"], engine.vehicle_match.FIT_REPLY)

    def test_vehicle_rules_require_tool_and_vehicle_intent(self):
        for intent in ("purchase", "vehicle_fitment"):
            result, _ = self.run_brain(job(message("m1", "怎么买")), completion(answer("", intent, rule_id="vehicle_no_size")))
            self.assertEqual(result["action"], "handoff")
        result, _ = self.run_brain(job(message("m1", "完全没有的车")), tool(quote="完全没有的车"), completion(answer("", "purchase", rule_id="vehicle_no_size")))
        self.assertEqual(result["action"], "handoff")

    def test_required_vehicle_handoff_cannot_be_bypassed_with_shop_rule(self):
        work = job(message("m1", "吉姆尼5门"))
        work["settings"]["rules"] = [{"id": "buy", "contains": "下单", "reply": "直接下单"}]
        result, _ = self.run_brain(work, tool(quote="吉姆尼5门"), completion(answer("", "vehicle_fitment", rule_id="buy")))
        self.assertEqual(result["reason"], "vehicle_handoff:needs_human")
        self.assertEqual(result["action"], "handoff")

    def test_fabricated_or_seller_sources_cannot_query(self):
        for ids in (["invented"], ["agent"], ["m1", "m1"]):
            work = job(message("agent", "示例车A", role="agent", when=1), message("m1", "你好", when=2), message("m2", "22款", when=3))
            result, _ = self.run_brain(work, tool(args={"parts": [{"source_id": i, "quote": "示例车A"} for i in ids]}))
            self.assertIn("invalid_tool_arguments", result["reason"])

    def test_unknown_tools_and_unbounded_arguments_are_refused(self):
        for call in (tool("delete_order", {}), tool("read_orders", {"url": "forbidden"}), tool(args={"source_ids": ["m1"], "shop_id": "b"})):
            result, _ = self.run_brain(job(message("m1", "你好")), call)
            self.assertEqual(result["action"], "handoff")

    def test_tool_loop_is_bounded(self):
        result, post = self.run_brain(job(message("m1", "你好")), tool("read_orders", {}), tool("read_product", {}), tool("read_orders", {}))
        self.assertIn("tool_budget_exceeded", result["reason"])
        self.assertEqual(post.call_count, 3)
        self.assertEqual(post.call_args.args[1]["tool_choice"], "none")

    def test_invalid_final_can_be_repaired_without_executing_it(self):
        work = job(message("m1", "示例车A 22款"))
        result, post = self.run_brain(work, completion(answer("可以用", "vehicle_fitment")), tool(),
                                      completion(answer("", "vehicle_fitment", rule_id="vehicle_fit")))
        self.assertEqual(result["text"], engine.vehicle_match.FIT_REPLY)
        self.assertEqual(post.call_count, 3)
        self.assertIn("vehicle_claim_unverified", post.call_args_list[1].args[1]["messages"][3]["content"])

    def test_product_and_order_tools_only_read_event_scoped_data(self):
        work = job(message("m1", "什么材质"))
        work["product_notes"] = "虚构商品仅有黑色"
        work["payload"]["context"]["orders"] = [{"status": "待发货", "observed_at": 1}]
        result, post = self.run_brain(work, tool("read_product", {}), completion(answer("黑色", "product")))
        self.assertEqual(result["text"], "黑色")
        tool_result = json.loads(post.call_args.args[1]["messages"][-1]["content"])
        self.assertEqual(tool_result["shop_product_notes"], "虚构商品仅有黑色")
        orders = brain._execute(work, "read_orders", {}, {})
        self.assertEqual(orders["authority"], "page_snapshot_not_live")
        self.assertEqual(orders["orders"][0]["observed_at"], 1)

    def test_internal_order_notes_never_reach_model_or_tool_results(self):
        work = job(message("m1", "订单备注是什么"))
        work["payload"]["context"]["orders"] = [{"status": "待发货", "observed_at": 1, "note": "虚构商家保密信息"}]
        result, post = self.run_brain(work, tool("read_orders", {}), completion(answer("请问您想核对什么信息", "shipping")))
        self.assertEqual(result["action"], "reply")
        for call in post.call_args_list:
            body = json.dumps(call.args[1], ensure_ascii=False)
            self.assertNotIn("虚构商家保密信息", body)
        orders = brain._execute(work, "read_orders", {}, {})["orders"]
        self.assertEqual(orders, [{"status": "待发货", "observed_at": 1}])
        self.assertEqual(work["payload"]["context"]["orders"][0]["note"], "虚构商家保密信息")

    def test_timeout_falls_back_with_fresh_tool_context(self):
        work = job(message("m1", "你好"))
        with patch("backend.engine._post", side_effect=[engine.ProviderFailure("timeout"), completion(answer())]) as post:
            result = engine.decide(work, {"primary": SLOT, "backup": SLOT})
        self.assertEqual(result["text"], "您好")
        self.assertTrue(work["timing"]["fallback_used"])
        self.assertEqual(len(post.call_args.args[1]["messages"]), 2)

    def test_fabricated_memory_rejected_even_when_answer_is_valid(self):
        result, _ = self.run_brain(job(message("m1", "你好")), completion(answer(memory=[{"field": "vehicle", "source_id": "m1", "quote": "不存在的车"}])))
        self.assertIn("invalid_memory", result["reason"])
        self.assertNotIn("_conversation_memory", result)

    def test_brain_timeout_does_not_change_saved_slot_or_total_deadline(self):
        work = job(message("m1", "你好"))
        work.update(brain_request_timeout_seconds=15, brain_primary_slot="backup", deadline_monotonic=time.monotonic() + 5)
        config = {"primary": SLOT, "backup": {**SLOT, "model": "preferred"}}
        original = copy.deepcopy(config)
        with patch("backend.engine._post", return_value=completion(answer())) as post:
            result = engine.decide(work, config)
        spec = post.call_args.args[0]
        self.assertEqual((result["text"], spec["model"], spec["timeout_seconds"]), ("您好", "preferred", 15))
        self.assertEqual(spec["deadline_monotonic"], work["deadline_monotonic"])
        self.assertEqual(config, original)
        self.assertFalse(work["timing"]["fallback_used"])

    def test_deadline_prevents_any_provider_call(self):
        work = job(message("m1", "你好")); work["deadline_monotonic"] = time.monotonic() - 1
        result, post = self.run_brain(work)
        self.assertEqual(result["reason"], "reply_deadline_exceeded")
        post.assert_not_called()

    def test_missing_catalog_cannot_create_fit_claim(self):
        work = job(message("m1", "示例车A"))
        with patch("backend.engine._post", side_effect=[tool(quote="示例车A"), *[completion(answer("", "vehicle_fitment", rule_id="vehicle_fit"))] * 2]):
            result = engine.decide(work, {"primary": SLOT})
        self.assertEqual(result["action"], "handoff")

    def test_real_subprocess_serializes_catalog_and_returns_memory(self):
        provider = SyntheticProvider().start(); self.addCleanup(provider.stop)
        output = answer("", "vehicle_fitment", rule_id="vehicle_fit", memory=[{"field": "vehicle", "source_id": "m1", "quote": "示例车A"}])
        provider.queue({"raw": json.dumps(tool())}, {"raw": json.dumps(completion(output))})
        work = job(message("m1", "示例车A 22款"))
        work.update(brain_catalog=self.catalog, deadline_monotonic=time.monotonic() + 10)
        result = modelworker.bounded_decide(work, {"primary": {**SLOT, "base_url": provider.base_url}}, lambda: True, threading.Event())
        self.assertEqual(result["text"], engine.vehicle_match.FIT_REPLY)
        self.assertEqual(result["_conversation_memory"]["vehicle"]["quote"], "示例车A")
        self.assertEqual(provider.count(), 2)


class MemoryTests(unittest.TestCase):
    def test_correction_clears_old_year_and_rejects_old_evidence(self):
        ctx = {"messages": [message("old", "示例车A 22款", when=1), message("new", "换一辆星河远航", when=2)]}
        before = conversation_memory.update({}, [{"field": "vehicle", "source_id": "old", "quote": "示例车A"},
                                                  {"field": "year", "source_id": "old", "quote": "22款"}], ctx)
        after = conversation_memory.update(before, [{"field": "vehicle", "source_id": "new", "quote": "星河远航"}], ctx)
        self.assertTrue(after["year"]["cleared"])
        with self.assertRaises(ValueError):
            conversation_memory.update(before, [{"field": "vehicle", "source_id": "new", "quote": "星河远航"},
                                                {"field": "year", "source_id": "old", "quote": "22款"}], ctx)
        self.assertFalse(before["year"]["cleared"])
        with self.assertRaises(ValueError):
            conversation_memory.update(after, [{"field": "year", "source_id": "old", "quote": "22款"}], ctx)
        with self.assertRaises(ValueError):
            conversation_memory.update(after, [{"field": "vehicle", "source_id": "old", "quote": "示例车A"}], ctx)

    def test_equal_timestamps_use_message_order_for_corrections(self):
        ctx = {"messages": [message("old", "示例车A 22款", when=1), message("new", "改成星河远航", when=1),
                            message("year", "25款", when=1)]}
        old_year = {"field": "year", "source_id": "old", "quote": "22款"}
        correction = {"field": "vehicle", "source_id": "new", "quote": "星河远航"}
        before = conversation_memory.update({}, [{"field": "vehicle", "source_id": "old", "quote": "示例车A"}, old_year], ctx)
        after = conversation_memory.update(before, [correction], ctx)
        self.assertTrue(after["year"]["cleared"])
        with self.assertRaisesRegex(ValueError, "stale_memory"):
            conversation_memory.update(after, [old_year], ctx)
        with self.assertRaisesRegex(ValueError, "old_vehicle_year"):
            conversation_memory.update(before, [correction, old_year], ctx)
        newer = {"field": "year", "source_id": "year", "quote": "25款"}
        self.assertEqual(conversation_memory.update(after, [newer], ctx)["year"]["quote"], "25款")
        self.assertEqual(conversation_memory.update(before, [correction, newer], ctx)["year"]["quote"], "25款")

    def test_old_year_is_rejected_when_initial_memory_omitted_year(self):
        for same_time in (False, True):
            ctx = {"messages": [message("old", "示例车A 22款", when=1), message("new", "改成星河远航", when=1 if same_time else 2),
                                message("year", "25款", when=3)]}
            before = conversation_memory.update({}, [{"field": "vehicle", "source_id": "old", "quote": "示例车A"}], ctx)
            after = conversation_memory.update(before, [{"field": "vehicle", "source_id": "new", "quote": "星河远航"}], ctx)
            self.assertNotIn("year", after)
            with self.assertRaisesRegex(ValueError, "old_vehicle_year"):
                conversation_memory.update(after, [{"field": "year", "source_id": "old", "quote": "22款"}], ctx)
            updated = conversation_memory.update(after, [{"field": "year", "source_id": "year", "quote": "25款"}], ctx)
            self.assertEqual(updated["year"]["quote"], "25款")

    def test_equal_timestamp_history_gap_cannot_restore_cleared_fact(self):
        ctx = {"messages": [message("old", "缺一片", when=1), message("new", "处理好了", when=1)]}
        old = {"field": "open_issue", "source_id": "old", "quote": "缺一片"}
        before = conversation_memory.update({}, [old], ctx)
        after = conversation_memory.update(before, [{"field": "open_issue", "source_id": "new", "quote": "处理好了", "clear": True}], ctx)
        for visible in (ctx, {"messages": ctx["messages"][:1]}):
            with self.assertRaisesRegex(ValueError, "stale_memory"):
                conversation_memory.update(after, [old], visible)

    def test_resolved_issue_cannot_be_restored_from_old_history(self):
        ctx = {"messages": [message("old", "缺一片", when=1), message("new", "已处理好了", when=2)]}
        before = conversation_memory.update({}, [{"field": "open_issue", "source_id": "old", "quote": "缺一片"}], ctx)
        after = conversation_memory.update(before, [{"field": "open_issue", "source_id": "new", "quote": "已处理好了", "clear": True}], ctx)
        self.assertTrue(conversation_memory.public(after)["open_issue"]["cleared"])
        with self.assertRaises(ValueError):
            conversation_memory.update(after, [{"field": "open_issue", "source_id": "old", "quote": "缺一片"}], ctx)

    def test_memory_cannot_claim_verified_payment_or_use_agent_text(self):
        ctx = {"messages": [message("buyer", "买好了"), message("agent", "支付已核实", role="agent")]}
        for change in ({"field": "purchase_stage", "source_id": "agent", "quote": "支付已核实"},
                       {"field": "purchase_stage", "source_id": "buyer", "quote": "已核实支付"}):
            with self.assertRaises(ValueError):
                conversation_memory.update({}, [change], ctx)
        saved = conversation_memory.update({}, [{"field": "purchase_stage", "source_id": "buyer", "quote": "买好了"}], ctx)
        self.assertEqual(conversation_memory.public(saved)["purchase_stage"]["authority"], "buyer_statement")


class StoreMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.shops = [{"shop_id": x, "name": "虚构店"} for x in ("a", "b")]
        self.store = Store(self.tmp.name, self.shops); self.addCleanup(lambda: self.store.close())
        self.identity = {"shop_id": "a", "client_id": "client"}
        self.lease = self.store.heartbeat(self.identity, {"instance_id": "i", "session_id": "s"})
        self.store.update_settings("a", {"enabled": True, "mode": "hybrid", "system_prompt": "", "rules": []})

    def enqueue(self, key, revision, conversation="buyer"):
        payload = {"event_id": key, "message_id": key, "conversation_id": conversation, "context_revision": revision,
                   "received_at": time.time(), **{k: self.lease[k] for k in ("instance_id", "session_id", "generation")},
                   "context": {"history_complete": True, "messages": [message(key, "示例车A 22款")]}}
        self.store.enqueue(self.identity, payload)
        work = self.store.next_job(); work["conversation_brain"] = True
        work.update(self.store.conversation_context(work))
        return work

    def result(self, work):
        memory = conversation_memory.update({}, [{"field": "vehicle", "source_id": work["payload"]["message_id"], "quote": "示例车A"}], work["payload"]["context"])
        return {**engine.decision("reply", "model:brain:synthetic", "请问哪一年的？"), "_conversation_memory": memory}

    def test_memory_survives_restart_is_isolated_and_never_leaks_on_wire(self):
        first = self.enqueue("m1", 1)
        result = self.store.finish(first, self.result(first))
        self.assertNotIn("_conversation_memory", result)
        self.assertNotIn("conversation_memory", json.dumps(self.store.get(self.identity, "m1")))
        self.store.close(); self.store = Store(self.tmp.name, self.shops)
        self.lease = self.store.heartbeat(self.identity, {"instance_id": "i", "session_id": "s"})
        second = self.enqueue("m2", 2)
        self.assertEqual(second["conversation_memory"]["vehicle"]["quote"], "示例车A")
        self.assertEqual(second["previous_deliveries"][0]["status"], "unclaimed")
        foreign = self.enqueue("m3", 1, "other-buyer")
        self.assertEqual(foreign["conversation_memory"], {})
        with self.store.lock:
            self.assertEqual(self.store.db.execute("SELECT count(*) FROM conversation_memory WHERE shop_id='b'").fetchone()[0], 0)

    def test_superseded_job_cannot_save_memory(self):
        old = self.enqueue("m1", 1)
        self.enqueue("m2", 2)
        result = self.store.finish(old, self.result(old))
        self.assertEqual(result["reason"], "superseded")
        self.assertEqual(self.store.conversation_context(old)["conversation_memory"], {})

    def test_settings_change_or_expired_lease_cannot_save_memory(self):
        for change in ("settings", "lease"):
            with self.subTest(change=change):
                work = self.enqueue(change, 1, change)
                if change == "settings":
                    self.store.update_settings("a", {"enabled": True, "mode": "hybrid", "system_prompt": "new", "rules": []})
                else:
                    with self.store.lock, self.store.db:
                        self.store.db.execute("UPDATE leases SET payload=json_set(payload,'$.expires_at',0) WHERE shop_id='a'")
                self.store.finish(work, self.result(work))
                self.assertEqual(self.store.conversation_context(work)["conversation_memory"], {})

    def test_unknown_and_failed_receipts_remain_distinct_from_sent(self):
        for index, status in enumerate(("sent", "not_sent", "unknown"), 1):
            work = self.enqueue("m" + str(index), index)
            self.store.finish(work, self.result(work))
            with self.store.lock, self.store.db:
                self.store.db.execute("UPDATE events SET delivery=json_set(delivery,'$.status',?) WHERE event_id=?", (status, work["event_id"]))
        last = self.enqueue("latest", 4)
        self.assertEqual([d["status"] for d in last["previous_deliveries"]], ["sent", "not_sent", "unknown"])
        self.assertEqual(self.store.get(self.identity, "m3")["delivery"]["status"], "unknown")


class ServerBrainTests(unittest.TestCase):
    def test_opted_in_scheduler_runs_tools_and_persists_private_memory(self):
        provider = SyntheticProvider().start(); self.addCleanup(provider.stop)
        provider.queue({"raw": json.dumps(tool())}, {"raw": json.dumps(completion(answer("", "vehicle_fitment", rule_id="vehicle_fit",
            memory=[{"field": "vehicle", "source_id": "m1", "quote": "示例车A"}])))} )
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); table = root / "table"; table.mkdir(); write_table(table)
            config = {"shops": [{"shop_id": "a", "name": "虚构店"}], "clients": [], "conversation_brain": ["a"],
                      "vehicle_knowledge": {"a": str(table)}, "model": {"primary": {**SLOT, "base_url": provider.base_url}}}
            server = create_server(config, root / "data", port=0)
            try:
                identity = {"shop_id": "a", "client_id": "client"}
                lease = server.store.heartbeat(identity, {"instance_id": "i", "session_id": "s", "capabilities": ["reply_deadline"]})
                server.store.update_settings("a", {"enabled": True, "mode": "hybrid", "system_prompt": "", "rules": []})
                server.store.enqueue(identity, {"event_id": "m1", "message_id": "m1", "conversation_id": "buyer", "context_revision": 1,
                    "received_at": time.time(), "remaining_budget_ms": 10000,
                    **{k: lease[k] for k in ("instance_id", "session_id", "generation")},
                    "context": {"history_complete": True, "messages": [message("m1", "示例车A 22款")]}})
                server.wake.set()
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    result = server.store.get(identity, "m1")
                    if result["state"] == "ready":
                        break
                    time.sleep(0.01)
                self.assertEqual(result["decision"]["text"], engine.vehicle_match.FIT_REPLY)
                self.assertNotIn("_conversation_memory", result["decision"])
                with server.store.lock:
                    saved = server.store.db.execute("SELECT payload FROM conversation_memory WHERE shop_id='a'").fetchone()
                self.assertEqual(json.loads(saved[0])["vehicle"]["quote"], "示例车A")
            finally:
                server.server_close()


class ConfigTests(unittest.TestCase):
    def test_opt_in_is_validated(self):
        config = {"shops": [{"shop_id": "a", "name": "虚构店"}], "clients": []}
        validate_config(config)
        validate_config({**config, "conversation_brain": ["a"], "brain_primary_slot": "backup"})
        for value in ("a", ["missing"], ["a", "a"], [None]):
            with self.subTest(value=value), self.assertRaises(ApiError):
                validate_config({**config, "conversation_brain": value})
        with self.assertRaises(ApiError):
            validate_config({**config, "brain_primary_slot": "invented"})
        for value in (0, 61, True, "15", None):
            with self.subTest(timeout=value), self.assertRaises(ApiError):
                validate_config({**config, "brain_request_timeout_seconds": value})
        validate_config({**config, "brain_request_timeout_seconds": 15})
