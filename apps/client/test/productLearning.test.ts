import test from "node:test";
import assert from "node:assert/strict";
import { parseProductFacts, parseProductList, productKey } from "../src/core/productLearning.js";
import { collectStoreProducts, productReadScript } from "../src/main/productCollector.js";
const identity = { mall_id: "7", mall: { mall_id: "7", mall_name: "虚构店铺" } };
const row = { id: "123", title: "虚构遮阳挡" };
const properties = { properties: [{ name: "材质", values: ["不含棉"] }] };
const skus = { success: true, result: { sku: [{ specs: [{ specKey: "颜色", specValue: "黑色" }, { specKey: "位置", specValue: "前挡" }] }] } };
test("strict product identities, safe list schemas and zero totals", () => {
  assert.equal(productKey("a", "123"), productKey("a", 123));
  assert.notEqual(productKey("a", "123"), productKey("b", "123"));
  for (const bad of [true, 0, Number.MAX_SAFE_INTEGER + 1, "abc", "1/2"]) assert.throws(() => productKey("a", bad));
  assert.deepEqual(parseProductList({goods: [], total: 0}), {rows: [], total: 0});
  assert.equal(parseProductList({success: true, result: {goods: [{goodsId: "123", goodsName: "P"}], total: 1}}).rows[0].id, "123");
  for (const value of [{success: false, result: {goods: [], total: 0}}, {goods: [], total: -1}, {goods: [{goodsId: 1, goodsName: "P"}, {goodsId: 1, goodsName: "P"}], total: 2}]) assert.throws(() => parseProductList(value));
});
test("negative product attributes and independent whole SKU combinations are preserved", () => {
  const doc = parseProductFacts("a", row, properties, skus);
  assert.equal(doc.details_complete, true);
  assert(doc.facts.includes("属性：材质：不含棉"));
  assert(doc.facts.some(x => x.includes("颜色") && x.includes("黑色") && x.includes("位置") && x.includes("前挡")));
  assert.equal(parseProductFacts("a", row, null, skus).details_complete, false);
  assert(parseProductFacts("a", row, null, skus).facts.some(x => x.includes("规格组合")));
  assert.equal(parseProductFacts("a", row, {properties: []}, {sku: []}).details_complete, true);
});
test("combinations sharing their first spec are one line, so many cars and windows fit", () => {
  const specs = (car: string, window: string) => ({specs: [{specKey: "款式", specValue: car}, {specKey: "型号", specValue: window}]});
  const cars = Array.from({length: 12}, (_, i) => "示例车" + i), windows = ["前挡1片", "尾挡1片", "侧窗4片", "侧窗6片", "全车8片"];
  const doc = parseProductFacts("a", row, {properties: []}, {sku: cars.flatMap(c => windows.map(w => specs(c, w)))});
  assert.equal(doc.details_complete, true);
  assert.equal(doc.facts.length, 1 + cars.length);
  assert(doc.facts.includes('规格组合：款式："示例车0"；型号："前挡1片"、"尾挡1片"、"侧窗4片"、"侧窗6片"、"全车8片"'));
  // A lone combination or rests of different shapes keep the whole combination.
  const mixed = parseProductFacts("a", row, {properties: []}, {sku: [specs("甲", "前挡"), {specs: [{specKey: "款式", specValue: "甲"}]}]});
  assert.deepEqual(mixed.facts.slice(1), ['规格组合：款式："甲"；型号："前挡"', '规格组合：款式："甲"']);
});
test("oversized and malformed details remain partial; no stock/price/ID captured", () => {
  const doc = parseProductFacts("a", row, {properties: Array.from({length: 90}, (_, i) => ({name: "属性" + i, values: ["值"]}))}, {sku: []});
  assert(doc.facts.length <= 80); assert.equal(doc.details_complete, false);
  const d = parseProductFacts("a", row, {properties: []}, {sku: [{skuId: 999, price: 1, quantity: 5, specs: [{specKey: "颜色", specValue: "红"}]}]});
  assert(!JSON.stringify(d.facts).includes("999")); assert(!JSON.stringify(d.facts).includes("price"));
});
test("source-verified read script contains exact read paths and never send/update paths", () => {
  const script = productReadScript("list", {pageNo: 1, pageSize: 20, status: 1});
  assert(script.includes("/latitude/goods/queryGoods")); assert(!script.includes("/send")); assert(!script.includes("cookies"));
  assert(!script.includes("nodeIntegration"));
});
test("collector reads every page and all41 products, not recommendations", async () => {
  const rows = Array.from({length: 41}, (_, i) => ({goodsId: String(i + 1), goodsName: "商品" + i}));
  const calls: string[] = [], docs: unknown[] = [];
  const result = await collectStoreProducts("a", "7", {}, async (kind, p) => {
    calls.push(kind);
    if (kind === "identity") return identity;
    if (kind === "list") return {goods: rows.slice(((p.pageNo as number)-1)*20, (p.pageNo as number)*20), total: 41};
    return kind === "properties" ? {properties: []} : {sku: []};
  }, async batch => { docs.push(...batch); }, () => {});
  assert.equal(docs.length, 41); assert.equal(calls.filter(x => x === "list").length, 3); assert.equal(result.complete, true);
});
test("collector rejects wrong shop and cross-product search; zero catalog is valid", async () => {
  let reads = 0;
  await assert.rejects(collectStoreProducts("a", "7", {mall_id: "8"}, async () => {reads++;return null;}, async () => {}, () => {})); assert.equal(reads, 0);
  const empty = await collectStoreProducts("a", "7", {}, async kind => kind === "identity" ? identity : {goods: [], total: 0}, async () => {throw Error("unexpected batch");}, () => {});
  assert.deepEqual(empty, {total: 0, complete: true});
  await assert.rejects(collectStoreProducts("a", "7", {goods_id: "999"}, async kind => kind === "identity" ? identity : {goods: [{goodsId: "1", goodsName: "P"}], total: 1}, async () => {}, () => {}), /product_list_invalid/);
});
test("repeated pages are partial and terminate; response-time shop change blocks upload", async () => {
  let pages = 0, uploads = 0, changed = false;
  const r = await collectStoreProducts("a", "7", {}, async kind => {
    if (kind === "identity") return identity;
    if (kind === "list") {pages++;return {goods: [{goodsId: "1", goodsName: "P"}], total: 2};}
    return kind === "properties" ? {properties: []} : {sku: []};
  }, async () => {uploads++;}, () => {});
  assert.equal(r.complete, false); assert.equal(pages, 2); assert.equal(uploads, 1);
  await assert.rejects(collectStoreProducts("a", "7", {}, async kind => {
    if (kind === "identity") return changed ? {...identity,mall_id: "9"} : identity;
    if (kind === "list") {changed=true;return {goods: [{goodsId: "1", goodsName: "P"}], total: 1};}
    return kind === "properties" ? {properties: []} : {sku: []};
  }, async () => {throw Error("should not upload");}, () => {}), /product_source_changed/);
});

