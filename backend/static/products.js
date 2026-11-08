"use strict";

window.setupProductLearning = function ({state, request, handleError}) {
  const panel = document.getElementById("product-learning");
  if (!panel) return;
  const input = document.getElementById("product-source"), button = document.getElementById("product-learn");
  const status = document.getElementById("product-status"), list = document.getElementById("product-preview");
  const notes = document.getElementById("product-notes"), notesSave = document.getElementById("product-notes-save");
  const notesStatus = document.getElementById("product-notes-status");
  let active = null, busy = false, polling = false, seq = 0, preview = "", savedNotes = null;
  const context = () => ({shop: state.selectedShopId, token: state.token, epoch: state.epoch});
  const current = c => c.shop === state.selectedShopId && c.token === state.token && c.epoch === state.epoch;
  function render(value) {
    const n = value.processed || 0, total = Number.isInteger(value.total) ? " / " + value.total : "";
    const labels = {
      idle: value.catalog_count > 0 ? "知识库已有 " + value.catalog_count + " 件商品资料，可按需重新学习。" : "还未学习商品。选好店铺后点“学习本店商品”。",
      queued: value.client_ready ? "等待客户端读取本店在售商品。" : "等待客户端更新到支持商品学习的版本并连接后台，请保持本店平台已登录。",
      collecting: "正在读取本店在售商品，已整理 " + n + total + " 件。",
      learning: "正在用已配置的模型整理商品资料，已整理 " + n + total + " 件。",
      completed: "本次完成 " + n + " 件，知识库共 " + value.catalog_count + " 件。",
      partial: "本次整理 " + n + total + " 件；部分列表或属性/规格未读完整，缺失信息仍会向买家询问。",
      failed: value.error === "product_learning_failed" ? "模型整理没有完成，原有产品知识保持不变。请核对模型连接后重新学习。" :
        "本次读取未完成，原有产品知识保持不变。请确认本店平台已登录、身份正确、客户端已连接后重新学习。"
    };
    status.textContent = labels[value.status] || "暂时无法确认学习进度，请刷新。";
    const summary = document.getElementById("product-summary");
    if (summary) summary.textContent = ["queued", "collecting", "learning"].includes(value.status)
      ? " · 学习中 " + n + total + " 件"
      : " · 已学 " + (Number.isInteger(value.catalog_count) ? value.catalog_count : 0) + " 件";
    const products = Array.isArray(value.products) ? value.products : [], snapshot = JSON.stringify(products);
    if (snapshot !== preview) {
      preview = snapshot; list.replaceChildren();
      for (const product of products) {
        const details = document.createElement("details"), title = document.createElement("summary");
        title.textContent = product.title + " · " + product.category + (product.link ? " · " + product.link : "") +
          (product.details_complete ? "" : " · 部分资料缺失");
        details.appendChild(title);
        const ul = document.createElement("ul");
        for (const fact of Array.isArray(product.facts) ? product.facts : []) {
          const li = document.createElement("li"); li.textContent = fact; ul.appendChild(li);
        }
        details.appendChild(ul); list.appendChild(details);
      }
    }
    button.textContent = value.status === "idle" ? "学习本店商品" : "重新学习本店商品";
    // Keep what the owner is typing: only an untouched box follows the saved text.
    const saved = typeof value.notes === "string" ? value.notes : "";
    if (savedNotes === null || notes.value === savedNotes) notes.value = saved;
    savedNotes = saved;
  }
  async function refresh() {
    const c = context(), identity = JSON.stringify(c);
    if (identity !== active) {
      active = identity; seq++; busy = false; preview = ""; input.value = ""; list.replaceChildren();
      savedNotes = null; notes.value = ""; notesStatus.textContent = "";
      status.textContent = "正在读取当前店铺的产品知识状态。";
      const summary = document.getElementById("product-summary"); if (summary) summary.textContent = "";
    }
    button.disabled = !c.shop || !c.token || busy;
    notesSave.disabled = !c.shop || !c.token || busy;
    if (!c.shop || !c.token || state.route !== "scripts" || document.hidden || polling || busy) return;
    const order = ++seq;
    polling = true;
    try {
      const data = await request("/api/v1/admin/shops/" + encodeURIComponent(c.shop) + "/product-learning", {token: c.token});
      if (current(c) && order === seq) render(data);
    } catch (err) {
      if (current(c) && order === seq) {
        if ([401, 403].includes(err.status)) handleError(err, "读取商品知识失败", c.epoch, c.token);
        else status.textContent = "暂时无法读取商品学习状态，请确认后台已更新。";
      }
    } finally { polling = false; }
  }
  button.addEventListener("click", async () => {
    const c = context();
    if (!c.shop || !c.token || busy) return;
    busy = true; button.disabled = true; const order = ++seq;
    status.textContent = "正在安排读取本店商品。";
    try {
      const data = await request("/api/v1/admin/shops/" + encodeURIComponent(c.shop) + "/product-learning", {
        token: c.token, method: "POST", body: {source_url: input.value.trim()}
      });
      if (current(c) && order === seq) render(data);
    } catch (err) {
      if (current(c)) status.textContent = err.code === "invalid_product_url" ? "请使用拼多多店铺/商品链接，或留空读取当前登录店铺。" : "安排未确认，请先看当前进度，不要连续点击。";
    } finally { if (current(c) && order === seq) { busy = false; button.disabled = false; } }
  });
  notesSave.addEventListener("click", async () => {
    const c = context();
    if (!c.shop || !c.token || busy) return;
    busy = true; notesSave.disabled = true; const order = ++seq, sent = notes.value;
    notesStatus.textContent = "正在保存详情要点。";
    try {
      const data = await request("/api/v1/admin/shops/" + encodeURIComponent(c.shop) + "/product-notes", {
        token: c.token, method: "PUT", body: {notes: sent}
      });
      if (current(c)) {
        // Text typed while the save was on its way stays in the box, unsaved.
        const typed = notes.value !== sent;
        savedNotes = sent; render(data);
        notesStatus.textContent = typed ? "已保存点击时的内容；之后的修改还没保存。" :
          data.notes ? "已保存，买家问材质、功能、透光时按要点回答。" : "已清空详情要点。";
      }
    } catch (err) {
      if (current(c)) notesStatus.textContent = err.code === "invalid_product_notes" ? "要点最多 2000 字，请精简后再保存。" : "保存未确认，请刷新后核对。";
    } finally { if (current(c) && order === seq) { busy = false; notesSave.disabled = false; } }
  });
  setInterval(() => void refresh(), 3000);
  void refresh();
  return {refresh: function () { void refresh(); }, reset: function () {
    active = null; seq++; busy = false; preview = ""; input.value = ""; list.replaceChildren();
    savedNotes = null; notes.value = ""; notesStatus.textContent = "";
    const summary = document.getElementById("product-summary"); if (summary) summary.textContent = "";
    status.textContent = "还未学习商品。"; button.disabled = true;
  }};
};
