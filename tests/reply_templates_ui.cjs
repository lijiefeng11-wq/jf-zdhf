// Actual management code, fictional DOM/shops/HTTP. No platform or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Element {
  constructor(tag) { Object.assign(this,{tagName:tag,children:[],dataset:{},value:'',textContent:'',files:[],checked:false,hidden:false,disabled:false,open:false,listeners:{},className:'',style:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}}}); }
  appendChild(n) { this.children.push(n);n.parent=this;return n; }
  replaceChildren(...nodes) { this.children=[];nodes.forEach(n=>this.appendChild(n)); }
  replaceWith(n) { const i=this.parent.children.indexOf(this);this.parent.children[i]=n;n.parent=this.parent; }
  setAttribute() {} removeAttribute() {} focus() {} addEventListener(name,fn) { this.listeners[name]=fn; }
  querySelectorAll(selector) { const match=n=>selector.split(',').some(s=>s.trim().startsWith('.') ? n.className.split(' ').includes(s.trim().slice(1)) : n.tagName===s.trim());return this.children.flatMap(n=>[...(match(n)?[n]:[]),...n.querySelectorAll(selector)]); }
}
let source=fs.readFileSync(path.join(__dirname,'../backend/static/app.js'),'utf8');
source=source.replace(/  if \(document.readyState === "loading"\) \{[\s\S]*?\n  \}\n\}\)\(\);\s*$/, '  globalThis.fixture={state,el,IDS,renderSettings,onTemplateChange,saveSettings,onFormEdit,onShopFormEdit,applyRemoteSettings,syncTemplateSelect,collectRules,loadTemplateEditor,saveTemplate,newTemplate,onEditorTemplateChange,resetTemplateEditor,applyTemplatesSnapshot,openShopTemplate,showRulesError,renderDecisionRuntime,decisionDetails};\n})();');
const plain=x=>JSON.parse(JSON.stringify(x));
const shared={mode:'hybrid',system_prompt:'共用提示词',rules:[{id:'r',contains:'规格',reply:'请补充车型'}]};
const tpl={template_id:'a'.repeat(32),name:'共用模版',version:3,...shared};
const local={enabled:false,mode:'rules',system_prompt:'本店原有提示词',rules:[],fallback:{error:{action:'none'}},version:11};
const response=(data,status=200)=>({ok:status<400,status,text:async()=>JSON.stringify(data)});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const mutations=calls=>calls.filter(c=>c.method!=='GET');
function setup(handler) {
  const ids={},calls=[];let next=1;
  const server={shops:[{shop_id:'a',name:'虚构甲店',settings:plain(local)},{shop_id:'b',name:'虚构乙店',settings:plain(local)}],templates:[plain(tpl)]};
  const document={createElement:t=>new Element(t),getElementById:id=>ids[id]??=new Element('div'),querySelectorAll:()=>[]};
  const window={confirm:()=>true,prompt:(_q,value)=>value||'新模版',location:{hash:''},scrollTo(){},setInterval:()=>1,clearInterval(){}};
  const ctx={document,window,URL,Date,console,setTimeout:()=>1,clearTimeout(){},fetch:async(url,opts)=>{
    const call={url,method:opts.method,body:opts.body?JSON.parse(opts.body):null};calls.push(call);
    if (handler) { const custom=handler(call,server);if(custom!==undefined)return custom; }
    if (url==='/api/v1/admin/shops') return response(server);
    if (url==='/api/v1/admin/summary') return response({protocol_version:'1.0',counts:{pending:0,processing:0,ready:0,sent:0,unknown:0}});
    if (url==='/api/v1/admin/reply-templates') {
      const data={...call.body,template_id:(next++).toString(16).padStart(32,'0'),version:1};server.templates.push(data);return response(data,201);
    }
    if (url.startsWith('/api/v1/admin/reply-templates/')) {
      const id=url.split('/').pop(),i=server.templates.findIndex(t=>t.template_id===id);
      if (server.templates[i].version!==call.body.version)return response({error:{code:'template_changed'}},409);
      const data={...call.body,template_id:id,version:call.body.version+1};server.templates[i]=data;return response(data);
    }
    const shop=server.shops.find(s=>url==='/api/v1/admin/shops/'+s.shop_id+'/settings');
    if (shop) { shop.settings={...call.body,version:shop.settings.version+1};return response(shop.settings); }
    throw Error('unexpected fictional request '+url);
  }};
  vm.runInNewContext(source,ctx);const h=ctx.fixture;
  h.IDS.forEach(id=>h.el[id]=document.getElementById(id));
  Object.assign(h.state,{token:'fictional-session',selectedShopId:'a',shops:plain(server.shops),templates:plain(server.templates),formDisabled:false});
  h.renderSettings(plain(local));
  return {h,ids,calls,window,server};
}
let passed=0;
(async()=>{
  {
    const {h,ids}=setup();
    h.state.shopStatus='ok';
    h.state.shops[0].decision_runtime={mode:'conversation_brain',enabled:true,persistent_memory:true,total_budget_seconds:20,
      models:[{slot:'backup',model:'<img src=x onerror=alert(1)>',configured:true,timeout_seconds:15},
        {slot:'primary',model:'local',configured:true,timeout_seconds:15}]};
    h.state.shops[1].decision_runtime={mode:'rules',enabled:false,brain_configured:true,models:[]};
    h.renderDecisionRuntime();
    const text=node=>node.textContent+node.children.map(text).join('');
    assert.match(text(ids['shop-decision-runtime']),/新决策模式 · 已启用/);
    assert.match(text(ids['shop-decision-runtime']),/单次 15 秒/);
    assert.match(text(ids['shop-decision-runtime']),/最多 20 秒/);
    assert.equal(ids['shop-decision-runtime'].querySelectorAll('img').length,0);
    assert.match(text(ids['shop-decision-runtime']),/<img src=x/);
    h.state.selectedShopId='b';h.renderDecisionRuntime();
    assert.match(text(ids['shop-decision-runtime']),/纯规则 · 已暂停/);
    assert.match(text(ids['shop-decision-runtime']),/不调用模型/);
    h.state.shopStatus='error';h.renderDecisionRuntime();
    assert.match(text(ids['model-decision-runtime']),/状态未确认/);
    assert.doesNotMatch(text(ids['model-decision-runtime']),/已启用|单次 15/);
    h.state.shops=[];h.renderDecisionRuntime();
    assert.doesNotMatch(text(ids['model-decision-runtime']),/虚构甲店|cloud|local/);
    passed++;
  }
  {
    const {h,ids,calls}=setup();
    assert.equal(ids['prompt-input'].value,local.system_prompt);assert.equal(h.state.editor.id,'');
    ids['prompt-input'].value='另一份尚未保存的模版';h.onFormEdit();
    ids['template-select'].value=tpl.template_id;h.onTemplateChange();
    assert.equal(ids['prompt-input'].value,'另一份尚未保存的模版');assert.equal(h.state.editor.dirty,true);
    assert.equal(h.state.formDirty,true);assert.equal(h.state.templateVersion,3);assert.equal(calls.length,0);passed++;
    await h.saveSettings();const body=mutations(calls)[0].body;
    assert.equal(body.system_prompt,tpl.system_prompt);assert.deepEqual(body.rules,tpl.rules);
    assert.equal(body.template_id,tpl.template_id);assert.equal(body.template_version,3);
    assert.equal(body.enabled,false);assert.equal(ids['prompt-input'].value,'另一份尚未保存的模版');passed++;
  }
  {
    const {h,ids,calls}=setup();ids['prompt-input'].value='不能偷存到店铺';h.onFormEdit();
    ids['enabled-input'].checked=true;h.onShopFormEdit();await h.saveSettings();
    const body=mutations(calls)[0].body;assert.equal(body.enabled,true);assert.equal(body.system_prompt,local.system_prompt);
    assert.equal(body.template_id,null);assert.deepEqual(body.rules,local.rules);assert.equal(h.state.editor.dirty,true);passed++;
  }
  {
    const {h,ids,calls}=setup();h.renderSettings({...local,...shared,template_id:tpl.template_id,template_version:3});
    ids['template-select'].value='';h.onTemplateChange();await h.saveSettings();
    assert.equal(mutations(calls)[0].body.template_id,null);assert.equal(mutations(calls)[0].body.system_prompt,shared.system_prompt);passed++;
  }
  {
    const {h,ids,calls}=setup();h.newTemplate();assert.equal(ids['prompt-input'].value,'');assert.equal(h.state.rules.length,0);
    ids['template-name'].value='新模版';ids['prompt-input'].value='新提示词';h.onFormEdit();await h.saveTemplate(false);await tick();
    const request=mutations(calls)[0];assert.equal(request.method,'POST');assert.equal(request.url,'/api/v1/admin/reply-templates');
    assert.deepEqual(Object.keys(request.body).sort(),['mode','name','rules','system_prompt']);
    assert.equal(h.state.templateId,'');assert.equal(h.state.shops[0].settings.template_id,undefined);
    assert.equal(ids['enabled-input'].checked,false);assert.equal(h.state.editor.id.length,32);assert.equal(h.state.editor.dirty,false);passed++;
  }
  {
    const {h,ids,calls}=setup();h.loadTemplateEditor(tpl);ids['prompt-input'].value='编辑已保存模版';h.onFormEdit();
    await h.saveTemplate(false);await tick();const request=mutations(calls)[0];
    assert.equal(request.method,'PUT');assert.equal(request.url,'/api/v1/admin/reply-templates/'+tpl.template_id);
    assert.equal(request.body.version,3);assert.equal(h.state.editor.version,4);assert.equal(h.state.templateId,'');passed++;
  }
  {
    const {h,ids,calls,window}=setup();h.loadTemplateEditor(tpl);window.prompt=()=> '独立副本';
    await h.saveTemplate(true);await tick();assert.equal(mutations(calls)[0].method,'POST');
    assert.equal(mutations(calls)[0].body.version,undefined);assert.equal(h.state.templates.find(t=>t.template_id===tpl.template_id).version,3);
    assert.equal(h.state.editor.id===tpl.template_id,false);assert.equal(ids['template-name'].value,'独立副本');passed++;
  }
  {
    let done;const {h,ids,calls}=setup(c=>c.method==='POST'?new Promise(r=>{done=r;}):undefined);
    const pending=h.saveTemplate(false);await h.saveTemplate(false);assert.equal(mutations(calls).length,1);
    ids['prompt-input'].value='等待时继续输入';h.onFormEdit();done(response({...tpl,template_id:'b'.repeat(32),version:1}));
    await pending;await tick();assert.equal(ids['prompt-input'].value,'等待时继续输入');assert.equal(h.state.editor.dirty,true);
    assert.equal(h.state.editor.version,1);assert.equal(h.state.editor.id,'b'.repeat(32));passed++;
  }
  {
    let done;const {h}=setup(c=>c.method==='POST'?new Promise(r=>{done=r;}):undefined);const pending=h.saveTemplate(false);
    h.state.epoch++;h.state.templates=[];done(response({...tpl,version:1}));await pending;
    assert.equal(h.state.templates.length,0);assert.equal(h.state.editor.id,'');passed++;
  }
  {
    let done;const {h,ids,calls,window}=setup((c,server)=>c.method==='POST'?new Promise(resolve=>{done=data=>{server.templates.push(data);resolve(response(data,201));};}):undefined);
    h.loadTemplateEditor(tpl);window.prompt=()=> '延迟副本';const pending=h.saveTemplate(true);
    ids['prompt-input'].value='等待另存期间继续编辑';h.onFormEdit();
    done({...tpl,template_id:'b'.repeat(32),name:'延迟副本',version:1});await pending;await tick();
    assert.equal(ids['template-name'].value,'延迟副本');assert.equal(ids['prompt-input'].value,'等待另存期间继续编辑');
    await h.saveTemplate(false);await tick();const next=mutations(calls)[1];
    assert.equal(next.method,'PUT');assert.equal(next.body.name,'延迟副本');assert.equal(next.body.system_prompt,'等待另存期间继续编辑');passed++;
  }
  {
    const {h,ids}=setup();h.loadTemplateEditor(tpl);ids['prompt-input'].value='本地编辑';h.onFormEdit();
    h.applyTemplatesSnapshot([{...tpl,version:4,system_prompt:'别处更新'}]);
    assert.equal(ids['prompt-input'].value,'本地编辑');assert.equal(h.state.editor.version,3);
    assert.match(ids['template-editor-status'].textContent,/已有更新/);passed++;
    h.resetTemplateEditor();assert.equal(ids['prompt-input'].value,'别处更新');assert.equal(h.state.editor.version,4);passed++;
  }
  {
    const {h,ids}=setup();h.loadTemplateEditor(tpl);
    h.applyTemplatesSnapshot([{...tpl,version:4,system_prompt:'最新已保存内容'}]);
    h.applyTemplatesSnapshot([tpl]);assert.equal(ids['prompt-input'].value,'最新已保存内容');assert.equal(h.state.editor.version,4);passed++;
  }
  {
    const {h,ids}=setup(c=>c.method==='PUT'?response({error:{code:'template_changed'}},409):undefined);
    h.loadTemplateEditor(tpl);ids['prompt-input'].value='版本冲突草稿';h.onFormEdit();await h.saveTemplate(false);await tick();
    assert.equal(ids['prompt-input'].value,'版本冲突草稿');assert.equal(h.state.editor.version,3);
    assert.equal(h.state.editor.dirty,true);assert.match(ids['template-editor-status'].textContent,/已有更新/);passed++;
  }
  {
    const {h,ids,window}=setup();h.loadTemplateEditor(tpl);ids['prompt-input'].value='未保存';h.onFormEdit();window.confirm=()=>false;
    h.newTemplate();assert.equal(ids['prompt-input'].value,'未保存');h.resetTemplateEditor();assert.equal(ids['prompt-input'].value,'未保存');
    ids['template-editor-select'].value='';h.onEditorTemplateChange();assert.equal(h.state.editor.id,tpl.template_id);passed++;
  }
  {
    const {h,ids,calls}=setup();ids['template-name'].value='😀'.repeat(50);h.onFormEdit();await h.saveTemplate(false);await tick();
    assert.equal(mutations(calls)[0].body.name,'😀'.repeat(50));passed++;
    h.applyTemplatesSnapshot([{...tpl,name:'<img src=x onerror=alert(1)>'}]);
    assert.equal(ids['template-editor-select'].children.find(n=>n.value===tpl.template_id).textContent,'<img src=x onerror=alert(1)>');passed++;
  }
  {
    const {h,ids}=setup();h.loadTemplateEditor(tpl);assert.equal(ids['template-prompt-section'].open,false);
    assert.match(ids['template-prompt-summary'].textContent,/5字/);assert.match(ids['template-rules-summary'].textContent,/1条/);
    h.showRulesError('虚构错误');assert.equal(ids['template-rules-section'].open,true);passed++;
  }
  {
    const html=fs.readFileSync(path.join(__dirname,'../backend/static/index.html'),'utf8');
    const shops=html.slice(html.indexOf('<section id="page-scripts"'),html.indexOf('<section id="page-templates"'));
    const templates=html.slice(html.indexOf('<section id="page-templates"'),html.indexOf('<section id="page-chat-import"'));
    assert.match(html,/data-route="templates"/);assert.match(shops,/>店铺配置</);assert.match(templates,/>话术模版</);
    assert(shops.includes('id="product-learning"'));assert(!templates.includes('id="product-learning"'));
    assert(!shops.includes('id="prompt-input"'));assert(!shops.includes('id="rules-list"'));
    assert(templates.includes('id="prompt-input"'));assert(templates.includes('id="rules-list"'));
    for(const id of ['template-mode-section','template-prompt-section','template-rules-section'])assert.match(templates,new RegExp('<details id="'+id+'"'));
    const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);passed++;
  }
  console.log(JSON.stringify({passed,actualManagementCode:true,fictionalHttp:true,platform:false}));
})().catch(e=>{console.error(e);process.exitCode=1;});