test("actual page read script uses native Axios and fixed requests without navigation", async () => {
  const { runInNewContext } = await import("node:vm");
  const calls: unknown[] = [];
  const vm = { $axios: { post: async (path: string, params: unknown) => { calls.push([path, params]); return {goods: [],total:0}; } } };
  const env = {location:{origin:"https://mms.pinduoduo.com"},document:{querySelector:()=>({__vue__:vm}),querySelectorAll:()=>[]}};
  await runInNewContext(productReadScript("list", {pageNo:2,pageSize:20,status:1}), env);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["/latitude/goods/queryGoods",{pageNo:2,pageSize:20,status:1}]]);
  await assert.rejects(runInNewContext(productReadScript("list", {}), {...env,location:{origin:"https://example.invalid"}}), /product_page_unavailable/);
  assert.equal(parseProductFacts("a", row, {properties:[]}, {sku:[{specs:[]}]}).details_complete, false);
});

test("actual card parser and snapshot share only verified shop-scoped product keys", async () => {
  const { parseChatList } = await import("../src/core/pddParse.js");
  const { buildGoodsSnapshot } = await import("../src/core/goodsSnapshot.js");
  const request={data:{list:{with:{role:"user",id:"2000000000001"}}}};
  const parse=(info:Record<string,unknown>, shop="a")=>parseChatList(request,{success:true,result:{has_more:false,messages:[{
    msg_id:"3000000000001",from:{role:"user",uid:"2000000000001"},to:{role:"mall_cs",uid:"agent",mall_id:"7"},
    template_name:"user_goods_card",type:41,ts:1790000000,info:{goodsName:"虚构商品",...info}
  }]}},shop)!.messages[0];
  const a=parse({goodsID:"123"}), b=parse({goodsID:123},"b");
  assert.equal(a.card?.product_key,productKey("a","123")); assert.notEqual(a.card?.product_key,b.card?.product_key);
  for(const info of [{goodsID:"invalid"},{goodsID:Number.MAX_SAFE_INTEGER+1},{goodsID:"123",goodsId:"124"}]) assert.equal(parse(info).card?.product_key,undefined);
  const message={...a,id:"m-1"};
  const snapshot=buildGoodsSnapshot({orders:[],messages:[message]},()=>"g-1",id=>productKey("a",id));
  assert.equal(snapshot.goods[0].product_key,a.card?.product_key);
  assert.equal(snapshot.goods[0].goods_ref,"g-1");assert(!JSON.stringify(snapshot).includes('"123"'));
  assert.doesNotThrow(()=>buildGoodsSnapshot({orders:[{order_ref:"o",observed_at:1,goods:[{goods_id:"legacy-id",title:"旧商品",exact:true}]}],messages:[]},()=>"g-2",id=>productKey("a",id)));
});
