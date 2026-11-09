"use strict";

(function () {
  const PROTOCOL_VERSION = "1.0";
  const EMPTY_EVENTS_TEXT = "当前没有任务事件。前台提交消息后，这里会显示后台判断与回执。";
  const LIMITS = { maxRules: 100, contains: 500, reply: 2000, prompt: 8000, modelName: 128, sendMatch: 50 };
  const SEND_TYPES = ["instruction", "goods_card", "video"];
  const SEND_TYPE_LABELS = {
    instruction: "发送说明书",
    goods_card: "发送商品卡片",
    video: "发送视频"
  };
  const SEND_TYPE_NAMES = {
    instruction: "说明书",
    goods_card: "商品卡片",
    video: "视频"
  };
  const SAVE_UNCONFIRMED = "保存结果未确认，请刷新核对。";
  const RULE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
  const SHOP_POLL_MS = 5000;
  const VERIFY_NOTE_MAX = 200;
  const ROUTES = {
    dashboard: "工作台",
    scripts: "店铺配置",
    templates: "话术模版",
    "chat-import": "聊天记录整理",
    records: "处理记录",
    model: "模型配置",
    system: "系统设置"
  };
  const ROUTE_KEYS = ["dashboard", "scripts", "templates", "chat-import", "records", "model", "system"];

  const state = {
    epoch: 0,
    token: null,
    me: null,
    username: null,
    expiresAt: null,
    handoff: { seq: 0, busy: false },
    route: "dashboard",
    shops: [],
    templates: [],
    templateId: "",
    templateVersion: null,
    templateBusy: false,
    editor: { id: "", version: null, initialized: false, dirty: false, revision: 0, snapshot: null },
    settingsBusy: false,
    formRevision: 0,
    selectedShopId: null,
    loadedSettings: null,
    remoteSettings: null,
    formVersion: null,
    formSignature: "",
    formDirty: false,
    formDisabled: true,
    rules: [],
    fallback: {},
    rulesPage: 0,
    ruleUid: 0,
    ruleSeq: 0,
    events: [],
    autoTimer: null,
    requestSeq: 0,
    shopPollTimer: null,
    shopPollInFlight: false,
    maintenance: null,
    healthCounts: null,
    shopStatus: "unknown",
    shopError: "",
    shopUpdatedAt: null,
    promptDraft: { seq: 0, busy: false, shopId: null },
    verify: {
      open: false,
      busy: false,
      unconfirmed: false,
      seq: 0,
      eventId: null,
      shopId: null,
      conversationId: null
    },
    model: {
      loaded: false,
      dirty: false,
      busy: false,
      config: null,
      testSeq: 0,
      tests: {
        primary: { busy: false, state: "idle", message: "" },
        backup: { busy: false, state: "idle", message: "" }
      }
    }
  };

  const el = {};
  let assist = null;
  let productLearning = null;
  const IDS = [
    "login-view", "login-panel", "login-form", "username-input", "password-input", "login-btn",
    "login-notice", "login-error",
    "dashboard", "admin-badge", "logout-btn", "global-alert", "health-alert", "nav-toggle", "nav-backdrop",
    "topbar-route", "topbar-shop-status", "dashboard-refresh-btn",
    "count-pending", "count-processing", "count-ready", "count-sent", "count-unknown",
    "summary-meta", "account-meta", "account-panel", "account-close",
    "change-password-form", "current-password-input", "new-password-input",
    "confirm-password-input", "change-password-btn", "change-password-status",
    "change-password-error",
    "page-dashboard", "page-scripts", "page-templates", "page-chat-import", "page-records", "page-model", "page-system",
    "shop-connection-list", "shop-connection-summary", "shop-connection-meta",
    "shop-select", "shop-meta", "settings-version", "lease-status", "lease-details",
    "shop-decision-runtime", "model-decision-runtime",
    "template-select", "template-create", "template-help", "template-status",
    "template-editor-form", "template-editor-select", "template-name", "template-new", "template-save", "template-save-as",
    "template-reset", "template-editor-status", "template-editor-version", "template-source-note",
    "template-mode-summary", "template-prompt-summary", "template-rules-summary",
    "lease-instance", "lease-session", "lease-generation", "lease-expires",
    "settings-form", "enabled-input", "enabled-note", "mode-input", "prompt-input",
    "prompt-brief", "generate-prompt", "prompt-draft-status", "prompt-draft", "apply-prompt-draft",
    "rules-list", "rules-empty", "rules-count", "add-rule-btn", "rules-error",
    "rules-prev", "rules-next", "rules-page",
    "settings-remote-note", "save-btn", "reset-btn", "save-status", "fallback-controls",
    "limit-select", "refresh-btn", "auto-refresh", "events-meta", "events-body", "events-empty",
    "model-form", "model-version", "model-note", "model-error",
    "model-save-btn", "model-reload-btn", "model-status",
    "primary-base-url", "primary-model", "primary-timeout", "primary-key",
    "primary-clear-key", "primary-key-status", "primary-test-btn", "primary-test-status",
    "backup-base-url", "backup-model", "backup-timeout", "backup-key",
    "backup-clear-key", "backup-key-status", "backup-test-btn", "backup-test-status",
    "system-connection", "system-version", "system-checked", "system-shop-state",
    "system-user", "system-session", "system-role", "system-refresh-btn",
    "settings-password-btn", "settings-logout-btn",
    "handoff-panel", "handoff-create", "handoff-refresh", "handoff-secret",
    "handoff-code", "handoff-hide", "handoff-status", "handoff-grants",
    "verify-panel", "verify-form", "verify-identity-shop", "verify-identity-conversation",
    "verify-identity-event", "verify-outcome", "verify-note", "verify-note-count",
    "verify-error", "verify-status", "verify-submit", "verify-cancel", "verify-close"
  ];

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || "请求失败");
      this.status = status;
      this.code = code;
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(node, value) {
    if (!node) {
      return;
    }
    node.textContent = value === null || value === undefined ? "" : String(value);
  }

  function textOrDash(value) {
    return value === null || value === undefined || value === "" ? "–" : String(value);
  }

  function formatTime(unixSeconds) {
    const n = Number(unixSeconds);
    if (!Number.isFinite(n) || n <= 0) {
      return "–";
    }
    try {
      return new Date(n * 1000).toLocaleString("zh-CN", { hour12: false });
    } catch (err) {
      return "–";
    }
  }

  function formatClock(date) {
    try {
      return date.toLocaleTimeString("zh-CN", { hour12: false });
    } catch (err) {
      return "–";
    }
  }

  async function request(path, options) {
    const opts = options || {};
    const token = Object.prototype.hasOwnProperty.call(opts, "token") ? opts.token : state.token;
    const headers = { "Accept": "application/json" };
    if (token) {
      headers["Authorization"] = "Bearer " + token;
    }
    const init = {
      method: opts.method || "GET",
      headers: headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: opts.redirect || "follow"
    };
    if (Object.prototype.hasOwnProperty.call(opts, "body")) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch (err) {
      throw new ApiError(0, "network_error", "无法连接后台服务，请检查服务是否启动、地址是否同源。");
    }

    let raw = "";
    try {
      raw = await response.text();
    } catch (err) {
      throw new ApiError(response.status, "read_error", "读取服务端响应失败。");
    }
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (err) {
        throw new ApiError(response.status, "bad_response", "服务端返回了无法解析的响应。");
      }
    }

    if (!response.ok) {
      const detail = data && data.error && typeof data.error === "object"
        ? data.error
        : (data && typeof data === "object" ? data : {});
      const code = typeof detail.code === "string" ? detail.code : "http_" + response.status;
      const message = typeof detail.message === "string" ? detail.message : "请求失败（HTTP " + response.status + "）";
      throw new ApiError(response.status, code, message);
    }
    return data;
  }

  function isStale(epoch) {
    return typeof epoch === "number" && epoch !== state.epoch;
  }

  function showLoginError(message) {
    setText(el["login-error"], message);
    el["login-error"].hidden = !message;
  }

  function showLoginNotice(message, kind) {
    const node = el["login-notice"];
    if (!message) {
      node.className = "login-notice";
      setText(node, "");
      node.hidden = true;
      return;
    }
    node.className = "login-notice login-notice-" + (kind || "info");
    setText(node, message);
    node.hidden = false;
  }

  function showAlert(message, kind) {
    const box = el["global-alert"];
    if (!message) {
      box.hidden = true;
      setText(box, "");
      box.className = "alert";
      return;
    }
    box.className = "alert" + (kind ? " alert-" + kind : "");
    setText(box, message);
    box.hidden = false;
  }

  function applyHealthSummary(summary) {
    const counts = summary && summary.counts;
    if (!counts || !["pending", "processing", "ready", "sent", "unknown"].every(function (key) {
      return Number.isInteger(counts[key]) && counts[key] >= 0;
    })) {
      throw new ApiError(0, "bad_response", "后台状态返回异常，请刷新核对。");
    }
    state.maintenance = summary.maintenance;
    state.healthCounts = counts;
    renderSummary(counts);
    renderHealthAlert(false);
  }

  function renderHealthAlert(unavailable) {
    const box = el["health-alert"];
    const messages = [];
    if (unavailable) {
      messages.push("后台连接未确认，状态可能已过期；请检查后台是否运行。");
    } else {
      const maintenance = state.maintenance || {};
      const failures = maintenance.model_failures || {};
      if (Object.keys(failures).some(function (shop) { return failures[shop] >= 3; })) {
        messages.push("模型已连续至少 3 次判断失败，请检查模型配置和连接；计数自本次后台启动起。");
      }
      if (maintenance.worker_alive === false) messages.push("后台判断任务已停止，请检查后台运行状态。");
      if (maintenance.backup && maintenance.backup.status === "error") messages.push("数据库自动备份失败，旧备份保留；请检查数据目录权限与剩余空间。");
      const unknown = state.healthCounts && state.healthCounts.unknown;
      if (Number.isInteger(unknown) && unknown > 0) messages.push("有 " + unknown + " 条发送结果不确定记录（含已人工核查的历史），请查看处理记录；不会自动重试。");
    }
    setText(box, messages.join(" "));
    box.hidden = messages.length === 0;
  }

  function showRemoteNote(message) {
    const box = el["settings-remote-note"];
    if (!message) {
      box.hidden = true;
      setText(box, "");
      return;
    }
    setText(box, message);
    box.hidden = false;
  }

  function showModelError(message) {
    setText(el["model-error"], message);
    el["model-error"].hidden = !message;
  }

  function showChangePasswordError(message) {
    setText(el["change-password-error"], message);
    el["change-password-error"].hidden = !message;
  }

  function hideChangePasswordError() {
    setText(el["change-password-error"], "");
    el["change-password-error"].hidden = true;
  }

  function clearChangePasswordForm() {
    ["current-password-input", "new-password-input", "confirm-password-input"].forEach(function (id) {
      if (el[id]) {
        el[id].value = "";
      }
    });
    hideChangePasswordError();
    if (el["change-password-status"]) {
      setText(el["change-password-status"], "");
    }
  }

  function setChangeBusy(busy) {
    if (!el["change-password-btn"]) {
      return;
    }
    el["change-password-btn"].disabled = busy;
    setText(el["change-password-btn"], busy ? "修改中…" : "修改密码");
  }

  function setLoginBusy(busy) {
    if (!el["login-btn"]) {
      return;
    }
    el["login-btn"].disabled = busy;
    setText(el["login-btn"], busy ? "登录中…" : "登录");
  }

  function renderAccountMeta() {
    const parts = [];
    if (state.username) {
      parts.push("当前登录：" + state.username);
    }
    if (Number.isFinite(state.expiresAt)) {
      parts.push("会话有效至 " + formatTime(state.expiresAt));
    }
    setText(el["account-meta"], parts.join(" · "));
    setText(el["system-user"], textOrDash(state.username));
    setText(el["system-session"], Number.isFinite(state.expiresAt) ? formatTime(state.expiresAt) : "–");
    const role = state.me && state.me.role === "admin" ? "管理员" : "–";
    setText(el["system-role"], role);
    const protocol = state.me && state.me.protocol_version ? String(state.me.protocol_version) : PROTOCOL_VERSION;
    setText(el["system-version"], protocol);
  }

  function passwordChangeRequired() {
    return state.me && state.me.must_change_password === true;
  }

  function errorText(err) {
    if (err instanceof ApiError) {
      const code = err.code ? "（" + err.code + "）" : "";
      return err.message + code;
    }
    return "发生未知错误，请重试。";
  }

  function clearTimer() {
    if (state.autoTimer !== null) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
  }

  function settingsVersion(settings) {
    if (!settings || typeof settings !== "object") {
      return null;
    }
    const n = Number(settings.version);
    return Number.isFinite(n) ? n : null;
  }

  function settingsSignature(settings) {
    const s = settings && typeof settings === "object" ? settings : {};
    const rules = (Array.isArray(s.rules) ? s.rules : []).map(function (rule) {
      const r = rule && typeof rule === "object" ? rule : {};
      const send = r.send && typeof r.send === "object" ? r.send : null;
      const sendType = send && SEND_TYPES.includes(send.type) ? send.type : "";
      const sendMatch = sendType && typeof send.match === "string" ? send.match : "";
      return [
        typeof r.id === "string" ? r.id : "",
        typeof r.contains === "string" ? r.contains : "",
        typeof r.reply === "string" ? r.reply : "",
        typeof r.description === "string" ? r.description : "",
        sendType,
        sendMatch,
        r.handling ? policySignature(r.handling) : null
      ];
    });
    return JSON.stringify([
      s.enabled === true,
      ["model", "hybrid"].includes(s.mode) ? s.mode : "rules",
      typeof s.system_prompt === "string" ? s.system_prompt : "",
      rules,
      ["unhandled", "error", "model_timeout"].map(function (key) {
        return policySignature(s.fallback && s.fallback[key]);
      }),
      s.template_id || "", s.template_version || null
    ]);
  }

  function renderVersion(version) {
    const node = el["settings-version"];
    if (version === null || version === undefined) {
      node.hidden = true;
      setText(node, "");
      return;
    }
    node.hidden = false;
    setText(node, "服务器第 " + String(version) + " 版设置");
  }

  /* ---------- 页面导航 ---------- */

  function routeFromHash() {
    const raw = typeof window.location.hash === "string" ? window.location.hash : "";
    const value = raw.replace(/^#\/?/, "").trim();
    return Object.prototype.hasOwnProperty.call(ROUTES, value) ? value : "dashboard";
  }

  function closeMobileNav() {
    el["dashboard"].classList.remove("nav-open");
    el["nav-toggle"].setAttribute("aria-expanded", "false");
    el["nav-toggle"].setAttribute("aria-label", "打开导航");
    el["nav-backdrop"].hidden = true;
  }

  function openMobileNav() {
    el["dashboard"].classList.add("nav-open");
    el["nav-toggle"].setAttribute("aria-expanded", "true");
    el["nav-toggle"].setAttribute("aria-label", "关闭导航");
    el["nav-backdrop"].hidden = false;
  }

  function applyRoute(route, options) {
    const opts = options || {};
    const target = Object.prototype.hasOwnProperty.call(ROUTES, route) ? route : "dashboard";
    if (target !== "system") clearHandoff();
    state.route = target;

    ROUTE_KEYS.forEach(function (key) {
      const page = byId("page-" + key);
      if (page) {
        page.hidden = key !== target;
      }
    });

    document.querySelectorAll(".nav-link[data-route]").forEach(function (node) {
      if (node.dataset.route === target) {
        node.setAttribute("aria-current", "page");
      } else {
        node.removeAttribute("aria-current");
      }
    });

    setText(el["topbar-route"], ROUTES[target]);
    closeMobileNav();

    if (!state.token) {
      return;
    }
    if (target === "model" && !state.model.loaded && !state.model.busy) {
      loadModelConfig({ force: false });
    }
    if (target === "templates" && !state.editor.initialized) loadShopTemplateEditor();
    if (target === "system" && opts.refreshSystem !== false) {
      refreshSystemStatus(false);
      loadHandoffGrants();
    }
    if (opts.scroll !== false) {
      window.scrollTo(0, 0);
    }
  }

  function navigateTo(route) {
    const target = Object.prototype.hasOwnProperty.call(ROUTES, route) ? route : "dashboard";
    if (state.route === target) {
      applyRoute(target);
      return;
    }
    try {
      window.location.hash = "#/" + target;
    } catch (err) {
      applyRoute(target);
    }
  }

  /* ---------- 自动发送状态（前台连接） ---------- */

  function clearLeaseDisplay() {
    const badge = el["lease-status"];
    badge.className = "badge badge-muted";
    setText(badge, "状态未知");
    el["lease-details"].hidden = true;
    ["lease-instance", "lease-session", "lease-generation", "lease-expires"].forEach(function (id) {
      setText(byId(id), "–");
    });
  }

  function leaseActive(lease) {
    const expires = lease && typeof lease === "object" ? Number(lease.expires_at) : NaN;
    return Number.isFinite(expires) && expires * 1000 > Date.now();
  }

  function renderLease(lease) {
    const badge = el["lease-status"];
    if (!lease || typeof lease !== "object") {
      badge.className = "badge badge-muted";
      setText(badge, "未连接后台，不会自动发送");
      el["lease-details"].hidden = true;
      ["lease-instance", "lease-session", "lease-generation", "lease-expires"].forEach(function (id) {
        setText(byId(id), "–");
      });
      return;
    }
    const expires = Number(lease.expires_at);
    const isActive = Number.isFinite(expires) && expires * 1000 > Date.now();
    if (state.shopStatus === "error") {
      badge.className = "badge badge-warn";
      setText(badge, "状态未确认（刷新失败）");
    } else if (isActive) {
      badge.className = "badge badge-ok";
      setText(badge, "已连接后台；平台登录由客户端核验");
    } else if (Number.isFinite(expires)) {
      badge.className = "badge badge-warn";
      setText(badge, "后台连接已过期，暂停自动发送");
    } else {
      badge.className = "badge badge-muted";
      setText(badge, "连接状态未知");
    }
    el["lease-details"].hidden = false;
    setText(el["lease-instance"], textOrDash(lease.instance_id));
    setText(el["lease-session"], textOrDash(lease.session_id));
    setText(el["lease-generation"], textOrDash(lease.generation));
    setText(el["lease-expires"], Number.isFinite(expires) ? formatTime(expires) : "–");
  }

  function shopName(shop) {
    return shop && typeof shop.name === "string" && shop.name ? shop.name : textOrDash(shop && shop.shop_id);
  }

  function renderTopbarShopStatus(activeCount) {
    const node = el["topbar-shop-status"];
    if (!node) {
      return;
    }
    if (state.shopStatus === "error") {
      node.className = "status-dot status-unknown";
      setText(node, "状态未确认");
      node.title = state.shopError || "店铺连接状态未确认";
      return;
    }
    if (state.shopStatus !== "ok") {
      node.className = "status-dot status-unknown";
      setText(node, "状态未确认");
      node.title = "尚未取得店铺连接状态";
      return;
    }
    const total = state.shops.length;
    const active = typeof activeCount === "number" ? activeCount : 0;
    node.className = "status-dot " + (active > 0 ? "status-ok" : "status-idle");
    setText(node, active + " / " + total + " 已连接");
    node.title = "已连接后台的店铺数 / 配置店铺数";
  }

  function decisionDetails(shop) {
    const runtime = shop && shop.decision_runtime;
    if (state.shopStatus !== "ok" || !runtime) return [["决策流程", "状态未确认，请刷新"]];
    const mode = runtime.mode === "conversation_brain" ? "新决策模式" : runtime.mode === "rules" ? "纯规则" : "传统模型流程";
    const rows = [["决策流程", mode + (runtime.enabled ? " · 已启用" : " · 已暂停")]];
    if (runtime.mode === "rules") {
      rows.push(["模型调用", "不调用模型"], ["会话记忆", "不更新持久记忆"]);
      if (runtime.brain_configured) rows.push(["新模式", "已配置；当前纯规则方式不使用"]);
      return rows;
    }
    (runtime.models || []).forEach(function (model, index) {
      const label = model.slot === "backup" ? "备用模型配置" : "主模型配置";
      rows.push([index === 0 ? "优先尝试" : "故障后尝试", model.configured
        ? model.model + "（" + label + "） · 单次 " + model.timeout_seconds + " 秒"
        : label + "未配置，将跳过"]);
    });
    rows.push(["会话记忆", runtime.persistent_memory ? (runtime.enabled ? "启用有原文来源的持久记忆" : "已配置，暂停更新") : "仅使用本次提交的上下文"]);
    if (runtime.total_budget_seconds) rows.push(["决策总预算", "最多 " + runtime.total_budget_seconds + " 秒；客户端剩余预算更少时提前截止"]);
    return rows;
  }

  function fillDecisionDetails(node, shop) {
    node.replaceChildren();
    decisionDetails(shop).forEach(function (pair) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      setText(dt, pair[0]);
      setText(dd, pair[1]);
      row.appendChild(dt);
      row.appendChild(dd);
      node.appendChild(row);
    });
  }

  function renderDecisionRuntime() {
    fillDecisionDetails(el["shop-decision-runtime"], currentShop());
    const list = el["model-decision-runtime"];
    list.replaceChildren();
    if (!state.shops.length) {
      const empty = document.createElement("p");
      setText(empty, "尚未取得店铺运行配置。");
      list.appendChild(empty);
    }
    state.shops.forEach(function (shop) {
      const card = document.createElement("article");
      card.className = "shop-card";
      const title = document.createElement("h4");
      setText(title, shopName(shop));
      const details = document.createElement("dl");
      details.className = "detail-list";
      fillDecisionDetails(details, shop);
      card.appendChild(title);
      card.appendChild(details);
      list.appendChild(card);
    });
  }

  function renderShopConnections() {
    renderDecisionRuntime();
    const list = el["shop-connection-list"];
    list.replaceChildren();
    const summary = el["shop-connection-summary"];
    const meta = el["shop-connection-meta"];

    if (state.shopStatus === "error") {
      summary.className = "pill pill-warn";
      setText(summary, "状态未确认");
    } else if (state.shopStatus !== "ok") {
      summary.className = "pill pill-muted";
      setText(summary, "尚未加载店铺");
    }

    if (state.shops.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state small";
      setText(empty, state.shopStatus === "error"
        ? "店铺状态刷新失败，暂时无法确认是否有店铺。"
        : "服务端没有返回店铺。请先在后台配置店铺。");
      list.appendChild(empty);
      setText(meta, state.shopStatus === "error"
        ? "店铺状态未确认：" + (state.shopError || "刷新失败") + "。不会沿用旧的成功状态。"
        : "尚未加载店铺。");
      renderTopbarShopStatus(0);
      setText(el["system-shop-state"], state.shopStatus === "error" ? "状态未确认" : "没有店铺");
      return;
    }

    let activeCount = 0;
    state.shops.forEach(function (shop) {
      const lease = shop.lease && typeof shop.lease === "object" ? shop.lease : null;
      const expires = lease ? Number(lease.expires_at) : NaN;
      const active = state.shopStatus === "ok" && leaseActive(lease);
      if (active) {
        activeCount += 1;
      }

      const card = document.createElement("article");
      card.className = "shop-card";

      const head = document.createElement("div");
      head.className = "shop-card-head";
      const name = document.createElement("div");
      name.className = "shop-card-name";
      const nameText = document.createElement("span");
      nameText.className = "cell-strong";
      setText(nameText, shopName(shop));
      name.appendChild(nameText);
      const idText = document.createElement("span");
      idText.className = "small muted mono";
      setText(idText, "店铺编号 " + textOrDash(shop.shop_id));
      name.appendChild(idText);

      const badge = document.createElement("span");
      if (state.shopStatus === "error") {
        badge.className = "badge badge-unknown";
        setText(badge, "状态未确认");
      } else if (!lease) {
        badge.className = "badge badge-muted";
        setText(badge, "未连接后台");
      } else if (active) {
        badge.className = "badge badge-ok";
        setText(badge, "已连接后台");
      } else if (Number.isFinite(expires)) {
        badge.className = "badge badge-warn";
        setText(badge, "连接已过期");
      } else {
        badge.className = "badge badge-muted";
        setText(badge, "连接状态未知");
      }
      head.appendChild(name);
      head.appendChild(badge);
      card.appendChild(head);

      const details = document.createElement("dl");
      details.className = "shop-card-details";
      const heartbeat = Number.isFinite(expires) ? expires - 60 : NaN;
      [
        ["客户端实例", lease ? textOrDash(lease.instance_id) : "–"],
        ["最近心跳", Number.isFinite(heartbeat) ? formatTime(heartbeat) : "–"],
        ["连接有效至", Number.isFinite(expires) ? formatTime(expires) : "–"]
      ].concat(decisionDetails(shop).slice(0, 2)).forEach(function (pair) {
        const row = document.createElement("div");
        const dt = document.createElement("dt");
        setText(dt, pair[0]);
        const dd = document.createElement("dd");
        setText(dd, pair[1]);
        row.appendChild(dt);
        row.appendChild(dd);
        details.appendChild(row);
      });
      card.appendChild(details);
      list.appendChild(card);
    });

    if (state.shopStatus === "error") {
      summary.className = "pill pill-warn";
      setText(summary, "状态未确认");
      setText(meta, "刷新失败，连接状态未确认（" + (state.shopError || "网络或服务异常") + "）。不会沿用旧的成功状态；到期时间仍按本地时间计算。");
      renderTopbarShopStatus(activeCount);
      setText(el["system-shop-state"], "状态未确认（配置 " + state.shops.length + " 家）");
      return;
    }

    summary.className = activeCount > 0 ? "pill pill-ok" : "pill pill-muted";
    setText(summary, activeCount + " / " + state.shops.length + " 家已连接后台");
    const updated = state.shopUpdatedAt ? formatClock(state.shopUpdatedAt) : "–";
    setText(meta, "共 " + state.shops.length + " 家店铺 · 更新于 " + updated + " · 每 5 秒刷新");
    renderTopbarShopStatus(activeCount);
    setText(el["system-shop-state"], state.shops.length + " 家 · " + activeCount + " 家已连接后台");
  }

  /* ---------- 规则行 ---------- */

  function nextUid() {
    state.ruleUid += 1;
    return state.ruleUid;
  }

  function generateRuleId() {
    const used = new Set();
    state.rules.forEach(function (rule) {
      if (rule.id) {
        used.add(rule.id);
      }
    });
    let id = "";
    do {
      state.ruleSeq += 1;
      id = "rule-" + Date.now().toString(36) + "-" + state.ruleSeq.toString(36);
    } while (used.has(id));
    return id;
  }

  function ruleSendType(rule) {
    return rule && rule.send && SEND_TYPES.includes(rule.send.type) ? rule.send.type : "";
  }

  function normalizeRuleSend(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const type = SEND_TYPES.includes(raw.type) ? raw.type : "";
    if (!type) {
      return null;
    }
    return { type: type, match: typeof raw.match === "string" ? raw.match : "" };
  }

  const sendUiSync = new WeakMap();

  function renderRules() {
    const list = el["rules-list"];
    list.replaceChildren();
    const pages = Math.max(1, Math.ceil(state.rules.length / 10));
    state.rulesPage = Math.min(Math.max(0, state.rulesPage), pages - 1);
    const start = state.rulesPage * 10;
    state.rules.slice(start, start + 10).forEach(function (rule, index) {
      list.appendChild(buildRuleRow(rule, start + index));
    });
    setText(el["rules-page"], "第 " + (state.rulesPage + 1) + " / " + pages + " 页 · 每页 10 条");
    el["rules-prev"].disabled = state.formDisabled || state.rulesPage === 0;
    el["rules-next"].disabled = state.formDisabled || state.rulesPage + 1 >= pages;
    const hasRules = state.rules.length > 0;
    el["rules-empty"].hidden = hasRules;
    if (hasRules) {
      setText(el["rules-count"], "共 " + state.rules.length + " 条规则（最多 " + LIMITS.maxRules + " 条）");
    } else {
      setText(el["rules-count"], "当前没有规则（最多 " + LIMITS.maxRules + " 条）");
    }
    el["add-rule-btn"].disabled = state.formDisabled || state.rules.length >= LIMITS.maxRules;
  }

  function buildRuleRow(rule, index) {
    const row = document.createElement("div");
    row.className = "rule-row";
    row.dataset.uid = String(rule.uid);

    const number = document.createElement("span");
    number.className = "rule-index";
    number.setAttribute("aria-hidden", "true");
    setText(number, String(index + 1));
    row.appendChild(number);

    const containsLabel = document.createElement("label");
    containsLabel.className = "field rule-field";
    const containsTitle = document.createElement("span");
    containsTitle.className = "field-label";
    setText(containsTitle, "匹配词");
    const containsInput = document.createElement("input");
    containsInput.type = "text";
    containsInput.className = "rule-contains";
    containsInput.maxLength = LIMITS.contains;
    containsInput.spellcheck = false;
    containsInput.placeholder = "例如：营业时间";
    containsInput.value = rule.contains;
    containsInput.setAttribute("aria-label", "第 " + (index + 1) + " 条规则的匹配词");
    containsInput.disabled = state.formDisabled;
    containsInput.addEventListener("input", function () {
      rule.contains = containsInput.value;
      onFormEdit();
    });
    containsLabel.appendChild(containsTitle);
    containsLabel.appendChild(containsInput);
    function help(label, text) {
      const note = document.createElement("span");
      note.className = "field-help";
      setText(note, text);
      label.appendChild(note);
    }
    help(containsLabel, "必填。买家文字里包含这个词就按本条处理；例如“材质”。每条只填一个词，按列表顺序取第一条命中。不是只要意思相近就命中。");
    const matchingFields = document.createElement("div");
    matchingFields.appendChild(containsLabel);
    const descriptionLabel = document.createElement("label");
    descriptionLabel.className = "field rule-field";
    const descriptionTitle = document.createElement("span");
    descriptionTitle.className = "field-label";
    setText(descriptionTitle, "适用问题说明（可选）");
    const descriptionInput = document.createElement("textarea");
    descriptionInput.className = "rule-description";
    descriptionInput.rows = 2;
    descriptionInput.maxLength = 500;
    descriptionInput.value = rule.description || "";
    descriptionInput.placeholder = "例如：询问何时发货、几天能收到";
    descriptionInput.setAttribute("aria-label", "第 " + (index + 1) + " 条规则的适用问题说明");
    descriptionInput.disabled = state.formDisabled;
    descriptionInput.addEventListener("input", function () {
      rule.description = descriptionInput.value;
      onFormEdit();
    });
    descriptionLabel.appendChild(descriptionTitle);
    descriptionLabel.appendChild(descriptionInput);
    help(descriptionLabel, "选填，最多 500 字。告诉混合方式的模型什么问题适用；例如“询问产品材质”。留空仍可按匹配词命中。纯模型方式不使用这些固定规则。");
    matchingFields.appendChild(descriptionLabel);
    row.appendChild(matchingFields);

    const replyGroup = document.createElement("div");
    replyGroup.className = "field rule-field rule-reply-group";

    const sendLabel = document.createElement("label");
    sendLabel.className = "field rule-field rule-send-type-field";
    const sendTitle = document.createElement("span");
    sendTitle.className = "field-label";
    setText(sendTitle, "处理方式");
    const sendSelect = document.createElement("select");
    sendSelect.className = "rule-send-type";
    [{ value: "", label: "文字回复" }].concat(SEND_TYPES.map(function (type) {
      return { value: type, label: SEND_TYPE_LABELS[type] };
    }), [
      { value: "handling:mark", label: "收藏标星" },
      { value: "handling:transfer", label: "转人工" },
      { value: "handling:handoff", label: "建议人工处理" },
      { value: "handling:none", label: "不处理" }
    ]).forEach(function (entry) {
      const option = document.createElement("option");
      option.value = entry.value;
      setText(option, entry.label);
      sendSelect.appendChild(option);
    });
    sendSelect.value = rule.handling ? "handling:" + rule.handling.action : ruleSendType(rule);
    sendSelect.setAttribute("aria-label", "第 " + (index + 1) + " 条规则的发送方式");
    sendSelect.disabled = state.formDisabled;
    sendLabel.appendChild(sendTitle);
    sendLabel.appendChild(sendSelect);
    help(sendLabel, "每条规则只执行一种处理。收藏与转人工需新版客户端连接并确认能力，且当前店铺为自动处理；保存配置不会自动开启回复。");
    replyGroup.appendChild(sendLabel);

    const matchLabel = document.createElement("label");
    matchLabel.className = "field rule-field rule-send-match-field";
    const matchTitle = document.createElement("span");
    matchTitle.className = "field-label";
    setText(matchTitle, "候选名称关键词（可选）");
    const matchInput = document.createElement("input");
    matchInput.type = "text";
    matchInput.className = "rule-send-match";
    matchInput.maxLength = LIMITS.sendMatch;
    matchInput.spellcheck = false;
    matchInput.value = rule.send && typeof rule.send.match === "string" ? rule.send.match : "";
    matchInput.placeholder = "例如：商品或视频名称的一部分";
    matchInput.setAttribute("aria-label", "第 " + (index + 1) + " 条规则的候选名称关键词");
    matchLabel.appendChild(matchTitle);
    matchLabel.appendChild(matchInput);
    help(matchLabel, "选填，最多 50 字。用于筛选前台提供的候选名称，例如“安装”。留空表示按类型选；只有唯一候选才能发送。不要填网址或本机文件路径。");
    replyGroup.appendChild(matchLabel);

    const sendHint = document.createElement("div");
    sendHint.className = "field-help rule-send-hint";
    setText(sendHint, "只有匹配到一项内容才发送；无匹配或多项时使用下方文字回复，留空则继续原来的未匹配处理。");
    replyGroup.appendChild(sendHint);

    const replyLabel = document.createElement("label");
    replyLabel.className = "field rule-field rule-field-reply";
    const replyTitle = document.createElement("span");
    replyTitle.className = "field-label";
    setText(replyTitle, "回复内容");
    const replyInput = document.createElement("textarea");
    replyInput.className = "rule-reply";
    replyInput.rows = 2;
    replyInput.maxLength = LIMITS.reply;
    replyInput.spellcheck = false;
    replyInput.placeholder = "匹配后提供给客户端的回复建议";
    replyInput.value = rule.reply;
    replyInput.setAttribute("aria-label", "第 " + (index + 1) + " 条规则的回复内容");
    replyInput.disabled = state.formDisabled;
    replyInput.addEventListener("input", function () {
      rule.reply = replyInput.value;
      onFormEdit();
    });
    replyLabel.appendChild(replyTitle);
    replyLabel.appendChild(replyInput);
    help(replyLabel, "文字回复时必填，最多 2000 字；选商品卡等方式时可留空。示例写法：“请告知具体款式，我先核对材质。”请填写店铺已确认的事实，模型选中这条规则后也会使用原文。");
    replyGroup.appendChild(replyLabel);
    const handlingGroup = document.createElement("div");
    replyGroup.appendChild(handlingGroup);
    row.appendChild(replyGroup);

    function syncSendUi() {
      const active = !rule.handling && ruleSendType(rule) !== "";
      replyLabel.hidden = !!rule.handling;
      replyInput.disabled = state.formDisabled || !!rule.handling;
      handlingGroup.replaceChildren();
      if (rule.handling) handlingGroup.appendChild(policyDetails(rule.handling));
      matchLabel.hidden = !active;
      sendHint.hidden = !active;
      matchInput.disabled = state.formDisabled || !active;
      if (active) {
        matchInput.value = rule.send && typeof rule.send.match === "string" ? rule.send.match : "";
      }
      setText(replyTitle, active ? "文字回复（可选，无匹配内容或匹配到多项时使用）" : "回复内容");
      replyInput.placeholder = active
        ? "可选：无匹配内容或匹配到多项时使用；留空则继续原来的未匹配处理"
        : "匹配后提供给客户端的回复建议";
    }
    sendUiSync.set(row, syncSendUi);
    syncSendUi();

    sendSelect.addEventListener("change", function () {
      if (sendSelect.value.startsWith("handling:")) {
        rule.handling = newPolicy(sendSelect.value.slice(9));
        rule.send = null;
        syncSendUi();onFormEdit();return;
      }
      rule.handling = null;
      const type = SEND_TYPES.includes(sendSelect.value) ? sendSelect.value : "";
      if (type) {
        rule.send = {
          type: type,
          match: rule.send && typeof rule.send.match === "string" ? rule.send.match : ""
        };
      } else {
        rule.send = null;
      }
      syncSendUi();
      onFormEdit();
    });
    matchInput.addEventListener("input", function () {
      if (!rule.send) {
        return;
      }
      rule.send.match = matchInput.value;
      onFormEdit();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-ghost rule-delete btn-sm";
    setText(deleteBtn, "删除");
    deleteBtn.setAttribute("aria-label", "删除第 " + (index + 1) + " 条规则");
    deleteBtn.disabled = state.formDisabled;
    deleteBtn.addEventListener("click", function () {
      state.rules = state.rules.filter(function (item) {
        return item.uid !== rule.uid;
      });
      renderRules();
      onFormEdit();
    });
    row.appendChild(deleteBtn);

    return row;
  }

  function policySignature(policy) {
    const p = policy || { action: "handoff" };
    return [p.action, p.color || "", p.account || "", p.allow_unmark === true];
  }

  function policyError(policy) {
    if (!["none", "handoff", "mark", "transfer"].includes(policy.action)) return "请选择处理方式。";
    if (policy.action === "mark" && !["red", "orange", "blue", "green"].includes(policy.color)) return "请选择星标颜色。";
    if (policy.action === "transfer" && (typeof policy.account !== "string" || !policy.account.trim() || policy.account.trim().length > 40)) return "请填写 1–40 字的接收人账号名。";
    return "";
  }

  function policyDetails(policy, onEdit) {
    const edited = onEdit || onFormEdit;
    const group = document.createElement("div");
    group.className = "policy-details";
    function field(title, input) {
      const label = document.createElement("label");
      label.className = "field";
      const text = document.createElement("span");
      setText(text, title);
      label.appendChild(text);
      input.disabled = state.formDisabled;
      label.appendChild(input);
      group.appendChild(label);
    }
    if (policy.action === "mark") {
      const color = document.createElement("select");
      [["red", "红色"], ["orange", "黄色"], ["blue", "蓝色"], ["green", "绿色"]].forEach(function (entry) {
        const option = document.createElement("option");option.value = entry[0];setText(option, entry[1]);color.appendChild(option);
      });
      color.value = policy.color;
      color.addEventListener("change", function () { policy.color = color.value;edited(); });
      field("星标颜色", color);
    } else if (policy.action === "transfer") {
      const account = document.createElement("input");
      account.type = "text";account.maxLength = 40;account.value = policy.account || "";
      account.placeholder = "填写转移框第一列的完整账号名";
      account.addEventListener("input", function () { policy.account = account.value;edited(); });
      field("接收人账号名", account);
      const allow = document.createElement("input");allow.type = "checkbox";allow.className = "policy-unmark";allow.checked = policy.allow_unmark === true;
      allow.addEventListener("change", function () { policy.allow_unmark = allow.checked;edited(); });
      field("已收藏时，取消收藏并转人工", allow);
      allow.disabled = state.formDisabled;
    }
    return group;
  }

  function newPolicy(action) {
    if (action === "mark") return { action: action, color: "red" };
    if (action === "transfer") return { action: action, account: "", allow_unmark: false };
    return { action: action };
  }

  function renderFallback(saved) {
    state.fallback = JSON.parse(JSON.stringify(saved || {}));
    const root = el["fallback-controls"];root.replaceChildren();
    [["unhandled", "无法处理"], ["error", "判断报错"], ["model_timeout", "模型超时（回复总时限内）"]].forEach(function (entry) {
      const key = entry[0];
      if (!state.fallback[key]) state.fallback[key] = { action: "handoff" };
      const group = document.createElement("div");group.className = "fallback-policy";
      const label = document.createElement("label");label.className = "field";
      const title = document.createElement("span");setText(title, entry[1]);label.appendChild(title);
      const select = document.createElement("select");
      [["handoff", "建议人工处理"], ["none", "不处理"], ["mark", "收藏标星"], ["transfer", "转人工"]].forEach(function (item) {
        const option = document.createElement("option");option.value = item[0];setText(option, item[1]);select.appendChild(option);
      });
      select.value = state.fallback[key].action;select.disabled = state.formDisabled;label.appendChild(select);group.appendChild(label);
      let details = policyDetails(state.fallback[key], onShopFormEdit);group.appendChild(details);
      select.addEventListener("change", function () {
        state.fallback[key] = newPolicy(select.value);
        const next = policyDetails(state.fallback[key], onShopFormEdit);details.replaceWith(next);details = next;onShopFormEdit();
      });
      root.appendChild(group);
    });
  }

  function loadRules(rules) {
    state.rules = (Array.isArray(rules) ? rules : []).map(function (rule) {
      const source = rule && typeof rule === "object" ? rule : {};
      return {
        uid: nextUid(),
        id: RULE_ID_PATTERN.test(source.id) ? source.id : "",
        contains: typeof source.contains === "string" ? source.contains : "",
        reply: typeof source.reply === "string" ? source.reply : "",
        description: typeof source.description === "string" ? source.description : "",
        send: normalizeRuleSend(source.send),
        handling: source.handling ? JSON.parse(JSON.stringify(source.handling)) : null
      };
    });
    const seen = new Set();
    state.rules.forEach(function (rule) {
      if (!rule.id || seen.has(rule.id)) {
        rule.id = "";
        return;
      }
      seen.add(rule.id);
    });
    state.rules.forEach(function (rule) {
      if (!rule.id) {
        rule.id = generateRuleId();
        seen.add(rule.id);
      }
    });
    renderRules();
  }

  function addRule() {
    if (state.formDisabled || state.rules.length >= LIMITS.maxRules) {
      return;
    }
    state.rules.push({ uid: nextUid(), id: generateRuleId(), contains: "", reply: "", description: "", send: null });
    state.rulesPage = Math.floor((state.rules.length - 1) / 10);
    renderRules();
    onFormEdit();
    const rows = el["rules-list"].querySelectorAll(".rule-row");
    const last = rows[rows.length - 1];
    const input = last ? last.querySelector(".rule-contains") : null;
    if (input) {
      input.focus();
    }
  }

  function showRulesError(message, focusUid, focusField) {
    const section = byId("template-rules-section"); if (section) section.open = true;
    setText(el["rules-error"], message);
    el["rules-error"].hidden = false;
    if (focusUid === undefined || focusUid === null) {
      return;
    }
    const index = state.rules.findIndex(function (rule) { return rule.uid === focusUid; });
    if (index >= 0 && Math.floor(index / 10) !== state.rulesPage) {
      state.rulesPage = Math.floor(index / 10);
      renderRules();
    }
    const row = el["rules-list"].querySelector('.rule-row[data-uid="' + String(focusUid) + '"]');
    if (!row) {
      return;
    }
    const fieldSelectors = {
      description: ".rule-description",
      reply: ".rule-reply",
      send_type: ".rule-send-type",
      send_match: ".rule-send-match"
    };
    const target = row.querySelector(fieldSelectors[focusField] || ".rule-contains");
    if (target) {
      target.focus();
    }
  }

  function hideRulesError() {
    el["rules-error"].hidden = true;
    setText(el["rules-error"], "");
  }

  function collectRules() {
    if (state.rules.length > LIMITS.maxRules) {
      return { ok: false, message: "规则最多 " + LIMITS.maxRules + " 条。" };
    }
    const value = [];
    for (let i = 0; i < state.rules.length; i += 1) {
      const rule = state.rules[i];
      const label = "第 " + (i + 1) + " 条规则：";
      const contains = typeof rule.contains === "string" ? rule.contains : "";
      const reply = typeof rule.reply === "string" ? rule.reply : "";
      const sendType = ruleSendType(rule);
      const send = sendType
        ? { type: sendType, match: typeof rule.send.match === "string" ? rule.send.match.trim() : "" }
        : null;
      if (!contains.trim()) {
        return { ok: false, message: label + "请填写“匹配词”。", uid: rule.uid, field: "contains" };
      }
      if (contains.trim().length > LIMITS.contains) {
        return { ok: false, message: label + "“匹配词”最多 " + LIMITS.contains + " 个字。", uid: rule.uid, field: "contains" };
      }
      if (send && send.match.length > LIMITS.sendMatch) {
        return { ok: false, message: label + "“候选名称关键词”最多 " + LIMITS.sendMatch + " 个字。", uid: rule.uid, field: "send_match" };
      }
      if (rule.handling && policyError(rule.handling)) {
        return { ok: false, message: label + policyError(rule.handling), uid: rule.uid, field: "send_type" };
      }
      if (!rule.handling && !send && !reply.trim()) {
        return { ok: false, message: label + "请填写“回复内容”，或选择发送说明书 / 商品卡片 / 视频。", uid: rule.uid, field: "reply" };
      }
      if (!rule.handling && reply.trim().length > LIMITS.reply) {
        return { ok: false, message: label + "“回复内容”最多 " + LIMITS.reply + " 个字。", uid: rule.uid, field: "reply" };
      }
      if (!rule.id) {
        rule.id = generateRuleId();
      }
      const description = rule.description || "";
      if (description.length > 500) {
        return { ok: false, message: label + "适用问题说明最多 500 字。", uid: rule.uid, field: "description" };
      }
      const item = { id: rule.id, contains: contains, description: description };
      if (rule.handling) {
        item.handling = JSON.parse(JSON.stringify(rule.handling));
        if (item.handling.action === "transfer") item.handling.account = item.handling.account.trim();
      } else if (reply.trim()) {
        item.reply = reply;
      }
      if (send && !rule.handling) {
        item.send = send.match ? { type: send.type, match: send.match } : { type: send.type };
      }
      value.push(item);
    }
    return { ok: true, value: value };
  }

  /* ---------- 设置表单 ---------- */

  function syncPromptDraft() {
    const busy = state.promptDraft.busy;
    el["prompt-brief"].disabled = state.formDisabled || busy;
    el["prompt-draft"].disabled = state.formDisabled || busy;
    el["generate-prompt"].disabled = state.formDisabled || busy;
    el["apply-prompt-draft"].disabled = state.formDisabled || busy ||
      state.promptDraft.shopId !== state.selectedShopId || !el["prompt-draft"].value.trim();
    setText(el["generate-prompt"], busy ? "正在生成草稿…" : "一键生成提示词草稿");
  }

  function clearPromptDraft() {
    if (assist) assist.reset();
    state.promptDraft.seq += 1;
    state.promptDraft.busy = false;
    state.promptDraft.shopId = null;
    el["prompt-brief"].value = "";
    el["prompt-draft"].value = "";
    setText(el["prompt-draft-status"], "");
    syncPromptDraft();
  }

  async function generatePromptDraft() {
    if (state.formDisabled || state.promptDraft.busy || !state.selectedShopId) return;
    const brief = el["prompt-brief"].value.trim();
    if (!brief || brief.length > 4000) {
      setText(el["prompt-draft-status"], "请用 1–4000 字说明已确认的规则；不清楚的可以写“待确认”。");
      el["prompt-brief"].focus();
      return;
    }
    if (state.model.dirty) {
      setText(el["prompt-draft-status"], "模型配置有未保存的修改，请先到“模型配置”核对并保存或重新加载。");
      return;
    }
    const epoch = state.epoch, token = state.token, shop = state.selectedShopId;
    const seq = ++state.promptDraft.seq;
    const current = function () {
      return state.epoch === epoch && state.token === token && state.selectedShopId === shop && state.promptDraft.seq === seq;
    };
    state.promptDraft.busy = true;
    syncPromptDraft();
    setText(el["prompt-draft-status"], "正在读取已保存的主模型配置…");
    try {
      const config = await request("/api/v1/admin/model", { token: token });
      if (!current()) return;
      if (!validModelConfig(config)) throw new ApiError(0, "bad_response");
      if (!config.primary.base_url || !config.primary.model) {
        setText(el["prompt-draft-status"], "请先在“模型配置”保存主模型的接口地址和名称。");
        return;
      }
      setText(el["prompt-draft-status"], "正在使用主模型 " + config.primary.model + " 生成；不会保存设置或开启回复。");
      const data = await request("/api/v1/admin/prompt-draft", {
        method: "POST", token: token, body: { shop_id: shop, brief: brief, version: config.version }
      });
      if (!current()) return;
      if (!data || data.shop_id !== shop || data.version !== config.version ||
          typeof data.draft !== "string" || !data.draft.trim() || data.draft.length > LIMITS.prompt) {
        throw new ApiError(0, "bad_response");
      }
      // Provider text is untrusted plain text, never HTML or an automatic settings update.
      el["prompt-draft"].value = data.draft;
      state.promptDraft.shopId = shop;
      setText(el["prompt-draft-status"], "草稿已生成，尚未生效。请核对材质、安装、退换等事实，编辑后再填入提示词并保存模版。");
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        handleError(err, "生成草稿失败", epoch, token);
      } else {
        const message = err.code === "model_config_changed" ? "模型配置已改变，请重新生成。" :
          err.code === "prompt_draft_busy" ? "已有草稿正在生成，请稍后再试。" :
          "草稿生成失败，可能是连接异常、超时或模型未输出完整正文。现有提示词未改变，也没有切换到备用模型。";
        setText(el["prompt-draft-status"], message);
      }
    } finally {
      if (current()) {
        state.promptDraft.busy = false;
        syncPromptDraft();
      }
    }
  }

  function applyPromptDraft() {
    if (state.formDisabled || state.promptDraft.busy || state.promptDraft.shopId !== state.selectedShopId) return;
    const draft = el["prompt-draft"].value.trim();
    if (!draft || draft.length > LIMITS.prompt) {
      setText(el["prompt-draft-status"], "草稿需为 1–8000 字，请修改后再填入。");
      return;
    }
    el["prompt-input"].value = draft;
    onFormEdit();
    setText(el["prompt-draft-status"], "已填入提示词，尚未保存。请核对后点击“保存模版”；纯规则方式不使用模型提示词。");
  }

  function onFormEdit() {
    state.editor.revision += 1;
    state.editor.dirty = true;
    setText(el["template-editor-status"], "有未保存的模版修改。");
    hideRulesError();
    syncTemplateEditor();
    if (assist) assist.sync();
  }

  function onShopFormEdit() {
    state.formRevision += 1;
    state.formDirty = true;
    setText(el["save-status"], "有未保存的修改。");
    hideRulesError();
    if (assist) assist.sync();
  }

  function renderSettings(settings) {
    const s = settings && typeof settings === "object" ? settings : {};
    state.loadedSettings = s;
    state.remoteSettings = s;
    state.formVersion = settingsVersion(s);
    state.formSignature = settingsSignature(s);
    state.formDirty = false;
    state.formRevision += 1;
    state.templateId = typeof s.template_id === "string" ? s.template_id : "";
    state.templateVersion = Number.isInteger(s.template_version) ? s.template_version : null;
    syncTemplateSelect();
    el["enabled-input"].checked = s.enabled === true;
    setText(el["enabled-note"], s.enabled === true ? "服务器当前为开启。" : "服务器当前为关闭。");
    if (!state.editor.initialized) loadShopTemplateEditor(s);
    renderFallback(s.fallback);
    hideRulesError();
    showRemoteNote("");
    renderVersion(state.formVersion);
    setText(el["save-status"], "");
    if (assist) assist.sync();
  }

  function applyRemoteSettings(remote) {
    const s = remote && typeof remote === "object" ? remote : {};
    state.remoteSettings = s;
    const version = settingsVersion(s);
    if (!state.formDirty) {
      if (settingsSignature(s) === state.formSignature && state.formVersion !== null) {
        state.loadedSettings = s;
        if (version !== null) {
          state.formVersion = version;
        }
        renderVersion(state.formVersion);
        return;
      }
      renderSettings(s);
      return;
    }
    if (version !== null && state.formVersion !== null && version < state.formVersion) {
      return;
    }
    if (version !== null) {
      renderVersion(version);
    }
    if (version !== null && state.formVersion !== null && version !== state.formVersion) {
      showRemoteNote("服务器上的设置已被改动（服务器现在是第 " + String(version) + " 版，页面中打开的是第 " + String(state.formVersion) + " 版）。你的修改还保留在页面上；保存会用页面内容覆盖服务器设置。");
    }
  }

  function clearSettingsForm() {
    clearPromptDraft();
    state.loadedSettings = null;
    state.remoteSettings = null;
    state.formVersion = null;
    state.formSignature = "";
    state.formDirty = false;
    state.formRevision += 1;
    state.templateId = "";
    state.templateVersion = null;
    syncTemplateSelect();
    el["enabled-input"].checked = false;
    setText(el["enabled-note"], "服务器状态未知。");
    renderFallback({});
    hideRulesError();
    showRemoteNote("");
    renderVersion(null);
    setText(el["save-status"], "");
  }

  function setFormDisabled(disabled) {
    state.formDisabled = disabled;
    syncPromptDraft();
    if (assist) assist.sync();
    el["rules-prev"].disabled = disabled || state.rulesPage === 0;
    el["rules-next"].disabled = disabled || (state.rulesPage + 1) * 10 >= state.rules.length;
    ["enabled-input", "mode-input", "prompt-input", "save-btn", "reset-btn"].forEach(function (id) {
      byId(id).disabled = disabled;
    });
    el["add-rule-btn"].disabled = disabled || state.rules.length >= LIMITS.maxRules;
    el["fallback-controls"].querySelectorAll("input, select").forEach(function (node) { node.disabled = disabled; });
    el["rules-list"].querySelectorAll("input, select, textarea, button").forEach(function (node) {
      node.disabled = disabled;
    });
    el["rules-list"].querySelectorAll(".rule-row").forEach(function (row) {
      const sync = sendUiSync.get(row);
      if (typeof sync === "function") {
        sync();
      }
    });
    ["fallback-controls", "rules-list"].forEach(function (id) {
      el[id].querySelectorAll(".policy-unmark").forEach(function (node) {
        node.disabled = disabled;
      });
    });
    syncTemplateSelect();
    syncTemplateEditor();
  }

  function setSaveBusy(busy) {
    state.settingsBusy = busy;
    syncTemplateSelect();
    syncTemplateEditor();
  }

  function validTemplate(item) {
    return item && typeof item.template_id === "string" && /^[0-9a-f]{32}$/.test(item.template_id)
      && typeof item.name === "string" && item.name.trim().length > 0 && Array.from(item.name).length <= 80
      && Number.isInteger(item.version) && item.version > 0
      && ["rules", "model", "hybrid"].includes(item.mode)
      && typeof item.system_prompt === "string" && item.system_prompt.length <= LIMITS.prompt
      && Array.isArray(item.rules) && item.rules.length <= LIMITS.maxRules;
  }

  function rememberTemplates(items) {
    const byId = new Map(state.templates.map(function (item) { return [item.template_id, item]; }));
    (items || []).filter(validTemplate).forEach(function (item) {
      const previous = byId.get(item.template_id);
      if (!previous || item.version >= previous.version) byId.set(item.template_id, item);
    });
    state.templates = Array.from(byId.values()).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function syncTemplateSelect() {
    const select = el["template-select"];
    const signature = JSON.stringify([state.templates.map(function (item) { return [item.template_id, item.name]; }), state.templateId]);
    if (select.dataset.signature !== signature) {
      const own = document.createElement("option");
      own.value = ""; own.textContent = "保留本店现有话术";
      select.replaceChildren(own);
      state.templates.forEach(function (item) {
        const option = document.createElement("option");
        option.value = item.template_id; option.textContent = item.name; select.appendChild(option);
      });
      if (state.templateId && !state.templates.some(function (item) { return item.template_id === state.templateId; })) {
        const option = document.createElement("option");
        option.value = state.templateId; option.textContent = "当前模版（待刷新）"; select.appendChild(option);
      }
      select.dataset.signature = signature;
    }
    select.value = state.templateId;
    const busy = state.settingsBusy || state.templateBusy;
    select.disabled = state.formDisabled || busy;
    el["template-create"].disabled = state.formDisabled || busy;
    setText(el["template-create"], state.templateId ? "编辑所选模版" : "编辑本店现有话术");
    el["save-btn"].disabled = state.formDisabled || busy;
    setText(el["save-btn"], state.settingsBusy ? "保存中…" : "保存店铺配置");
    setText(el["template-status"], state.templateId
      ? "保存后使用所选模版；各店开关、处理不了时怎么办和商品知识保持独立。"
      : "本店原有话术继续保留。可点“编辑本店现有话术”到模版页另存，再回来选用。");
  }

  function onTemplateChange() {
    const id = el["template-select"].value;
    if (state.formDisabled || state.settingsBusy || state.templateBusy || id === state.templateId) return;
    const template = state.templates.find(function (item) { return item.template_id === id; });
    if (id && !template) { el["template-select"].value = state.templateId; return; }
    state.templateId = id;
    state.templateVersion = template ? template.version : null;
    onShopFormEdit();
    syncTemplateSelect();
    setText(el["save-status"], "尚未保存，点“保存店铺配置”后生效。");
  }

  function syncTemplateEditor() {
    const select = el["template-editor-select"], editor = state.editor;
    const signature = JSON.stringify(state.templates.map(function (item) { return [item.template_id, item.name, item.version]; }));
    if (select.dataset.signature !== signature) {
      const option = document.createElement("option"); option.value = ""; option.textContent = "新模版（未保存）";
      select.replaceChildren(option);
      state.templates.forEach(function (item) {
        const row = document.createElement("option"); row.value = item.template_id; row.textContent = item.name; select.appendChild(row);
      });
      select.dataset.signature = signature;
    }
    select.value = editor.id;
    const disabled = state.formDisabled || state.settingsBusy || state.templateBusy;
    ["template-editor-select", "template-name", "template-new", "template-save", "template-save-as", "template-reset"].forEach(function (id) {
      el[id].disabled = disabled;
    });
    setText(el["template-save"], state.templateBusy ? "保存中…" : "保存模版");
    el["template-editor-version"].hidden = !editor.id;
    setText(el["template-editor-version"], editor.id ? "第 " + editor.version + " 版" : "");
    setText(el["template-mode-summary"], " · " + ({rules: "按规则", model: "模型判断", hybrid: "混合判断"}[el["mode-input"].value] || "未选择"));
    setText(el["template-prompt-summary"], " · " + Array.from(el["prompt-input"].value).length + "字");
    setText(el["template-rules-summary"], " · " + state.rules.length + "条");
    const count = state.shops.filter(function (shop) { return shop.settings && shop.settings.template_id === editor.id && editor.id; }).length;
    setText(el["template-source-note"], editor.id
      ? "已供 " + count + " 家店铺选用。保存会同步这些店铺的话术，各店开关、兜底处理和商品资料不变。"
      : "还未存为模版。保存后可在“店铺配置”里选择使用；本店已有话术不会自动改变。");
  }

  function loadTemplateEditor(data) {
    clearPromptDraft();
    const snapshot = {
      template_id: data.template_id || "", version: data.template_id ? data.version : null,
      name: data.name || "", mode: data.mode || "hybrid", system_prompt: data.system_prompt || "",
      rules: JSON.parse(JSON.stringify(data.rules || []))
    };
    Object.assign(state.editor, {id: snapshot.template_id, version: snapshot.version, initialized: true,
      dirty: false, revision: state.editor.revision + 1, snapshot: snapshot});
    el["template-name"].value = snapshot.name;
    el["mode-input"].value = snapshot.mode;
    el["prompt-input"].value = snapshot.system_prompt;
    loadRules(snapshot.rules);
    ["template-mode-section", "template-prompt-section", "template-rules-section"].forEach(function (id) {
      const panel = byId(id); if (panel) panel.open = false;
    });
    hideRulesError();
    setText(el["template-editor-status"], "");
    syncTemplateEditor();
    if (assist) assist.sync();
  }

  function loadShopTemplateEditor(settings) {
    const template = state.templates.find(function (item) { return item.template_id === state.templateId; });
    const shop = currentShop(), source = settings || (shop && shop.settings) || {};
    loadTemplateEditor(template || {name: shop ? shopName(shop) + "话术" : "", mode: source.mode,
      system_prompt: source.system_prompt, rules: source.rules});
  }

  function openShopTemplate() {
    if (state.templateBusy || state.settingsBusy) return;
    if (state.editor.dirty && !window.confirm("模版有未保存的修改。放弃这些修改，打开本店话术吗？")) return;
    loadShopTemplateEditor();
    navigateTo("templates");
  }

  function newTemplate() {
    if (state.templateBusy || state.settingsBusy) return;
    if (state.editor.dirty && !window.confirm("放弃当前未保存的模版修改，创建新模版吗？")) return;
    loadTemplateEditor({name: "", mode: "hybrid", system_prompt: "", rules: []});
  }

  function onEditorTemplateChange() {
    const id = el["template-editor-select"].value;
    if (state.templateBusy || state.settingsBusy || id === state.editor.id) return;
    if (state.editor.dirty && !window.confirm("模版有未保存的修改。放弃后切换吗？")) {
      el["template-editor-select"].value = state.editor.id; return;
    }
    const template = state.templates.find(function (item) { return item.template_id === id; });
    if (id && !template) { el["template-editor-select"].value = state.editor.id; return; }
    loadTemplateEditor(template || {name: "", mode: "hybrid", system_prompt: "", rules: []});
  }

  function resetTemplateEditor() {
    if (state.templateBusy || state.settingsBusy) return;
    if (state.editor.dirty && !window.confirm("放弃模版中尚未保存的修改吗？")) return;
    const template = state.templates.find(function (item) { return item.template_id === state.editor.id; });
    loadTemplateEditor(template || state.editor.snapshot || {name: "", mode: "hybrid", system_prompt: "", rules: []});
  }

  function applyTemplatesSnapshot(items) {
    rememberTemplates(items);
    const template = state.templates.find(function (item) { return item.template_id === state.editor.id; });
    if (template && template.version > state.editor.version && !state.templateBusy) {
      if (!state.editor.dirty) loadTemplateEditor(template);
      else setText(el["template-editor-status"], "模版已有更新。当前草稿保留，请撤销修改载入最新版本后再编辑保存。");
    }
    syncTemplateEditor();
  }

  async function saveTemplate(asCopy) {
    if (state.formDisabled || !state.token || state.settingsBusy || state.templateBusy) return;
    const checked = collectRules();
    if (!checked.ok) { showRulesError(checked.message, checked.uid, checked.field); return; }
    const prompt = el["prompt-input"].value;
    if (prompt.length > LIMITS.prompt) { setText(el["template-editor-status"], "提示词最多8000字。"); return; }
    let name = el["template-name"].value.trim();
    if (asCopy) {
      const input = window.prompt("另存为新的模版名称（最多80字）：", name + "副本");
      if (input === null) return;
      name = input.trim();
    }
    if (!name || Array.from(name).length > 80) { setText(el["template-editor-status"], "模版名称请填写1–80字。"); return; }
    const id = state.editor.id, revision = state.editor.revision, epoch = state.epoch, token = state.token;
    const creating = asCopy || !id;
    const payload = {name: name, mode: el["mode-input"].value, system_prompt: prompt, rules: checked.value};
    if (!creating) payload.version = state.editor.version;
    state.templateBusy = true;
    syncTemplateSelect(); syncTemplateEditor();
    setText(el["template-editor-status"], "正在保存模版…");
    try {
      const data = await request("/api/v1/admin/reply-templates" + (creating ? "" : "/" + encodeURIComponent(id)), {
        method: creating ? "POST" : "PUT", token: token, body: payload
      });
      if (isStale(epoch) || state.token !== token) return;
      if (!validTemplate(data) || (!creating && data.template_id !== id)) throw new ApiError(0, "bad_response");
      rememberTemplates([data]);
      if (state.editor.id === id && state.editor.revision === revision) {
        loadTemplateEditor(data);
        setText(el["template-editor-status"], creating ? "模版已保存，请到“店铺配置”选择使用。" : "模版已保存，已选用的店铺已同步话术。");
      } else if (state.editor.id === id) {
        Object.assign(state.editor, {id: data.template_id, version: data.version, snapshot: JSON.parse(JSON.stringify(data))});
        el["template-name"].value = data.name;
        setText(el["template-editor-status"], "提交时的模版已保存，之后的编辑仍保留，尚未保存。");
      }
      syncTemplateSelect();
      void fetchShops(epoch, {});
    } catch (err) {
      if (isStale(epoch) || state.token !== token) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        handleError(err, "保存模版失败", epoch, token); return;
      }
      const message = err.code === "template_name_exists" ? "已有同名模版，请换个名称。" :
        err.code === "template_changed" ? "模版已有更新。当前草稿保留，请撤销修改载入最新版本后再编辑保存。" :
        "保存结果未确认，请刷新模版列表核对；当前内容仍保留。";
      setText(el["template-editor-status"], message);
      if (err.code === "template_changed") void fetchShops(epoch, {});
    } finally {
      if (!isStale(epoch) && state.token === token) {
        state.templateBusy = false; syncTemplateSelect(); syncTemplateEditor();
      }
    }
  }


  function clearModelDisplay() {
    state.model.testSeq += 1;
    state.model.loaded = false;
    state.model.dirty = false;
    state.model.busy = false;
    state.model.config = null;
    state.model.tests = newModelTestState();
    MODEL_SLOTS.forEach(function (slot) {
      el[modelFieldId(slot, "base-url")].value = "";
      el[modelFieldId(slot, "model")].value = "";
      el[modelFieldId(slot, "timeout")].value = "20";
      el[modelFieldId(slot, "key")].value = "";
      el[modelFieldId(slot, "clear-key")].checked = false;
      el[modelFieldId(slot, "key-status")].className = "badge badge-muted";
      setText(el[modelFieldId(slot, "key-status")], "未加载");
      el[modelFieldId(slot, "test-status")].className = "small muted";
      setText(el[modelFieldId(slot, "test-status")], "");
      el[modelFieldId(slot, "test-btn")].disabled = true;
      setText(el[modelFieldId(slot, "test-btn")], "测试连接");
    });
    el["model-save-btn"].disabled = true;
    setText(el["model-save-btn"], "保存配置");
    el["model-reload-btn"].disabled = false;
    el["model-version"].hidden = true;
    setText(el["model-version"], "");
    setText(el["model-status"], "");
    el["model-note"].hidden = true;
    setText(el["model-note"], "");
    showModelError("");
  }

  function clearAllVisibleData() {
    clearHandoff();
    state.shops = [];
    state.templates = [];
    state.templateBusy = false;
    state.editor = { id: "", version: null, initialized: false, dirty: false, revision: state.editor.revision + 1, snapshot: null };
    state.settingsBusy = false;
    state.selectedShopId = null;
    state.loadedSettings = null;
    state.remoteSettings = null;
    state.formVersion = null;
    state.formSignature = "";
    state.formDirty = false;
    state.events = [];
    state.maintenance = null;
    state.healthCounts = null;
    renderHealthAlert(false);
    state.requestSeq += 1;
    state.shopStatus = "unknown";
    state.shopError = "";
    state.shopUpdatedAt = null;
    renderDecisionRuntime();

    el["dashboard"].hidden = true;
    el["login-view"].hidden = false;
    el["login-panel"].hidden = false;
    el["account-panel"].close();
    closeVerifyDialog(true);
    el["login-panel"].hidden = false;
    el["admin-badge"].hidden = true;
    el["logout-btn"].hidden = true;
    el["shop-select"].replaceChildren();
    delete el["shop-select"].dataset.signature;
    el["events-body"].replaceChildren();
    el["shop-select"].value = "";
    setText(el["shop-meta"], "尚未加载店铺。");
    setText(el["summary-meta"], "");
    setText(el["account-meta"], "");
    setText(el["system-user"], "–");
    setText(el["system-session"], "–");
    setText(el["system-role"], "管理员");
    setText(el["system-connection"], "未检查");
    setText(el["system-checked"], "–");
    setText(el["system-shop-state"], "未加载");
    [ "pending", "processing", "ready", "sent", "unknown" ].forEach(function (key) {
      setText(byId("count-" + key), "–");
    });
    clearLeaseDisplay();
    clearSettingsForm();
    loadTemplateEditor({name: "", mode: "hybrid", system_prompt: "", rules: []});
    state.editor.initialized = false;
    clearModelDisplay();
    setFormDisabled(true);
    setChangeBusy(false);
    clearChangePasswordForm();
    setText(el["events-meta"], "尚未加载事件。");
    setText(el["events-empty"], EMPTY_EVENTS_TEXT);
    el["events-empty"].hidden = true;
    el["shop-connection-list"].replaceChildren();
    const placeholder = document.createElement("p");
    placeholder.className = "empty-state small";
    setText(placeholder, "登录后显示店铺连接状态。");
    el["shop-connection-list"].appendChild(placeholder);
    setText(el["shop-connection-summary"], "尚未加载店铺");
    el["shop-connection-summary"].className = "pill pill-muted";
    setText(el["shop-connection-meta"], "尚未加载店铺。");
    el["topbar-shop-status"].className = "status-dot status-unknown";
    setText(el["topbar-shop-status"], "状态未确认");
    closeMobileNav();
    showAlert("");
  }

  function resetNavigation() {
    state.route = "dashboard";
    applyRoute("dashboard", { refreshSystem: false, scroll: false });
    try {
      const base = window.location.pathname + window.location.search;
      window.history.replaceState(null, "", base);
    } catch (err) {
      /* ignore */
    }
  }

  function endSession(message, options) {
    const opts = options || {};
    const lastUser = state.username;
    state.epoch += 1;
    clearTimer();
    stopShopPolling();
    state.token = null;
    if (productLearning) productLearning.reset();
    state.me = null;
    state.username = null;
    state.expiresAt = null;
    el["auto-refresh"].checked = false;
    setSaveBusy(false);
    clearAllVisibleData();
    resetNavigation();
    setChangeBusy(false);
    clearChangePasswordForm();
    el["password-input"].value = "";
    el["username-input"].value = lastUser || "admin";
    el["logout-btn"].disabled = false;
    el["settings-logout-btn"].disabled = false;
    setText(el["logout-btn"], "退出登录");
    setLoginBusy(false);
    showLoginError("");
    showLoginNotice(message || "", opts.kind || "info");
    if (opts.focus !== false) {
      if (opts.focusPassword) {
        el["password-input"].focus();
      } else {
        el["username-input"].focus();
      }
    }
  }

  function handleError(err, context, epoch, token) {
    if (isStale(epoch)) {
      return;
    }
    if (typeof token === "string" && state.token !== null && token !== state.token) {
      return;
    }
    if (err instanceof ApiError && err.status === 401) {
      endSession("登录已过期或被撤销，请重新登录。", { kind: "warn", focusPassword: true });
      return;
    }
    if (err instanceof ApiError && err.code === "admin_password_change_required") {
      state.me.must_change_password = true;
      clearTimer();
      stopShopPolling();
      el["dashboard"].hidden = true;
      openAccountDialog();
      return;
    }
    if (err instanceof ApiError && err.status === 403) {
      showAlert(context + "：当前登录没有权限执行此操作（需要管理员角色）。" + errorText(err), "error");
      return;
    }
    showAlert(context + "：" + errorText(err), "error");
  }

  /* ---------- 登录 ---------- */

  function loginErrorMessage(err) {
    const codeSuffix = function (code) {
      return code ? "（" + code + "）" : "";
    };
    if (err instanceof ApiError) {
      if (err.code === "invalid_credentials") {
        return "用户名或密码不正确。" + codeSuffix(err.code);
      }
      if (err.code === "login_rate_limited") {
        return "登录尝试过于频繁，请稍后再试。" + codeSuffix(err.code);
      }
      if (err.code === "invalid_login") {
        return "登录请求不完整或格式不正确。" + codeSuffix(err.code);
      }
      if (err.code === "network_error" || err.code === "bad_response") {
        return err.message;
      }
      if (err.status === 401) {
        return "用户名或密码不正确。" + codeSuffix(err.code);
      }
      if (err.status === 429) {
        return "登录尝试过于频繁，请稍后再试。" + codeSuffix(err.code);
      }
      if (err.status === 400) {
        return "登录请求不完整或格式不正确。" + codeSuffix(err.code);
      }
      return "登录失败：" + errorText(err);
    }
    return "登录失败：发生未知错误，请重试。";
  }

  async function acceptAdminSession(data, username, epoch) {
    state.token = data.session_token;
    state.username = typeof data.username === "string" && data.username ? data.username : username;
    const expires = Number(data.expires_at);
    state.expiresAt = Number.isFinite(expires) && expires > 0 ? expires : null;
    state.me = {
      role: data.role,
      username: state.username,
      protocol_version: data.protocol_version,
      must_change_password: data.must_change_password === true
    };
    state.formDirty = false;
    state.model.loaded = false;
    state.model.dirty = false;
    el["password-input"].value = "";
    el["login-view"].hidden = true;
    el["login-panel"].hidden = false;
    el["dashboard"].hidden = passwordChangeRequired();
    el["admin-badge"].hidden = false;
    setText(el["admin-badge"], "管理员：" + state.username);
    el["logout-btn"].hidden = false;
    el["logout-btn"].disabled = false;
    setText(el["logout-btn"], "退出登录");
    clearChangePasswordForm();
    setChangeBusy(false);
    renderAccountMeta();
    setSaveBusy(false);
    setFormDisabled(true);
    if (passwordChangeRequired()) {
      openAccountDialog();
      return;
    }
    applyRoute(routeFromHash(), { refreshSystem: false, scroll: false });
    startShopPolling(epoch);

    if (data.protocol_version && data.protocol_version !== PROTOCOL_VERSION) {
      showAlert("服务端协议版本为 " + String(data.protocol_version) + "，本页面按 " + PROTOCOL_VERSION + " 构建，字段可能不兼容。", "warn");
    }
    await loadDashboard(epoch);
  }

  async function login(username, password) {
    state.epoch += 1;
    const epoch = state.epoch;
    setLoginBusy(true);
    showLoginError("");
    showLoginNotice("");
    showAlert("");
    try {
      const data = await request("/api/v1/admin/login", {
        method: "POST",
        body: { username: username, password: password },
        token: null
      });
      if (isStale(epoch)) {
        return;
      }
      if (!data || typeof data !== "object") {
        throw new ApiError(0, "bad_response", "登录响应格式异常。");
      }
      if (data.role !== "admin") {
        showLoginError("服务器返回的角色不是管理员，已拒绝进入后台。");
        return;
      }
      if (typeof data.session_token !== "string" || !data.session_token) {
        showLoginError("服务器没有返回有效的登录会话，请重试。");
        return;
      }
      await acceptAdminSession(data, username, epoch);
    } catch (err) {
      if (isStale(epoch)) {
        return;
      }
      state.token = null;
      state.me = null;
      state.username = null;
      state.expiresAt = null;
      el["dashboard"].hidden = true;
      el["login-view"].hidden = false;
      el["login-panel"].hidden = false;
      el["admin-badge"].hidden = true;
      el["logout-btn"].hidden = true;
      el["password-input"].value = "";
      el["username-input"].value = username || "admin";
      showLoginError(loginErrorMessage(err));
    } finally {
      if (!isStale(epoch)) {
        setLoginBusy(false);
      }
    }
  }

  /* ---------- 本机快捷登录 ---------- */

  function localHandoffOrigin() {
    return ["http:", "https:"].includes(window.location.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);
  }

  function takeHandoffTicket() {
    const hash = window.location.hash;
    if (!hash.startsWith("#handoff=")) return { present: false, ticket: null };
    // Clear the secret before any network call. If this fails, do not redeem.
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (_) {
      return { present: true, ticket: null };
    }
    const match = /^#handoff=([A-Za-z0-9_-]{43})$/.exec(hash);
    return { present: true, ticket: match ? match[1] : null };
  }

  async function redeemHandoff(ticket) {
    if (!ticket || !localHandoffOrigin()) {
      showLoginError("快捷登录链接无效，请使用管理员密码登录。");
      return;
    }
    state.epoch += 1;
    const epoch = state.epoch;
    setLoginBusy(true);
    try {
      const data = await request("/api/v1/admin/handoff/redeem", {
        method: "POST", body: { ticket: ticket }, token: null, redirect: "error"
      });
      ticket = null;
      if (isStale(epoch)) return;
      if (!data || data.protocol_version !== PROTOCOL_VERSION || data.role !== "admin"
          || data.username !== "admin" || data.must_change_password !== false
          || typeof data.session_token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.session_token)
          || typeof data.expires_at !== "number" || !Number.isFinite(data.expires_at)
          || data.expires_at * 1000 <= Date.now()) {
        throw new ApiError(0, "bad_response", "");
      }
      await acceptAdminSession(data, "admin", epoch);
    } catch (err) {
      if (!isStale(epoch)) {
        endSession("快捷登录未完成，请使用管理员密码登录。", { kind: "warn" });
        if (err instanceof ApiError && err.status === 404) {
          showLoginNotice("此后台尚不支持快捷登录，请使用管理员密码登录。", "info");
        }
      }
    } finally {
      ticket = null;
      if (!isStale(epoch)) setLoginBusy(false);
    }
  }

  function hideHandoffCode() {
    el["handoff-code"].value = "";
    el["handoff-secret"].hidden = true;
  }

  function clearHandoff() {
    state.handoff.seq += 1;
    state.handoff.busy = false;
    hideHandoffCode();
    setText(el["handoff-status"], "");
    el["handoff-grants"].replaceChildren();
    el["handoff-create"].disabled = false;
    el["handoff-refresh"].disabled = false;
  }

  function handoffError(err) {
    if (err instanceof ApiError) {
      if (err.code === "handoff_grant_limit") return "授权已达上限，请先撤销不用的授权。";
      if (err.code === "local_only") return "请从本机地址打开后台设置授权。";
      if (err.status === 404) return "此后台尚不支持本机授权。";
    }
    // Do not surface arbitrary backend error codes, bodies or credential values.
    return "操作结果未确认，请刷新授权列表核对，不要重复生成。";
  }

  function validGrant(item) {
    return item && typeof item.grant_id === "string" && /^[0-9a-f]{32}$/.test(item.grant_id)
      && typeof item.created_at === "number" && Number.isFinite(item.created_at) && item.created_at > 0;
  }

  function renderHandoffGrants(grants) {
    const list = el["handoff-grants"];
    list.replaceChildren();
    if (!grants.length) {
      setText(list, "尚无本机授权。");
      return;
    }
    grants.forEach(function (grant) {
      const row = document.createElement("p");
      row.className = "form-actions";
      const label = document.createElement("span");
      setText(label, "授权 " + grant.grant_id.slice(0, 8) + " · " + formatTime(grant.created_at));
      const revoke = document.createElement("button");
      revoke.className = "btn btn-ghost btn-sm";
      revoke.type = "button";
      setText(revoke, "撤销");
      revoke.addEventListener("click", function () {
        if (window.confirm("撤销此本机授权？该客户端以后打开后台将需要重新授权；已打开的后台会话仍有效。")) {
          manageHandoff("revoke", grant.grant_id);
        }
      });
      row.appendChild(label);
      row.appendChild(revoke);
      list.appendChild(row);
    });
  }

  async function manageHandoff(action, grantId) {
    if (!state.token || passwordChangeRequired() || !localHandoffOrigin()
        || state.route !== "system" || state.handoff.busy) return;
    const epoch = state.epoch;
    const seq = ++state.handoff.seq;
    const current = function () { return !isStale(epoch) && seq === state.handoff.seq; };
    state.handoff.busy = true;
    el["handoff-create"].disabled = true;
    el["handoff-refresh"].disabled = true;
    setText(el["handoff-status"], "正在处理…");
    if (action !== "list") hideHandoffCode();
    try {
      const base = "/api/v1/admin/handoff/grants";
      if (action === "create") {
        const data = await request(base, { method: "POST", body: {}, redirect: "error" });
        if (!current()) return;
        if (!validGrant(data) || data.protocol_version !== PROTOCOL_VERSION
            || typeof data.grant_token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.grant_token)) {
          throw new ApiError(0, "bad_response", "");
        }
        el["handoff-code"].value = data.grant_token;
        el["handoff-secret"].hidden = false;
      } else if (action === "revoke") {
        const data = await request(base + "/" + grantId, { method: "DELETE", redirect: "error" });
        if (!current()) return;
        if (!data || data.ok !== true || data.protocol_version !== PROTOCOL_VERSION) {
          throw new ApiError(0, "bad_response", "");
        }
      }
      const data = await request(base, { redirect: "error" });
      if (!current()) return;
      if (!data || data.protocol_version !== PROTOCOL_VERSION || !Array.isArray(data.grants)
          || data.grants.length > 8 || !data.grants.every(validGrant)
          || new Set(data.grants.map(function (g) { return g.grant_id; })).size !== data.grants.length) {
        throw new ApiError(0, "bad_response", "");
      }
      renderHandoffGrants(data.grants);
      setText(el["handoff-status"], action === "create" ? "授权码已生成，请保存到本机客户端。"
        : action === "revoke" ? "授权已撤销。" : "授权列表已刷新。");
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiError && err.status === 401) {
        endSession("登录已失效，请重新登录。", { kind: "warn" });
      } else {
        setText(el["handoff-status"], handoffError(err));
      }
    } finally {
      if (current()) {
        state.handoff.busy = false;
        el["handoff-create"].disabled = false;
        el["handoff-refresh"].disabled = false;
      }
    }
  }

  function loadHandoffGrants() {
    return manageHandoff("list");
  }

  /* ---------- 修改密码 ---------- */

  function passwordLength(value) {
    return Array.from(value).length;
  }

  function passwordChangeErrorMessage(err) {
    switch (err.code) {
      case "password_mismatch":
        return "两次输入的新密码不一致。";
      case "invalid_new_password":
        return "新密码不符合要求：需为 8-128 个字符，且不能与当前密码相同。";
      case "password_unchanged":
        return "新密码不能与当前密码相同。";
      case "invalid_password_request":
        return "修改密码请求不完整或格式不正确。";
      default:
        return "修改密码失败：" + errorText(err);
    }
  }

  async function changePassword(event) {
    if (event) {
      event.preventDefault();
    }
    const current = el["current-password-input"].value;
    const next = el["new-password-input"].value;
    const confirm = el["confirm-password-input"].value;
    hideChangePasswordError();
    setText(el["change-password-status"], "");

    if (!current) {
      showChangePasswordError("请输入当前密码。");
      el["current-password-input"].focus();
      return;
    }
    if (!next) {
      showChangePasswordError("请输入新密码。");
      el["new-password-input"].focus();
      return;
    }
    const length = passwordLength(next);
    if (length < 8 || length > 128) {
      showChangePasswordError("新密码需为 8-128 个字符（当前 " + length + " 个字符）。");
      el["new-password-input"].focus();
      return;
    }
    if (next === current) {
      showChangePasswordError("新密码不能与当前密码相同。");
      el["new-password-input"].focus();
      return;
    }
    if (next !== confirm) {
      showChangePasswordError("两次输入的新密码不一致。");
      el["confirm-password-input"].focus();
      return;
    }
    if (!state.token) {
      endSession("登录已失效，请重新登录。", { kind: "warn" });
      return;
    }

    const epoch = state.epoch;
    const token = state.token;
    setChangeBusy(true);
    setText(el["change-password-status"], "正在修改密码…");
    try {
      const data = await request("/api/v1/admin/password", {
        method: "POST",
        body: {
          current_password: current,
          new_password: next,
          confirm_password: confirm
        },
        token: token
      });
      if (isStale(epoch)) {
        return;
      }
      if (!data || data.ok !== true || data.reauthenticate !== true) {
        throw new ApiError(0, "bad_response", "服务器没有确认密码修改。");
      }
      const lastUser = state.username;
      endSession("密码修改成功，所有管理员会话已撤销，请使用新密码重新登录。", {
        kind: "ok",
        focusPassword: true
      });
      el["username-input"].value = lastUser || "admin";
    } catch (err) {
      if (isStale(epoch)) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "修改密码失败", epoch, token);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        const codeSuffix = err.code ? "（" + err.code + "）" : "";
        showChangePasswordError("当前密码不正确，请重新输入。" + codeSuffix);
        setText(el["change-password-status"], "");
        el["current-password-input"].focus();
        el["current-password-input"].select();
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        showChangePasswordError(passwordChangeErrorMessage(err));
        setText(el["change-password-status"], "");
        return;
      }
      if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500 ||
          err.code === "read_error" || err.code === "bad_response") {
        showChangePasswordError("密码修改结果未确认。请刷新页面并用新密码重新登录核实，不要直接重复提交。");
        setText(el["change-password-status"], "修改结果未确认。");
        return;
      }
      showChangePasswordError("修改密码失败：" + errorText(err));
      setText(el["change-password-status"], "修改失败。");
    } finally {
      if (!isStale(epoch)) {
        setChangeBusy(false);
      }
    }
  }

  /* ---------- 退出登录 ---------- */

  async function logout() {
    clearHandoff();
    const epoch = state.epoch;
    const token = state.token;
    if (!token) {
      endSession("当前没有登录会话。", { kind: "info" });
      return;
    }
    el["logout-btn"].disabled = true;
    el["settings-logout-btn"].disabled = true;
    setText(el["logout-btn"], "退出中…");
    let confirmed = false;
    let failure = null;
    try {
      const data = await request("/api/v1/admin/logout", {
        method: "POST",
        body: {},
        token: token
      });
      if (isStale(epoch)) {
        return;
      }
      if (data && data.ok === true) {
        confirmed = true;
      } else {
        failure = new ApiError(0, "bad_response", "服务器没有确认退出。");
      }
    } catch (err) {
      if (isStale(epoch)) {
        return;
      }
      failure = err;
    }

    el["logout-btn"].disabled = false;
    el["settings-logout-btn"].disabled = false;
    setText(el["logout-btn"], "退出登录");

    if (confirmed) {
      endSession("已退出登录，服务器会话已撤销。", { kind: "ok" });
      return;
    }
    if (failure instanceof ApiError && failure.status === 401) {
      endSession("登录已失效，本地登录状态已清除。", { kind: "info" });
      return;
    }
    let reason = "未知错误";
    if (failure instanceof ApiError) {
      reason = failure.code === "network_error" ? "网络请求失败" : errorText(failure);
    }
    endSession("本地登录状态已清除，但未能确认服务器会话已撤销（" + reason + "）。如需确保安全，请重新登录后修改密码。", {
      kind: "warn"
    });
  }

  /* ---------- 店铺 / 概览 ---------- */

  function currentShop() {
    return state.shops.find(function (shop) {
      return shop && shop.shop_id === state.selectedShopId;
    }) || null;
  }

  function syncShopSelect() {
    const select = el["shop-select"];
    const signature = state.shops.map(function (shop) {
      return shop.shop_id + "|" + (typeof shop.name === "string" ? shop.name : "");
    }).join("\u0001");
    if (select.dataset.signature !== signature) {
      select.replaceChildren();
      state.shops.forEach(function (shop) {
        const option = document.createElement("option");
        option.value = shop.shop_id;
        option.textContent = shopName(shop) + "（" + shop.shop_id + "）";
        select.appendChild(option);
      });
      select.dataset.signature = signature;
    }
    select.value = state.selectedShopId || "";
  }

  function renderShopHeader() {
    renderDecisionRuntime();
    if (productLearning) productLearning.refresh();
    const shop = currentShop();
    if (!shop) {
      setText(el["shop-meta"], "未选择店铺。");
      return;
    }
    setText(el["shop-meta"], "当前店铺：" + shopName(shop) + " · 店铺编号 " + textOrDash(shop.shop_id));
  }

  function applyShopsSnapshot(shops, options) {
    const opts = options || {};
    if (Array.isArray(opts.templates)) applyTemplatesSnapshot(opts.templates);
    const previousShopId = state.selectedShopId;
    state.shops = (Array.isArray(shops) ? shops : []).filter(function (shop) {
      return shop && typeof shop.shop_id === "string" && shop.shop_id;
    });

    if (state.shops.length === 0) {
      state.selectedShopId = null;
      syncShopSelect();
      setText(el["shop-meta"], "服务端没有返回店铺。请先在后台配置店铺。");
      clearLeaseDisplay();
      if (!state.formDirty) {
        clearSettingsForm();
        setFormDisabled(true);
      }
      renderShopConnections();
      return false;
    }

    const exists = state.shops.some(function (shop) {
      return shop.shop_id === state.selectedShopId;
    });
    if (!exists) {
      state.selectedShopId = state.shops[0].shop_id;
    }
    if (state.selectedShopId !== previousShopId || opts.resetForm === true) {
      clearPromptDraft();
      state.formDirty = false;
    }
    syncShopSelect();
    setFormDisabled(false);
    renderShopHeader();
    const shop = currentShop();
    renderLease(shop ? shop.lease : null);
    applyRemoteSettings(shop ? shop.settings : null);
    syncTemplateSelect();
    syncTemplateEditor();
    renderShopConnections();
    return true;
  }

  async function loadDashboard(epoch) {
    if (isStale(epoch)) {
      return;
    }
    setText(el["summary-meta"], "正在加载…");
    setText(el["events-meta"], "正在加载概览与店铺…");
    try {
      const results = await Promise.all([
        request("/api/v1/admin/summary"),
        request("/api/v1/admin/shops")
      ]);
      if (isStale(epoch)) {
        return;
      }
      const summary = results[0];
      const shopsData = results[1];
      if (summary && summary.protocol_version && summary.protocol_version !== PROTOCOL_VERSION) {
        showAlert("服务端协议版本为 " + String(summary.protocol_version) + "，与页面 " + PROTOCOL_VERSION + " 不一致。", "warn");
      }
      applyHealthSummary(summary);
      const shops = shopsData && Array.isArray(shopsData.shops) ? shopsData.shops : [];
      state.shopStatus = "ok";
      state.shopError = "";
      state.shopUpdatedAt = new Date();
      setText(el["system-connection"], "正常");
      setText(el["system-checked"], formatTime(Math.floor(Date.now() / 1000)));
      const hasShops = applyShopsSnapshot(shops, { resetForm: true, templates: shopsData && shopsData.templates });
      if (!hasShops) {
        renderEvents([]);
        setText(el["events-meta"], "没有可查询的店铺，事件列表为空。");
        el["events-empty"].hidden = false;
        setText(el["events-empty"], "尚未配置店铺。配置店铺后，这里会显示该店铺的任务事件。");
        return;
      }
      await loadEvents(false, epoch);
    } catch (err) {
      if (isStale(epoch)) {
        return;
      }
      state.shopStatus = "error";
      state.shopError = errorText(err);
      renderHealthAlert(true);
      renderShopConnections();
      setText(el["summary-meta"], "加载失败");
      setText(el["system-connection"], "未确认");
      handleError(err, "加载后台数据失败", epoch, state.token);
      setText(el["events-meta"], "加载失败，未显示任何服务端数据。");
    }
  }

  function renderSummary(counts) {
    const keys = ["pending", "processing", "ready", "sent", "unknown"];
    keys.forEach(function (key) {
      const node = byId("count-" + key);
      const value = counts ? Number(counts[key]) : NaN;
      setText(node, Number.isFinite(value) ? String(value) : "–");
    });
    setText(el["summary-meta"], "更新于 " + formatClock(new Date()));
  }

  async function fetchShops(epoch, options) {
    const opts = options || {};
    if (!state.token || isStale(epoch)) {
      return false;
    }
    if (opts.background === true && document.hidden) {
      return false;
    }
    if (state.shopPollInFlight) {
      return false;
    }
    const token = state.token;
    state.shopPollInFlight = true;
    if (document.hidden && opts.background !== true) {
      state.shopPollInFlight = false;
      return false;
    }
    try {
      const results = await Promise.all([request("/api/v1/admin/shops"), request("/api/v1/admin/summary")]);
      const data = results[0];
      if (isStale(epoch) || state.token !== token) {
        return false;
      }
      const shops = data && Array.isArray(data.shops) ? data.shops : [];
      state.shopStatus = "ok";
      state.shopError = "";
      state.shopUpdatedAt = new Date();
      applyShopsSnapshot(shops, { templates: data && data.templates });
      applyHealthSummary(results[1]);
      setText(el["system-connection"], "正常");
      setText(el["system-checked"], formatTime(Math.floor(Date.now() / 1000)));
      return true;
    } catch (err) {
      if (isStale(epoch) || state.token !== token) {
        return false;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "刷新店铺状态失败", epoch, token);
        return false;
      }
      state.shopStatus = "error";
      state.shopError = errorText(err);
      renderHealthAlert(true);
      renderShopConnections();
      const shop = currentShop();
      renderLease(shop ? shop.lease : null);
      return false;
    } finally {
      if (!isStale(epoch) && state.token === token) state.shopPollInFlight = false;
    }
  }

  async function refreshShopState(epoch) {
    return fetchShops(epoch, {});
  }

  function stopShopPolling() {
    if (state.shopPollTimer !== null) {
      window.clearInterval(state.shopPollTimer);
      state.shopPollTimer = null;
    }
    state.shopPollInFlight = false;
  }

  function startShopPolling(epoch) {
    stopShopPolling();
    state.shopPollTimer = window.setInterval(function () {
      if (!state.token || isStale(epoch) || document.hidden) {
        return;
      }
      fetchShops(epoch, { background: true });
    }, SHOP_POLL_MS);
  }

  /* ---------- 模型配置 ---------- */

  const MODEL_SLOTS = ["primary", "backup"];
  const MODEL_SLOT_LABELS = { primary: "主", backup: "备用" };

  function newModelTestState() {
    return {
      primary: { busy: false, state: "idle", message: "" },
      backup: { busy: false, state: "idle", message: "" }
    };
  }

  function modelFieldId(slot, field) {
    return slot + "-" + field;
  }

  function isLocalModelHost(host) {
    const value = String(host || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") {
      return true;
    }
    if (/^(fc|fd)[0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value)) {
      return true;
    }
    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
    if (!octets) {
      return false;
    }
    const parts = octets.slice(1).map(Number);
    if (parts.some(function (part) { return part > 255; })) {
      return false;
    }
    return parts[0] === 127 || parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 169 && parts[1] === 254);
  }

  function validModelBaseUrl(value) {
    if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) {
      return false;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch (err) {
      return false;
    }
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return false;
    }
    if (parsed.protocol === "https:") {
      return true;
    }
    return parsed.protocol === "http:" && isLocalModelHost(parsed.hostname);
  }

  function normalizeModelSlot(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const timeout = Number(source.timeout_seconds);
    return {
      base_url: typeof source.base_url === "string" ? source.base_url : "",
      model: typeof source.model === "string" ? source.model : "",
      timeout_seconds: Number.isInteger(timeout) && timeout >= 1 && timeout <= 60 ? timeout : 20,
      key_configured: source.key_configured === true
    };
  }

  function validModelConfig(data) {
    if (!data || typeof data !== "object" || !Number.isInteger(data.version)) {
      return false;
    }
    return MODEL_SLOTS.every(function (slot) {
      const value = data[slot];
      return value && typeof value === "object" &&
        typeof value.base_url === "string" && typeof value.model === "string" &&
        Number.isInteger(value.timeout_seconds) && typeof value.key_configured === "boolean";
    });
  }

  function modelSlotView(slot) {
    const config = state.model.config;
    return config && config[slot] ? config[slot] : null;
  }

  function modelSlotConfigured(slot) {
    const view = modelSlotView(slot);
    return !!(view && view.base_url && view.model);
  }

  function modelSlotFormValue(slot) {
    return {
      base_url: el[modelFieldId(slot, "base-url")].value.trim(),
      model: el[modelFieldId(slot, "model")].value.trim(),
      timeout: el[modelFieldId(slot, "timeout")].value.trim(),
      api_key: el[modelFieldId(slot, "key")].value,
      clear_key: el[modelFieldId(slot, "clear-key")].checked
    };
  }

  function validateModelSlotInput(slot) {
    const value = modelSlotFormValue(slot);
    const label = MODEL_SLOT_LABELS[slot] + "模型：";
    if (!/^\d+$/.test(value.timeout) || Number(value.timeout) < 1 || Number(value.timeout) > 60) {
      return label + "超时需为 1-60 的整数秒。";
    }
    if (!value.base_url !== !value.model) {
      return label + "接口地址与模型名称需要同时填写，或都留空以停用该槽位。";
    }
    if (value.base_url && !validModelBaseUrl(value.base_url)) {
      return label + "接口地址不被接受。公共地址必须使用 HTTPS；本地 http 仅限 localhost、回环或私有 IP，且不能含账号、参数或片段。";
    }
    if (value.model && Array.from(value.model).length > LIMITS.modelName) {
      return label + "模型名称最多 " + LIMITS.modelName + " 个字符。";
    }
    if (value.api_key && (Array.from(value.api_key).length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(value.api_key) || value.api_key !== value.api_key.trim())) {
      return label + "密钥格式不被接受。";
    }
    if (value.clear_key && value.api_key) {
      return label + "勾选“清除已保存的密钥”时不要再填写新密钥。";
    }
    return "";
  }

  function renderModelNote() {
    const note = el["model-note"];
    note.hidden = false;
    const primary = modelSlotConfigured("primary");
    const backup = modelSlotConfigured("backup");
    if (!primary && !backup) {
      note.className = "model-note model-note-warn";
      setText(note, "主模型与备用模型都未配置：模型判断会直接转人工。");
      return;
    }
    note.className = "model-note";
    setText(note, "主模型" + (primary ? "已配置" : "未配置") + "，备用" + (backup ? "已配置" : "未配置") +
      "。各店铺的优先顺序和有效超时见上方运行配置；故障后仅在剩余预算内尝试另一模型，不能保证一定有时间切换。");
  }

  function renderModelTestStatus(slot) {
    const node = el[modelFieldId(slot, "test-status")];
    const test = state.model.tests[slot];
    node.className = "small " + (test.state === "ok" ? "test-status-ok" : test.state === "error" ? "test-status-error" : "muted");
    setText(node, test.message);
  }

  function renderModelSlot(slot) {
    const view = modelSlotView(slot);
    const badge = el[modelFieldId(slot, "key-status")];
    if (!view || !view.base_url || !view.model) {
      badge.className = "badge badge-muted";
      setText(badge, view && view.key_configured ? "未启用（密钥已保存）" : "未启用");
    } else if (view.key_configured) {
      badge.className = "badge badge-ok";
      setText(badge, "密钥已保存");
    } else {
      badge.className = "badge badge-warn";
      setText(badge, "无密钥（适合本地服务）");
    }
    el[modelFieldId(slot, "key")].placeholder = view && view.key_configured
      ? "已保存，留空则保留"
      : "可留空（本地服务通常不需要）";
    renderModelTestStatus(slot);
  }

  function updateModelTestButtons() {
    const anyBusy = MODEL_SLOTS.some(function (slot) { return state.model.tests[slot].busy; });
    MODEL_SLOTS.forEach(function (slot) {
      const button = el[modelFieldId(slot, "test-btn")];
      const configured = modelSlotConfigured(slot);
      const test = state.model.tests[slot];
      button.disabled = state.model.busy || !state.model.loaded || state.model.dirty || !configured || anyBusy;
      setText(button, test.busy ? "测试中…" : "测试连接");
      button.title = state.model.dirty
        ? "请先保存配置再测试"
        : configured ? "向该槽位已保存的配置发起一次真实调用" : "该槽位未配置接口地址与模型名称";
    });
  }

  function invalidateModelTests(message) {
    state.model.testSeq += 1;
    MODEL_SLOTS.forEach(function (slot) {
      state.model.tests[slot] = { busy: false, state: "idle", message: message || "" };
      renderModelTestStatus(slot);
    });
    updateModelTestButtons();
  }

  function renderModelConfig(config, options) {
    const opts = options || {};
    const source = config && typeof config === "object" ? config : {};
    const version = Number(source.version);
    state.model.config = {
      version: Number.isInteger(version) ? version : null,
      primary: normalizeModelSlot(source.primary),
      backup: normalizeModelSlot(source.backup)
    };
    state.model.loaded = true;

    if (opts.force === true || !state.model.dirty) {
      MODEL_SLOTS.forEach(function (slot) {
        const view = state.model.config[slot];
        el[modelFieldId(slot, "base-url")].value = view.base_url;
        el[modelFieldId(slot, "model")].value = view.model;
        el[modelFieldId(slot, "timeout")].value = String(view.timeout_seconds);
        el[modelFieldId(slot, "key")].value = "";
        el[modelFieldId(slot, "clear-key")].checked = false;
      });
      state.model.dirty = false;
    }

    MODEL_SLOTS.forEach(renderModelSlot);
    renderModelNote();

    if (Number.isInteger(state.model.config.version)) {
      el["model-version"].hidden = false;
      setText(el["model-version"], "服务器第 " + String(state.model.config.version) + " 版配置");
    } else {
      el["model-version"].hidden = true;
      setText(el["model-version"], "");
    }
    el["model-save-btn"].disabled = state.model.busy || !state.model.loaded;
    updateModelTestButtons();
  }

  function setModelBusy(busy) {
    state.model.busy = busy;
    el["model-save-btn"].disabled = busy || !state.model.loaded;
    setText(el["model-save-btn"], busy ? "保存中…" : "保存配置");
    el["model-reload-btn"].disabled = busy;
    MODEL_SLOTS.forEach(function (slot) {
      ["base-url", "model", "timeout", "key", "clear-key"].forEach(function (field) {
        const node = el[modelFieldId(slot, field)];
        if (node) {
          node.disabled = busy;
        }
      });
    });
    updateModelTestButtons();
  }

  function modelConfigErrorMessage(code) {
    switch (code) {
      case "invalid_model_url":
        return "接口地址不被接受：公共地址必须使用 HTTPS；本地 http 仅限 localhost、回环或私有 IP，且不能含账号、参数或片段。";
      case "invalid_model_name":
        return "模型名称不被接受，请检查长度与空格。";
      case "invalid_model_timeout":
        return "超时需要为 1-60 的整数秒。";
      case "invalid_api_key":
        return "密钥格式不被接受。";
      case "secret_storage_unavailable":
        return "系统密钥存储不可用。请检查当前用户的钥匙串或 Windows 账户；不会降级明文保存。";
      case "secret_encrypt_failed":
      case "secret_decrypt_failed":
        return "密钥无法安全保存或读取，原配置未被覆盖。换机后请重新录入密钥。";
      case "invalid_model_config":
        return "模型配置不完整或包含未知字段：接口地址与模型名称需同时填写，或都留空。";
      default:
        return "";
    }
  }

  function modelTestReason(reason) {
    if (typeof reason !== "string" || !reason) {
      return "未知原因";
    }
    if (/^http_\d{3}$/.test(reason)) {
      return "模型服务返回 HTTP " + reason.slice(5);
    }
    const map = {
      timeout: "请求超时",
      connect_error: "无法连接到模型服务",
      invalid_response: "返回内容不是有效的补全结构",
      response_too_large: "返回内容过大",
      not_configured: "该槽位未配置接口地址与模型名称",
      invalid_output: "返回内容无法解析为决策",
      secret_storage_unavailable: "系统密钥存储不可用；请检查钥匙串状态或在本机重新录入密钥",
      secret_decrypt_failed: "已保存的密钥无法读取；请在本机重新录入",
      stale_test_result: "配置已变更，结果已作废"
    };
    return map[reason] || "失败代码 " + reason;
  }

  async function loadModelConfig(options) {
    const opts = options || {};
    if (!state.token || state.model.busy) {
      return;
    }
    if (state.model.dirty && opts.force !== true) {
      setText(el["model-status"], "有未保存的修改，未自动重新加载。");
      return;
    }
    const epoch = state.epoch;
    const token = state.token;
    showModelError("");
    setText(el["model-status"], "正在加载配置…");
    setModelBusy(true);
    try {
      const data = await request("/api/v1/admin/model");
      if (isStale(epoch) || state.token !== token) {
        return;
      }
      if (!validModelConfig(data)) {
        throw new ApiError(0, "bad_response", "服务器返回的模型配置格式异常。");
      }
      renderModelConfig(data, { force: true });
      invalidateModelTests("");
      setText(el["model-status"], "已加载服务器当前配置。");
    } catch (err) {
      if (isStale(epoch) || state.token !== token) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "加载模型配置失败", epoch, token);
        return;
      }
      showModelError("加载模型配置失败：" + errorText(err));
      setText(el["model-status"], "加载失败。");
    } finally {
      if (!isStale(epoch) && state.token === token) {
        setModelBusy(false);
      }
    }
  }

  function onModelEdit() {
    state.model.dirty = true;
    setText(el["model-status"], "有未保存的修改。");
    showModelError("");
    invalidateModelTests("配置已修改，请保存后再测试。");
    updateModelTestButtons();
  }

  async function saveModelConfig(event) {
    if (event) {
      event.preventDefault();
    }
    if (!state.token || state.model.busy) {
      return;
    }
    showModelError("");
    setText(el["model-status"], "");
    for (let i = 0; i < MODEL_SLOTS.length; i += 1) {
      const slot = MODEL_SLOTS[i];
      const problem = validateModelSlotInput(slot);
      if (problem) {
        showModelError(problem);
        el[modelFieldId(slot, "base-url")].focus();
        return;
      }
    }
    if (!state.model.loaded || !state.model.config || !Number.isInteger(state.model.config.version)) {
      showModelError("还没有读取到服务器配置版本，请先点击“重新加载”。");
      return;
    }

    const payload = { version: state.model.config.version };
    MODEL_SLOTS.forEach(function (slot) {
      const value = modelSlotFormValue(slot);
      const item = {
        base_url: value.base_url,
        model: value.model,
        timeout_seconds: Number(value.timeout),
        clear_key: value.clear_key
      };
      if (value.api_key) {
        item.api_key = value.api_key;
      }
      payload[slot] = item;
    });

    const epoch = state.epoch;
    const token = state.token;
    setModelBusy(true);
    setText(el["model-status"], "正在保存…");
    try {
      const data = await request("/api/v1/admin/model", { method: "PUT", body: payload, token: token });
      if (isStale(epoch) || state.token !== token) {
        return;
      }
      if (!validModelConfig(data)) {
        throw new ApiError(0, "bad_response", "服务器没有返回保存后的模型配置。");
      }
      renderModelConfig(data, { force: true });
      invalidateModelTests("");
      setText(el["model-status"], "已保存，服务器已确认（第 " + String(data.version) + " 版配置）。");
      await fetchShops(epoch, {});
      window.setTimeout(function () {
        if (state.token === token && !isStale(epoch)) {
          fetchShops(epoch, {});
        }
      }, 350);
    } catch (err) {
      if (isStale(epoch) || state.token !== token) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "保存模型配置失败", epoch, token);
        return;
      }
      if (err instanceof ApiError && err.status === 409 && err.code === "model_config_changed") {
        invalidateModelTests("配置版本已变化，请重新加载后再测试。");
        showModelError("配置已在其他窗口被修改，请先点击“重新加载”核对后再保存。当前输入仍保留。");
        setText(el["model-status"], "保存被拒绝：配置版本已变化。");
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        const mapped = modelConfigErrorMessage(err.code);
        showModelError(mapped || "保存失败：" + errorText(err));
        setText(el["model-status"], "保存失败，页面上的输入仍保留。");
        return;
      }
      const unconfirmed = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
      if (unconfirmed) {
        showModelError("保存结果未确认，请点击“重新加载”核对服务器配置。");
        setText(el["model-status"], "保存结果未确认。");
      } else {
        showModelError("保存失败：" + errorText(err));
        setText(el["model-status"], "保存失败，页面上的输入仍保留。");
      }
    } finally {
      if (!isStale(epoch) && state.token === token) {
        setModelBusy(false);
      }
    }
  }

  async function runModelTest(slot) {
    if (!state.token || state.model.busy || state.model.dirty || !state.model.loaded) {
      return;
    }
    if (!modelSlotConfigured(slot) || !Number.isInteger(state.model.config.version)) {
      return;
    }
    const version = state.model.config.version;
    const epoch = state.epoch;
    const token = state.token;
    state.model.testSeq += 1;
    const seq = state.model.testSeq;
    state.model.tests[slot] = { busy: true, state: "idle", message: "正在向" + MODEL_SLOT_LABELS[slot] + "模型发起真实调用…" };
    renderModelTestStatus(slot);
    updateModelTestButtons();
    try {
      const data = await request("/api/v1/admin/model/test", {
        method: "POST",
        body: { slot: slot, version: version },
        token: token
      });
      if (isStale(epoch) || state.token !== token || seq !== state.model.testSeq) {
        return;
      }
      if (state.model.dirty || !state.model.config || state.model.config.version !== version) {
        invalidateModelTests("配置已变更，已丢弃过期的测试结果。");
        return;
      }
      if (!data || typeof data !== "object" || typeof data.ok !== "boolean" ||
          data.slot !== slot || data.version !== version) {
        throw new ApiError(0, "bad_response", "服务器返回的测试结果格式异常。");
      }
      if (data.ok) {
        const latency = Number(data.latency_ms);
        const shown = Number.isFinite(latency) ? "，" + Math.max(0, Math.round(latency)) + " ms" : "";
        state.model.tests[slot] = { busy: false, state: "ok",
          message: "连接成功（" + MODEL_SLOT_LABELS[slot] + shown + "）" };
      } else {
        state.model.tests[slot] = { busy: false, state: "error",
          message: "连接失败（" + MODEL_SLOT_LABELS[slot] + "）：" + modelTestReason(data.reason) + "。" };
      }
      renderModelTestStatus(slot);
    } catch (err) {
      if (isStale(epoch) || state.token !== token || seq !== state.model.testSeq) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "测试模型连接失败", epoch, token);
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        state.model.tests[slot] = { busy: false, state: "error", message: "配置已更新，请先“重新加载”再测试。" };
      } else if (err instanceof ApiError && err.status === 400) {
        state.model.tests[slot] = { busy: false, state: "error", message: "测试请求被拒绝：" + errorText(err) };
      } else {
        state.model.tests[slot] = { busy: false, state: "error", message: "测试结果未确认：" + errorText(err) };
      }
      renderModelTestStatus(slot);
    } finally {
      if (!isStale(epoch) && state.token === token && seq === state.model.testSeq) {
        state.model.tests[slot].busy = false;
        renderModelTestStatus(slot);
        updateModelTestButtons();
      }
    }
  }

  /* ---------- 系统状态 ---------- */

  async function refreshSystemStatus(explicit) {
    if (!state.token) {
      return;
    }
    const epoch = state.epoch;
    const token = state.token;
    if (explicit === true) {
      setText(el["system-connection"], "检查中…");
    }
    try {
      const summary = await request("/api/v1/admin/summary");
      if (isStale(epoch) || state.token !== token) {
        return;
      }
      const protocol = summary && summary.protocol_version ? String(summary.protocol_version) : PROTOCOL_VERSION;
      setText(el["system-connection"], "正常");
      setText(el["system-version"], protocol);
      setText(el["system-checked"], formatTime(Math.floor(Date.now() / 1000)));
      if (summary && summary.counts) {
        renderSummary(summary.counts);
      }
      if (state.shopStatus === "ok") {
        const active = state.shops.filter(function (shop) {
          return leaseActive(shop.lease);
        }).length;
        setText(el["system-shop-state"], state.shops.length + " 家 · " + active + " 家已连接后台");
      }
    } catch (err) {
      if (isStale(epoch) || state.token !== token) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "检查服务状态失败", epoch, token);
        return;
      }
      setText(el["system-connection"], "未确认");
      setText(el["system-checked"], formatClock(new Date()));
      if (explicit === true) {
        showAlert("检查服务状态失败：" + errorText(err), "warn");
      }
    }
  }

  /* ---------- 保存设置 ---------- */

  function applySavedSettingsToShops(shopId, settings) {
    state.shops.forEach(function (shop) {
      if (shop && shop.shop_id === shopId) {
        shop.settings = settings;
      }
    });
    if (state.selectedShopId === shopId) {
      state.loadedSettings = settings;
      state.remoteSettings = settings;
    }
  }

  async function saveSettings(event) {
    if (event) {
      event.preventDefault();
    }
    if (state.settingsBusy || state.templateBusy) return;
    const shop = currentShop();
    if (!shop) {
      showAlert("保存失败：还没有选择店铺。", "error");
      return;
    }
    const shared = state.templateId
      ? state.templates.find(function (item) { return item.template_id === state.templateId; })
      : state.remoteSettings || state.loadedSettings || shop.settings;
    if (!shared || !Array.isArray(shared.rules) || typeof shared.system_prompt !== "string") {
      setText(el["save-status"], "话术内容还未加载完整，请刷新后再保存。"); return;
    }
    const payload = {
      enabled: el["enabled-input"].checked === true,
      mode: shared.mode,
      system_prompt: shared.system_prompt,
      rules: JSON.parse(JSON.stringify(shared.rules)),
      fallback: JSON.parse(JSON.stringify(state.fallback))
    };
    payload.template_id = state.templateId || null;
    if (state.templateId) payload.template_version = state.templateVersion;
    for (const policy of Object.values(payload.fallback)) {
      const error = policyError(policy);
      if (error) { showAlert("保存失败：" + error, "error");return; }
      if (policy.action === "transfer") policy.account = policy.account.trim();
    }

    const epoch = state.epoch;
    const token = state.token;
    const shopId = shop.shop_id;
    const shopLabel = shopName(shop);
    const revision = state.formRevision;
    const otherShop = function () {
      return state.selectedShopId !== shopId;
    };

    hideRulesError();
    setSaveBusy(true);
    setText(el["save-status"], "正在保存…");
    try {
      const data = await request("/api/v1/admin/shops/" + encodeURIComponent(shopId) + "/settings", {
        method: "PUT",
        body: payload,
        token: token
      });
      if (isStale(epoch)) {
        return;
      }
      if (!data || typeof data !== "object" || typeof data.enabled !== "boolean" || !Array.isArray(data.rules) || !Number.isInteger(data.version)) {
        throw new ApiError(0, "bad_response", "服务器没有返回保存后的设置。");
      }
      const saved = data;
      applySavedSettingsToShops(shopId, saved);
      if (otherShop()) {
        setText(el["save-status"], "");
        showAlert("店铺“" + shopLabel + "”的设置已保存。你已切换到其他店铺，因此没有在这里显示。", "info");
        return;
      }
      if (state.formRevision !== revision && state.formDirty) {
        setText(el["save-status"], "已保存提交时的设置，之后的修改仍保留，尚未保存。");
        return;
      }
      renderSettings(saved);
      setText(el["save-status"], "店铺配置已保存，服务器已确认。");
      showAlert("");
    } catch (err) {
      if (isStale(epoch)) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "保存设置失败", epoch, token);
        return;
      }
      const unconfirmed = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
      if (otherShop()) {
        setText(el["save-status"], "");
        showAlert("店铺“" + shopLabel + "”" + (unconfirmed
          ? "的保存结果未确认，请刷新核对。"
          : "保存失败：" + errorText(err)), unconfirmed ? "warn" : "error");
        return;
      }
      if (unconfirmed) {
        setText(el["save-status"], SAVE_UNCONFIRMED);
        showAlert(SAVE_UNCONFIRMED + "（" + (err instanceof ApiError && err.code === "network_error"
          ? "网络请求没有完成，服务器可能已经保存"
          : "服务器没有返回明确结果") + "。页面上的修改仍保留。）", "warn");
      } else {
        if (err instanceof ApiError && err.code === "template_changed") {
          setText(el["save-status"], "所选模版已有更新，请撤销店铺修改后重新选择保存。当前修改仍保留。");
          return;
        }
        setText(el["save-status"], "保存失败：" + err.message + "。页面上的修改仍保留。");
        showAlert("保存设置失败：" + errorText(err) + "（修改未保存，仍保留在页面上）", "error");
      }
    } finally {
      if (!isStale(epoch)) {
        setSaveBusy(false);
      }
    }
  }

  /* ---------- 事件 ---------- */

  async function loadEvents(silent, epoch) {
    const currentEpoch = typeof epoch === "number" ? epoch : state.epoch;
    if (isStale(currentEpoch)) {
      return;
    }
    const shop = currentShop();
    if (!shop) {
      renderEvents([]);
      el["events-empty"].hidden = false;
      setText(el["events-empty"], "未选择店铺，无法查询事件。");
      setText(el["events-meta"], "未选择店铺，无法查询事件。");
      return;
    }
    const token = state.token;
    state.requestSeq += 1;
    const seq = state.requestSeq;
    const shopId = shop.shop_id;
    const limit = el["limit-select"].value;
    el["refresh-btn"].disabled = true;
    if (!silent) {
      setText(el["events-meta"], "正在加载事件…");
      el["events-empty"].hidden = true;
    }
    try {
      const data = await request("/api/v1/admin/events?shop_id=" + encodeURIComponent(shopId) + "&limit=" + encodeURIComponent(limit));
      if (isStale(currentEpoch) || seq !== state.requestSeq || shopId !== state.selectedShopId) {
        return;
      }
      const events = data && Array.isArray(data.events) ? data.events : [];
      state.events = events;
      renderEvents(events);
      setText(el["events-meta"], "店铺 " + shopId + " · 共 " + events.length + " 条 · 更新于 " + formatClock(new Date()) + "（仅显示后台记录）");
    } catch (err) {
      if (isStale(currentEpoch)) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "加载事件失败", currentEpoch, token);
        return;
      }
      handleError(err, "加载事件失败", currentEpoch, token);
      if (state.events.length > 0) {
        setText(el["events-meta"], "刷新失败：下方是上次成功加载的数据（可能已过期）。");
      } else {
        setText(el["events-meta"], "加载失败，未显示任何事件数据。");
        el["events-empty"].hidden = false;
        setText(el["events-empty"], "事件加载失败。请修复上方错误后重试。");
      }
    } finally {
      if (!isStale(currentEpoch)) {
        el["refresh-btn"].disabled = false;
      }
    }
  }

  function stateBadge(key) {
    const span = document.createElement("span");
    const map = {
      pending: { label: "等待判断", cls: "badge-pending" },
      processing: { label: "处理中", cls: "badge-processing" },
      ready: { label: "就绪", cls: "badge-ready" }
    };
    const info = map[key] || { label: key ? String(key) : "未知", cls: "badge-muted" };
    span.className = "badge " + info.cls;
    setText(span, info.label);
    return span;
  }

  function actionBadge(action, item) {
    const span = document.createElement("span");
    const map = {
      reply: { label: "回复", cls: "badge-reply" },
      handoff: { label: "建议转人工", cls: "badge-handoff" },
      mark: { label: "收藏标星", cls: "badge-reply" },
      transfer: { label: "转人工", cls: "badge-handoff" },
      none: { label: "不回复", cls: "badge-muted" }
    };
    if (action === "send_item") {
      const type = item && typeof item === "object" && SEND_TYPES.includes(item.type) ? item.type : "";
      map.send_item = { label: type ? SEND_TYPE_LABELS[type] : "发送内容（未知类型）", cls: "badge-reply" };
    }
    const info = map[action] || { label: action ? String(action) : "无判断", cls: "badge-muted" };
    span.className = "badge " + info.cls;
    setText(span, info.label);
    return span;
  }

  function deliveryBadge(status, action) {
    const span = document.createElement("span");
    const map = {
      unclaimed: { label: "未认领", cls: "badge-muted" },
      claimed: { label: "已授权发送", cls: "badge-processing" },
      sent: { label: "已发送（客户端回执）", cls: "badge-ok" },
      not_sent: { label: "未发送（明确）", cls: "badge-muted" },
      unknown: { label: "结果不确定 unknown", cls: "badge-unknown" }
    };
    if (action === "mark" || action === "transfer") {
      map.claimed.label = "操作已领取";
      map.sent.label = "操作已确认（客户端回执）";
      map.not_sent.label = "操作未完成";
    }
    const info = map[status] || { label: status ? String(status) : "无回执数据", cls: "badge-muted" };
    span.className = "badge " + info.cls;
    setText(span, info.label);
    return span;
  }

  /* ---------- unknown 人工核查 ---------- */

  function verificationInfo(delivery) {
    const source = delivery && typeof delivery === "object" ? delivery.verification : null;
    if (!source || typeof source !== "object") {
      return null;
    }
    const verifiedAt = Number(source.verified_at);
    return {
      outcome: source.outcome === "sent" || source.outcome === "not_sent" ? source.outcome : null,
      note: typeof source.note === "string" ? source.note : "",
      verifiedAt: Number.isFinite(verifiedAt) && verifiedAt > 0 ? verifiedAt : null
    };
  }

  function verificationOutcomeLabel(outcome) {
    if (outcome === "sent") {
      return "平台已发出";
    }
    if (outcome === "not_sent") {
      return "平台未发出";
    }
    return "结论未知";
  }

  function verificationBox(info) {
    const box = document.createElement("div");
    box.className = "verification-box";
    const badge = document.createElement("span");
    badge.className = "badge " + (info.outcome === "sent" ? "badge-ok" : "badge-muted");
    setText(badge, "已核查：" + verificationOutcomeLabel(info.outcome));
    box.appendChild(badge);
    const note = document.createElement("div");
    note.className = "verification-note";
    setText(note, "核查说明：" + (info.note || "（无说明）"));
    box.appendChild(note);
    box.appendChild(smallLine("核查时间 " + (info.verifiedAt === null ? "–" : formatTime(info.verifiedAt)) + " · 管理员核查记录", "small muted"));
    box.appendChild(smallLine("unknown 结果保持不变；该旧事件永不重发。", "small muted"));
    return box;
  }

  function showVerifyError(message) {
    setText(el["verify-error"], message);
    el["verify-error"].hidden = !message;
  }

  function hideVerifyError() {
    setText(el["verify-error"], "");
    el["verify-error"].hidden = true;
  }

  function updateVerifyNoteCount() {
    const node = el["verify-note-count"];
    if (!node) {
      return;
    }
    const length = Array.from(String(el["verify-note"].value || "").trim()).length;
    node.className = length > VERIFY_NOTE_MAX ? "small warn-text" : "small muted";
    setText(node, length > VERIFY_NOTE_MAX
      ? "已输入 " + length + " 字，超出 " + VERIFY_NOTE_MAX + " 字上限"
      : "已输入 " + length + " / " + VERIFY_NOTE_MAX + " 字（首尾空白不计入）");
  }

  function setVerifyBusy(busy) {
    if (!el["verify-submit"]) {
      return;
    }
    state.verify.busy = busy;
    el["verify-submit"].disabled = busy || state.verify.unconfirmed;
    setText(el["verify-submit"], busy
      ? "提交中…"
      : state.verify.unconfirmed ? "结果未确认，请先核对" : "确认记录核查结论");
    el["verify-outcome"].disabled = busy;
    el["verify-note"].disabled = busy;
    el["verify-cancel"].disabled = busy;
    el["verify-close"].disabled = busy;
  }

  function resetVerifyState() {
    state.verify.open = false;
    state.verify.busy = false;
    state.verify.unconfirmed = false;
    state.verify.seq += 1;
    state.verify.eventId = null;
    state.verify.shopId = null;
    state.verify.conversationId = null;
    if (el["verify-outcome"]) {
      el["verify-outcome"].value = "";
      el["verify-outcome"].disabled = false;
    }
    if (el["verify-note"]) {
      el["verify-note"].value = "";
      el["verify-note"].disabled = false;
    }
    if (el["verify-submit"]) {
      el["verify-submit"].disabled = false;
      setText(el["verify-submit"], "确认记录核查结论");
    }
    if (el["verify-cancel"]) {
      el["verify-cancel"].disabled = false;
    }
    if (el["verify-close"]) {
      el["verify-close"].disabled = false;
    }
    setText(el["verify-identity-shop"], "–");
    setText(el["verify-identity-conversation"], "–");
    setText(el["verify-identity-event"], "–");
    setText(el["verify-status"], "");
    updateVerifyNoteCount();
    hideVerifyError();
  }

  function closeVerifyDialog(force) {
    if (!el["verify-panel"]) {
      return;
    }
    if (state.verify.busy && force !== true) {
      return;
    }
    if (el["verify-panel"].open) {
      el["verify-panel"].close();
    }
    resetVerifyState();
  }

  function openVerifyDialog(item) {
    if (!state.token) {
      return;
    }
    const delivery = item && typeof item === "object" ? item.delivery : null;
    if (!delivery || delivery.status !== "unknown" || verificationInfo(delivery)) {
      showAlert("该事件当前不满足核查条件（需要尚未核查的不确定记录）。", "warn");
      loadEvents(true, state.epoch);
      return;
    }
    const eventId = typeof item.event_id === "string" ? item.event_id : "";
    const shopId = typeof item.shop_id === "string" ? item.shop_id : "";
    const conversationId = typeof item.conversation_id === "string" ? item.conversation_id : "";
    if (!eventId) {
      showAlert("无法核查：该事件缺少事件编号。", "error");
      return;
    }
    if (!shopId) {
      showAlert("无法核查：该事件缺少店铺信息。", "error");
      return;
    }
    if (state.selectedShopId && shopId !== state.selectedShopId) {
      showAlert("无法核查：该事件不属于当前所选店铺，请刷新列表后重试。", "error");
      return;
    }
    if (el["verify-panel"].open) {
      el["verify-panel"].close();
    }
    resetVerifyState();
    state.verify.open = true;
    state.verify.eventId = eventId;
    state.verify.shopId = shopId;
    state.verify.conversationId = conversationId;
    setText(el["verify-identity-shop"], shopId);
    setText(el["verify-identity-conversation"], textOrDash(conversationId));
    setText(el["verify-identity-event"], eventId);
    updateVerifyNoteCount();
    setVerifyBusy(false);
    el["verify-panel"].showModal();
    el["verify-outcome"].focus();
  }

  function applyVerifiedEvent(snapshot) {
    let replaced = false;
    state.events = state.events.map(function (item) {
      if (item && typeof item === "object" && item.event_id === snapshot.event_id && item.shop_id === snapshot.shop_id) {
        replaced = true;
        return snapshot;
      }
      return item;
    });
    if (replaced) {
      renderEvents(state.events);
    }
    return replaced;
  }

  function reconcileOpenVerify() {
    if (!state.verify.open || state.verify.busy) {
      return;
    }
    const eventId = state.verify.eventId;
    const shopId = state.verify.shopId;
    if (!eventId || !shopId) {
      return;
    }
    const match = state.events.find(function (item) {
      return item && typeof item === "object" && item.event_id === eventId && item.shop_id === shopId;
    });
    if (!match) {
      return;
    }
    const delivery = match.delivery && typeof match.delivery === "object" ? match.delivery : null;
    const info = delivery && delivery.status === "unknown" ? verificationInfo(delivery) : null;
    if (!info) {
      return;
    }
    closeVerifyDialog(true);
    showAlert("事件 " + eventId + " 已有核查记录：" + verificationOutcomeLabel(info.outcome) +
      "（来自服务器最新快照）。原不确定记录保持不变，旧消息不会重发。", "info");
  }

  function buildVerifyButton(eventId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-sm btn-verify";
    setText(button, "核查");
    if (!eventId) {
      button.disabled = true;
      button.title = "该事件缺少事件编号，无法核查。";
      return button;
    }
    button.setAttribute("aria-label", "人工核查事件 " + eventId);
    return button;
  }

  async function submitVerify(event) {
    if (event) {
      event.preventDefault();
    }
    if (!state.verify.open || state.verify.busy) {
      return;
    }
    hideVerifyError();
    setText(el["verify-status"], "");
    if (!state.token) {
      showVerifyError("登录已失效，请重新登录后再核查。");
      return;
    }
    const eventId = state.verify.eventId;
    const shopId = state.verify.shopId;
    if (!eventId || !shopId) {
      showVerifyError("核查目标已失效，请关闭窗口后重新选择事件。");
      return;
    }
    if (state.verify.unconfirmed) {
      showVerifyError("上一次提交结果未确认。请先关闭窗口并刷新列表核对；确认没有核查记录后再重新核查，不要直接重复提交。");
      return;
    }
    const outcome = el["verify-outcome"].value;
    if (outcome !== "sent" && outcome !== "not_sent") {
      showVerifyError("请选择核查结论：平台已发出或平台未发出。");
      el["verify-outcome"].focus();
      return;
    }
    const note = String(el["verify-note"].value || "").trim();
    const noteLength = Array.from(note).length;
    if (noteLength === 0) {
      showVerifyError("请填写核查依据说明（去掉首尾空白后 1-200 字）。");
      el["verify-note"].focus();
      return;
    }
    if (noteLength > VERIFY_NOTE_MAX) {
      showVerifyError("核查依据说明最多 " + VERIFY_NOTE_MAX + " 字（当前 " + noteLength + " 字）。");
      el["verify-note"].focus();
      return;
    }

    const epoch = state.epoch;
    const token = state.token;
    state.verify.seq += 1;
    const seq = state.verify.seq;
    setVerifyBusy(true);
    setText(el["verify-status"], "正在提交核查，请勿关闭窗口…");
    try {
      const data = await request("/api/v1/admin/events/" + encodeURIComponent(eventId) +
        "/verify?shop_id=" + encodeURIComponent(shopId), {
          method: "POST",
          body: { outcome: outcome, note: note },
          token: token
        });
      if (isStale(epoch) || state.token !== token || seq !== state.verify.seq) {
        return;
      }
      if (!data || typeof data !== "object" || data.event_id !== eventId || data.shop_id !== shopId) {
        throw new ApiError(0, "bad_response", "服务器返回的核查结果与所选事件不一致。");
      }
      const delivery = data.delivery && typeof data.delivery === "object" ? data.delivery : null;
      if (!delivery || delivery.status !== "unknown") {
        throw new ApiError(0, "bad_response", "服务器返回的核查结果异常：unknown 结果应保持不变。");
      }
      const info = verificationInfo(delivery);
      if (!info || info.outcome !== outcome) {
        throw new ApiError(0, "bad_response", "服务器没有返回本次核查记录。");
      }
      setVerifyBusy(false);
      closeVerifyDialog(true);
      applyVerifiedEvent(data);
      showAlert("已记录事件 " + eventId + " 的核查结论：" + verificationOutcomeLabel(info.outcome) +
        "。旧消息永不重发；买家新消息可正常处理，无需等待核查。", "ok");
    } catch (err) {
      if (isStale(epoch) || state.token !== token || seq !== state.verify.seq) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "提交核查失败", epoch, token);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        showVerifyError("当前登录没有权限执行核查（需要管理员角色）。" + (err.code ? "（" + err.code + "）" : ""));
        setText(el["verify-status"], "提交被拒绝。");
        setVerifyBusy(false);
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        showVerifyError("服务器拒绝了核查：该事件可能已被核查或状态已变化（" + errorText(err) + "）。正在刷新列表。");
        setText(el["verify-status"], "提交被拒绝。");
        setVerifyBusy(false);
        loadEvents(true, epoch);
        return;
      }
      if (err instanceof ApiError && (err.status === 400 || err.status === 404)) {
        showVerifyError("核查请求被拒绝：" + errorText(err));
        setText(el["verify-status"], "未提交成功。");
        setVerifyBusy(false);
        return;
      }
      state.verify.unconfirmed = true;
      setVerifyBusy(false);
      showVerifyError("核查结果未确认：服务器是否已记录不明（" + errorText(err) +
        "）。正在刷新列表核对；如仍无核查记录，请关闭窗口后重新核查，不要直接重复提交。");
      setText(el["verify-status"], "结果未确认。");
      loadEvents(true, epoch);
    }
  }

  function smallLine(text, className) {
    const div = document.createElement("div");
    div.className = className || "small muted";
    setText(div, text);
    return div;
  }

  function renderEvents(events) {
    const body = el["events-body"];
    body.replaceChildren();
    const list = Array.isArray(events) ? events : [];
    list.forEach(function (item) {
      if (!item || typeof item !== "object") {
        return;
      }
      const eventId = typeof item.event_id === "string" ? item.event_id : "";
      const delivery = item.delivery && typeof item.delivery === "object" ? item.delivery : null;
      const isUnknown = delivery && delivery.status === "unknown";
      const row = document.createElement("tr");
      if (isUnknown) {
        row.className = "row-unknown";
      }
      if (eventId) {
        row.dataset.eventId = eventId;
      }

      const timeCell = document.createElement("td");
      timeCell.appendChild(smallLine(formatTime(item.created_at !== undefined ? item.created_at : item.received_at), "cell-strong"));
      if (eventId) {
        timeCell.appendChild(smallLine(eventId, "small muted mono"));
      }
      row.appendChild(timeCell);

      const shopCell = document.createElement("td");
      shopCell.appendChild(smallLine(textOrDash(item.shop_id), "cell-strong"));
      shopCell.appendChild(smallLine("会话 " + textOrDash(item.conversation_id), "small"));
      shopCell.appendChild(smallLine("消息 " + textOrDash(item.message_id) + " · 上下文 v" + textOrDash(item.context_revision), "small muted mono"));
      row.appendChild(shopCell);

      const stateCell = document.createElement("td");
      stateCell.appendChild(stateBadge(item.state));
      if (item.generation !== undefined && item.generation !== null) {
        stateCell.appendChild(smallLine("连接代号 " + textOrDash(item.generation), "small muted"));
      }
      row.appendChild(stateCell);

      const decisionCell = document.createElement("td");
      const decision = item.decision && typeof item.decision === "object" ? item.decision : null;
      if (!decision) {
        const waiting = item.state === "pending" || item.state === "processing";
        decisionCell.appendChild(smallLine(waiting ? "等待后台判断…" : "无判断数据（可能已结束为转人工）", "muted"));
      } else {
        decisionCell.appendChild(actionBadge(decision.action, decision.item));
        if (decision.action === "send_item") {
          const sendItem = decision.item && typeof decision.item === "object" ? decision.item : null;
          const itemType = sendItem && SEND_TYPES.includes(sendItem.type) ? SEND_TYPE_NAMES[sendItem.type] : "未知类型";
          const optionId = sendItem && typeof sendItem.option_id === "string" && sendItem.option_id ? sendItem.option_id : "–";
          decisionCell.appendChild(smallLine("内容类型：" + itemType, "small"));
          decisionCell.appendChild(smallLine("候选编号 " + optionId, "small muted mono"));
        }
        if (decision.action === "mark" && decision.mark) {
          const color = { red: "红色", orange: "黄色", blue: "蓝色", green: "绿色" }[decision.mark.color];
          decisionCell.appendChild(smallLine("星标颜色：" + (color || "未知"), "small"));
        }
        if (decision.reason !== undefined && decision.reason !== null) {
          decisionCell.appendChild(smallLine("原因：" + String(decision.reason), "small"));
        }
        if (decision.action === "reply" && delivery && delivery.status === "unclaimed") {
          decisionCell.appendChild(smallLine("建议回复 · 尚未领取发送，请先人工核对", "small muted"));
        }
        if (typeof decision.text === "string" && decision.text) {
          const textNode = document.createElement("div");
          textNode.className = "decision-text";
          textNode.textContent = decision.text;
          decisionCell.appendChild(textNode);
        }
        if (decision.expires_at !== undefined && decision.expires_at !== null) {
          const expires = Number(decision.expires_at);
          const expired = Number.isFinite(expires) && expires * 1000 <= Date.now();
          decisionCell.appendChild(smallLine("回复有效期至 " + formatTime(expires) + (expired ? "（已过期）" : ""), expired ? "small warn-text" : "small muted"));
        }
      }
      row.appendChild(decisionCell);

      const deliveryCell = document.createElement("td");
      if (!delivery) {
        deliveryCell.appendChild(smallLine("无回执数据", "muted"));
      } else {
        deliveryCell.appendChild(deliveryBadge(delivery.status, decision && decision.action));
        if (Array.isArray(delivery.steps) && delivery.steps.some(function (step) {
          return step && step.step === "unmark_and_transfer" && step.unmarked === true;
        }) && delivery.status !== "sent") {
          deliveryCell.appendChild(smallLine("收藏已取消，转移未确认完成；不会自动恢复收藏或重试。", "small warn-text"));
        }
        if (delivery.attempt_id) {
          deliveryCell.appendChild(smallLine("尝试 " + delivery.attempt_id, "small muted mono"));
        }
        if (delivery.platform_message_id) {
          deliveryCell.appendChild(smallLine("平台消息 " + delivery.platform_message_id, "small mono"));
        }
        if (delivery.claim_expires_at !== undefined && delivery.claim_expires_at !== null) {
          deliveryCell.appendChild(smallLine("授权至 " + formatTime(delivery.claim_expires_at), "small muted"));
        }
        if (delivery.status === "unknown") {
          const verification = verificationInfo(delivery);
          if (verification) {
            deliveryCell.appendChild(verificationBox(verification));
          } else {
            deliveryCell.appendChild(smallLine("此结果永久保留，不得重发；请人工核查。", "small warn-text"));
            const verifyButton = buildVerifyButton(eventId);
            if (eventId) {
              verifyButton.addEventListener("click", function () {
                openVerifyDialog(item);
              });
            }
            deliveryCell.appendChild(verifyButton);
          }
        }
      }
      row.appendChild(deliveryCell);

      body.appendChild(row);
    });

    if (list.length === 0) {
      setText(el["events-empty"], EMPTY_EVENTS_TEXT);
      el["events-empty"].hidden = false;
    } else {
      el["events-empty"].hidden = true;
    }
    reconcileOpenVerify();
  }

  async function refreshAll(silent) {
    if (!state.token) {
      return;
    }
    const epoch = state.epoch;
    const token = state.token;
    if (state.shops.length === 0) {
      await loadDashboard(epoch);
      return;
    }
    try {
      const summary = await request("/api/v1/admin/summary");
      if (isStale(epoch)) {
        return;
      }
      renderSummary(summary && summary.counts ? summary.counts : null);
      setText(el["system-connection"], "正常");
    } catch (err) {
      if (isStale(epoch)) {
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        handleError(err, "刷新概览失败", epoch, token);
        return;
      }
      handleError(err, "刷新概览失败", epoch, token);
    }
    if (isStale(epoch)) {
      return;
    }
    await fetchShops(epoch, {});
    if (isStale(epoch)) {
      return;
    }
    await loadEvents(silent === true, epoch);
  }

  function onShopChange() {
    const value = el["shop-select"].value;
    if (!value || value === state.selectedShopId) {
      return;
    }
    if (state.formDirty && !window.confirm("当前店铺有未保存的修改，切换店铺会丢弃这些修改。仍要切换吗？")) {
      el["shop-select"].value = state.selectedShopId || "";
      return;
    }
    state.selectedShopId = value;
    clearPromptDraft();
    state.loadedSettings = null;
    state.remoteSettings = null;
    state.formVersion = null;
    state.formSignature = "";
    state.formDirty = false;
    showAlert("");
    state.events = [];
    renderShopHeader();
    const shop = currentShop();
    renderLease(shop ? shop.lease : null);
    if (shop) {
      renderSettings(shop.settings);
    } else {
      clearSettingsForm();
    }
    loadEvents(false, state.epoch);
  }

  function resetSettings() {
    const source = state.remoteSettings || state.loadedSettings;
    if (!source) {
      clearSettingsForm();
      setText(el["save-status"], "没有可还原的服务器设置。");
      return;
    }
    if (state.formDirty && !window.confirm("放弃当前未保存的修改，恢复为服务器上的设置？")) {
      return;
    }
    renderSettings(source);
    setText(el["save-status"], "已恢复为服务器上的设置（未保存的修改已丢弃）。");
  }

  function handleAutoRefresh() {
    clearTimer();
    if (el["auto-refresh"].checked) {
      state.autoTimer = window.setInterval(function () {
        if (!state.token || el.dashboard.hidden || state.route !== "records") {
          return;
        }
        loadEvents(true, state.epoch);
      }, 15000);
    }
  }

  function openAccountDialog() {
    clearHandoff();
    if (!state.token) {
      return;
    }
    byId("first-password-notice").hidden = !passwordChangeRequired();
    setText(el["account-close"], passwordChangeRequired() ? "退出登录" : "关闭");
    el["account-close"].setAttribute("aria-label", passwordChangeRequired() ? "退出登录" : "关闭修改密码");
    el["account-panel"].showModal();
    el["current-password-input"].focus();
  }

  function init() {
    const handoff = takeHandoffTicket();
    if (window.setupProductLearning) productLearning = window.setupProductLearning({state: state, request: request, handleError: handleError});
    IDS.forEach(function (id) {
      el[id] = byId(id);
    });
    assist = window.setupAdminAssist({ state: state, request: request, onEdit: onFormEdit,
      renderRules: renderRules, newRuleId: generateRuleId, nextUid: nextUid,
      validateRules: collectRules, handleError: handleError, onShopChange: function (id) {
        el["shop-select"].value = id; onShopChange();
      }, onApply: function () {
        byId("template-rules-section").open = true;
        navigateTo("templates"); showAlert("草稿已填入当前话术模版，请核对后保存模版。", "warn");
      } });

    el["login-form"].addEventListener("submit", function (event) {
      event.preventDefault();
      const username = el["username-input"].value.trim();
      const password = el["password-input"].value;
      showLoginError("");
      showLoginNotice("");
      if (!username) {
        showLoginError("请输入用户名。");
        el["username-input"].focus();
        return;
      }
      if (!password) {
        showLoginError("请输入密码。");
        el["password-input"].focus();
        return;
      }
      login(username, password);
    });

    document.querySelectorAll(".nav-link[data-route]").forEach(function (node) {
      node.addEventListener("click", function () {
        navigateTo(node.dataset.route);
      });
    });
    document.querySelectorAll(".shortcut[data-route]").forEach(function (node) {
      node.addEventListener("click", function () {
        navigateTo(node.dataset.route);
      });
    });

    window.addEventListener("hashchange", function () {
      if (!state.token || passwordChangeRequired()) {
        return;
      }
      const route = routeFromHash();
      if (window.location.hash && window.location.hash !== "#/" + route) {
        try {
          window.history.replaceState(null, "", "#/" + route);
        } catch (err) {
          /* ignore */
        }
      }
      applyRoute(route);
    });

    el["nav-toggle"].addEventListener("click", function () {
      if (el["dashboard"].classList.contains("nav-open")) {
        closeMobileNav();
      } else {
        openMobileNav();
      }
    });
    el["nav-backdrop"].addEventListener("click", closeMobileNav);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeMobileNav();
      }
    });

    el["logout-btn"].addEventListener("click", function () {
      logout();
    });
    el["settings-logout-btn"].addEventListener("click", function () {
      logout();
    });

    el["admin-badge"].addEventListener("click", openAccountDialog);
    el["settings-password-btn"].addEventListener("click", openAccountDialog);
    el["account-close"].addEventListener("click", function () {
      if (passwordChangeRequired()) {
        logout();
      } else {
        el["account-panel"].close();
      }
    });
    el["account-panel"].addEventListener("cancel", function (event) {
      if (passwordChangeRequired()) {
        event.preventDefault();
      }
    });
    el["account-panel"].addEventListener("close", clearChangePasswordForm);

    el["change-password-form"].addEventListener("submit", changePassword);
    el["handoff-create"].addEventListener("click", function () { manageHandoff("create"); });
    el["handoff-refresh"].addEventListener("click", loadHandoffGrants);
    el["handoff-hide"].addEventListener("click", hideHandoffCode);
    el["handoff-code"].addEventListener("click", function () { this.select(); });
    el["handoff-panel"].hidden = !localHandoffOrigin();

    el["verify-form"].addEventListener("submit", submitVerify);
    el["verify-cancel"].addEventListener("click", function () {
      closeVerifyDialog(false);
    });
    el["verify-close"].addEventListener("click", function () {
      closeVerifyDialog(false);
    });
    el["verify-panel"].addEventListener("cancel", function (event) {
      if (state.verify.busy) {
        event.preventDefault();
      }
    });
    el["verify-panel"].addEventListener("close", resetVerifyState);
    el["verify-outcome"].addEventListener("change", hideVerifyError);
    el["verify-note"].addEventListener("input", function () {
      hideVerifyError();
      updateVerifyNoteCount();
    });

    el["shop-select"].addEventListener("change", onShopChange);
    el["template-select"].addEventListener("change", onTemplateChange);
    el["template-create"].addEventListener("click", openShopTemplate);
    el["template-editor-select"].addEventListener("change", onEditorTemplateChange);
    el["template-new"].addEventListener("click", newTemplate);
    el["template-editor-form"].addEventListener("submit", function (event) { event.preventDefault(); saveTemplate(false); });
    el["template-save-as"].addEventListener("click", function () { saveTemplate(true); });
    el["template-reset"].addEventListener("click", resetTemplateEditor);
    el["settings-form"].addEventListener("submit", saveSettings);
    el["reset-btn"].addEventListener("click", resetSettings);
    el["generate-prompt"].addEventListener("click", generatePromptDraft);
    el["apply-prompt-draft"].addEventListener("click", applyPromptDraft);
    el["prompt-draft"].addEventListener("input", syncPromptDraft);
    el["add-rule-btn"].addEventListener("click", addRule);
    el["rules-prev"].addEventListener("click", function () { state.rulesPage -= 1; renderRules(); });
    el["rules-next"].addEventListener("click", function () { state.rulesPage += 1; renderRules(); });
    el["refresh-btn"].addEventListener("click", function () {
      showAlert("");
      refreshAll(false);
    });
    el["auto-refresh"].addEventListener("change", handleAutoRefresh);
    el["limit-select"].addEventListener("change", function () {
      if (state.token) {
        loadEvents(false, state.epoch);
      }
    });
    el["dashboard-refresh-btn"].addEventListener("click", function () {
      showAlert("");
      refreshAll(false);
    });
    el["system-refresh-btn"].addEventListener("click", function () {
      showAlert("");
      refreshSystemStatus(true);
    });

    ["mode-input", "prompt-input", "template-name"].forEach(function (id) {
      el[id].addEventListener("input", onFormEdit);
      el[id].addEventListener("change", onFormEdit);
    });
    el["enabled-input"].addEventListener("change", onShopFormEdit);

    MODEL_SLOTS.forEach(function (slot) {
      ["base-url", "model", "timeout", "key"].forEach(function (field) {
        const node = el[modelFieldId(slot, field)];
        node.addEventListener("input", onModelEdit);
        node.addEventListener("change", onModelEdit);
      });
      el[modelFieldId(slot, "clear-key")].addEventListener("change", function (event) {
        if (event.target.checked) {
          el[modelFieldId(slot, "key")].value = "";
        }
        onModelEdit();
      });
      el[modelFieldId(slot, "test-btn")].addEventListener("click", function () {
        runModelTest(slot);
      });
    });
    el["model-form"].addEventListener("submit", saveModelConfig);
    el["model-reload-btn"].addEventListener("click", function () {
      if (state.model.dirty && !window.confirm("重新加载会丢弃当前未保存的模型配置修改，继续吗？")) {
        return;
      }
      loadModelConfig({ force: true });
    });

    document.addEventListener("visibilitychange", function () {
      if (!state.token || document.hidden) {
        return;
      }
      fetchShops(state.epoch, {});
    });

    applyRoute("dashboard", { refreshSystem: false, scroll: false });
    el["username-input"].focus();
    if (handoff.present) redeemHandoff(handoff.ticket);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
