import {SCENARIOS} from './scenarios.mjs';

const $=id=>document.getElementById(id);
const iframe=$('preview');
const stage=$('preview-stage');
const mount=$('frame-mount');
const sizes={S:[360,800],M:[390,844],L:[430,932],D:[1280,900]};
const groups=[['E','在家首页'],['G','需求卡与回应'],['H','发送成功'],['F','旅行首页']];
const actions=[
  ['arrive-need','一封需求卡到达','模拟一封需求卡到达；不自动打开，也不代替用户已读。'],
  ['arrive-postcard','一封明信片到达','模拟明信片到达；完整详情属于第三批。'],
  ['trip','小猫出发旅行','模拟独立出发；与是否回应无关。'],
  ['home','小猫回家','模拟回家；已有未读信仍保留。'],
  ['read-postcard','标记明信片已读','仅模拟明信片已读；不会结束旅行。'],
  ['old-draft','打开既有旧草稿','尝试打开已经读过的需求卡；没有对应旧卡时不改变页面。'],
  ['send-error','下一次发送失败','故障已设为下次发送使用；请在回复框点击“送出去”。'],
  ['save-error','下一次保存失败','故障已设为下次保存使用；请在回复框继续输入。'],
  ['check-error','下一次检查失败','故障已设为下次提交使用；请在回复框点击“送出去”。'],
  ['safety','下一次安全处理','仅手动模拟系统安全路径，不真实分析输入内容。请在回复框点击“送出去”。'],
  ['refresh-error','模拟读取失败','模拟读取失败；若已经送出，仍保留成功事实。'],
];
let scenario=SCENARIOS.find(item=>item.id==='E-new-letter-M') || SCENARIOS[0];
let mode='scenario';
let cat='cat-01';
let width=scenario.width,height=scenario.height;
let fit=true;
let connected=false;
let loadTimer;

