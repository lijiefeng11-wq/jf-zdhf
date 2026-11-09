import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FetchLike } from "../src/core/backend.js";
import { MockPlatformAdapter } from "../src/core/mockAdapter.js";
import { ShopConfig, ShopRuntime, Timing } from "../src/core/runtime.js";

// 全部为虚构数据。管理员使用后台首次初始化的默认账号登录，仅存在于临时数据目录。
export const TOKEN_A = "client-a-token-for-tests-aaaaaaaaaaaaaaaa";
export const TOKEN_B = "client-b-token-for-tests-bbbbbbbbbbbbbbbb";
export const HOURS_REPLY = "演示：营业时间请咨询人工客服。";

const CLIENT_ROOT = path.resolve(__dirname, "..", "..");
/** 默认用本仓库后台；CLAW_NEXT_BACKEND_ROOT 可指向其他后台检出做联调。 */
const REPO_ROOT = process.env.CLAW_NEXT_BACKEND_ROOT || path.resolve(CLIENT_ROOT, "..", "..");

export function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function findPython(): string {
  const candidates = [process.env.CLAW_NEXT_PYTHON, "python3.13", "python3.12", "python3.11", "python3", "python"].filter(Boolean) as string[];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return cmd;
  }
  throw new Error("需要 Python 3.11+ 运行后台（可设置 CLAW_NEXT_PYTHON）");
}

export type TestBackend = {
  url: string;
  stop(): Promise<void>;
  settings(shop: string, enabled: boolean, rules?: { id: string; contains: string; reply: string }[], mode?: "rules" | "model" | "hybrid", fallback?: Record<string, unknown>): Promise<void>;
  events(shop: string): Promise<any[]>;
};

/** model：可选的后台模型配置（只用于指向本机虚构的合成模型服务）。 */
/**
 * 临时数据目录里的首次默认管理员：先用现有改密接口把初始密码改成本次测试专用的随机虚构密码，再重新登录取会话。
 * 不依赖、也不增加任何绕过首次改密的开关；后台要求首次改密前后都适用。
 */
