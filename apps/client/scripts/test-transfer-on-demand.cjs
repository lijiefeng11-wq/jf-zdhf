// Actual adapter, DOM scripts and send engine; fictional data: pages and receipts only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const parentOwned = process.env.CLAW_NEXT_SEND_LOCATION_DATA;
const temp = parentOwned ? path.join(parentOwned, 'transfer-on-demand') : fs.mkdtempSync(path.join(os.tmpdir(), 'claw-transfer-fictional-'));
fs.mkdirSync(temp, { recursive: true });
app.setPath('userData', temp);
const { PddPageAdapter } = require(path.join(root, 'dist/src/main/pddAdapter.js'));
const { selectSendControl, stopSelector } = require(path.join(root, 'dist/src/main/scraplingSelector.js'));
const cases = [], timer = setTimeout(() => app.exit(2), 120000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  if (process.platform !== 'darwin') win.showInactive();
  const wc = win.webContents;
  wc.session.webRequest.onBeforeRequest((d, c) => c({ cancel: !d.url.startsWith('data:') }));
  wc.debugger.attach('1.3');
  const native = wc.debugger.sendCommand.bind(wc.debugger);
  await selectSendControl('<div class="reply-footer"><button data-claw-candidate="0">发送</button></div>', 15000);
  try {
    const pageHtml = (header, open = "document.querySelector('.el-dialog__wrapper').style.display='block'") => `<!doctype html><meta charset="utf-8"><style>body{margin:0}.reply-box{position:absolute;left:200px;top:250px}.send-btn{display:block;width:90px;height:35px;background:#69f}.el-dialog__wrapper{display:none;position:fixed;inset:0;background:#999c;z-index:99}.el-dialog{position:absolute;left:150px;top:80px;width:600px;height:260px;background:white}.el-dialog__headerbtn{position:absolute;right:4px;top:4px}</style>
        <li class="chat-item"><div class="chat-item-box active" data-random="9001-fixture">虚构买家一</div></li>
        <li class="chat-item"><div class="chat-item-box" data-random="9002-fixture">虚构买家二</div></li>
        <i title="收藏该用户" style="display:inline-block;width:20px;height:20px"></i>
        <button id="open" onclick="opens++;${open}">转移会话</button>
        <div class="reply-box"><div class="reply-input"><textarea></textarea></div><div class="reply-footer"><div class="send-btn" onclick="sends++;document.querySelector('textarea').value=''">发送</div></div></div>
        <div class="el-dialog__wrapper" onclick="if(event.target===this){closes++;this.style.display='none';document.getElementById('fixture-popover').style.display='none'}"><div class="el-dialog"><span class="el-dialog__title">转移会话</span>${header ? '<button class="el-dialog__headerbtn" onclick="closes++;document.querySelector(\'.el-dialog__wrapper\').style.display=\'none\'">X</button>' : ''}<table><tr class="el-table__row"><td>fictional-main</td><td>fixture</td><td><button aria-describedby="fixture-popover" onclick="rows++;document.getElementById('fixture-popover').style.display='block'">转移</button></td></tr></table></div></div>
        <div id="fixture-popover" class="el-popover" style="display:none;position:fixed;left:550px;top:380px;z-index:100;background:white"><span style="padding:4px" onclick="transfers++;document.querySelector('.el-dialog__wrapper').style.display='none';this.parentElement.style.display='none';document.querySelector('.chat-item-box.active').closest('li').remove()">无原因直接转移</span><span onclick="this.parentElement.style.display='none'">取消</span></div>
        <script>window.opens=0;window.closes=0;window.sends=0;window.rows=0;window.transfers=0;window.escapes=0;addEventListener('keydown',e=>{if(e.key==='Escape'){escapes++;document.querySelector('.chat-item-box.active')?.remove()}})</script>`;
    for (const header of [true, false]) {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(header)));
      await wc.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const a = new PddPageAdapter('fictional', 'Fictional');
      a.window = win; a.tracker = { status: () => ({ logged_in: true, identity: { platform_shop_id: 'fictional-mall' } }) };
      const opened = [];
      a.freshActive = async () => '9001'; a.openConversation = async uid => (opened.push(uid), null);
      wc.debugger.sendCommand = async (method, params = {}, session) => {
        const r = await native(method, params, session);
        if (params.type === 'mouseReleased' && await wc.executeJavaScript('window.sends') && a.outgoing) {
          a.outgoing.resolve({ status: 'confirmed', platform_message_id: 'fictional-only' });
        }
        return r;
      };
      const send = () => a.send({ conversation_id: '9001', text: 'fictional reply', attempt_id: 'fictional-only', deadline: Date.now() / 1000 + 10, recheck: () => null });
      const first = await send();
      const ordinary = await wc.executeJavaScript('({opens,sends,rows,transfers})');
      if (first.status !== 'confirmed' && process.env.CLAW_NEXT_TRANSFER_SHOT) fs.writeFileSync(process.env.CLAW_NEXT_TRANSFER_SHOT, (await wc.capturePage()).toPNG());
      assert.equal(first.status, 'confirmed', JSON.stringify({ first, ordinary, ready: await wc.executeJavaScript("({state:document.readyState,buttons:document.querySelectorAll('.send-btn').length,label:document.querySelector('.send-btn')?.innerText})") }));
      assert.deepEqual(ordinary, { opens: 0, sends: 1, rows: 0, transfers: 0 });
      const request = account => ({ conversation_id: '9001', account, allow_unmark: false, attempt_id: 'fictional-transfer', deadline: Date.now() / 1000 + 8, recheck: () => null });
      const missing = await a.transferConversation(request('missing-account'));
      assert.equal(missing.status, 'not_sent'); assert.equal(missing.reason, 'transfer_target_missing');
      const second = await send();
      const beforeMatch = await wc.executeJavaScript("({open:getComputedStyle(document.querySelector('.el-dialog__wrapper')).display!=='none',opens,closes,sends,rows,transfers,escapes})");
      assert.equal(second.status, 'confirmed', JSON.stringify({ second, beforeMatch })); assert.equal(beforeMatch.open, false);
      assert.deepEqual([beforeMatch.opens, beforeMatch.closes, beforeMatch.sends, beforeMatch.rows, beforeMatch.transfers, beforeMatch.escapes], [1, 1, 2, 0, 0, 0]);
      if (process.env.CLAW_NEXT_TRANSFER_SHOT && !header) fs.writeFileSync(process.env.CLAW_NEXT_TRANSFER_SHOT, (await wc.capturePage()).toPNG());
      const matched = await a.transferConversation(request('fictional-main'));
      const after = await wc.executeJavaScript('({opens,sends,rows,transfers,escapes})');
      assert.equal(matched.status, 'confirmed'); assert.equal(matched.page_observed, 'left_list');
      assert.deepEqual(after, { opens: 2, sends: 2, rows: 1, transfers: 1, escapes: 0 });
      assert.equal(a.sending, false);
      assert.deepEqual(opened, ['9001', '9001', '9001', '9001'], '转接前先切到该买家的会话');
      cases.push({ header_close: header, ordinary, missing, before_match: beforeMatch, matched, after });
      wc.debugger.sendCommand = native;
    }
    // 平台点“转移会话”后先取客服名单，返回非空才弹框：名单的进展由测试按场景直接给出（真实监听另有单元测试）。
    const listCases = [
      { name: 'slow_list_dialog_after_5s', open: "setTimeout(()=>{document.querySelector('.el-dialog__wrapper').style.display='block'},5000)", list: 'requested', status: 'confirmed' },
      { name: 'empty_list_no_dialog', open: '', list: 'empty', status: 'not_sent', reason: 'transfer_no_assignable_cs', within: 1500 },
      { name: 'list_request_failed', open: '', list: 'failed', status: 'not_sent', reason: 'transfer_cs_list_failed', within: 1500 },
      { name: 'open_click_never_requests_list', open: '', list: null, status: 'not_sent', reason: 'transfer_open_not_triggered', within: 4500 },
      { name: 'conversation_cannot_be_opened', open: '', list: null, openConv: 'pdd_conversation_not_in_list', status: 'not_sent', reason: 'pdd_conversation_not_in_list', opens: 0 },
    ];
    for (const c of listCases) {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(true, c.open)));
      await wc.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const a = new PddPageAdapter('fictional', 'Fictional');
      a.window = win; a.tracker = { status: () => ({ logged_in: true, identity: { platform_shop_id: 'fictional-mall' } }) };
      a.freshActive = async () => '9001'; a.openConversation = async () => c.openConv ?? null;
      wc.debugger.sendCommand = async (method, params = {}, session) => {
        const r = await native(method, params, session);
        if (params.type === 'mouseReleased' && c.list && a.csList?.state === 'waiting' && await wc.executeJavaScript('opens') === 1) a.csList = { state: c.list, id: null };
        return r;
      };
      const started = Date.now();
      const result = await a.transferConversation({ conversation_id: '9001', account: 'fictional-main', allow_unmark: false, attempt_id: 'fictional-transfer', deadline: Date.now() / 1000 + 15, recheck: () => null });
      const elapsed = Date.now() - started;
      const counts = await wc.executeJavaScript('({opens,rows,transfers})');
      wc.debugger.sendCommand = native;
      assert.equal(result.status, c.status, `${c.name}: ${JSON.stringify(result)}`);
      if (c.reason) assert.equal(result.reason, c.reason, c.name);
      if (c.within) assert.ok(elapsed < c.within, `${c.name}: 等待须有界 ${elapsed}`);
      assert.deepEqual(counts, { opens: c.opens ?? 1, rows: c.status === 'confirmed' ? 1 : 0, transfers: c.status === 'confirmed' ? 1 : 0 }, c.name);
      assert.equal(a.sending, false); assert.equal(a.csList, null);
      cases.push({ name: c.name, result, elapsed });
    }
  } finally {
    wc.debugger.sendCommand = native; stopSelector(); win.destroy(); clearTimeout(timer);
    if (!parentOwned) fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, fictional_data_only: true, actual_adapter_scripts_and_playwright_scrapling: true, platform_receipt_stubbed: true, cases }));
  app.exit(0);
}).catch(e => { console.log(JSON.stringify({ ok: false, cases, error: String(e.stack || e) })); app.exit(1); });
