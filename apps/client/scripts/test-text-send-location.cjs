// 真实适配器与 Electron 命中测试；仅虚构 data: 页面，平台回执替身，不联网、不读取用户资料。
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// e2e 父进程在 Electron 退出后清理目录，避免 Windows 仍持有会话文件时删除。
const parentOwned = process.env.CLAW_NEXT_SEND_LOCATION_DATA;
const temp = parentOwned || fs.mkdtempSync(path.join(os.tmpdir(), "claw-send-location-"));
fs.mkdirSync(temp, { recursive: true });
app.setPath("userData", temp);
const { PddPageAdapter } = require("../dist/src/main/pddAdapter.js");
const { selectSendControl, stopSelector } = require("../dist/src/main/scraplingSelector.js");
const results = [];
const watchdog = setTimeout(() => app.exit(2), 45_000);

function html(s) {
  const button = `<div class="${s.renamed ? 'new-send-control' : 'send-btn'}" onclick="clicks++"><span>${s.label || "发送"}${s.hint ? '(Enter)' : ''}</span></div>`;
  // 平台“推荐话术”形态：底栏被 v-show 隐藏，回复框里另有一个发送按钮（加载中带 sendBtn_disabled）。
  const gpt = s.gpt ? `<div class="send-btn${s.gptDisabled ? " sendBtn_disabled" : ""}" onclick="clicks++">发送</div><div class="gpt-suggest">虚构推荐话术</div>` : "";
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0} .reply-box{position:absolute;left:120px;top:100px;width:300px}
    textarea{width:200px;height:60px} .reply-footer{position:relative}
    .send-btn,.new-send-control{position:relative;display:inline-block;width:100px;height:40px;background:#69f}
    ${s.css || ""}${s.revealButton || s.revealDelay || s.neverReveal ? '#composer .send-btn{visibility:hidden}' : ""}</style>
    <ul><li class="chat-item"><div class="chat-item-box active" data-random="${s.otherBuyer ? "9002" : "9001"}-fixture"></div></li></ul>
    ${s.offscreenDuplicate ? '<div class="reply-box" style="left:-1200px"><div class="reply-footer">' + button + '</div></div>' : ""}
    <div class="reply-box" id="composer"><div class="reply-input"><textarea>${s.existingDraft ? '虚构回复' : ''}</textarea></div>
      <div class="reply-footer"${s.gpt ? ' style="display:none"' : ""}>${s.hiddenDuplicate ? '<div class="send-btn" style="display:none"></div>' : ""}
      ${s.insertDelay ? "" : button}${s.ambiguous ? button : ""}</div>${gpt}</div>
    ${s.mask ? '<div style="position:fixed;inset:0;background:#fff;z-index:10"></div>' : ""}
    <script>window.clicks=0;${s.changeDraft ? 'document.querySelector("textarea").addEventListener("input",e=>{if(e.target.value)e.target.value="人工草稿"})' : ""}
    ${s.revealButton ? 'document.querySelector("textarea").addEventListener("input",()=>{document.querySelector("#composer .send-btn").style.visibility="visible"})' : ""}
    ${s.revealDelay ? `document.querySelector("textarea").addEventListener("input",()=>{setTimeout(()=>{document.querySelector("#composer .send-btn").style.visibility="visible"},${s.revealDelay})})` : ""}
    ${s.insertDelay ? `document.querySelector("textarea").addEventListener("input",()=>{if(document.querySelector("textarea").value)setTimeout(()=>document.querySelector("#composer .reply-footer").insertAdjacentHTML("beforeend",${JSON.stringify(button)}),${s.insertDelay})})` : ""}
    ${s.switchWhileWaiting ? 'document.querySelector("textarea").addEventListener("input",()=>setTimeout(()=>document.querySelector(".chat-item-box").setAttribute("data-random","9002-fixture"),100))' : ""}</script>`;
}

app.whenReady().then(async () => {
  await selectSendControl('<div class="reply-footer"><button data-claw-candidate="0">发送</button></div>', 15000);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = win.webContents;
  wc.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  wc.debugger.attach("1.3");
  const nativeCommand = wc.debugger.sendCommand.bind(wc.debugger);
  const scenarios = [
    { name: "below_viewport_scrolls_before_click", css: "#composer{top:1000px}body{height:1500px}", status: "confirmed" },
    { name: "ancestor_clipping_scrolls_before_click", css: "#composer{height:70px;overflow:hidden}", status: "confirmed" },
    { name: "normal", status: "confirmed" },
    { name: "press_rejected_no_release_or_retry", rejectPress: true, status: "unknown", reason: "pdd_playwright_click_uncertain" },
    { name: "press_hangs_bounded_no_release_or_retry", hangPress: true, status: "unknown", reason: "pdd_playwright_click_uncertain" },
    { name: "button_hint_enter", hint: true, status: "confirmed" },
    { name: "renamed_control_class", renamed: true, status: "confirmed" },
    { name: "button_appears_after_input", revealButton: true, status: "confirmed" },
    { name: "button_appears_after_350ms", revealDelay: 350, status: "confirmed" },
    { name: "button_appears_after_650ms", revealDelay: 650, status: "confirmed" },
    { name: "button_created_after_input", insertDelay: 350, status: "confirmed" },
    { name: "waiting_never_retries_a_click", neverReveal: true, status: "not_sent", reason: "pdd_send_button_not_ready" },
    { name: "conversation_changes_while_waiting", revealDelay: 650, switchWhileWaiting: true, status: "not_sent", reason: "pdd_conversation_changed" },
    { name: "page_changes_while_waiting", revealDelay: 650, pageChanged: true, status: "not_sent", reason: "pdd_page_changed" },
    { name: "deadline_expires_while_waiting", revealDelay: 650, shortDeadline: true, status: "not_sent", reason: "claim_expiring" },
    { name: "hidden_first_button", hiddenDuplicate: true, status: "confirmed" },
    { name: "offscreen_button_in_other_composer", offscreenDuplicate: true, status: "confirmed" },
    { name: "partly_clipped_button", css: "#composer{left:-80px}", status: "confirmed" },
    { name: "center_covered_but_same_button_has_clear_point", css: ".reply-footer::after{content:'';position:absolute;left:40px;top:0;width:20px;height:40px;background:#fff;z-index:1}", status: "confirmed" },
    { name: "insist_send_label", label: "坚持发送", status: "confirmed" },
    { name: "gpt_suggest_hides_footer_uses_its_send_button", gpt: true, status: "confirmed" },
    { name: "gpt_suggest_send_button_loading_is_not_clicked", gpt: true, gptDisabled: true, status: "not_sent", reason: "pdd_send_button_not_ready" },
    { name: "zoom80", zoom: 0.8, status: "confirmed" },
    { name: "fully_covered", mask: true, status: "not_sent", reason: "pdd_send_button_not_ready" },
    { name: "two_visible_buttons_are_ambiguous", ambiguous: true, status: "not_sent", reason: "pdd_send_control_unverified" },
    { name: "different_conversation", otherBuyer: true, status: "not_sent", reason: "pdd_conversation_changed" },
    { name: "human_draft_changed", changeDraft: true, status: "not_sent", reason: "pdd_input_mismatch" },
    { name: "existing_identical_human_draft_is_preserved", existingDraft: true, status: "not_sent", reason: "pdd_input_not_empty" },
    { name: "conversation_changes_just_before_press", switchBeforePress: true, status: "not_sent", reason: "pdd_conversation_changed" },
    { name: "human_draft_changes_just_before_press", draftBeforePress: true, status: "not_sent", reason: "pdd_input_mismatch" },
    { name: "page_changed_after_location", pageChanged: true, status: "not_sent", reason: "pdd_page_changed" },
    { name: "deadline_recheck_blocks_click", recheck: "reply_deadline_exceeded", status: "not_sent", reason: "reply_deadline_exceeded" },
  ];
  try {
    for (const s of scenarios) {
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html(s)));
      wc.setZoomFactor(s.zoom || 1);
      const commands = [];
      const adapter = new PddPageAdapter("fixture", "虚构店铺");
      wc.debugger.sendCommand = async (method, params = {}, sessionId) => {
        if (params.type === "mouseMoved" && s.switchBeforePress) await wc.executeJavaScript('document.querySelector(".chat-item-box").setAttribute("data-random","9002-fixture")');
        if (params.type === "mouseMoved" && s.draftBeforePress) await wc.executeJavaScript('document.querySelector("textarea").value="人工草稿"');
        if (["mousePressed", "mouseReleased"].includes(params.type)) commands.push(params.type);
        if (params.type === "mousePressed" && s.rejectPress) throw new Error("fictional_input_failure");
        if (params.type === "mousePressed" && s.hangPress) return new Promise(() => {});
        const result = await nativeCommand(method, params, sessionId);
        if (s.pageChanged && method === "DOM.scrollIntoViewIfNeeded") adapter.watchEpoch++;
        if (params.type === "mouseReleased") {
          const clicked = await wc.executeJavaScript("window.clicks");
          adapter.outgoing?.resolve(clicked === 1 ? { status: "confirmed", platform_message_id: "fixture-only" } : { status: "unknown", reason: "fixture_click_missed" });
        }
        return result;
      };
      adapter.window = { isDestroyed: () => win.isDestroyed(), webContents: wc };
      adapter.tracker = { status: () => ({ logged_in: true }) };
      adapter.openConversation = async () => null;
      const started = Date.now();
      const result = await adapter.send({ conversation_id: "9001", text: "虚构回复", attempt_id: "fixture-only", deadline: Date.now() / 1000 + (s.shortDeadline ? 1.7 : 10), recheck: () => s.recheck || null });
      const elapsed = Date.now() - started;
      const clicks = await wc.executeJavaScript("window.clicks");
      try {
        assert.equal(result.status, s.status);
        if (s.reason) assert.equal(result.reason, s.reason);
        assert.equal(clicks, s.status === "confirmed" ? 1 : 0);
        assert.deepEqual(commands, s.status === "confirmed" ? ["mousePressed", "mouseReleased"] : s.rejectPress || s.hangPress ? ["mousePressed"] : []);
        assert.equal(adapter.sending, false);
        assert.equal(adapter.outgoing, null);
        if (s.changeDraft || s.draftBeforePress) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), "人工草稿");
        if (s.existingDraft) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), "虚构回复");
        if (s.switchBeforePress || s.switchWhileWaiting) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), "虚构回复", "切换到其他买家后不清除输入");
        if (s.neverReveal) assert.ok(elapsed < 3000, "等待必须有界");
        results.push({ name: s.name, ok: true, result, clicks, commands, elapsed });
      } catch (error) {
        results.push({ name: s.name, ok: false, result, clicks, commands, error: error.message });
      }
    }
  } catch (error) {
    results.push({ name: "fixture", ok: false, error: String(error.stack || error) });
  } finally {
    win.destroy();
    stopSelector();
    clearTimeout(watchdog);
    if (!parentOwned) fs.rmSync(temp, { recursive: true, force: true });
  }
  const ok = results.length === scenarios.length && results.every(r => r.ok);
  console.log(JSON.stringify({ ok, fictional_data_page_only: true, real_adapter_and_native_hit_test: true, runtime_driver: "playwright+scrapling", platform_receipt_stubbed: true, results }));
  app.exit(ok ? 0 : 1);
}).catch(error => {
  clearTimeout(watchdog);
  console.log(JSON.stringify({ ok: false, results, error: String(error.stack || error) }));
  app.exit(1);
});
