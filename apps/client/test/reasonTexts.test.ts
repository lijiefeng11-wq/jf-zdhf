import assert from "node:assert/strict";
import { test } from "node:test";
import { REASONS, reasonText } from "../src/core/view.js";

// 平台页面操作与回执的原因代码：界面须显示中文说明，且说明只讲原因，不引导重发（unknown 永不重发）。
const CODES = [
  "pdd_send_busy", "pdd_send_button_covered", "pdd_send_button_hidden", "pdd_send_blocked_mismatch", "pdd_send_request_not_observed",
  "pdd_input_mismatch", "pdd_input_missing", "pdd_input_not_empty", "pdd_page_changed", "pdd_conversation_changed",
  "pdd_conversation_not_in_list", "pdd_conversation_not_opened", "pdd_goods_button_covered", "pdd_goods_button_hidden", "pdd_goods_button_missing",
  "pdd_goods_list_changed", "pdd_goods_list_not_loaded", "pdd_goods_not_in_list", "pdd_goods_row_identity_changed", "pdd_goods_rows_changed",
  "pdd_goods_rows_mismatch", "pdd_goods_rows_missing", "pdd_goods_thumb_missing", "pdd_goods_thumb_not_unique", "pdd_instruct_button_missing",
  "pdd_instruct_changed", "pdd_instruct_dialog_already_open", "pdd_instruct_dialog_name_mismatch", "pdd_instruct_not_loaded", "pdd_instruct_option_invalid",
  "pdd_instruct_send_button_hidden", "pdd_instruct_send_button_missing", "pdd_item_blocked_mismatch", "pdd_item_request_not_observed", "pdd_item_type_unsupported",
  "pdd_video_button_covered", "pdd_video_button_hidden", "pdd_video_button_missing", "pdd_video_entry_covered", "pdd_video_entry_hidden",
  "pdd_video_entry_missing", "pdd_video_file_url_missing", "pdd_video_library_not_loaded", "pdd_video_option_changed", "pdd_video_panel_closed",
  "pdd_video_panel_not_opened", "pdd_video_row_identity_mismatch", "pdd_video_row_identity_missing", "pdd_video_rows_mismatch", "platform_not_logged_in",
  "platform_request_failed", "platform_response_unparsed", "platform_send_error", "platform_send_failed", "platform_window_closed",
  "receipt_ambiguous", "receipt_not_observed", "receipt_object_mismatch", "image_fetch_failed", "image_fetch_timeout",
  "image_too_large", "image_type_unsupported", "command_timeout", "command_exception", "command_rejected",
  "invalid_point", "contents_destroyed", "preflight_failed", "debugger_not_attached", "recheck_failed",
  "before_press_failed", "target_moved", "page_state_not_confirmed", "lease_response_mismatch",
  "transfer_no_assignable_cs", "transfer_cs_list_failed", "transfer_cs_list_timeout", "transfer_open_not_triggered", "transfer_conversation_mismatch",
] as const;

test("平台页面操作与回执的原因代码都有中文说明", () => {
  assert.equal(new Set(CODES).size, CODES.length);
  for (const code of CODES) {
    const text = reasonText(code);
    assert.notEqual(text, code, code);
    assert.match(text, /[一-鿿]/, code);
    assert.ok(text.length <= 30, `${code} 超过 30 字`);
  }
});

test("这些说明只讲原因，不引导重发，也不替界面标签下结论", () => {
  for (const code of CODES) assert.doesNotMatch(REASONS[code], /重发|重试|补发|再发|已发送|未发送|发送成功/, code);
});

test("拦截分支（发送、附加发送、标星）只能说明请求不符，不得宣称已拦截（拦截命令的结果没有等待确认）", () => {
  for (const code of ["pdd_send_blocked_mismatch", "pdd_item_blocked_mismatch", "mark_request_blocked"] as const) {
    assert.doesNotMatch(REASONS[code], /已在本机拦截|已拦截|拦截成功/, code);
    assert.match(REASONS[code], /未确认/, code);
  }
});
