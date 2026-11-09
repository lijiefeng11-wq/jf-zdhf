"""Explicit offline provider evaluation; fictional conversations, no platform I/O.

Run manually with --database and --config to read existing model credentials.
Neither the service database nor configuration is opened for writing. Provider
requests contain fictional messages/table data and optionally the selected shop's
saved policy, never customer records.
"""
import argparse
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from unittest.mock import patch

from backend import brain, engine, modelconfig, vehicle_knowledge
from test_conversation_brain import job, message
from test_vehicle_lookup_v2 import write_table

RULES = [
    {"id": "buy", "contains": "下单", "description": "咨询如何购买，按需要的窗位选择规格", "reply": "选择需要的窗位规格下单即可"},
    {"id": "remark", "contains": "备注", "description": "已购买后请记录车型或备注需求，不是改单", "reply": "嗯嗯 已记录"},
    {"id": "ship", "contains": "发货", "description": "一般催尽快发货，没有物流异常或超时", "reply": "48小时内发货"},
]
CASES = [
    ("报车型", "示例车A 22款能用吗", "vehicle_fit", "reply"),
    ("购买方法", "那我要怎么拍呢", "buy", "reply"),
    ("购买后备注", "我已经拍好了，帮我记录下车型", "remark", "reply"),
    ("催发货", "麻烦早点发出哦", "ship", "reply"),
    ("跨话题问候", "还在不", None, "reply"),
    ("纠正车型", "刚说错了，是星河远航，能用吗", "vehicle_fit", "reply"),
    ("收货投诉", "已经收到了，缺了一片后窗的", None, "handoff"),
    ("另买新车", "刚才缺件的事已经处理好了。我另外一辆示例车A也想买，能用吗", None, "reply"),
    ("补充年款", "22款的", "vehicle_fit", "reply"),
    ("补充后购买", "这辆就按刚才说的买，要怎么选", "buy", "reply"),
]


def evaluate(config, slot_name, timeout, policy=None):
    selected = copy.deepcopy(config.get(slot_name) or {})
    if timeout is not None:
        selected["timeout_seconds"] = timeout
    config = {**config, "primary": selected, "backup": {}}
    # Preserve the saved slot's credential resolution; never copy plaintext keys
    # to fixture files or print provider errors/bodies.
    if slot_name != "primary":
        selected["use_environment_key"] = False
    history, memory, deliveries, report = [], {}, [], []
    with tempfile.TemporaryDirectory() as temp:
        write_table(Path(temp))
        catalog = vehicle_knowledge.load_directory(Path(temp))
        for index, (label, text, expected_rule, expected_action) in enumerate(CASES):
            key = "fictional-" + str(index)
            history.append(message(key, text, when=time.time() - 1))
            work = job(*history)
            work.update(brain_catalog=catalog, conversation_memory=memory, previous_deliveries=deliveries,
                        deadline_monotonic=time.monotonic() + 20)
            work["settings"]["rules"] = RULES
            work["settings"]["system_prompt"] = "本店遮阳挡客服。缺件/质量投诉或要求人工转人工。一般购买、备注和发货按规则。自写回复最多20字。"
            if policy is not None:
                work["settings"] = {**copy.deepcopy(policy), "enabled": True}
            active_rules = work["settings"]["rules"]
            started = time.monotonic()
            tool_trace = []
            post = engine._post

            def observed(spec, body):
                response = post(spec, body)
                for choice in response.get("choices", []):
                    tool_trace.extend(choice.get("message", {}).get("tool_calls") or [])
                return response

            validation_failures = []
            validate = brain._final

            def validated(*args):
                try:
                    return validate(*args)
                except engine.ProviderFailure as exc:
                    validation_failures.append(exc.code)
                    raise

            with patch("backend.engine._post", side_effect=observed), patch("backend.brain._final", side_effect=validated):
                result = engine.decide(work, config)
            labels = {"buy": ("下单",), "remark": ("备注",), "ship": ("发货", "已下单催发货")}
            expected_texts = [r["reply"] for r in active_rules if r.get("reply") and r["contains"] in labels.get(expected_rule, ())]
            if expected_rule == "vehicle_fit":
                expected_texts = [engine.vehicle_match.FIT_REPLY]
            passed = (result["action"] == expected_action and not result["reason"].startswith(("model_unavailable:", "reply_deadline_", "decision_internal_"))
                      and (expected_rule is None or result["text"] in expected_texts))
            if label == "另买新车":
                passed = passed and result["reason"] != "rule_semantic:vehicle_no_size" and any(word in result["text"] for word in ("年", "20-24", "25-26"))
            if label == "跨话题问候":
                passed = passed and "尺寸" not in result["text"] and "车型" not in result["text"]
            memory = result.pop("_conversation_memory", memory)
            if index == 0:
                passed = passed and "vehicle" in memory and "year" in memory
            if label == "纠正车型":
                passed = passed and "星河远航" in memory.get("vehicle", {}).get("quote", "") and "示例车A" not in memory.get("vehicle", {}).get("quote", "") and ("year" not in memory or memory["year"].get("cleared"))
            record = {"case": label, "passed": passed, "action": result["action"], "reason": result["reason"],
                      "text": result["text"], "duration_ms": int((time.monotonic() - started) * 1000),
                      "memory_fields": list(memory), "tool_trace": tool_trace, "validation_failures": validation_failures}
            report.append(record)
            print(json.dumps(record, ensure_ascii=False), flush=True)
            if result["action"] == "reply":
                # Fictional acknowledgement for this offline conversation only.
                history.append(message(key + "-reply", result["text"], role="agent", when=time.time() - 1))
                deliveries = (deliveries + [{"action": "reply", "text": result["text"], "status": "sent", "created_at": time.time() - 1}])[-6:]
    print(json.dumps({"model": selected.get("model"), "passed": sum(r["passed"] for r in report), "total": len(report)}, ensure_ascii=False))
    return all(r["passed"] for r in report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--slot", choices=("primary", "backup"), required=True)
    parser.add_argument("--timeout", type=int, choices=range(1, 61))
    parser.add_argument("--shop-policy", help="Optional saved shop policy; conversations and vehicle table remain fictional")
    args = parser.parse_args()
    fallback = json.loads(Path(args.config).read_text(encoding="utf-8")).get("model", {})
    db = sqlite3.connect(Path(args.database).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        row = db.execute("SELECT payload FROM model_settings WHERE id=1").fetchone()
        policy_row = db.execute("SELECT settings FROM shops WHERE shop_id=?", (args.shop_policy,)).fetchone() if args.shop_policy else None
        if args.shop_policy and policy_row is None:
            parser.error("shop policy not found")
    finally:
        db.close()
    config = modelconfig.stored_config(json.loads(row[0]) if row else {}, fallback)
    return 0 if evaluate(config, args.slot, args.timeout, json.loads(policy_row[0]) if policy_row else None) else 1


if __name__ == "__main__":
    raise SystemExit(main())
