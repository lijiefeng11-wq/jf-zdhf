"""Main and dedicated links from learned goods, the link a car needs, and the shop's detail notes (fictional data)."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from backend import vehicle_knowledge as vk
from backend.engine import model_decide
from backend.productcatalog import ProductCatalog
from backend.store import ApiError, Store
from test_vehicle_knowledge import document
from test_vehicle_lookup_v2 import SLOT, completion, messages

ROWS = {
    "问界": [("L-w5", "问界", "问界M5"), ("L-w7a", "问界", "22-25款 问界M7"), ("L-w7b", "问界", "26款 问界M7")],
    "丰田": [("L-t1", "丰田", "卡罗拉/雷凌 19-25款"), ("L-t2", "丰田", "凯美瑞八代 18-23")],
    "凯迪拉克": [("L-c1", "凯迪拉克", "XT6")],
}
WENJIE = {"product_key": "1" * 64, "title": "问界m5/m7专用汽车遮阳挡防晒隔热",
          "facts": ["商品名称：问界m5/m7专用汽车遮阳挡防晒隔热", '规格组合：款式："问界m5"；型号："前挡1片"',
                    '规格组合：款式："【26款】问界m7"；型号："前挡1片"']}
TOYOTA = {"product_key": "2" * 64, "title": "丰田凯美瑞/卡罗拉/雷凌专用汽车遮阳挡", "facts": ["商品名称：丰田凯美瑞/卡罗拉/雷凌专用汽车遮阳挡"]}
MAIN = {"product_key": "3" * 64, "title": "全车定制专车专用汽车遮阳挡",
        "facts": ["商品名称：全车定制专车专用汽车遮阳挡", '规格组合：颜色："下单留言车型+年份【双面黑】"；型号："前挡1片"']}
OTHER = {"product_key": "4" * 64, "title": "汽车脚垫", "facts": ["商品名称：汽车脚垫"]}
DOCS = [WENJIE, TOYOTA, MAIN, OTHER]
SENTENCE = "您进来的是问界m5/m7专车链接，您的车需要拍「丰田凯美瑞/卡罗拉/雷凌」专车链接，我给您记录车型"


def context(text, entry=WENJIE, titles=(), orders=None, before=()):
    turns = [*before, ("buyer", text)]
    ctx = {"messages": messages(*turns), "history_complete": True,
           "goods": [{"goods_ref": "g1", "title": "平台来源卡片：买家从商品进入", "product_key": entry["product_key"],
                      "evidence": [{"source": "goods_card", "message_id": "m0", "observed_at": 1}]}],
           "send_options": {"goods": [{"option_id": "g-%d" % i, "goods_title": t, "observed_at": 1} for i, t in enumerate(titles)]}}
    if orders is not None:
        ctx["orders"] = orders
    return ctx


class Links(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for folder, rows in ROWS.items():
            (root / folder).mkdir()
            for record, family, model in rows:
                (root / folder / (record + ".md")).write_text(document(record=record, model=model, family=family), encoding="utf-8")
        self.catalog = vk.load_directory(root)

    def recommend(self, ctx):
        return self.catalog.recommend_link(ctx, self.catalog.conversation(ctx["messages"]), DOCS)

    def test_main_dedicated_and_unknown_links(self):
        self.assertEqual(self.catalog.describe_link(MAIN)["kind"], "main")
        link = self.catalog.describe_link(WENJIE)
        self.assertEqual((link["kind"], link["label"]), ("dedicated", "问界m5/m7"))
        # A bare code takes the first car's brand; a bracketed year in a spec is searched with the car.
        self.assertEqual([u["query"] for u in link["units"]], ["问界m5", "问界m7", "26款 问界m7"])
        self.assertIsNone(self.catalog.describe_link(OTHER)["kind"])
        fits = {**OTHER, "title": "专用汽车遮阳挡", "facts": ["属性：适用车型：卡罗拉、XT6"]}
        self.assertEqual(self.catalog.describe_link(fits)["label"], "卡罗拉、XT6")

    def test_another_cars_entry_link_recommends_its_link(self):
        link = self.recommend(context("卡罗拉 22款能用吗"))
        self.assertEqual((link["reply"], link["option_id"]), (SENTENCE, None))
        # Sendable: the sentence offers the card.
        link = self.recommend(context("卡罗拉 22款能用吗", titles=["汽车脚垫", TOYOTA["title"]]))
        self.assertEqual((link["reply"], link["option_id"]), (SENTENCE + "，需要链接说一声我发您", "g-1"))
        # No dedicated link for the car: the main link.
        self.assertEqual(self.recommend(context("XT6能用吗"))["reply"],
                         "您进来的是问界m5/m7专车链接，您的车需要拍店里下单留言车型的通用链接，我给您记录车型")

    def test_no_recommendation(self):
        for ctx in (context("问界M5能用吗"), context("26款问界M7"), context("问界M7"),  # covered, or not clear yet
                    context("卡罗拉 22款", entry=MAIN), context("卡罗拉 22款", orders=[{"status": "待发货"}])):
            with self.subTest(text=ctx["messages"][-1]["content"]):
                self.assertIsNone(self.recommend(ctx))
        ctx = context("卡罗拉 22款")
        ctx["goods"][0]["evidence"] = [{"source": "order", "order_ref": "o", "observed_at": 1}]
        self.assertIsNone(self.recommend(ctx))  # Only the link the buyer came in through or sent.

    def test_card_after_the_sentence(self):
        said = SENTENCE + "，需要链接说一声我发您"
        ctx = context("好的发我", titles=[TOYOTA["title"]], before=[("buyer", "卡罗拉 22款"), ("agent", said)])
        self.assertEqual(self.catalog.link_card(ctx, DOCS), {"type": "goods_card", "option_id": "g-0"})
        self.assertIsNone(self.catalog.link_card(context("好的发我", before=[("agent", said)]), DOCS))  # Not sendable now.
        self.assertIsNone(self.catalog.link_card(context("好的", titles=[TOYOTA["title"]], before=[("agent", "您好")]), DOCS))


    def test_review_fixes(self):
        # A link of a year the table lacks covers no row: 22款卡罗拉 gets the main link, not the 30款 link.
        future = {"product_key": "5" * 64, "title": "30款卡罗拉专用遮阳挡", "facts": ["商品名称：30款卡罗拉专用遮阳挡"]}
        self.assertEqual(self.catalog.recommend_link(context("卡罗拉 22款"), self.catalog.conversation(
            context("卡罗拉 22款")["messages"]), [WENJIE, future, MAIN])["target"], None)
        # Two sendable options with the recommended title: no card is chosen by list order.
        twin = {**TOYOTA, "product_key": "6" * 64}
        ctx = context("卡罗拉 22款", titles=[TOYOTA["title"], TOYOTA["title"]])
        link = self.catalog.recommend_link(ctx, self.catalog.conversation(ctx["messages"]), DOCS)
        self.assertEqual((link["option_id"], link["reply"]), (None, SENTENCE))
        ctx = context("卡罗拉 22款", titles=[TOYOTA["title"]])
        self.assertIsNone(self.catalog.recommend_link(ctx, self.catalog.conversation(ctx["messages"]), DOCS + [twin])["option_id"])
        said = SENTENCE + "，需要链接说一声我发您"
        follow = context("好的发我", titles=[TOYOTA["title"], TOYOTA["title"]], before=[("buyer", "卡罗拉 22款"), ("agent", said)])
        self.assertIsNone(self.catalog.link_card(follow, DOCS))
        # A newer order of another product does not hide the entry card.
        ctx = context("卡罗拉 22款")
        ctx["goods"].insert(0, {"goods_ref": "g0", "title": "汽车脚垫", "product_key": OTHER["product_key"],
                                "evidence": [{"source": "order", "order_ref": "o", "observed_at": 99}]})
        self.assertEqual(self.recommend(ctx)["target"], "丰田凯美瑞/卡罗拉/雷凌")
        # Only a link selling the same thing: a 卡罗拉 floor mat never replaces the sunshade's main link.
        mat = {"product_key": "9" * 64, "title": "卡罗拉专用汽车脚垫", "facts": ["商品名称：卡罗拉专用汽车脚垫"]}
        plain = context("卡罗拉 22款", titles=[mat["title"]])
        link = self.catalog.recommend_link(plain, self.catalog.conversation(plain["messages"]), [WENJIE, mat, MAIN])
        self.assertEqual((link["target"], link["option_id"]), (None, None))
        follow = context("好的发我", titles=[mat["title"]], before=[("buyer", "卡罗拉 22款"), ("agent", said)])
        self.assertIsNone(self.catalog.link_card(follow, [WENJIE, mat, MAIN]))
        unknown = {**WENJIE, "title": "问界m5/m7专用汽车用品"}
        plain = context("卡罗拉 22款", entry=unknown)
        self.assertIsNone(self.catalog.recommend_link(plain, self.catalog.conversation(plain["messages"]), [unknown, TOYOTA, MAIN]))
        # A newer card without a learned product: the older entry card no longer decides.
        ctx["goods"].insert(0, {"goods_ref": "g9", "title": "别的商品", "evidence": [{"source": "goods_card", "message_id": "m9", "observed_at": 50}]})
        self.assertIsNone(self.recommend(ctx))


class CrossBrand(unittest.TestCase):
    def test_same_model_name_of_another_brand(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for folder, record in (("问界", "SUN-w1"), ("风行", "SUN-f1")):
                (root / folder).mkdir()
                (root / folder / (record + ".md")).write_text(document(record=record, model="M7 22-26款", family=folder), encoding="utf-8")
            catalog = vk.load_directory(root)
        entry = {"product_key": "7" * 64, "title": "问界M7专用遮阳挡", "facts": []}
        fengxing = {"product_key": "8" * 64, "title": "风行M7专用遮阳挡", "facts": []}
        ctx = context("风行M7 24款", entry=entry)
        link = catalog.recommend_link(ctx, catalog.conversation(ctx["messages"]), [entry, fengxing])
        self.assertEqual(link["target"], "风行M7")


class Engine(unittest.TestCase):
    def decide(self, link, *outputs, allow_send=False):
        ctx = context("卡罗拉 22款", titles=[TOYOTA["title"]])
        vehicle = {"status": "matched", "hint": "", "candidates": [], "follow_up": False, "version": 2}
        with patch("backend.engine._post", side_effect=[completion(o) for o in outputs]) as post:
            result = model_decide(ctx, {"mode": "hybrid", "system_prompt": "", "rules": []}, {"primary": SLOT, "backup": SLOT},
                                  allow_send, vehicle_context=vehicle, vehicle_link=link)
        return result, post

    def test_link_sentence_replaces_fit(self):
        result, post = self.decide({"reply": SENTENCE}, {"action": "reply", "rule_id": "vehicle_other_link", "text": "", "reason": "x"})
        self.assertEqual(result["text"], SENTENCE)
        system = post.call_args.args[1]["messages"][0]["content"]
        self.assertIn('"id": "vehicle_other_link"', system)
        self.assertNotIn('"id": "vehicle_fit"', system)
        # The fit sentence typed by the model becomes the link sentence; fit is not offered.
        result, _ = self.decide({"reply": SENTENCE}, {"action": "reply", "text": "您的车型可以用，已给您备注车型 有需要直接下单就可以了哈", "reason": "x"})
        self.assertEqual(result["text"], SENTENCE)

    def test_card_rule_sends_the_card(self):
        card = {"type": "goods_card", "option_id": "g-0"}
        result, _ = self.decide({"card": card}, {"action": "reply", "rule_id": "vehicle_link_card", "text": "", "reason": "x"}, allow_send=True)
        self.assertEqual((result["action"], result["item"]), ("send_item", card))
        _, post = self.decide({"card": card}, {"action": "reply", "text": "好的", "reason": "x"})
        self.assertNotIn("vehicle_link_card", post.call_args.args[1]["messages"][0]["content"])  # Not without send_item.

    def test_notes_reach_the_model(self):
        with patch("backend.engine._post", return_value=completion({"action": "reply", "text": "钛银布，双面黑不透光", "reason": "x"})) as post:
            model_decide({"messages": messages(("buyer", "透光吗")), "history_complete": True},
                         {"mode": "hybrid", "system_prompt": "", "rules": []}, {"primary": SLOT}, product_notes="双面黑不透光")
        body = post.call_args.args[1]["messages"]
        self.assertIn("shop_product_notes", body[0]["content"])
        self.assertIn("双面黑不透光", json.dumps(body[1]["content"], ensure_ascii=False))


class Notes(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.store = Store(tmp.name, [{"shop_id": "a", "name": "甲"}, {"shop_id": "b", "name": "乙"}])
        self.addCleanup(self.store.close)
        self.products = ProductCatalog(self.store)

    def test_notes_per_shop_and_bounded(self):
        before = self.store._settings("a")["version"]
        status = self.products.set_notes("a", "  材质：钛银布\n双面黑不透光  ")
        self.assertEqual((status["notes"], self.products.notes("a"), self.products.notes("b")), ("材质：钛银布\n双面黑不透光",) * 2 + ("",))
        self.assertEqual(self.store._settings("a")["version"], before + 1)
        with self.assertRaises(ApiError):
            self.products.set_notes("a", "字" * 2001)
        self.products.set_notes("a", "")
        self.assertEqual(self.products.notes("a"), "")


if __name__ == "__main__":
    unittest.main()
