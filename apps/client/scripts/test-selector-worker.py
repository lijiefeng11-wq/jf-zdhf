import io
import json
import unittest
from contextlib import redirect_stdout

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/main"))

from selector_worker import MAX_BYTES, main, select


def run(html):
    return select(json.dumps({"html": html}, ensure_ascii=False).encode("utf-8"))


def area(inner, scope='<div class="reply-footer">', close="</div>"):
    return f"<div class='chat'>{scope}{inner}{close}</div>"


class SelectorWorkerTest(unittest.TestCase):
    def test_single_chinese_button(self):
        self.assertEqual(run(area("<button data-claw-candidate='7'> 发送 </button>")),
                         {"candidate": 7, "engine": "scrapling"})

    def test_single_send_btn_div_in_attribute_scope(self):
        html = '<section data-claw-send-area="1"><div class="send-btn" data-claw-candidate="0">Send</div></section>'
        self.assertEqual(run(html), {"candidate": 0, "engine": "scrapling"})

    def test_semantic_label_without_legacy_class(self):
        self.assertEqual(run(area("<span data-claw-send-control='true' data-claw-candidate='6'>发送</span>")), {"candidate": 6, "engine": "scrapling"})

    def test_insist_send_label(self):
        self.assertEqual(run(area("<div class='send-btn' data-claw-candidate='2'>坚持 发送</div>")),
                         {"candidate": 2, "engine": "scrapling"})

    def test_ambiguous_two_controls(self):
        inner = "<button data-claw-candidate='1'>发送</button><button data-claw-candidate='2'>Send</button>"
        self.assertEqual(run(area(inner)), {"error": "ambig"})

    def test_absent_outside_scope_or_non_send_control(self):
        self.assertEqual(run("<div class='other'><button data-claw-candidate='3'>发送</button></div>"),
                         {"error": "absent"})
        self.assertEqual(run(area("<span data-claw-candidate='3'>发送</span>")), {"error": "absent"})

    def test_wrong_text_rejected(self):
        for text in ("发送商品", "转移", "确定", "坚持", "坚持发送商品"):
            self.assertEqual(run(area(f"<button data-claw-candidate='4'>{text}</button>")),
                             {"error": "absent"})

    def test_invalid_or_missing_candidate_id(self):
        for cid in ("101", "-1", "7a", "", None):
            attr = "" if cid is None else f" data-claw-candidate='{cid}'"
            self.assertEqual(run(area(f"<button{attr}>发送</button>")), {"error": "bad_candidate"})

    def test_malformed_and_unsigned_input(self):
        for raw in (b"not json", b'{"html": 1}', b'{"html": "x", "extra": 0}', b"[]"):
            self.assertEqual(select(raw), {"error": "input_invalid"})
        self.assertEqual(select("html"), {"error": "input_invalid"})

    def test_excessive_input_and_cli_fixed_output(self):
        self.assertEqual(select(b" " * (MAX_BYTES + 1)), {"error": "input_too_large"})

        def cli(raw):
            buf = io.StringIO()
            with redirect_stdout(buf):
                main(io.BytesIO(raw))
            return buf.getvalue()

        good = {"html": area("<button data-claw-candidate='9'>Send</button>")}
        self.assertEqual(cli(json.dumps(good).encode()), '{"candidate":9,"engine":"scrapling"}\n')
        self.assertEqual(cli(b"<xml"), '{"error":"input_invalid"}\n')


if __name__ == "__main__":
    unittest.main()
