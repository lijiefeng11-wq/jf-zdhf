"""vehicle_lookup_v2 with fictional tables and fake providers; the real table only when present locally."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend import vehicle_knowledge as vk
from backend import vehicle_match
from backend.app import create_server, validate_config
from backend.engine import ProviderFailure, model_decide
from backend.store import ApiError, Store
from test_vehicle_knowledge import document

SLOT = {"model": "fake-provider", "base_url": "http://127.0.0.1:1/v1",
        "timeout_seconds": 1, "use_environment_key": False}
REAL = Path("/Users/li/Documents/Obsidian Vault/业务表格/遮阳挡尺寸-逐车型")
ROWS = {  # brand folder -> (record, family, model)
    "示例牌": [("SUN-a1", "示例牌", "示例车A 20-24款"), ("SUN-a2", "示例牌", "示例车A 25-26款"),
            ("SUN-b1", "示例牌", "星河远航"), ("SUN-c1", "示例牌", "示例轩逸 19-25款"),
            ("SUN-d1", "示例牌", "示例旅行车5座"), ("SUN-d2", "示例牌", "示例旅行车7座")],
    "铃木": [("SUN-j1", "铃木", "07-18 吉姆尼")],
}


def messages(*turns):
    now = time.time()
    return [{"id": "m%d" % i, "role": role, "kind": "text", "content": text, "created_at": now + i}
            for i, (role, text) in enumerate(turns)]


def write_table(root):
    for folder, rows in ROWS.items():
        (root / folder).mkdir()
        for record, family, model in rows:
            (root / folder / (record + ".md")).write_text(document(record=record, model=model, family=family), encoding="utf-8")


def completion(output):
    return {"choices": [{"message": {"content": json.dumps(output, ensure_ascii=False)}}]}


class FictionalTable(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        write_table(Path(temp.name))
        self.catalog = vk.load_directory(Path(temp.name))

    def talk(self, *turns, orders=()):
        return self.catalog.conversation(messages(*turns), orders)

    def test_statuses(self):
        cases = {"示例车A": "needs_year", "示例车A 22款": "matched", "示例车A 18款": "year_mismatch",
                 "示例旅行车": "needs_model", "示例旅行车 七座": "matched", "星河远杭": "similar",
                 "示例軒逸": "matched", "完全没有的车": "not_found", "吉姆尼5门": "needs_human",
                 "在吗": "no_vehicle", "您好？": "no_vehicle", "后窗": "no_vehicle"}
        for text, status in cases.items():
            with self.subTest(text=text):
                self.assertEqual(self.talk(("buyer", text))["status"], status)

    def test_short_answers_complete_the_car_asked_about(self):
        result = self.talk(("buyer", "示例车A"), ("agent", "请问是20-24款还是25-26款？"), ("buyer", "22款的"))
        self.assertEqual((result["status"], result["follow_up"]), ("matched", True))
        self.assertEqual(result["candidates"], [{"family": "示例牌", "model": "示例车A 20-24款"}])
        result = self.talk(("buyer", "星河远杭"), ("agent", "是星河远航吗？"), ("buyer", "是的"))
        self.assertEqual(result["status"], "matched")
        result = self.talk(("buyer", "示例旅行车"), ("agent", "5座还是7座？"), ("buyer", "7座"))
        self.assertEqual(result["status"], "matched")
        # A window alone asks about the car just named.
        result = self.talk(("buyer", "示例车A 22款"), ("buyer", "后窗"))
        self.assertEqual((result["status"], result["follow_up"]), ("matched", True))
        # It completes only a car the table has: after a complaint or an unknown car it names no car.
        for before in ("完全没有的车", "我已经找遍了，没有找到小床的"):
            with self.subTest(before=before):
                self.assertEqual(self.talk(("buyer", before), ("buyer", "小窗的"))["status"], "no_vehicle")
        # Also when a year answer came between the unknown car and the window.
        self.assertEqual(self.talk(("buyer", "完全没有的车"), ("buyer", "25款"), ("buyer", "后窗"))["status"], "no_vehicle")
        # A new question is not a follow-up: it never inherits the earlier car.
        self.assertEqual(self.talk(("buyer", "示例车A 22款"), ("agent", "x"), ("buyer", "发货几天"))["status"], "no_vehicle")
        self.assertEqual(self.talk(("buyer", "示例车A 22款"), ("agent", "x"), ("buyer", "在吗"))["status"], "no_vehicle")

    def test_order_talk_after_an_unknown_car_names_no_car(self):
        # The table lacks the earlier car; "下单了" must never be answered with the no-size sentence.
        for text in ("下单了", "尽快发货", "快点", "还要备注吗？", "你给我备注一下", "你帮我备注一下，我下单了",
                     "我拍了给我备份车型年份", "怎么没发货呢", "已经下单了麻烦尽快发货", "今天能发货不"):
            with self.subTest(text=text):
                result = self.talk(("buyer", "完全没有的车 2025"), ("agent", "x"), ("buyer", text), orders=[{"status": "待发货"}])
                self.assertEqual((result["status"], result["forced"]), ("no_vehicle", None))
        # A complaint about received goods with a typo ("小床") is no car the table lacks.
        self.assertEqual(self.talk(("buyer", "你核实一下，我已经找遍了，没有找到小床的"))["status"], "no_vehicle")
        # Asking whether a car fits is a lookup, even with a complaint word in it.
        self.assertEqual(self.talk(("buyer", "请核实一下完全没有的车能用吗"))["status"], "not_found")
        # A car named together with the order talk is still looked up.
        self.assertEqual(self.talk(("buyer", "下单了，车型：示例车A 22款"))["status"], "matched")
        self.assertEqual(self.talk(("buyer", "已经下单了，完全没有的车"))["status"], "not_found")

    def test_program_stops(self):
        self.assertEqual(self.talk(("buyer", "吉姆尼5门"))["forced"], "needs_human")
        asked = self.talk(("buyer", "示例车A"), ("agent", "哪一款？"), ("buyer", "示例旅行车"), ("agent", "5座还是7座？"),
                          ("buyer", "星河远杭"))
        self.assertEqual((asked["asks_before"], asked["forced"]), (2, "vehicle_ask_limit"))
        insist = self.talk(("buyer", "示例车A 18款"), ("agent", "表里是20-24款，是这款吗？"), ("buyer", "18款"))
        self.assertEqual(insist["forced"], "repeated_year_mismatch")
        self.assertIsNone(self.talk(("buyer", "示例车A"))["forced"])
        ordered = self.talk(("buyer", "示例车A"), orders=[{"status": "待发货"}])
        self.assertEqual(ordered["forced"], "ordered_vehicle_unclear")
        self.assertIsNone(self.talk(("buyer", "示例车A"), orders=[{"status": "已取消"}])["forced"])
        self.assertIsNone(self.talk(("buyer", "示例车A 22款"), orders=[{"status": "待发货"}])["forced"])

    def test_short_answers_without_a_car(self):
        for turns in ((("buyer", "是的"),), (("buyer", "18款"), ("agent", "哪款车？"), ("buyer", "是的"))):
            with self.subTest(turns=turns):
                self.assertEqual(self.talk(*turns)["status"], "no_vehicle")

    def test_review_fixes(self):
        # A stated seat count the table does not have is a question, never a fit.
        self.assertEqual(self.talk(("buyer", "示例旅行车 6座"))["status"], "needs_model")
        # The latest year replaces the earlier one, and a bare 2-digit answer is a year.
        fixed = self.talk(("buyer", "示例车A 18款"), ("agent", "表里是20-24款，是这款吗？"), ("buyer", "22款"))
        self.assertEqual((fixed["status"], fixed["forced"]), ("matched", None))
        bare = self.talk(("buyer", "示例车A"), ("agent", "哪一年？"), ("buyer", "22"))
        self.assertEqual(bare["status"], "matched")
        # A denied car is never approved.
        self.assertNotIn(self.talk(("buyer", "不是星河远航，是完全没有的车"))["status"], vehicle_match.MATCH_STATUSES)
        # Also when a window answer follows the denial.
        self.assertNotIn(self.talk(("buyer", "不是星河远航，是完全没有的车"), ("buyer", "后窗"))["status"],
                         vehicle_match.MATCH_STATUSES)
        # A yes to an unknown car keeps the car the buyer confirmed: it is no window answer.
        for yes in ("是的", "对", "嗯"):
            with self.subTest(yes=yes):
                confirmed = self.talk(("buyer", "完全没有的车"), ("agent", "请确认车型是完全没有的车吗？"), ("buyer", yes))
                self.assertEqual((confirmed["status"], confirmed["follow_up"]), ("not_found", True))

    def test_brand_said_picks_its_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for folder, record in (("问界", "SUN-w1"), ("风行", "SUN-f1")):
                (root / folder).mkdir()
                (root / folder / (record + ".md")).write_text(document(record=record, model="M7 22-26款", family=folder), encoding="utf-8")
            catalog = vk.load_directory(root)
            result = catalog.conversation(messages(("buyer", "问界M7 24款")))
            self.assertEqual(result["status"], "matched")
            self.assertEqual(result["candidates"], [{"family": "问界", "model": "M7 22-26款"}])
            self.assertEqual(catalog.conversation(messages(("buyer", "M7 24款")))["status"], "needs_model")

    def test_latest_non_text_has_no_lookup(self):
        msgs = messages(("buyer", "示例车A"))
        msgs.append({**msgs[0], "id": "img", "kind": "image", "content": "[图片]"})
        self.assertIsNone(self.catalog.conversation(msgs))

    def test_old_lookup_is_unchanged(self):
        self.assertEqual(self.catalog.lookup("示例车A 22款")["status"], "ambiguous")


class EngineV2(unittest.TestCase):
    def decide(self, vehicle, *outputs, prompt="模型自写回复不要超过20个字"):
        ctx = {"messages": messages(("buyer", "示例车A 22款")), "history_complete": True}
        with patch("backend.engine._post", side_effect=[completion(o) for o in outputs]) as post:
            result = model_decide(ctx, {"mode": "hybrid", "system_prompt": prompt, "rules": []},
                                  {"primary": SLOT, "backup": SLOT}, vehicle_context={**vehicle, "version": 2})
        return result, post

    def test_matched_fixed_sentence_is_exact(self):
        vehicle = {"status": "matched", "hint": "表内匹配", "candidates": [], "follow_up": False}
        result, post = self.decide(vehicle, {"action": "reply", "rule_id": "vehicle_fit", "text": "", "reason": "x"})
        self.assertEqual((result["action"], result["text"]), ("reply", vehicle_match.FIT_REPLY))
        self.assertIn("车型    有需要", result["text"])
        system = post.call_args.args[1]["messages"][0]["content"]
        self.assertIn('"id": "vehicle_fit"', system)
        self.assertNotIn('"id": "vehicle_no_size"', system)
        self.assertNotIn("fitment_confirmed", post.call_args.args[1]["messages"][1]["content"])
        # The model typing the sentence itself with other spacing still sends the shop's exact text.
        result, _ = self.decide(vehicle, {"action": "reply", "text": "您的车型可以用，已给您备注车型 有需要直接下单就可以了哈", "reason": "x"})
        self.assertEqual(result["text"], vehicle_match.FIT_REPLY)

    def test_no_size_only_for_not_found(self):
        vehicle = {"status": "not_found", "hint": "表里没有", "candidates": [], "follow_up": False}
        result, _ = self.decide(vehicle, {"action": "reply", "rule_id": "vehicle_no_size", "text": "", "reason": "x"})
        self.assertEqual(result["text"], vehicle_match.NO_SIZE_REPLY)
        vehicle["status"] = "needs_year"
        result, _ = self.decide(vehicle, {"action": "reply", "rule_id": "vehicle_no_size", "text": "", "reason": "x"},
                                {"action": "reply", "rule_id": "vehicle_fit", "text": "", "reason": "x"})
        self.assertEqual(result["action"], "handoff")  # Neither fixed sentence fits a question status.

    def test_no_vehicle_offers_no_vehicle_sentence(self):
        vehicle = {"status": "no_vehicle", "hint": "没有提到车型", "candidates": [], "follow_up": False}
        result, _ = self.decide(vehicle, {"action": "reply", "rule_id": "vehicle_no_size", "text": "", "reason": "x"},
                                {"action": "reply", "text": "您好，请问有什么可以帮您？", "reason": "x"})
        self.assertEqual(result["text"], "您好，请问有什么可以帮您？")

    def test_question_room_and_unverified_claims(self):
        vehicle = {"status": "needs_year", "hint": "按年款区分", "candidates": [], "follow_up": False}
        question = "请问您的是20-24款示例车A，还是25-26款示例车A呢？"
        self.assertGreater(len(question), 20)
        result, _ = self.decide(vehicle, {"action": "reply", "text": question, "reason": "x"})
        self.assertEqual(result["text"], question)
        result, post = self.decide(vehicle, {"action": "reply", "text": "可以用的亲", "reason": "x"},
                                   {"action": "reply", "text": "请问是哪一年的？", "reason": "x"})
        self.assertEqual((result["text"], len(post.call_args_list)), ("请问是哪一年的？", 2))
        # Even when matched, a self-written fit claim is not the fixed sentence and is rejected.
        matched = {"status": "matched", "hint": "表内匹配", "candidates": [], "follow_up": False}
        result, post = self.decide(matched, {"action": "reply", "text": "可以用，终身保修", "reason": "x"},
                                   {"action": "reply", "rule_id": "vehicle_fit", "text": "", "reason": "x"})
        self.assertEqual((result["text"], len(post.call_args_list)), (vehicle_match.FIT_REPLY, 2))

    def test_shop_rules_are_kept(self):
        ctx = {"messages": messages(("buyer", "几天发货")), "history_complete": True}
        rules = [{"id": "rule-ship", "contains": "发货", "reply": "48小时内发货", "description": "问发货"}]
        with patch("backend.engine._post", return_value=completion({"action": "reply", "rule_id": "rule-ship", "text": "", "reason": "x"})):
            result = model_decide(ctx, {"mode": "hybrid", "system_prompt": "", "rules": rules}, {"primary": SLOT},
                                  vehicle_context={"status": "not_found", "hint": "", "candidates": [], "follow_up": False, "version": 2})
        self.assertEqual(result["text"], "48小时内发货")


class ServerV2(unittest.TestCase):
    def test_config_switch_needs_a_table(self):
        config = {"shops": [{"shop_id": "a", "name": "虚构店"}], "clients": [], "vehicle_knowledge": {"a": str(Path(tempfile.gettempdir()).resolve() / "unused")}}
        validate_config({**config, "vehicle_lookup_v2": ["a"]})
        for bad in ("a", ["b"], ["a", "a"], [1]):
            with self.subTest(bad=bad), self.assertRaises(ApiError):
                validate_config({**config, "vehicle_lookup_v2": bad})

    def test_forced_handoff_uses_unhandled_fallback(self):
        job = {"settings": {"enabled": True, "version": 3, "fallback": {"unhandled": {"action": "none"}}},
               "payload": {"context": {}}, "capabilities": []}
        result = Store._action_fallback(job, {"action": "handoff", "reason": "vehicle_handoff:needs_human", "text": "", "expires_at": 1})
        self.assertEqual((result["action"], result["reason"]), ("none", "fallback:unhandled"))

    def test_only_switched_shop_uses_v2(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); vault = root / "catalog"; vault.mkdir(); write_table(vault)
            config = {"shops": [{"shop_id": k, "name": "虚构店"} for k in ("a", "b")], "clients": [],
                      "model": {"primary": SLOT}, "vehicle_knowledge": {"a": str(vault), "b": str(vault)},
                      "vehicle_lookup_v2": ["a"]}
            calls = []

            def post(_, body):
                calls.append(copy.deepcopy(body))
                return completion({"action": "handoff", "text": "", "reason": "synthetic"})
            with patch("backend.engine._post", side_effect=post):
                server = create_server(config, root / "data", port=0)
                try:
                    def run(shop, key, text):
                        identity = {"shop_id": shop, "client_id": "client-" + shop}
                        lease = server.store.heartbeat(identity, {"instance_id": "i", "session_id": "s"})
                        now = time.time()
                        server.store.enqueue(identity, {
                            "event_id": key, "message_id": key, "conversation_id": key, "context_revision": 1, "received_at": now,
                            **{k: lease[k] for k in ("instance_id", "session_id", "generation")},
                            "context": {"history_complete": True, "messages": [
                                {"id": key, "role": "buyer", "kind": "text", "content": text, "created_at": now}]}})
                        server.wake.set()
                        limit = time.monotonic() + 5
                        while time.monotonic() < limit:
                            with server.store.lock:
                                row = server.store.db.execute("SELECT state,decision FROM events WHERE event_id=?", (key,)).fetchone()
                            if row[0] == "ready":
                                return json.loads(row[1])
                            time.sleep(0.01)
                        self.fail("Fictional job did not complete")
                    for shop in ("a", "b"):
                        server.store.update_settings(shop, {"enabled": True, "mode": "model", "rules": [], "system_prompt": "虚构测试"})
                    run("a", "a1", "示例车A")
                    run("b", "b1", "示例车A")
                    a, b = [json.loads(call["messages"][1]["content"])["vehicle_knowledge"] for call in calls]
                    self.assertEqual((a["status"], set(a)), ("needs_year", {"status", "hint", "candidates", "follow_up"}))
                    self.assertIn("fitment_confirmed", b)
                    result = run("a", "a2", "吉姆尼5门")
                    self.assertEqual((result["action"], result["reason"]), ("handoff", "vehicle_handoff:needs_human"))
                    self.assertEqual(len(calls), 2)  # The program's stop needs no model call.
                finally:
                    server.server_close()


@unittest.skipUnless(REAL.is_dir(), "the shop's real table is only on the shop's machine")
class RealTable(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = vk.load_directory(REAL)

    def test_shop_cases(self):
        cases = {"十代思域": "matched", "卡罗拉": "needs_year", "奔驰e300": "needs_year", "路虎揽胜": "not_found",
                 "汉兰大": "similar", "豐田凱美瑞 2020款": "matched", "霸道": "needs_year", "吉姆尼五门": "needs_human"}
        for text, status in cases.items():
            with self.subTest(text=text):
                self.assertEqual(self.catalog.conversation(messages(("buyer", text)))["status"], status)