export async function adminTestSession(url: string): Promise<string> {
  const login = async (password: string) => {
    const r = await fetch(url + "/api/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
    if (!r.ok) throw new Error(`admin login ${r.status}`);
    return ((await r.json()) as { session_token: string }).session_token;
  };
  const initial = await login("admin");
  const password = `test-${randomBytes(12).toString("hex")}`;
  const changed = await fetch(url + "/api/v1/admin/password", {
    method: "POST",
    headers: { Authorization: `Bearer ${initial}`, "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: "admin", new_password: password, confirm_password: password }),
  });
  if (!changed.ok) throw new Error(`admin password change ${changed.status}`);
  return login(password);
}

export async function startBackend(opts: { model?: Record<string, unknown> } = {}): Promise<TestBackend> {
  const dir = tempDir("claw-next-backend-");
  const config = {
    ...(opts.model ? { model: opts.model } : {}),
    shops: [
      { shop_id: "shop-a", name: "虚构店铺A" },
      { shop_id: "shop-b", name: "虚构店铺B" },
    ],
    clients: [
      { client_id: "client-a", shop_id: "shop-a", token: TOKEN_A },
      { client_id: "client-b", shop_id: "shop-b", token: TOKEN_B },
    ],
  };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  const child: ChildProcessWithoutNullStreams = spawn(findPython(), [path.join(CLIENT_ROOT, "test", "backend_harness.py"), REPO_ROOT, path.join(dir, "config.json"), path.join(dir, "data")]);
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /PORT (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) => reject(new Error(`backend exited ${code}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  const session = await adminTestSession(url);
  const admin = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(url + p, { method, headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`admin ${p} ${r.status}`);
    return r.json() as Promise<any>;
  };
  return {
    url,
    async stop() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
    async settings(shop, enabled, rules = [{ id: "hours", contains: "营业时间", reply: HOURS_REPLY }], mode = "rules", fallback) {
      await admin("PUT", `/api/v1/admin/shops/${shop}/settings`, { enabled, mode, system_prompt: "测试", rules, ...(fallback ? { fallback } : {}) });
    },
    async events(shop) {
      return (await admin("GET", `/api/v1/admin/events?shop_id=${shop}&limit=200`)).events;
    },
  };
}

export const FAST: Partial<Timing> = { heartbeatMs: 300, pollMs: 80, pollMaxMs: 400, pollGiveUpMs: 10000, submitRetries: 3, sendTimeoutMs: 800, requestTimeoutMs: 3000, unknownCheckDelaysMs: [150, 400] };

export type Harness = { rt: ShopRuntime; mock: MockPlatformAdapter; dir: string };

export async function makeShop(opts: {
  backend: TestBackend;
  shop?: string;
  token?: string;
  platformShopId?: string;
  mode?: ShopConfig["mode"];
  dir?: string;
  fetchImpl?: FetchLike;
  timing?: Partial<Timing>;
  login?: boolean;
  now?: () => number;
  monotonicNow?: () => number;
  log?: (line: string) => void;
  declareMark?: boolean;
  declareTransfer?: boolean;
  updateHold?: () => boolean;
}): Promise<Harness> {
  const shop = opts.shop ?? "shop-a";
  const platformShopId = opts.platformShopId ?? `pdd-${shop}`;
  const mock = new MockPlatformAdapter({ platformShopId, displayName: shop, now: opts.now });
  const dir = opts.dir ?? tempDir("claw-next-client-");
  const rt = new ShopRuntime({
    config: { shop_id: shop, display_name: shop, backend_url: opts.backend.url, platform_shop_id: platformShopId, adapter: "mock", mode: opts.mode ?? "auto" },
    token: opts.token ?? (shop === "shop-b" ? TOKEN_B : TOKEN_A),
    adapter: mock,
    dataDir: dir,
    fetchImpl: opts.fetchImpl,
    timing: { ...FAST, ...opts.timing },
    now: opts.now,
    monotonicNow: opts.monotonicNow,
    log: opts.log,
    declareMark: opts.declareMark,
    declareTransfer: opts.declareTransfer,
    updateHold: opts.updateHold,
  });
  await rt.start();
  if (opts.login !== false) {
    await mock.login();
    await waitFor(() => rt.lease.state !== "none", "lease");
  }
  return { rt, mock, dir };
}

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function eventsOf(rt: ShopRuntime) {
  return [...rt.journal.events.values()];
}

/** 等某条消息对应的事件进入终态（判断完成且发送流程结束）。 */
export async function settle(rt: ShopRuntime) {
  await new Promise((r) => setTimeout(r, 50));
  await rt.settled();
}

/**
 * 模拟“不支持某能力的旧后台”：从心跳响应里去掉该能力（其他响应原样）。
 * 用于不论 CLAW_NEXT_BACKEND_ROOT 指向哪个后台，都能固定验证旧后台组合。
 */
export function withoutCapability(cap: string, base: FetchLike = fetch): FetchLike {
  return (async (input: any, init?: any) => {
    const res = await base(input, init);
    if (!String(input).endsWith("/api/v1/heartbeat") || !res.ok) return res;
    const body = (await res.json()) as { capabilities?: string[] };
    if (Array.isArray(body.capabilities)) body.capabilities = body.capabilities.filter((c) => c !== cap);
    return new Response(JSON.stringify(body), { status: res.status, headers: { "Content-Type": "application/json" } });
  }) as FetchLike;
}

/** 包装 fetch，按规则模拟“请求已到后台但响应丢失”“请求未发出即失败”或“后台暂时 503”。 */
export function faultyFetch(rule: (url: string, method: string) => "drop_response" | "fail_before" | "status_503" | null): FetchLike {
  return (async (input: any, init?: any) => {
    const url = String(input);
    const action = rule(url, init?.method ?? "GET");
    if (action === "fail_before") throw new TypeError("fetch failed");
    if (action === "status_503") return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 503, headers: { "Content-Type": "application/json" } });
    const res = await fetch(input, init);
    if (action === "drop_response") {
      await res.arrayBuffer();
      throw new TypeError("fetch failed");
    }
    return res;
  }) as FetchLike;
}
