/**
 * 弹窗清理与发送互斥：真实 Electron 渲染进程 + 虚构 data: 页面（不联网、不连接平台或后台）。
 * 用法：npm run build 后 `npx --no-install electron scripts/test-popup-sweep.cjs`（Linux CI 加 --no-sandbox）；
 * 界面端到端测试（scripts/e2e.mjs）会自动运行。输出一行 JSON，全部通过时退出码 0。
 *
 * 覆盖：渲染进程忙、清理脚本排队迟到时
 *   - 发送准备（yieldWarm）一直等到脚本真正结束才开始，不按超时放行；
 *   - 迟到的脚本过了点击时限，不点击、页面代次不变，之后也没有迟到的点击；
 * 渲染进程在清理期间退出时，过了点击时限才解除互斥；页面正常时清理照常点掉引导浮层并使页面代次加一。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-popup-sweep-"));
app.setPath("userData", temp);
const { PddPageAdapter, POPUP_SWEEP_START_MS } = require("../dist/src/main/pddAdapter.js");

const HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px sans-serif">
  <div class="guide-mask" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.3)">
    <div style="position:absolute;left:200px;top:150px;width:300px;background:#6b7cff;color:#fff;padding:12px">虚构：新功能上线
      <button onclick="clicks.push(Date.now());this.closest('.guide-mask').remove()">我知道了</button></div></div>
  <script>window.clicks = []</script></body>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

async function pageWith(win) {
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HTML));
  const wc = win.webContents;
  // 页面仍标记为加载中时清理直接返回 null（不建立互斥）：慢机器上 loadURL 返回后可能还要等一会儿。
  for (const end = Date.now() + 5000; wc.isLoadingMainFrame() && Date.now() < end;) await sleep(20);
  const page = { webContents: wc, isDestroyed: () => win.isDestroyed() || wc.isDestroyed(), loadURL: (u) => wc.loadURL(u), close: () => win.destroy(), on: () => undefined };
  const adapter = new PddPageAdapter("fixture", "虚构店铺", null, () => page);
  adapter.window = page;
  adapter.tracker = { status: () => ({ logged_in: true }), end() {} };
  return { wc, page, adapter };
}
// 在页面主环境里忙等 ms 毫秒（不等待返回），让之后提交的脚本排队。
const busy = (wc, ms) => void wc.executeJavaScript(`(() => { const t = Date.now(); while (Date.now() - t < ${ms}) {} })()`).catch(() => undefined);

const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, error: "timeout", results }));
  app.exit(2);
}, 60_000);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.showInactive();
    {
      const { wc, page, adapter } = await pageWith(win);
      // 从发出忙等的时刻计时：忙等在此之后才开始，持续 3000ms，所以正确实现结束等待时至少已过 3000ms；
      // 只从清理开始计时会把“发出忙等 → 清理开始”之间的耗时（慢机器上可超过 500ms）算丢。
      const busyAt = Date.now();
      busy(wc, 3000);
      await sleep(100);
      const epoch = adapter.watchEpoch;
      const sweep = adapter.sweepPopupsOnce(page, "auto");
      const started = Date.now();
      await adapter.yieldWarm();
      const released = Date.now();
      const waited = released - started;
      const sinceBusy = released - busyAt;
      // 发送准备开始：此后页面上不应再出现任何清理点击。
      adapter.sending = true;
      const sendStartedAt = Date.now();
      const r = await sweep;
      await sleep(1500);
      const clicks = await wc.executeJavaScript("window.clicks.slice()");
      // 两条都要满足：忙等真正结束后才放行（距发出忙等≥2900ms，留 100ms 时钟误差）；
      // 且明显晚于按超时放行的时刻（清理开始后 POPUP_SWEEP_START_MS），超时放行的错误实现两条都过不了。
      check("渲染进程忙：发送准备等到清理脚本真正结束（不按超时放行）", sinceBusy >= 2900 && waited >= POPUP_SWEEP_START_MS + 300 && adapter.popupSweep === null, { waited, sinceBusy });
      check("迟到的清理脚本过了点击时限：不点击、返回 expired、页面代次不变", r && r.expired === true && r.dismissed.length === 0 && adapter.watchEpoch === epoch, r);
      check("发送准备开始后没有迟到的清理点击", clicks.length === 0 && clicks.every((t) => t < sendStartedAt), { clicks });
      adapter.sending = false;
      const epoch2 = adapter.watchEpoch;
      const ok = await adapter.sweepPopupsOnce(page, "auto");
      const after = await wc.executeJavaScript("window.clicks.length");
      check("页面空闲：清理照常点掉引导浮层，页面代次加一", ok && ok.dismissed.length === 1 && after === 1 && adapter.watchEpoch === epoch2 + 1, ok);
    }
    {
      const { wc, page, adapter } = await pageWith(win);
      busy(wc, 20_000);
      await sleep(100);
      adapter.sweepPopupsOnce(page, "auto");
      const began = adapter.popupSweep !== null;
      const started = Date.now();
      setTimeout(() => wc.forcefullyCrashRenderer(), 300);
      await adapter.yieldWarm();
      const waited = Date.now() - started;
      check("清理期间渲染进程退出：过了点击时限才解除互斥", began && waited >= POPUP_SWEEP_START_MS && waited < POPUP_SWEEP_START_MS + 3000 && adapter.popupSweep === null, { began, waited, loading: wc.isDestroyed() ? null : wc.isLoadingMainFrame() });
    }
    win.destroy();
  } catch (err) {
    check("运行", false, String(err && err.stack || err).slice(0, 400));
  }
  clearTimeout(watchdog);
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, results }));
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
});
