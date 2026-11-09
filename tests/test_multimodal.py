"""Synthetic image/card transport and decision regression tests."""
import base64
import copy
import json
import time
import unittest
from unittest.mock import patch

from backend.content import model_content, validate_content
from backend.engine import decide, model_decide, ProviderFailure
from backend.store import ApiError, require


PNG = "data:image/png;base64," + base64.b64encode(
    bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489")
).decode()
ATTACHMENT = {"type": "image", "mime": "image/png", "data_url": PNG}
SLOT = {"base_url": "http://127.0.0.1:12345/v1", "model": "synthetic-vision", "timeout_seconds": 1, "api_key": ""}
CONFIG = {"primary": SLOT, "backup": {**SLOT, "model": "synthetic-backup"}}


def message(kind="text", role="buyer", name="m", **extra):
    return {"id": name, "role": role, "kind": kind, "content": "你好", "created_at": time.time(), **extra}


def job(messages, mode="model"):
    return {"payload": {"received_at": time.time(), "context": {"history_complete": True, "messages": messages}},
            "settings": {"enabled": True, "mode": mode, "system_prompt": "虚构店政策", "rules": [{"id": "r", "contains": "你好", "reply": "您好"}]}}


def completion():
    return {"choices": [{"message": {"content": json.dumps({"action": "reply", "text": "请问您想了解图中商品的哪个方面？", "reason": "clarify"})}}]}


class MultimodalTests(unittest.TestCase):
    def test_actual_image_parts_reach_primary_and_backup_without_data_in_text(self):
        ctx = {"history_complete": True, "messages": [message("image", attachments=[ATTACHMENT])]}
        original = copy.deepcopy(ctx)
        validate_content(ctx["messages"], require)
        with patch("backend.engine._post", side_effect=[ProviderFailure("timeout"), completion()]) as post:
            result = model_decide(ctx, {"system_prompt": "测试"}, CONFIG)
        self.assertEqual(result["action"], "reply")
        self.assertIn("model:backup", result["reason"])
        for call in post.call_args_list:
            parts = call.args[1]["messages"][1]["content"]
            self.assertEqual(parts[-1], {"type": "image_url", "image_url": {"url": PNG}})
            self.assertNotIn("base64", parts[0]["text"])
        self.assertEqual(ctx, original)

    def test_image_in_hybrid_mode_routes_to_vision_not_text_rule(self):
        with patch("backend.engine._post", return_value=completion()) as post:
            result = decide(job([message("image", attachments=[ATTACHMENT])], "hybrid"), CONFIG)
        self.assertEqual(post.call_count, 1)
        self.assertTrue(result["reason"].startswith("model:primary:"))

    def test_readable_card_is_model_context_not_rule_trigger_or_system_instruction(self):
        card = {"type": "goods", "title": "虚构商品", "fields": [{"label": "规格", "value": "测试规格"}]}
        msgs = [message("card", "system", "source", card={"type": "source", "title": "来源"}),
                message("card", card=card)]
        validate_content(msgs, require)
        with patch("backend.engine._post", return_value=completion()) as post:
            self.assertEqual(decide(job(msgs, "hybrid"), CONFIG)["action"], "reply")
        request = post.call_args.args[1]
        self.assertEqual(len(request["messages"]), 2)
        parsed = json.loads(request["messages"][1]["content"])
        self.assertEqual(parsed["messages"][-1]["card"], card)
        self.assertNotIn("虚构商品", request["messages"][0]["content"])

    def test_historical_images_and_cards_do_not_block_latest_text_rule(self):
        msgs = [message("image", name="old"), message("card", "system", "source"), message()]
        with patch("backend.engine._post") as post:
            result = decide(job(msgs, "rules"), CONFIG)
        self.assertEqual(result["text"], "您好")
        post.assert_not_called()
        view = json.loads(model_content({"messages": msgs}))
        self.assertFalse(view["messages"][0]["image_available"])

    def test_missing_latest_image_asks_for_image_without_model_or_handoff(self):
        with patch("backend.engine._post") as post:
            result = decide(job([message("image", content="[图片，前台未取到]")]), CONFIG)
        self.assertEqual(result["action"], "reply")
        self.assertEqual(result["reason"], "image_missing")
        post.assert_not_called()

    def test_order_remark_card_is_acknowledged_without_the_model(self):
        card = {"type": "order", "title": "请确认消费者订单备注", "fields": [{"label": "备注内容", "value": "23年虚构车型"}]}
        latest = message("card", content="请确认消费者订单备注：备注内容 23年虚构车型", card=card)
        validate_content([latest], require)
        for mode in ("hybrid", "rules", "model"):
            with self.subTest(mode=mode), patch("backend.engine._post") as post:
                result = decide(job([message(name="old"), latest], mode), CONFIG)
                self.assertEqual((result["action"], result["reason"], result["text"]), ("reply", "order_remark_card", "嗯嗯 已记录"))
                post.assert_not_called()
        # No remark read, or another order card: the usual path.
        for other in ({**card, "fields": []}, {**card, "title": "订单卡片"}):
            with self.subTest(card=other), patch("backend.engine._post", return_value=completion()) as post:
                self.assertNotEqual(decide(job([message("card", card=other)], "hybrid"), CONFIG)["reason"], "order_remark_card")
                post.assert_called_once()

    def test_delayed_message_and_rules_miss_model_fallback(self):
        item = job([message(content="商品规格", created_at=time.time()-3600)], "hybrid")
        item["payload"]["received_at"] -= 3600
        with patch("backend.engine._post", return_value=completion()) as post:
            result = decide(item, CONFIG)
        self.assertEqual(result["action"], "reply")
        self.assertEqual(post.call_count, 1)

    def test_integrity_and_current_buyer_gates_still_hold(self):
        for modifier, expected in (("disabled", "shop_disabled"),
                                   ("future", "message_future"), ("role", "no_new_buyer_message")):
            item = job([message()])
            if modifier == "disabled": item["settings"]["enabled"] = False
            if modifier == "future": item["payload"]["received_at"] += 30
            if modifier == "role": item["payload"]["context"]["messages"][-1]["role"] = "system"
            with patch("backend.engine._post") as post:
                self.assertEqual(decide(item, CONFIG)["reason"], expected)
            post.assert_not_called()

    def test_invalid_or_remote_attachments_rejected_before_model(self):
        invalid = [{**ATTACHMENT, "data_url": "http://127.0.0.1/private"},
                   {**ATTACHMENT, "mime": "image/jpeg"},
                   {**ATTACHMENT, "data_url": "data:image/png;base64,not-base64"},
                   {**ATTACHMENT, "data_url": "data:image/png;base64,"+base64.b64encode(b"not png").decode()},
                   {**ATTACHMENT, "cookie": "synthetic-forbidden"}]
        for attachment in invalid:
            with self.assertRaises(ApiError):
                validate_content([message("image", attachments=[attachment])], require)
        for msgs in ([message("image", attachments=[ATTACHMENT]*4)],
                     [message("image", name="old", attachments=[ATTACHMENT]), message()]):
            with self.assertRaises(ApiError): validate_content(msgs, require)

    def test_card_fields_are_bounded_text_not_actions(self):
        for card in ({"type": "goods", "fields": [{"label": "商品", "value": {"click": "button"}}]},
                     {"type": "goods", "fields": [{"label": "x", "value": "x"}]*11},
                     {"type": "goods", "actions": ["buy"]}, {"type": "unknown"}):
            with self.assertRaises(ApiError): validate_content([message("card", card=card)], require)

