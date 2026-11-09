import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// 注入页面的脚本由模板字符串拼成：模板会吞掉无效转义（如正则里的 \/），只有在拼好后解析才能发现。
test("拼多多适配器注入页面的脚本拼接后均可解析", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/main/pddAdapter.js"), "utf8");
  const scope = { ITEM: "a", VIDEO_ROWS: "b", VIDEO_BTN: "c", CAMERA: "d", TEXTAREA: "e", SEND_BTN: "f", uid: "1", buyer: "1", index: 0, urls: ["https://x.invalid/1"], covers: ["https://x.invalid/c"], text: "t", name: "n", guard: "", ids: ["1"], thumbOf: new Map([["1", "https://x.invalid/t"]]), GOODS_ROW: "g", GOODS_BTN: "h", thumb: "https://x.invalid/t", INSTRUCT_BTN: "i", INSTRUCT_DIALOG: "j", PROBE_WORDS_JSON: "[]", SAFE_CLASSES_JSON: "[]", star: { x: 1, y: 1 }, exclude: ".x", check: null, keepFavorite: false, near: { x: 1, y: 1 }, target: "t", ok: [{ x: 1, y: 1 }], LINK_PROBE: "", transferTargetSnippet: () => "const vis = () => true, t = () => '', trs = [], btn = null;" };
  const scriptScope = { ...scope, notAfter: 1000, expiresAt: 1000, controlKey: "fixture-video-control", markControl: true };
  const fill = new Function(...Object.keys(scriptScope), "tpl", "return eval(tpl);");
  let parsed = 0;
  for (let i = src.indexOf("`("); i !== -1; i = src.indexOf("`(", i)) {
    let j = i + 1;
    for (let depth = 0; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") j++;
      else if (c === "$" && src[j + 1] === "{") (depth++, j++);
      else if (c === "}" && depth) depth--;
      else if (c === "`" && !depth) break;
    }
    const start = i;
    const tpl = src.slice(start, j + 1);
    i = j + 1;
    if (!/^`\((async )?\(\) =>/.test(tpl)) continue;
    scriptScope.LINK_PROBE = scope.LINK_PROBE;
    const code = fill(...Object.values(scriptScope), tpl) as string;
    assert.doesNotThrow(() => new Function(code), `脚本无法解析：${code.slice(0, 80)}`);
    if (src.slice(0, start).endsWith("const LINK_PROBE = ")) scope.LINK_PROBE = code;
    parsed++;
  }
  assert.ok(parsed >= 10, `只找到 ${parsed} 段脚本`);
  assert.ok(scope.LINK_PROBE.includes("rows_popover_visible"), "未取到真实 LINK_PROBE");
  assert.match(src, /\$\{LINK_PROBE\}/, "DOM_PROBE 应直接引用本地 LINK_PROBE");
  assert.doesNotMatch(src, /\$\{exports\./, "注入脚本模板不得引用 exports.*");
});

// 解析通过不代表语义正确：执行实际生成的说明书对话框脚本，核对遮挡元素的结构记录。
test("说明书对话框脚本：按钮被遮挡时记录遮挡元素的标签与 class", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/main/pddAdapter.js"), "utf8");
  const start = src.lastIndexOf("`(", src.indexOf("pdd_instruct_send_button_covered:"));
  const end = src.indexOf("})()`", start) + 5;
  const tpl = src.slice(start, end);
  const code = new Function("ITEM", "INSTRUCT_DIALOG", "uid", "name", "return eval(tpl);".replace("tpl", JSON.stringify(tpl)))("a", "j", "1", "虚构说明书") as string;
  const btn = { textContent: "发送说明书", getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 10 }) };
  const dialog = { getClientRects: () => [1], textContent: "虚构说明书", querySelectorAll: () => [btn] };
  const mask = { tagName: "DIV", classList: ["mask", "is-visible"], closest: () => null };
  const document = {
    querySelector: () => ({ getAttribute: () => "1-x" }),
    querySelectorAll: () => [dialog],
    elementFromPoint: () => mask,
  };
  assert.equal(new Function("document", `return ${code};`)(document), "pdd_instruct_send_button_covered:div.mask.is-visible");
});
