// 界面端到端测试（Playwright 驱动 Electron 客户端）：临时后台（虚构配置）+ 模拟平台。
// 不连接任何真实店铺，不打开拼多多页面，所有店铺、买家和消息均为虚构数据。
// 用法：npm run e2e（先构建）。截图写入 CLAW_NEXT_E2E_OUT（默认临时目录）。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { popupSweepScript } = require(path.join(clientRoot, "dist", "src", "main", "pddPopups.js"));
const repoRoot = process.env.CLAW_NEXT_BACKEND_ROOT ? path.resolve(process.env.CLAW_NEXT_BACKEND_ROOT) : path.resolve(clientRoot, "..", "..");
// 临时后台配置、后台数据与客户端数据放在 tmp，结束时总是删除；截图单独放，结束后保留供查看。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-next-e2e-"));
const outDir = process.env.CLAW_NEXT_E2E_OUT ? path.resolve(process.env.CLAW_NEXT_E2E_OUT) : fs.mkdtempSync(path.join(os.tmpdir(), "claw-next-e2e-shots-"));
fs.mkdirSync(outDir, { recursive: true });

function python() {
  for (const cmd of [process.env.CLAW_NEXT_PYTHON, "python3.13", "python3.12", "python3.11", "python3", "python"].filter(Boolean)) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return cmd;
  }
  throw new Error("需要 Python 3.11+");
}