function sizeKey(){return Object.keys(sizes).find(key=>sizes[key][0]===width&&sizes[key][1]===height)||'M';}
function setConnected(value){connected=value;document.querySelectorAll('[data-simulate]').forEach(button=>{button.disabled=!value;});}
function scenarioButtons(){
  const list=$('scenario-list');
  for(const [page,label] of groups){
    const entries=SCENARIOS.filter(item=>item.page===page);
    const details=document.createElement('details');details.className='scenario-group';details.open=page==='E';details.dataset.page=page;
    const summary=document.createElement('summary');summary.append(document.createTextNode(`${page} · ${label}`));const count=document.createElement('span');count.textContent=String(entries.length);summary.append(count);details.append(summary);
    const options=document.createElement('div');options.className='scenario-options';
    for(const item of entries){const button=document.createElement('button');button.type='button';button.className='scenario-button';button.dataset.scenario=item.id;button.title=item.note;const text=document.createElement('span');text.textContent=item.label;const size=document.createElement('span');size.className='scenario-size';size.textContent=item.id.slice(item.id.lastIndexOf('-')+1);button.append(text,size);options.append(button);}
    details.append(options);list.append(details);
  }
  $('scenario-count').textContent=String(SCENARIOS.length);
  for(const [action,label,note] of actions){const button=document.createElement('button');button.type='button';button.dataset.simulate=action;button.textContent=label;button.title=note;button.disabled=true;$('simulation-actions').append(button);}
}
function previewUrl(){const url=new URL('./index.html',location.href);if(mode==='scenario'){url.searchParams.set('scenario',scenario.id);url.searchParams.set('cat',cat);}return url.href;}
function updateControls(){
  const live=mode==='live';
  $('mode-scenario').setAttribute('aria-pressed',String(!live));$('mode-live').setAttribute('aria-pressed',String(live));
  $('mode-note').textContent=live?'连续体验使用当前浏览器保存的演示数据；手动事件会改变这份本机数据。':'场景数据相互隔离，不改连续体验的本机数据。';
  $('cat-select').disabled=live;
  $('cat-note').textContent=live?'连续体验保持本机小猫，不通过审阅工具换猫。':'只替换当前审阅场景的参考猫。';
  $('scenario-list').setAttribute('aria-disabled',String(live));
  document.querySelectorAll('[data-scenario]').forEach(button=>{button.disabled=live;const selected=!live&&button.dataset.scenario===scenario.id;button.setAttribute('aria-current',String(selected));});
  $('tool-summary').textContent=live?'连续体验':`${SCENARIOS.length} 个场景`;
  $('preview-heading').textContent=live?'连续体验 · 本机保存':`${scenario.page} / ${scenario.label}`;
  $('scenario-note').textContent=live?'从当前保存的位置继续；这份预览不会伪造云端同步或后台事件。':scenario.note;
  $('open-preview').href=previewUrl();
  iframe.title=live?'有猫来信连续体验产品预览':`${scenario.page} ${scenario.label}产品预览`;
  document.querySelectorAll('[data-size]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.size===sizeKey())));
  $('fit-toggle').textContent=fit?'适配容器':'原尺寸';$('fit-toggle').setAttribute('aria-pressed',String(fit));
}
function resizePreview(){
  const computed=getComputedStyle(stage);
  const available=Math.max(1,stage.clientWidth-parseFloat(computed.paddingLeft)-parseFloat(computed.paddingRight));
  const scale=fit?Math.min(1,available/width):1;
  iframe.style.width=`${width}px`;iframe.style.height=`${height}px`;iframe.style.transform=`scale(${scale})`;
  iframe.width=width;iframe.height=height;mount.style.width=`${width*scale}px`;mount.style.height=`${height*scale}px`;
  const prescribed=mode==='scenario'&& (width!==scenario.width||height!==scenario.height)?` · 此场景原稿 ${scenario.width} × ${scenario.height}`:'';
  $('viewport-caption').textContent=`${sizeKey()} · ${width} × ${height} CSS px · 显示 ${Math.round(scale*100)}%${scale<1?'（仅缩放审阅画面，内部视口不变）':''}${prescribed} · 长内容在框内滚动`;
}
function waiting(){setConnected(false);$('connection-status').textContent='正在载入产品预览…';$('state-summary').replaceChildren();const pair=document.createElement('div'),term=document.createElement('dt'),value=document.createElement('dd');term.textContent='预览';value.textContent='等待状态';pair.append(term,value);$('state-summary').append(pair);}
function loadPreview(){
  clearTimeout(loadTimer);waiting();updateControls();resizePreview();
  $('simulation-feedback').textContent='手动模拟只在预览就绪后启用。';iframe.src=previewUrl();
  loadTimer=setTimeout(()=>{if(!connected){$('connection-status').textContent='尚未收到状态，可重新载入或新窗口检查。';}},7000);
}
function setMode(next){if(mode===next)return;mode=next;loadPreview();}
function selectScenario(id){const selected=SCENARIOS.find(item=>item.id===id);if(!selected)return;scenario=selected;width=selected.width;height=selected.height;loadPreview();if(matchMedia('(max-width:760px)').matches)$('review-tools').open=false;}
function describeState(state){
  const names={E:'在家首页',F:'旅行首页',G:'需求卡与回应',H:'发送成功'};
  const draftNames={IDLE:'未触发保存',SAVING:'保存中',SAVED:'已保存',ERROR:'保存失败'};
  const submitNames={IDLE:'尚未发送',SUBMITTING:'发送中',SUCCESS:'已送出',ERROR:'发送失败',UNKNOWN:'结果待确认'};
  const letters=Array.isArray(state.letters)?state.letters:[];
  const current=letters.find(letter=>letter?.id===state.currentLetterId);
  const rows=[['页面',names[state.page]||String(state.page||'—')],['小猫',state.catState==='TRIP'?'旅行中':state.catState==='HOME'?'在家':'—'],['新信',state.newLetterId?String(state.newLetterId):'没有'],['草稿',draftNames[state.draftSaveState]||String(state.draftSaveState||'—')],['回应',submitNames[state.replySubmitState]||String(state.replySubmitState||'—')]];
  if(current)rows.push(['当前文字',`${Number.isFinite(current.draftLength)?current.draftLength:0} 字符`]);
  const fragment=document.createDocumentFragment();for(const [term,value] of rows){const item=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=term;dd.textContent=value;item.append(dt,dd);fragment.append(item);}$('state-summary').replaceChildren(fragment);
}
scenarioButtons();
$('mode-scenario').addEventListener('click',()=>setMode('scenario'));
$('mode-live').addEventListener('click',()=>setMode('live'));
$('cat-select').addEventListener('change',event=>{if(mode!=='scenario')return;cat=event.target.value;loadPreview();});
$('scenario-list').addEventListener('click',event=>{const button=event.target.closest('button[data-scenario]');if(button&&!button.disabled)selectScenario(button.dataset.scenario);});
document.querySelectorAll('[data-size]').forEach(button=>button.addEventListener('click',()=>{[width,height]=sizes[button.dataset.size];updateControls();resizePreview();}));
$('fit-toggle').addEventListener('click',()=>{fit=!fit;updateControls();resizePreview();});
$('reload-preview').addEventListener('click',loadPreview);
$('simulation-actions').addEventListener('click',event=>{const button=event.target.closest('[data-simulate]');if(!button||!connected)return;const definition=actions.find(item=>item[0]===button.dataset.simulate);if(!definition)return;iframe.contentWindow.postMessage({type:'daily-review-action',action:definition[0]},location.origin);$('simulation-feedback').textContent=`已发出手动模拟指令：${definition[2]}`;});
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==iframe.contentWindow||event.data?.type!=='daily-state'||!event.data.state||typeof event.data.state!=='object')return;clearTimeout(loadTimer);setConnected(true);$('connection-status').textContent=mode==='scenario'?'场景已就绪 · 隔离数据':'连续体验已就绪 · 本机保存';describeState(event.data.state);});
iframe.addEventListener('load',()=>{resizePreview();if(connected)return;$('connection-status').textContent='页面已载入，等待产品状态…';});
const mobile=matchMedia('(max-width:760px)');
function setToolDisclosure(){ $('review-tools').open=!mobile.matches; }
setToolDisclosure();mobile.addEventListener('change',setToolDisclosure);
new ResizeObserver(resizePreview).observe(stage);
window.addEventListener('resize',resizePreview);
loadPreview();
