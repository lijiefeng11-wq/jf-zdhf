// 真实适配器、输入与网络回执；隔离 session、loopback 拒绝代理，CDP 仅履行经过适配器校验的请求。
const { app, BrowserWindow, session } = require("electron");
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
const watchdog = setTimeout(() => app.exit(2), 90_000);
const origin = "https://mms.pinduoduo.com";
const sendPath = "/plateau/chat/send_message";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 1500;
  while (!await check()) {
    assert.ok(Date.now() < end, "fixture render timeout");
    await sleep(20);
  }
}

function html(s) {
  const button = `<div class="${s.renamed ? 'new-send-control' : 'send-btn'}" onclick="clicks++;sendFixture()"><span>${s.label || "发送"}${s.hint ? '(Enter)' : ''}</span></div>`;
  // 平台“推荐话术”形态：底栏被 v-show 隐藏，回复框里另有一个发送按钮（加载中带 sendBtn_disabled）。
  const gpt = s.gpt ? `<div class="send-btn${s.gptDisabled ? " sendBtn_disabled" : ""}" onclick="clicks++;sendFixture()">发送</div><div class="gpt-suggest">虚构推荐话术</div>` : "";
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0} .reply-box{position:absolute;left:120px;top:100px;width:300px}
    textarea{width:200px;height:60px} .reply-footer{position:relative}
    .send-btn,.new-send-control{position:relative;display:inline-block;width:100px;height:40px;background:#69f}
    ${s.css || ""}${s.revealButton || s.revealDelay || s.neverReveal ? '#composer .send-btn{visibility:hidden}' : ""}</style>
    <ul><li class="chat-item"><div class="chat-item-box active" data-random="${s.otherBuyer ? "9002" : "9001"}-fixture"></div></li></ul>
    ${s.offscreenDuplicate ? '<div class="reply-box" style="left:-1200px"><div class="reply-footer">' + button + '</div></div>' : ""}
    <div class="reply-box" id="composer"${s.focusTrap ? ' inert' : ''}><div class="reply-input"><textarea>${s.existingDraft ? '虚构回复' : ''}</textarea></div>
      <div class="reply-footer"${s.gpt ? ' style="display:none"' : ""}>${s.hiddenDuplicate ? '<div class="send-btn" style="display:none"></div>' : ""}
      ${s.insertDelay ? "" : button}${s.ambiguous ? button : ""}</div>${gpt}</div>
    ${s.mask ? '<div style="position:fixed;inset:0;background:#fff;z-index:10"></div>' : ""}
    ${s.overlay ? '<div class="fullscreen-dialog-manager"><div class="el-dialog__wrapper full-screen-dialog-basic" tabindex="0" style="position:fixed;inset:0;background:#fff;z-index:10">' + (s.overlayContent ? '<div class="business-dialog" style="position:absolute;inset:0"></div>' : '') + '</div></div>' : ''}
    <div id="messages"><div class="buyer-message" data-uid="9001">虚构买家提问</div></div>
    <script>
    window.clicks=0;window.enters=[];window.sendErrors=[];
    async function sendFixture(){
      const uid=/^([0-9]+)-/.exec(document.querySelector('.chat-item-box.active').dataset.random)[1];
      const text=document.querySelector('textarea').value;
      try {
        const response=await fetch('${sendPath}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:{message:{to:{role:'user',uid},content:text,type:1}}})});
        const ack=await response.json();
        if(ack.success && ack.result.msg_id){
          const message=document.createElement('div');message.className='agent-message';message.dataset.uid=uid;message.dataset.messageId=ack.result.msg_id;message.textContent=text;document.querySelector('#messages').append(message);
          document.querySelector('textarea').value='';
        }
      }catch(error){window.sendErrors.push(String(error));}
    }
    document.querySelector('textarea').addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();window.enters.push({trusted:event.isTrusted,focused:document.activeElement===event.target});sendFixture();}
    });
    ${s.focusTrap ? 'document.addEventListener("focusin",event=>{if(event.target.matches("textarea"))document.querySelector(".full-screen-dialog-basic").focus()})' : ''}
    ${s.changeDraft ? 'document.querySelector("textarea").addEventListener("input",e=>{if(e.target.value)e.target.value="人工草稿"})' : ""}
    ${s.revealButton ? 'document.querySelector("textarea").addEventListener("input",()=>{document.querySelector("#composer .send-btn").style.visibility="visible"})' : ""}
    ${s.revealDelay ? `document.querySelector("textarea").addEventListener("input",()=>{setTimeout(()=>{document.querySelector("#composer .send-btn").style.visibility="visible"},${s.revealDelay})})` : ""}
    ${s.insertDelay ? `document.querySelector("textarea").addEventListener("input",()=>{if(document.querySelector("textarea").value)setTimeout(()=>document.querySelector("#composer .reply-footer").insertAdjacentHTML("beforeend",${JSON.stringify(button)}),${s.insertDelay})})` : ""}
    ${s.switchWhileWaiting ? 'document.querySelector("textarea").addEventListener("input",()=>setTimeout(()=>document.querySelector(".chat-item-box").setAttribute("data-random","9002-fixture"),100))' : ""}</script>`;
}

app.whenReady().then(async () => {
  await selectSendControl('<div class="reply-footer"><button data-claw-candidate="0">发送</button></div>', 15000);
  const fixtureSession = session.fromPartition('send-location-fixture');
  fixtureSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  fixtureSession.setPermissionCheckHandler(() => false);
  let currentScenario, received = [], unexpected = [];
  fixtureSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url === origin + '/fixture' || details.url === origin + sendPath;
    if (!allowed) unexpected.push(details.url);
    callback({ cancel: !allowed });
  });
  // protocol.handle 的 HTTPS 请求没有 Fetch.requestPaused；只用它加载文档，发送前卸载。
  // 代理只连接本进程的 loopback 拒绝服务器；漏过 CDP fixture 的请求也无法去真实平台。
  const proxy = require('node:net').createServer(socket => { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await fixtureSession.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + proxy.address().port, proxyBypassRules: '<-loopback>' });
  const documentFixture = request => request.url === origin + '/fixture'
    ? new Response(html(currentScenario), { headers: { 'Content-Type': 'text/html;charset=utf-8' } })
    : new Response('fixture route rejected', { status: 403 });
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: fixtureSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = win.webContents;
  const nativeCommand = wc.debugger.sendCommand.bind(wc.debugger);
  const scenarios = [
    { name: "below_viewport_scrolls_before_click", css: "#composer{top:1000px}body{height:1500px}", status: "confirmed" },
    { name: "ancestor_clipping_scrolls_before_click", css: "#composer{height:70px;overflow:hidden}", status: "confirmed" },
    { name: "normal", status: "confirmed" },
    { name: "fullscreen_overlay_enter_confirmed", overlay: true, status: "confirmed" },
    { name: "fullscreen_suggestion_enter_confirmed", overlay: true, gpt: true, status: "confirmed" },
    { name: "fullscreen_no_message_id_unknown_no_retry", overlay: true, noId: true, status: "unknown", reason: "platform_ack_without_message_id" },
    { name: "fullscreen_focus_trap_stops", overlay: true, focusTrap: true, status: "not_sent", reason: "pdd_send_button_covered" },
    { name: "fullscreen_focus_changes_at_key_guard", overlay: true, atKey: "focus", status: "not_sent", reason: "pdd_send_button_covered" },
    { name: "fullscreen_uid_changes_at_key_guard", overlay: true, atKey: "uid", status: "not_sent", reason: "pdd_conversation_changed" },
    { name: "fullscreen_draft_changes_at_key_guard", overlay: true, atKey: "draft", status: "not_sent", reason: "pdd_input_mismatch" },
    { name: "fullscreen_observe_recheck_at_key_guard", overlay: true, atKey: "observe", status: "not_sent", reason: "shop_observe_only" },
    { name: "fullscreen_page_changes_at_key_guard", overlay: true, atKey: "page", status: "not_sent", reason: "pdd_page_changed" },
    { name: "fullscreen_deadline_expires_at_key_guard", overlay: true, atKey: "deadline", status: "not_sent", reason: "claim_expiring" },
    { name: "fullscreen_button_hidden_at_key_guard", overlay: true, atKey: "hidden", status: "not_sent", reason: "pdd_send_control_unverified" },
    { name: "fullscreen_button_disabled_at_key_guard", overlay: true, atKey: "disabled", status: "not_sent", reason: "pdd_send_control_unverified" },
    { name: "fullscreen_native_mac_enter_refused", overlay: true, nativeMac: true, status: "not_sent", reason: "pdd_send_button_covered" },
    { name: "fullscreen_enter_rejected_no_retry", overlay: true, rejectKey: true, status: "unknown", reason: "pdd_playwright_click_uncertain" },
    { name: "fullscreen_enter_hangs_bounded_no_retry", overlay: true, hangKey: true, status: "unknown", reason: "pdd_playwright_click_uncertain" },
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
    { name: "fullscreen_business_modal_content_is_not_bypassed", overlay: true, overlayContent: true, status: "not_sent", reason: "pdd_send_button_not_ready" },
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
      currentScenario = s;
      const messageId = String(880000 + scenarios.indexOf(s));
      received = []; unexpected = [];
      wc.debugger.sendCommand = nativeCommand;
      await fixtureSession.protocol.handle('https', documentFixture);
      await win.loadURL(origin + '/fixture');
      await fixtureSession.protocol.unhandle('https');
      wc.setZoomFactor(s.zoom || 1);
      if (s.nativeMac) await wc.executeJavaScript('Object.defineProperty(navigator,"userAgent",{value:"fixture pddMerchant_mac_version"})');
      const commands = [], logs = [], network = [], paused = new Map();
      wc.debugger.on('message', (_event, method, params, sessionId) => {
        if (!sessionId && method === 'Fetch.requestPaused') paused.set(params.requestId, params.request);
      });
      const adapter = new PddPageAdapter("fixture", "虚构店铺");
      let verifications = 0, keyBoundary = false;
      const deadline = Date.now() / 1000 + (s.shortDeadline ? 1.7 : s.atKey === 'deadline' ? 3 : 10);
      wc.debugger.sendCommand = async (method, params = {}, sessionId) => {
        if (params.type === "mouseMoved" && s.switchBeforePress) await wc.executeJavaScript('document.querySelector(".chat-item-box").setAttribute("data-random","9002-fixture")');
        if (params.type === "mouseMoved" && s.draftBeforePress) await wc.executeJavaScript('document.querySelector("textarea").value="人工草稿"');
        // 第二次原文/焦点核验来自 transport 的 keyDown blocker，而非初次 Enter 准备。
        if (method === 'Runtime.callFunctionOn' && JSON.stringify(params).includes('args.enter') && ++verifications === 2) {
          keyBoundary = true;
          if (s.atKey === 'uid') await wc.executeJavaScript('document.querySelector(".chat-item-box").dataset.random="9002-fixture"');
          if (s.atKey === 'draft') await wc.executeJavaScript('document.querySelector("textarea").value="人工草稿"');
          if (s.atKey === 'focus') await wc.executeJavaScript('document.querySelector(".full-screen-dialog-basic").focus()');
          if (s.atKey === 'page') adapter.watchEpoch++;
          if (s.atKey === 'hidden') await wc.executeJavaScript('document.querySelector("#composer .send-btn").style.visibility="hidden"');
          if (s.atKey === 'disabled') await wc.executeJavaScript('document.querySelector("#composer .send-btn").setAttribute("aria-disabled","true")');
          if (s.atKey === 'deadline') await sleep(Math.max(0, deadline * 1000 - 1500 - Date.now() + 20));
        }
        if (['mousePressed', 'mouseReleased', 'keyDown', 'rawKeyDown', 'keyUp', 'char'].includes(params.type)) commands.push(params.type);
        if (method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown'].includes(params.type) && s.rejectKey) throw new Error('fictional_key_failure');
        if (method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown'].includes(params.type) && s.hangKey) return new Promise(() => {});
        if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest' || method === 'Network.getResponseBody') network.push(method);
        if (params.type === "mousePressed" && s.rejectPress) throw new Error("fictional_input_failure");
        if (params.type === "mousePressed" && s.hangPress) return new Promise(() => {});
        if (method === 'Fetch.continueRequest') {
          // 只有生产 onSendPaused 核验 uid、原文与单次发送后才会发出 continueRequest。
          const request = paused.get(params.requestId);
          assert.equal(request?.url, origin + sendPath);
          assert.equal(request.method, 'POST');
          received.push(JSON.parse(request.postData));
          const response = { success: true, result: s.noId ? {} : { msg_id: messageId } };
          return nativeCommand('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(response)).toString('base64') }, sessionId);
        }
        const result = await nativeCommand(method, params, sessionId);
        if (s.pageChanged && method === "DOM.scrollIntoViewIfNeeded") adapter.watchEpoch++;
        return result;
      };
      adapter.window = { isDestroyed: () => win.isDestroyed(), webContents: wc };
      adapter.tracker = { status: () => ({ logged_in: true }) };
      adapter.openConversation = async () => null;
      assert.equal(wc.debugger.isAttached(), false, 'attachNetwork must attach and enable interception itself');
      adapter.attachNetwork(adapter.window);
      // 等待 attachNetwork 排队的 Network.enable / Fetch.enable 完成。
      await nativeCommand('Runtime.evaluate', { expression: '0' });
      const originalLog = console.log;
      const started = Date.now();
      let result;
      console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };
      try {
        result = await adapter.send({ conversation_id: '9001', text: '虚构回复', attempt_id: 'fixture-only', deadline, recheck: () => s.recheck || (s.atKey === 'observe' && keyBoundary ? 'shop_observe_only' : null) });
      } finally { console.log = originalLog; }
      const elapsed = Date.now() - started;
      if (s.status === 'confirmed') await until(() => wc.executeJavaScript('document.querySelectorAll(".agent-message").length===1'));
      // 已返回结果后继续观察一次，确保 unknown 和被阻止的发送没有异步重试。
      await sleep(80);
      const clicks = await wc.executeJavaScript('window.clicks');
      const enters = await wc.executeJavaScript('window.enters');
      try {
        assert.equal(result.status, s.status);
        if (s.reason) assert.equal(result.reason, s.reason);
        const sent = s.status === 'confirmed' || s.noId;
        const expectedCommands = sent ? (s.overlay ? ['keyDown', 'keyUp'] : ['mousePressed', 'mouseReleased']) : s.rejectPress || s.hangPress ? ['mousePressed'] : s.rejectKey || s.hangKey ? ['keyDown'] : [];
        assert.equal(clicks, sent && !s.overlay ? 1 : 0);
        assert.deepEqual(commands, expectedCommands, 'one input attempt, no fallback click or retry');
        assert.deepEqual(enters, sent && s.overlay ? [{ trusted: true, focused: true }] : []);
        assert.deepEqual(received, sent ? [{ data: { message: { to: { role: 'user', uid: '9001' }, content: '虚构回复', type: 1 } } }] : []);
        assert.deepEqual(unexpected, [], 'all requests must stay inside the isolated fixture');
        assert.deepEqual(await wc.executeJavaScript('window.sendErrors'), []);
        assert.equal(network.filter(method => method === 'Fetch.continueRequest').length, sent ? 1 : 0);
        if (sent) assert.ok(network.includes('Network.getResponseBody'), 'real attachNetwork must read the platform response');
        assert.equal(logs.filter(line => line.includes('platform send via enter:')).length, sent && s.overlay ? 1 : 0);
        if (s.status === 'confirmed') {
          assert.equal(result.platform_message_id, messageId);
          assert.deepEqual(await wc.executeJavaScript('[...document.querySelectorAll(".buyer-message,.agent-message")].map(e=>({role:e.className,uid:e.dataset.uid,text:e.textContent,id:e.dataset.messageId||null}))'), [
            { role: 'buyer-message', uid: '9001', text: '虚构买家提问', id: null },
            { role: 'agent-message', uid: '9001', text: '虚构回复', id: messageId },
          ]);
        } else assert.equal(await wc.executeJavaScript('document.querySelectorAll(".agent-message").length'), 0);
        if (s.atKey) assert.ok(keyBoundary, 'mutation must occur in keyDown guard after initial verification');
        if (s.noId) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), '虚构回复');
        if (s.hangKey || s.rejectKey) assert.ok(elapsed < 3000, 'key transport failure must be bounded');
        assert.equal(adapter.sending, false);
        assert.equal(adapter.outgoing, null);
        if (s.changeDraft || s.draftBeforePress) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), "人工草稿");
        if (s.existingDraft) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), "虚构回复");
        if (s.switchBeforePress || s.switchWhileWaiting) assert.equal(await wc.executeJavaScript('document.querySelector("textarea").value'), "虚构回复", "切换到其他买家后不清除输入");
        if (s.neverReveal) assert.ok(elapsed < 3000, "等待必须有界");
        results.push({ name: s.name, ok: true, result, clicks, enters, commands, requests: received.length, network, elapsed });
      } catch (error) {
        results.push({ name: s.name, ok: false, result, clicks, enters, commands, received, network, keyBoundary, verifications, error: error.message });
      } finally {
        console.log('send_location_scenario ' + JSON.stringify(results.at(-1)));
        wc.debugger.removeAllListeners('message');
        wc.removeAllListeners('input-event');
        wc.debugger.detach();
      }
    }
  } catch (error) {
    results.push({ name: "fixture", ok: false, error: String(error.stack || error) });
  } finally {
    win.destroy();
    proxy.close();
    stopSelector();
    clearTimeout(watchdog);
    if (!parentOwned) fs.rmSync(temp, { recursive: true, force: true });
  }
  const ok = results.length === scenarios.length && results.every(r => r.ok);
  console.log(JSON.stringify({ ok, fictional_fixture_only: true, real_adapter_and_native_hit_test: true, runtime_driver: "playwright+scrapling", platform_receipt_via_real_network_listener: true, real_platform: false, results }));
  app.exit(ok ? 0 : 1);
}).catch(error => {
  clearTimeout(watchdog);
  console.log(JSON.stringify({ ok: false, results, error: String(error.stack || error) }));
  app.exit(1);
});