// ---------- 虚构后台 ----------
const SHOP = "demo-shop";
const token = randomBytes(24).toString("hex");
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ shops: [{ shop_id: SHOP, name: "演示店铺" }], clients: [{ client_id: "demo-client", shop_id: SHOP, token }] }));
const backend = spawn(python(), [path.join(clientRoot, "test", "backend_harness.py"), repoRoot, path.join(tmp, "config.json"), path.join(tmp, "data")]);
backend.stderr.on("data", (d) => process.stderr.write(d));
const port = await new Promise((resolve, reject) => {
  let buf = "";
  backend.stdout.on("data", (d) => {
    buf += d;
    const m = /PORT (\d+)/.exec(buf);
    if (m) resolve(Number(m[1]));
  });
  backend.on("exit", (c) => reject(new Error("backend exited " + c)));
});
const url = `http://127.0.0.1:${port}`;
// 临时数据目录中的首次默认管理员：先用改密接口换成本次测试专用的随机虚构密码，再重新登录，仅用于配置规则。
const adminLogin = async (password) => {
  const r = await fetch(url + "/api/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  if (!r.ok) throw new Error(`admin login ${r.status}`);
  return (await r.json()).session_token;
};
const adminPassword = `test-${randomBytes(12).toString("hex")}`;
const changed = await fetch(url + "/api/v1/admin/password", {
  method: "POST",
  headers: { Authorization: `Bearer ${await adminLogin("admin")}`, "Content-Type": "application/json" },
  body: JSON.stringify({ current_password: "admin", new_password: adminPassword, confirm_password: adminPassword }),
});
if (!changed.ok) throw new Error(`admin password change ${changed.status}`);
const adminSession = await adminLogin(adminPassword);
const admin = async (method, p, body) => (await fetch(url + p, { method, headers: { Authorization: `Bearer ${adminSession}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json();
await admin("PUT", `/api/v1/admin/shops/${SHOP}/settings`, { enabled: true, mode: "rules", system_prompt: "演示", rules: [{ id: "hours", contains: "营业时间", reply: "演示：营业时间请咨询人工客服。" }] });

// ---------- 启动客户端 ----------
const checks = [];
let failed = null;
const check = (name, ok) => checks.push({ name, ok: !!ok });
const electronApp = await _electron.launch({
  executablePath: require("electron"),
  // Linux CI 上 node_modules 里的 chrome-sandbox 没有 setuid，测试时关闭沙箱；渲染页面的隔离设置不变。
  args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), clientRoot],
  env: { ...process.env, CLAW_NEXT_USER_DATA: path.join(tmp, "user-data"), CLAW_NEXT_E2E: "1", CLAW_NEXT_DEMO_TOKEN: token, CLAW_NEXT_DEMO_SHOP: SHOP },
  timeout: 60_000,
});
const shot = async (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) }).catch(() => undefined);

try {
  // 主界面是 index.html；平台工作台视图（拼多多）在本测试中不会创建。
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = electronApp.windows().find((p) => p.url().endsWith("/renderer/index.html")) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error("未找到客户端主界面");
  page.setDefaultTimeout(15_000);
  // 鼠标操作前先把本次隔离测试窗口放到前台。
  await page.bringToFront();
  const detail = page.locator("#detail");
  const card = (title) => detail.locator(".card", { has: page.locator("h3", { hasText: title }) }).locator(".value");
  const chipOf = (conv) => page.locator(".messages .msg.buyer .chip").last();
  const simSend = async (conv, text) => {
    await page.getByLabel("买家对话编号").fill(conv);
    await detail.locator("details.panel textarea").fill(text);
    await page.getByRole("button", { name: "模拟买家发送" }).click();
  };
  // 模拟器里的“平台发送结果”下拉框。
  const behavior = () => detail.locator("select", { has: page.locator('option[value="ack_without_id"]') });
  const step = async (name, fn) => {
    try {
      await fn();
      check(name, true);
    } catch (err) {
      check(name, false);
      failed ??= `${name}: ${err?.message?.split("\n")[0] ?? err}`;
      // 保留 Playwright 的完整 actionability call log，区分焦点、遮挡、重绘与定位失败。
      console.error(`界面步骤失败：${name}\n${err?.stack ?? err}`);
      await shot(page, `fail-${checks.length}`);
    }
  };

  // 渲染页面隔离：不暴露 Node 能力，只有 invoke/onState 两个桥接方法。
  const iso = await page.evaluate(() => ({ require: typeof require, process: typeof process, bridge: Object.keys(window.clawNext || {}).sort() }));
  check("渲染页面无 require/process，只暴露 invoke/onState", iso.require === "undefined" && iso.process === "undefined" && JSON.stringify(iso.bridge) === '["invoke","onState"]');

  await step("没有店铺时显示“添加店铺”表单", async () => {
    await detail.getByRole("heading", { name: "添加店铺" }).waitFor();
  });
  await step("通过表单添加模拟店铺", async () => {
    const inputs = detail.locator(".form-grid input");
    await inputs.nth(0).fill(SHOP);
    await inputs.nth(1).fill("演示店铺");
    await inputs.nth(2).fill(url);
    await inputs.nth(3).fill("pdd-demo-shop");
    await detail.locator(".form-grid select").selectOption("mock");
    await detail.getByRole("button", { name: "保存" }).click();
    await detail.getByRole("heading", { name: "演示店铺" }).waitFor();
    await page.locator("#shop-list").getByText("演示店铺").waitFor();
  });
  await step("连接后台后显示“已连接”", async () => {
    await page.getByRole("button", { name: "连接后台" }).click();
    await card("后台连接").getByText("已连接").waitFor();
  });
  await step("模拟平台登录后：店铺身份已核验、持有发送归属", async () => {
    await page.getByRole("button", { name: "模拟平台登录" }).click();
    await card("店铺身份").getByText("已核验").waitFor();
    await card("发送归属").getByText(/已持有/).waitFor();
  });
  await step("新店默认“仅观察”：只显示建议回复，不发送", async () => {
    await page.locator(".segmented button.active", { hasText: "仅观察" }).waitFor();
    await simSend("buyer-e2e-001", "营业时间是什么时候？");
    await page.locator(".conv-item.active", { hasText: "buyer-e2e-001" }).waitFor();
    await chipOf().getByText("建议回复").waitFor();
    await page.locator(".messages").getByText("后台建议回复：演示：营业时间请咨询人工客服。").waitFor();
    await page.locator(".messages").getByText(/仅观察模式，不发送/).waitFor();
    if (await page.locator(".messages .chip", { hasText: "已获平台确认" }).count()) throw new Error("观察模式下出现了发送");
  });
  await shot(page, "1-observe");
  await step("切到“自动处理”后，新消息经平台确认发送", async () => {
    await page.getByRole("button", { name: "自动处理" }).click();
    await page.locator(".segmented button.active", { hasText: "自动处理" }).waitFor();
    await simSend("buyer-e2e-002", "营业时间？");
    await chipOf().getByText("已获平台确认").waitFor();
  });
  await step("规则没有命中时显示“建议交人工”，平台未执行转接", async () => {
    await simSend("buyer-e2e-003", "我想退款，怎么操作？");
    await chipOf().getByText("建议交人工").waitFor();
    await page.locator(".messages").getByText(/仅为建议，平台未执行转接/).waitFor();
  });
  await step("发送结果不确定：显示待核查、提示不会重发", async () => {
    await behavior().selectOption("ack_without_id");
    await simSend("buyer-e2e-004", "营业时间呢？");
    await chipOf().getByText(/待核查/).waitFor();
    await page.locator(".messages").getByText(/不会(自动)?重发/).waitFor();
    await detail.locator(".banner.error", { hasText: "结果待核查" }).waitFor();
    await page.locator(".conv-item", { hasText: "buyer-e2e-004 · 待核查" }).waitFor();
    await behavior().selectOption("confirm");
  });
  await shot(page, "2-unknown");
  await step("人工接管此对话：后续消息只给建议、不发送", async () => {
    await page.locator(".conv-item", { hasText: "buyer-e2e-002" }).click();
    await page.getByRole("button", { name: "人工接管此对话" }).click();
    await page.locator(".conv-item", { hasText: "buyer-e2e-002 · 人工接管" }).waitFor();
    await simSend("buyer-e2e-002", "营业时间再说一下");
    await page.locator(".messages").getByText(/此对话人工接管中/).waitFor();
    await page.getByRole("button", { name: "结束人工接管" }).click();
    await page.getByRole("button", { name: "人工接管此对话" }).waitFor();
  });
  await step("登录成其他店铺：提示疑似串店并停止；重新登录本店后恢复", async () => {
    await page.getByRole("button", { name: "登录成其他店铺（串店）" }).click();
    await detail.locator(".banner.error", { hasText: "疑似串店" }).waitFor();
    await card("店铺身份").getByText("与配置不符").waitFor();
    await shot(page, "3-wrong-shop");
    await page.getByRole("button", { name: "重新登录本店" }).click();
    await card("店铺身份").getByText("已核验").waitFor();
    await detail.locator(".banner.error", { hasText: "疑似串店" }).waitFor({ state: "detached" });
  });
  await step("收发记录：状态刷新后对话列表与消息区保持滚动位置；停在最底部时跟到最新消息", async () => {
    // 把两个区域限高，让少量虚构消息也能滚动；样式挂在 head 上，重绘不会去掉。
    // 页面 CSP 不允许内联样式：用 CSSOM 往已有样式表里加规则（只影响本次测试窗口）。
    await page.evaluate(() => {
      const sheet = document.styleSheets[0];
      sheet.insertRule(".conv-list{max-height:80px!important}", sheet.cssRules.length);
      sheet.insertRule(".messages{max-height:80px!important;flex:none!important}", sheet.cssRules.length);
    });
    for (let i = 0; i < 6; i++) await simSend("buyer-scroll-001", `滚动测试第 ${i} 条，营业时间？`);
    await page.locator(".conv-item", { hasText: "buyer-scroll-001" }).click();
    await page.locator(".messages[data-conv='buyer-scroll-001']").getByText("滚动测试第 5 条").waitFor();
    // 等 6 条都拿到后台判断、内容高度不再变化，再记滚动位置。
    await page.waitForFunction(() => document.querySelectorAll(".messages[data-conv='buyer-scroll-001'] .decision").length >= 6, null, { timeout: 15_000 });
    await page.waitForTimeout(500);
    const set = (sel, top) => page.evaluate(([q, t]) => { const e = document.querySelector(q); e.scrollTop = t; return e.scrollTop; }, [sel, top]);
    const get = (sel) => page.evaluate((q) => document.querySelector(q)?.scrollTop ?? -1, sel);
    const dims = () => page.evaluate(() => { const e = document.querySelector(".messages"); return { sh: e.scrollHeight, ch: e.clientHeight, top: e.scrollTop, conv: e.getAttribute("data-conv") }; });
    const listTop = await set(".conv-list", 30);
    const msgTop = await set(".messages", 25);
    if (listTop <= 0 || msgTop <= 0) throw new Error(`区域不能滚动：list=${listTop} msgs=${msgTop}`);
    // 等几次普通状态推送（心跳等）触发重绘：这正是“拉到下面又被弹回去”的场景。
    await page.waitForTimeout(6000);
    const [l2, m2] = [await get(".conv-list"), await get(".messages")];
    if (Math.abs(l2 - listTop) > 1 || Math.abs(m2 - msgTop) > 1) throw new Error(`重绘后滚动位置变了：list ${listTop}→${l2} msgs ${msgTop}→${m2} ${JSON.stringify(await dims())}`);
    // 停在最底部：本对话来新消息后仍在最底部。
    await page.evaluate(() => { const e = document.querySelector(".messages"); e.scrollTop = e.scrollHeight; });
    await simSend("buyer-scroll-001", "滚动测试最新一条");
    await page.locator(".messages").getByText("滚动测试最新一条").waitFor();
    await page.waitForTimeout(300);
    const bottom = await page.evaluate(() => { const e = document.querySelector(".messages"); return e.scrollHeight - e.scrollTop - e.clientHeight; });
    if (bottom > 2) throw new Error(`停在底部时没跟到最新消息：距底 ${bottom}`);
  });
  await step("客户端设置：开发运行时两个勾选项不可用，并说明仅打包版可用；检查更新只显示说明", async () => {
    await page.locator("#app-settings summary").click();
    await page.locator("#app-settings > details[open]").waitFor();
    const boxes = page.locator("#app-settings input[type=checkbox]");
    if ((await boxes.count()) !== 2) throw new Error("勾选项数量不对");
    for (let i = 0; i < 2; i++) if (!(await boxes.nth(i).isDisabled())) throw new Error("开发运行时勾选项应不可用");
    await page.locator("#app-settings").getByText(/仅打包后的 Mac \/ Windows/).waitFor();
    // 检查更新：开发运行没有版本信息，只显示说明，不显示“检查更新”按钮。
    await page.locator("#app-settings").getByText(/当前版本：开发版（没有版本信息）。只有放在“应用程序”文件夹里的 Mac 正式版本可以检查更新/).waitFor();
    if (await page.locator("#app-settings button", { hasText: "检查更新" }).count()) throw new Error("开发运行不应显示检查更新按钮");
    await page.locator("#app-settings summary").click();
    // 收起后经过若干次状态刷新仍保持收起（toggle 事件晚于刷新时曾被翻回）。
    await page.waitForTimeout(3000);
    if (await page.locator("#app-settings > details[open]").count()) throw new Error("收起的客户端设置被状态刷新重新展开");
  });
  await step("客户端设置：授权码输入在普通刷新后保留；非本机根地址时禁用并说明", async () => {
    const details = page.locator("#app-settings > details");
    // 只在收起时点开，避免把已展开的设置收起。
    if (!(await details.evaluate((d) => d.open))) await page.locator("#app-settings summary").click();
    await page.locator("#app-settings > details[open]").waitFor();
    const box = page.locator("#app-settings .admin-grant");
    const input = box.locator("input[type=password]");
    await input.waitFor();
    const unsupported = box.getByText("只有本机根地址（127.0.0.1 / [::1] / localhost，无路径）的后台才能使用快捷登录授权码");
    if (await unsupported.count()) {
      // 非本机根地址：输入禁用并说明。
      if (!(await input.isDisabled())) throw new Error("非本机根地址时授权码输入应禁用");
    } else if (await input.isDisabled()) {
      // 本机根地址但系统安全存储不可用（CI 界面测试环境）：输入禁用，无法验证草稿保留，跳过。
    } else {
      const grant = "a".repeat(43);
      await input.fill(grant);
      await page.waitForTimeout(6000);
      if ((await input.inputValue()) !== grant) throw new Error("授权码输入被普通状态刷新清空");
    }
    if (await details.evaluate((d) => d.open)) await page.locator("#app-settings summary").click();
  });
  await step("店铺栏可收起成窄条并恢复", async () => {
    await page.locator("#sidebar-toggle").click();
    await page.locator(".layout.collapsed").waitFor();
    await page.locator("#shop-list .initial", { hasText: "演示" }).waitFor();
    if (await page.locator("#shop-list .name").first().isVisible()) throw new Error("收起后仍显示完整店名");
    await page.locator("#sidebar-toggle").click();
    await page.locator(".layout:not(.collapsed)").waitFor();
    await page.locator("#shop-list").getByText("演示店铺").waitFor();
  });
  // 拼多多店铺只保存配置、不点“打开本店工作台 / 登录”：不会创建平台页面，也不会访问拼多多。
  await step("拼多多店铺的平台工作台：紧凑操作栏，平台区域占主要高度", async () => {
    await page.locator("#add-shop").click();
    const inputs = detail.locator(".form-grid input");
    await inputs.nth(0).fill("demo-pdd");
    await inputs.nth(1).fill("虚构拼多多店");
    await inputs.nth(2).fill(url);
    await inputs.nth(3).fill("pdd-demo-2");
    await detail.locator(".form-grid select").selectOption("pdd");
    await detail.getByRole("button", { name: "保存" }).click();
    await detail.locator(".pbar h2", { hasText: "虚构拼多多店" }).waitFor();
    if ((await detail.locator(".pbar .pill").count()) !== 4) throw new Error("状态标签数量不对");
    await detail.locator(".pbar .segmented button.active", { hasText: "仅观察" }).waitFor();
    await detail.locator(".pbar .segmented button.active", { hasText: "平台工作台" }).waitFor();
    if (await detail.locator(".status-grid, .banner.warn").count()) throw new Error("平台工作台仍显示大状态卡片或常驻说明");
    // 界面随状态刷新会替换平台区域节点：在同一次页面求值里读取区域与视口，有界重试（每 100 毫秒，最多 10 秒），
    // 直到区域存在、可见、尺寸非零且高度不低于窗口的 70%；超时则报告最后一次测量。
    const measure = () => {
      const el = document.getElementById("platform-area");
      const r = el?.getBoundingClientRect();
      const m = { found: !!el, visible: !!el && getComputedStyle(el).visibility === "visible", width: r?.width ?? 0, height: r?.height ?? 0, viewport: innerHeight };
      window.__e2eArea = m;
      return m.found && m.visible && m.width > 0 && m.height > 0 && m.height >= m.viewport * 0.7;
    };
    await page.waitForFunction(measure, null, { polling: 100, timeout: 10_000 }).catch(async () => {
      throw new Error(`平台区域测量：${JSON.stringify(await page.evaluate(() => window.__e2eArea ?? null))}`);
    });
    await shot(page, "5-platform-bar");
  });
  await step("平台页面缩放：− / + 切换档位，点比例恢复自动", async () => {
    const levels = [67, 75, 80, 90, 100];
    const value = (text) => detail.locator(".zoom .zoom-value", { hasText: text });
    await value(/^自动 \d+%$/).waitFor();
    const current = Number(/(\d+)%/.exec(await detail.locator(".zoom .zoom-value").textContent())[1]);
    const down = detail.getByRole("button", { name: "缩小平台页面" });
    const lower = await down.isEnabled();
    await (lower ? down : detail.getByRole("button", { name: "放大平台页面" })).click();
    await value(new RegExp(`^${levels[levels.indexOf(current) + (lower ? -1 : 1)]}%$`)).waitFor();
    await detail.locator(".zoom .zoom-value").click();
    await value(/^自动 \d+%$/).waitFor();
    // 回到模拟店铺，后续检查不受影响。
    await page.locator("#shop-list").getByText("演示店铺").click();
    await detail.getByRole("heading", { name: "演示店铺" }).waitFor();
  });
  // 在主进程开一个虚构页面窗口（data: 页面，不联网），执行与客户端相同的弹窗清理脚本。
  // 平台页面开着 / 已关闭 / 离开会话页时操作栏的按钮。不打开拼多多页面：从主进程向界面推送虚构的店铺状态
  // （与后台推送状态走同一通道），只看界面如何呈现。每次推送带唯一标记（显示在“平台”状态标签的悬停提示里），
  // 界面每 5 秒会取一次真实状态覆盖推送的虚构状态：在同一次页面求值里核对“标记在场 + 按钮符合预期 + 操作栏没有超出窗口”，
  // 被覆盖就重推（最多 5 次）。
  let fakeSeq = 0;
  let fakeBase = null;
  const fakePlatform = (platform) => {
    const marker = `虚构平台页面状态-${++fakeSeq}`;
    const state = { ...fakeBase, shops: fakeBase.shops.map((s) => (s.config.shop_id === "demo-pdd" ? { ...s, platform: { logged_in: false, detail: marker, ...platform } } : s)) };
    return { state, marker };
  };
  const pushState = (state) =>
    electronApp.evaluate(({ webContents }, state) => {
      for (const wc of webContents.getAllWebContents()) if (wc.getURL().endsWith("/renderer/index.html")) wc.send("state:changed", state);
    }, state);
  const expectBar = async ({ state, marker }, want) => {
    for (let i = 0; i < 5; i++) {
      await pushState(state);
      const ok = await page
        .waitForFunction(
          ([marker, want]) => {
            const detailEl = document.querySelector("#detail");
            const bar = document.querySelector("#detail .pbar");
            if (!bar || ![...bar.querySelectorAll(".pill[title]")].some((p) => p.getAttribute("title").includes(marker))) return false;
            const buttons = [...bar.querySelectorAll("button")];
            const byLabel = (l) => buttons.find((b) => b.textContent.trim() === l);
            if (!(want.present ?? []).every((l) => byLabel(l))) return false;
            if ((want.absent ?? []).some((l) => byLabel(l))) return false;
            if (!(want.enabled ?? []).every((l) => byLabel(l) && !byLabel(l).disabled)) return false;
            if (!(want.disabled ?? []).every((l) => byLabel(l) && byLabel(l).disabled)) return false;
            // 操作栏不能超出窗口：按钮右边缘都在工作区内（放不下时应换行，而不是被截断）。
            const right = detailEl.getBoundingClientRect().right;
            return buttons.every((b) => b.getBoundingClientRect().right <= right + 1);
          },
          [marker, want],
          { timeout: 1000, polling: 50 },
        )
        .then(() => true, () => false);
      if (ok) return;
    }
    throw new Error(`推送 ${marker} 后操作栏不符合预期：${JSON.stringify(want)}`);
  };
  const LOGIN = "打开本店工作台 / 登录", SWEEP = "清理弹窗", BACK = "← 后退", CHAT = "回到会话";
  const OPEN = { page: { state: "ok", gave_up: false } };
  await step("拼多多店铺：页面开着显示“清理弹窗”；退出登录后（页面已关闭）重新显示“打开本店工作台 / 登录”", async () => {
    await page.locator("#shop-list").getByText("虚构拼多多店").click();
    await detail.locator(".pbar h2", { hasText: "虚构拼多多店" }).waitFor();
    fakeBase = (await page.evaluate(() => window.clawNext.invoke("state:get"))).data;
    await expectBar(fakePlatform({ ...OPEN, nav: { on_chat: true, can_go_back: false } }), { present: [SWEEP], absent: [LOGIN, BACK, CHAT] }); // 打开
    await expectBar(fakePlatform({}), { present: [LOGIN], absent: [SWEEP, BACK, CHAT] }); // 退出登录：适配器仍在、页面已关闭
    await expectBar(fakePlatform({ ...OPEN, nav: { on_chat: true, can_go_back: false } }), { present: [SWEEP], absent: [LOGIN] }); // 从工作台重新打开
  });
  await step("拼多多店铺：离开会话页时显示“后退 / 回到会话”，在会话页或页面关闭时不显示；最小窗口宽度下操作栏不超出窗口", async () => {
    const resize = (w, h) => electronApp.evaluate(({ BaseWindow }, [w, h]) => { const win = BaseWindow.getAllWindows().find((x) => !x.isDestroyed()); const before = win.getSize(); win.setSize(w, h); return before; }, [w, h]);
    const before = await resize(1100, 760); // 主窗口最小宽度
    await expectBar(fakePlatform({ ...OPEN, nav: { on_chat: false, can_go_back: true } }), { present: [CHAT], enabled: [BACK] });
    await shot(page, "6-platform-nav-min-width");
    await resize(...before);
    await expectBar(fakePlatform({ ...OPEN, nav: { on_chat: false, can_go_back: true } }), { present: [CHAT], enabled: [BACK] });
    await shot(page, "6-platform-nav");
    await expectBar(fakePlatform({ ...OPEN, nav: { on_chat: false, can_go_back: false } }), { present: [CHAT], disabled: [BACK] }); // 上一页是登录页或没有记录
    await expectBar(fakePlatform({ ...OPEN, nav: { on_chat: true, can_go_back: false } }), { present: [SWEEP], absent: [BACK, CHAT] }); // 已回到会话页
    await expectBar(fakePlatform({ nav: { on_chat: false, can_go_back: true } }), { present: [LOGIN], absent: [BACK, CHAT] }); // 页面已关闭
    await page.locator("#shop-list").getByText("演示店铺").click();
    await detail.getByRole("heading", { name: "演示店铺" }).waitFor();
  });
  await step("客户端设置：打包版 Mac 不在“应用程序”文件夹运行时，开机自启 / 崩溃重启不可修改并说明原因", async () => {
    // 推送虚构的启动设置状态（开发运行的真实状态是“不支持”，提示文字不同，可据此识别被真实状态覆盖后重推）。
    const expectSettings = async (startup, want) => {
      const state = { ...fakeBase, app: { ...fakeBase.app, startup: { supported: true, platform: "darwin", launch_at_login: true, restart_on_crash: false, managed: false, ...startup } } };
      for (let i = 0; i < 5; i++) {
        await pushState(state);
        const ok = await page
          .waitForFunction(
            (want) => {
              const box = document.querySelector("#app-settings");
              const hint = box?.querySelector(".hint");
              const boxes = [...(box?.querySelectorAll("input[type=checkbox]") ?? [])];
              if (!hint || boxes.length !== 2 || !hint.textContent.includes(want.hint)) return false;
              return boxes.every((b) => b.disabled === want.disabled) && hint.classList.contains("error-text") === want.error;
            },
            want,
            { timeout: 1000, polling: 50 },
          )
          .then(() => true, () => false);
        if (ok) return;
      }
      throw new Error(`客户端设置不符合预期：${JSON.stringify(want)}`);
    };
    await expectSettings({ location_ok: false }, { hint: "拖进“应用程序”文件夹", disabled: true, error: true });
    await expectSettings({ location_ok: true }, { hint: "开机自启：登录", disabled: false, error: false });
  });
  await step("弹窗清理脚本（虚构页面）：自动只关引导/活动浮层；人工清理多关普通对话框；违规提醒（含按钮在内层定位容器）、含输入框的对话框与聊天区不碰", async () => {
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px sans-serif">
      <div class="app-root" style="position:fixed;inset:0;z-index:1">
        <ul class="msg-list"><li onclick="log.push('msg')">知道了</li></ul>
        <span class="tip" onclick="log.push('root-tip')">知道了</span>
        <div class="reply-box"><textarea></textarea><button onclick="log.push('send')">发送</button></div>
      </div>
      <div class="guide-mask" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.3)">
        <div style="position:absolute;left:300px;top:200px;width:320px;background:#6b7cff;color:#fff;padding:12px">虚构：新功能上线啦
          <button onclick="this.closest('.guide-mask').remove();log.push('guide')">我知道了</button></div></div>
      <div class="activity-dialog" style="position:fixed;right:20px;top:20px;width:260px;height:160px;z-index:2000;background:#fff">
        <span class="close-icon" style="display:inline-block;width:16px;height:16px" onclick="this.parentElement.remove();log.push('ad')">x</span>虚构活动</div>
      <div class="el-dialog remark-dialog" style="position:fixed;left:40px;top:420px;width:280px;z-index:2001;background:#fff">
        <button class="el-dialog__headerbtn" onclick="log.push('human-x')">x</button>虚构对话框
        <button onclick="this.parentElement.remove();log.push('human-close')">关闭</button></div>
      <div class="notice-pop" style="position:fixed;left:700px;top:420px;width:260px;z-index:1500;background:#fff">虚构：店铺违规处罚提醒
        <button onclick="log.push('risky')">我知道了</button></div>
      <div class="agree-dialog" style="position:fixed;left:40px;top:540px;width:280px;height:60px;z-index:2100;background:#fff">虚构：协议授权与违规处罚提醒
        <div style="position:absolute;right:0;bottom:0;z-index:101"><button onclick="log.push('nested-risky')">我知道了</button></div></div>
      <div class="form-dialog" style="position:fixed;left:360px;top:640px;width:280px;height:60px;z-index:2200;background:#fff"><input type="text" value="未保存的虚构内容">
        <div style="position:absolute;right:0;bottom:0;z-index:101"><button onclick="log.push('nested-input')">我知道了</button></div></div>
      <button id="zoom-target" style="position:fixed;left:900px;top:600px;width:80px;height:30px;z-index:3000" onclick="log.push('zoom-click')">缩放点击</button>
      <script>window.log = []</script></body>`;
    const r = await electronApp.evaluate(async ({ BrowserWindow }, { html, auto, manual }) => {
      const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        win.showInactive();
        const wc = win.webContents;
        const sweep = (code) => wc.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
        const log = () => wc.executeJavaScript("window.log.slice()");
        const first = await sweep(auto);
        const afterAuto = await log();
        const second = await sweep(auto);
        const isolated = await wc.executeJavaScript("typeof window.__clawPopups");
        const third = await sweep(manual);
        const afterManual = await log();
        // 平台页面缩放 80% 时，按页面坐标发出的原生点击仍须落在目标按钮上。
        wc.setZoomFactor(0.8);
        await new Promise((res) => setTimeout(res, 300));
        const p = await wc.executeJavaScript("(() => { const r = document.getElementById('zoom-target').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
        wc.debugger.attach("1.3");
        for (const type of ["mousePressed", "mouseReleased"]) await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
        await new Promise((res) => setTimeout(res, 100));
        return { first, second, third, afterAuto, afterManual, isolated, final: await log() };
      } finally {
        win.destroy();
      }
    }, { html, auto: popupSweepScript("auto", Date.now() + 60_000), manual: popupSweepScript("manual", Date.now() + 60_000) });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(r.afterAuto, ["guide", "ad"])) throw new Error(`自动清理点击：${JSON.stringify(r.afterAuto)}`);
    if (!same(r.first.seen.map((x) => x.why).sort(), ["not_guide", "risky", "risky"])) throw new Error(`自动清理跳过记录：${JSON.stringify(r.first.seen)}`);
    if (r.second.dismissed.length) throw new Error("第二次自动清理不应再点");
    if (r.isolated !== "undefined") throw new Error("清理状态泄露到页面脚本");
    if (!same(r.afterManual, ["guide", "ad", "human-close"])) throw new Error(`人工清理点击：${JSON.stringify(r.afterManual)}`);
    if (!same(r.final, ["guide", "ad", "human-close", "zoom-click"])) throw new Error(`缩放后点击：${JSON.stringify(r.final)}`);
  });
  // 真实渲染进程忙时的互斥回归（scripts/test-popup-sweep.cjs，独立 Electron 进程，虚构 data: 页面）。
  await step("弹窗清理与发送互斥：页面忙时发送等清理真正结束，迟到的清理不点击", async () => {
    const r = spawnSync(require("electron"), [...(process.platform === "linux" ? ["--no-sandbox"] : []), path.join(clientRoot, "scripts", "test-popup-sweep.cjs")], { encoding: "utf8", timeout: 90_000 });
    const line = (r.stdout || "").split("\n").reverse().find((l) => l.startsWith("{"));
    const out = line ? JSON.parse(line) : null;
    if (r.status !== 0 || !out?.ok) throw new Error(`互斥回归失败：${line ?? r.stderr?.slice(-300) ?? r.status}`);
  });
  await step("诊断点击记录：会话列表图标可记录，不带出昵称、客服名与动态编号", async () => {
    const r = spawnSync(require("electron"), [...(process.platform === "linux" ? ["--no-sandbox"] : []), path.join(clientRoot, "scripts", "test-ui-recorder.cjs")], { encoding: "utf8", timeout: 90_000 });
    const line = (r.stdout || "").split("\n").reverse().find((l) => l.startsWith("{"));
    const out = line ? JSON.parse(line) : null;
    if (r.status !== 0 || !out?.ok) throw new Error(`点击记录回归失败：${line ?? r.stderr?.slice(-300) ?? r.status}`);
  });
  for (const [name, script] of [["文字发送定位：弹窗与焦点锁不阻止可信点击，发送后恢复遮挡；会话、草稿与回执仍核验", "test-text-send-location.cjs"], ["视频可信点击：入口与发送按钮移开遮挡后恢复，核对买家和视频，unknown 不重试", "test-video-send-location.cjs"], ["普通回复不打开转接框；按账号转接仅在执行时精确定位，缺失账号不阻塞后续回复", "test-transfer-on-demand.cjs"], ["诊断收藏颜色测试：只点星标颜色浮层，会话不符或浮层不确定时零点击", "test-star-test.cjs"], ["诊断转移会话测试：只确认名称精确匹配的唯一目标，会话不符或重排不确认，取消收藏须请求允许", "test-transfer-test.cjs"]]) {
    await step(name, async () => {
      const r = spawnSync(require("electron"), [...(process.platform === "linux" ? ["--no-sandbox"] : []), path.join(clientRoot, "scripts", script)], { encoding: "utf8", timeout: 200_000, env: { ...process.env, CLAW_NEXT_SEND_LOCATION_DATA: path.join(tmp, "send-location-data") } });
      const line = (r.stdout || "").split("\n").reverse().find((l) => l.startsWith("{"));
      const out = line ? JSON.parse(line) : null;
      if (r.status !== 0 || !out?.ok) throw new Error(`${script} 失败：status=${r.status} signal=${r.signal} error=${r.error?.message ?? ""}\n${line ?? r.stdout?.slice(-12000) ?? ""}\n${r.stderr?.slice(-4000) ?? ""}`);
    });
  }
  await step("界面 HTML 中不含客户端口令", async () => {
    if ((await page.content()).includes(token)) throw new Error("口令出现在页面中");
  });
  await shot(page, "4-final");
} catch (err) {
  failed ??= err?.message ?? String(err);
} finally {
  await electronApp.close().catch(() => undefined);
  backend.stdin.end();
  await new Promise((r) => backend.once("exit", r));
}

for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
console.log(`截图：${outDir}`);
const bad = checks.filter((c) => !c.ok).length;
if (bad || failed) {
  console.error(`界面测试失败：${bad} 项${failed ? `；首个错误：${failed}` : ""}`);
  process.exitCode = 1;
} else {
  console.log(`界面测试通过：${checks.length}/${checks.length}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
