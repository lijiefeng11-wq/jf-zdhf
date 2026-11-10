// 真实视频适配器与可信点击；独立会话、拒绝代理及CDP虚构回执，不访问真实店铺。
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const parentOwned = process.env.CLAW_NEXT_SEND_LOCATION_DATA;
const temp = parentOwned || fs.mkdtempSync(path.join(os.tmpdir(), 'claw-video-location-'));
fs.mkdirSync(temp, { recursive: true });
app.setPath('userData', temp);
const { PddPageAdapter } = require('../dist/src/main/pddAdapter.js');
const origin = 'https://mms.pinduoduo.com';
const listPath = '/latitude/user/file/list';
const sendPath = '/plateau/message/library_file/send';
const syncPath = '/plateau/sync/message';
const video = id => `https://video.example.invalid/${id}.mp4`;
const cover = id => `https://img.example.invalid/${id}.jpg`;
const rows = [1, 2].map(id => ({ key: `video:${id}`, name: `虚构视频${id}`, url: video(id), cover: cover(id) }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let stage = 'startup';
const watchdog = setTimeout(() => { console.log(JSON.stringify({ ok: false, stage, results, error: 'fixture_watchdog' })); app.exit(2); }, 90_000);

function html(s) {
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;height:${s.scroll ? 1600 : 700}px}.reply-box{position:absolute;left:120px;top:${s.scroll ? 1000 : 100}px;width:400px}
    .chat-icon-camera{display:inline-block;width:40px;height:35px;background:#69f}
    .video-list-box{display:${s.alreadyOpen ? 'block' : 'none'};padding:0;list-style:none}.video-list-box li{height:70px}
    .send-video-btn{width:90px;height:30px}.blocker{position:fixed;inset:0;background:#fff;z-index:99}
    </style><ul><li class="chat-item"><div class="chat-item-box active" data-random="9001-fixture"></div></li></ul>
    <div class="chat-detail"></div><div class="reply-box" ${s.inert ? 'inert' : ''}>
    <div class="reply-header"><i class="chat-icon chat-icon-camera" onclick="openVideo(event)"></i>${s.ambiguous ? '<i class="chat-icon chat-icon-camera" onclick="openVideo(event)"></i>' : ''}</div>
    <ul class="video-list-box">${rows.map((r, i) => `<li><div class="video-item-info">${r.name}</div><span data-cover="${r.cover}"></span><button class="send-video-btn" onclick="sendVideo(event,${i + 1})">发送</button></li>`).join('')}</ul></div>
    ${s.overlay ? '<div class="fullscreen-dialog-manager blocker" style="display:block!important"><div class="el-dialog__wrapper">虚构业务弹窗</div></div>' : ''}
    ${s.mask ? '<div id="mask" class="blocker"></div>' : ''}
    <script>
    window.cameraClicks=[];window.videoClicks=[];window.sendErrors=[];window.opened=false;
    window.originalSurface=[...document.querySelectorAll('.fullscreen-dialog-manager,.el-dialog__wrapper,#mask')].map(el=>({el,display:el.style.getPropertyValue('display'),priority:el.style.getPropertyPriority('display')}));
    async function openVideo(event){cameraClicks.push(event.isTrusted);if(!event.isTrusted)return;opened=!opened;document.querySelector('.video-list-box').style.display=opened?'block':'none';if(opened)await fetch('${listPath}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_type_desc:'video',page:1})});}
    async function sendVideo(event,id){videoClicks.push({trusted:event.isTrusted,id});if(!event.isTrusted)return;try{const response=await fetch('${sendPath}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:'9001',url:'https://video.example.invalid/'+id+'.mp4'})});await response.json();${s.noReceipt ? '' : `await fetch('${syncPath}',{method:'POST',body:'{}'});`}}catch(error){sendErrors.push(String(error));}}
    </script>`;
}

app.whenReady().then(async () => {
  const fixture = session.fromPartition('video-location-fixture');
  fixture.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  fixture.setPermissionCheckHandler(() => false);
  const proxy = net.createServer(socket => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await fixture.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + proxy.address().port, proxyBypassRules: '<-loopback>' });
  const allowed = new Set(['/fixture', listPath, sendPath, syncPath].map(p => origin + p));
  let unexpected = [];
  fixture.webRequest.onBeforeRequest((details, callback) => {
    if (!allowed.has(details.url)) unexpected.push(details.url);
    callback({ cancel: !allowed.has(details.url) });
  });
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: fixture, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = win.webContents;
  const nativeCommand = wc.debugger.sendCommand.bind(wc.debugger);
  const nativeCapture = wc.capturePage.bind(wc);
  const scenarios = [
    { name: 'normal', status: 'confirmed' },
    { name: 'fullscreen_overlay_entry_and_send_restore', overlay: true, status: 'confirmed' },
    { name: 'arbitrary_mask_entry_and_send_restore', mask: true, status: 'confirmed' },
    { name: 'inert_ancestor_overlay_restore', overlay: true, inert: true, status: 'confirmed' },
    { name: 'entry_below_viewport_scrolls', scroll: true, overlay: true, status: 'confirmed' },
    { name: 'zoomed_mask_uses_css_coordinates', zoom: 0.8, mask: true, status: 'confirmed' },
    { name: 'late_overlay_before_send', lateOverlay: true, status: 'confirmed' },
    { name: 'first_frame_failure_recovers_once', captureFailure: true, overlay: true, status: 'confirmed' },
    { name: 'already_open_panel_mask_send_restore', alreadyOpen: true, mask: true, status: 'confirmed' },
    { name: 'conflicting_active_buyers_zero_send', mutate: 'active', status: 'not_sent', reason: 'pdd_conversation_changed' },
    { name: 'replaced_target_zero_send', mutate: 'replace', status: 'not_sent', reason: 'pdd_video_list_changed' },
    { name: 'reordered_rows_zero_send', mutate: 'reorder', status: 'not_sent', reason: 'pdd_video_list_changed' },
    { name: 'page_epoch_changes_zero_send', mutate: 'epoch', status: 'not_sent', reason: 'pdd_page_changed' },
    { name: 'late_frame_after_deadline_zero_send', mutate: 'lateFrame', status: 'not_sent', reason: 'claim_expiring' },
    { name: 'send_frames_unavailable_still_sends_once', mutate: 'framesFail', status: 'confirmed' },
    { name: 'duplicate_entries_zero_clicks', ambiguous: true, status: 'not_sent', reason: 'pdd_video_entry_ambiguous' },
    { name: 'buyer_changes_before_send_zero_send', mutate: 'buyer', overlay: true, status: 'not_sent', reason: 'pdd_conversation_changed' },
    { name: 'video_identity_changes_before_send_zero_send', mutate: 'video', status: 'not_sent', reason: 'pdd_video_row_identity_missing' },
    { name: 'observe_mode_before_send_zero_send', mutate: 'observe', status: 'not_sent', reason: 'shop_observe_only' },
    { name: 'deadline_before_send_zero_send', mutate: 'deadline', status: 'not_sent', reason: 'claim_expiring' },
    { name: 'send_press_rejected_unknown_no_retry', rejectPress: true, status: 'unknown', reason: 'press_command_rejected' },
    { name: 'missing_receipt_unknown_no_retry', noReceipt: true, status: 'unknown', reason: 'receipt_not_observed' },
  ];
  try {
    for (const s of scenarios) {
      stage = s.name;
      unexpected = [];
      wc.debugger.sendCommand = nativeCommand;
      await fixture.protocol.handle('https', request => request.url === origin + '/fixture'
        ? new Response(html(s), { headers: { 'Content-Type': 'text/html;charset=utf-8' } }) : new Response('rejected', { status: 403 }));
      await win.loadURL(origin + '/fixture');
      await fixture.protocol.unhandle('https');
      wc.setZoomFactor(s.zoom || 1);
      const adapter = new PddPageAdapter('video-fixture', '虚构店铺');
      adapter.window = { isDestroyed: () => win.isDestroyed(), webContents: wc };
      adapter.tracker.identityFromRealtime({ mall_id: '7001', mall_name: '虚构店铺' });
      adapter.tracker.chatList({ buyer_uid: '9001', messages: [], has_more: false, skipped: 0 });
      adapter.videoRows = rows;
      let reloads = 0, blocked = null, captures = 0, failures = 0, sendCaptured = false;
      const originalInputListeners = wc.listeners('input-event');
      adapter.reload = () => { reloads++; };
      const paused = new Map(), received = [], input = [];
      const messageId = String(990000 + scenarios.indexOf(s));
      const deadline = Date.now() / 1000 + (s.noReceipt || ['deadline', 'lateFrame'].includes(s.mutate) ? 3.5 : 8);
      wc.capturePage = async (...args) => {
        captures++;
        if (s.captureFailure && failures === 0) { failures++; throw new Error('fixture_capture_failed'); }
        if (s.mutate === 'framesFail' && adapter.itemWatch?.url) { failures++; throw new Error('fixture_send_capture_failed'); }
        const sendCapture = !!adapter.itemWatch?.url && !sendCaptured;
        if (sendCapture) {
          sendCaptured = true;
          if (s.mutate === 'active') await wc.executeJavaScript('document.querySelector(".chat-item").insertAdjacentHTML("afterend",\'<li class="chat-item"><div class="chat-item-box active" data-random="9002-fixture"></div></li>\')');
          if (s.mutate === 'replace') await wc.executeJavaScript('const button=document.querySelectorAll(".send-video-btn")[1];const clone=button.cloneNode(true);clone.removeAttribute("data-claw-video-control");button.replaceWith(clone)');
          if (s.mutate === 'reorder') await wc.executeJavaScript('const list=document.querySelector(".video-list-box");list.append(list.firstElementChild)');
          if (s.mutate === 'epoch') adapter.watchEpoch++;
          if (s.mutate === 'lateFrame') await sleep(Math.max(0, deadline * 1000 - 1250 - Date.now()));
          if (s.mutate === 'buyer') await wc.executeJavaScript('document.querySelector(".chat-item-box").dataset.random="9002-fixture"');
          if (s.mutate === 'video') await wc.executeJavaScript('document.querySelectorAll("[data-cover]")[1].dataset.cover="https://img.example.invalid/other.jpg"');
          if (s.mutate === 'observe') blocked = 'shop_observe_only';
          if (s.mutate === 'deadline') await sleep(Math.max(0, deadline * 1000 - 1480 - Date.now()));
          if (s.lateOverlay) await wc.executeJavaScript('document.body.insertAdjacentHTML("beforeend",\'<div class="el-overlay blocker" id="late">虚构迟到遮挡</div>\')');
        }
        return nativeCapture(...args);
      };
      wc.debugger.on('message', (_event, method, params, sessionId) => {
        if (!sessionId && method === 'Fetch.requestPaused') paused.set(params.requestId, params.request);
      });
      wc.debugger.sendCommand = async (method, params = {}, sessionId) => {
        if (method === 'Input.dispatchMouseEvent') {
          input.push(params.type);
          if (s.rejectPress && adapter.itemWatch?.clicked && params.type === 'mousePressed') throw new Error('fixture_press_rejected');
        }
        if (method === 'Fetch.continueRequest') {
          const request = paused.get(params.requestId);
          assert.ok(request && allowed.has(request.url), 'only isolated fixture requests are fulfilled');
          let response;
          if (request.url === origin + listPath) response = { success: true, result: { file_with_check_dtolist: rows.map((r, i) => ({ id: i + 1, name: r.name, url: r.url, extra_info: { video_cover_url: r.cover } })) } };
          else if (request.url === origin + sendPath) {
            received.push(JSON.parse(request.postData));
            response = { success: true, error_code: 1000000 };
          } else {
            assert.equal(request.url, origin + syncPath);
            response = { success: true, result: { sync_data: [{ data: [{ message: { msg_id: messageId, from: { role: 'mall_cs' }, to: { role: 'user', uid: '9001' }, template_name: 'library_video', type: 14, info: { file_id: '2' } } }] }] } };
          }
          return nativeCommand('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(response)).toString('base64') }, sessionId);
        }
        return nativeCommand(method, params, sessionId);
      };
      adapter.attachNetwork(adapter.window);
      await nativeCommand('Runtime.evaluate', { expression: '0' });
      await nativeCommand('Fetch.enable', { patterns: [listPath, sendPath, syncPath].map(p => ({ urlPattern: origin + p + '*', requestStage: 'Request' })) });
      const result = await adapter.sendItem({ conversation_id: '9001', option: { type: 'video', key: 'video:2', name: rows[1].name, observed_at: 1 }, attempt_id: 'fictional-video-attempt', deadline, recheck: () => blocked });
      for (let i = 0; adapter.sending && i < 100; i++) await sleep(20);
      await sleep(s.mutate === 'lateFrame' ? 350 : 80);
      const clicks = await wc.executeJavaScript('window.videoClicks');
      try {
        assert.equal(result.status, s.status);
        if (s.reason) assert.equal(result.reason, s.reason);
        assert.deepEqual(clicks, s.status === 'confirmed' || s.noReceipt ? [{ trusted: true, id: 2 }] : []);
        assert.deepEqual(received, s.status === 'confirmed' || s.noReceipt ? [{ uid: '9001', url: video(2) }] : []);
        assert.equal(await wc.executeJavaScript('cameraClicks.every(x=>x===true)'), true);
        assert.equal(await wc.executeJavaScript('originalSurface.every(({el,display,priority})=>el.isConnected&&el.style.getPropertyValue("display")===display&&el.style.getPropertyPriority("display")===priority)'), true);
        assert.equal(await wc.executeJavaScript('document.querySelector(".reply-box").hasAttribute("inert")'), !!s.inert);
        assert.deepEqual(await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: 'Object.keys(globalThis).filter(key=>key.startsWith("claw-click-surface-"))' }]), []);
        if (s.lateOverlay) assert.equal(await wc.executeJavaScript('document.querySelector("#late").style.display'), '');
        assert.deepEqual(unexpected, []);
        assert.equal(adapter.sending, false);
        if (s.captureFailure) assert.equal(failures, 1);
        if (s.mutate === 'framesFail') assert.ok(failures >= 1);
        if (s.alreadyOpen) assert.equal(await wc.executeJavaScript('cameraClicks.length'), 0);
        if (s.status === 'confirmed') assert.equal(result.platform_message_id, messageId);
        if (s.noReceipt) { assert.equal(reloads, 1); assert.equal(clicks.length, 1); }
        if (s.rejectPress) assert.equal(input.filter(x => x === 'mousePressed').length - input.filter(x => x === 'mouseReleased').length, 1);
        results.push({ name: s.name, ok: true, result, clicks, requests: received.length });
      } catch (error) { results.push({ name: s.name, ok: false, result, clicks, received, input, captures, error: error.message }); }
      console.log('video_location_scenario ' + JSON.stringify(results.at(-1)));
      for (const listener of wc.listeners('input-event')) if (!originalInputListeners.includes(listener)) wc.removeListener('input-event', listener);
      wc.debugger.removeAllListeners('message');
      wc.debugger.detach();
    }
  } finally {
    wc.capturePage = nativeCapture;
    wc.debugger.sendCommand = nativeCommand;
    if (wc.debugger.isAttached()) wc.debugger.detach();
    win.destroy();
    // 最后一个窗口销毁后不再 await，避免 Linux 默认退出抢先于最终结果输出。
    proxy.close();
    clearTimeout(watchdog);
  }
  console.log(JSON.stringify({ ok: results.length === scenarios.length && results.every(r => r.ok), results }));
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
}).catch(error => { console.log(JSON.stringify({ ok: false, stage, results, error: error.stack || String(error) })); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  if (!parentOwned) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} }
  app.exit(process.exitCode || 0);
});
