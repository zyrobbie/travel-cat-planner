import {SCENARIOS} from './scenarios.mjs?v=seven-demands-20261002';
import {DEMAND_SEQUENCE} from './demand-catalog.mjs';
import {PREVIEW_IDENTITY_KEY} from '../ui-adoption-flow-v1/preview-identity.mjs';

const $=id=>document.getElementById(id);
const iframe=$('preview');
const stage=$('preview-stage');
const mount=$('frame-mount');
const mobile=matchMedia('(max-width:760px)');
const sizes={S:[360,800],M:[390,844],L:[430,932],D:[1440,900]};
const groups=[['E','在家首页'],['G','需求卡与回应'],['H','发送成功'],['F','旅行首页']];
const actions=[
  ['arrive-need','一封需求卡到达','模拟一封需求卡到达；不自动打开，也不代替用户已读。'],
  ['arrive-postcard','一封明信片到达','模拟明信片到达；可打开最小阅读页。'],
  ['trip','小猫出发旅行','模拟独立出发；与是否回应无关。'],
  ['home','小猫回家','模拟回家；已有未读信仍保留。'],
  ['read-postcard','模拟明信片读后状态','只改变本次审阅的已读状态；不会结束旅行。'],
  ['old-draft','打开既有旧草稿','尝试打开已经读过的需求卡；没有对应旧卡时不改变页面。'],
  ['send-error','下一次发送失败','故障已设为下次发送使用；请在回复框点击“送出去”。'],
  ['save-error','下一次保存失败','故障已设为下次保存使用；请在回复框继续输入。'],
  ['check-error','下一次检查失败','故障已设为下次提交使用；请在回复框点击“送出去”。'],
  ['safety','下一次安全处理','仅手动模拟系统安全路径，不真实分析输入内容。请在回复框点击“送出去”。'],
  ['refresh-error','模拟读取失败','模拟读取失败；若已经送出，仍保留成功事实。'],
];
let scenario=SCENARIOS.find(item=>item.id==='E-new-letter-M') || SCENARIOS[0];
let mode=new URLSearchParams(location.search).get('mode')==='live'?'live':'scenario';
let cat='cat-01';
let width=scenario.width,height=scenario.height;
let fit=true;
let connected=false, childPage=null,childState=null,queuedQuick=null,pendingQuickTrip=null,pendingQuickOpen=null,quickRequest=0;
let loadTimer;
let fixedSimulation=false,frameHeight=360;

function sizeKey(){return Object.keys(sizes).find(key=>sizes[key][0]===width&&sizes[key][1]===height)||'M';}
function setConnected(value){connected=value;document.querySelectorAll('[data-simulate]').forEach(button=>{button.disabled=!value||mode!=='scenario';});$('deliver-next-demand').disabled=!value||mode!=='live'||!['E','F','G','I','J','K','R'].includes(childPage);for(const id of ['start-trip','end-trip','deliver-travel'])$(id).disabled=!value||mode!=='live'||!['E','F','G','I','J','K','R'].includes(childPage);document.querySelectorAll('[data-live-failure]').forEach(button=>button.disabled=!value||mode!=='live');}
function demandLinks(){
  const labels=['橘白','狸花','奶油白','三花'];
  for(const demand of DEMAND_SEQUENCE){
    const group=document.createElement('div');group.className='demand-group';
    const title=document.createElement('p');title.textContent=`${demand.eventId==='LIGHT'?'追光':demand.eventId} · ${demand.title}`;
    const links=document.createElement('div');links.className='demand-links';
    labels.forEach((label,index)=>{
      const catId=`cat-0${index+1}`,url=new URL('./index.html',location.href);
      url.searchParams.set('reviewDemand',demand.id);url.searchParams.set('cat',catId);
      const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';
      link.textContent=label;link.setAttribute('aria-label',`${demand.title} · ${label} · 独立审阅`);links.append(link);
    });
    group.append(title,links);$('demand-list').append(group);
  }
}
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
function previewUrl(){const url=new URL('./index.html',location.href);url.searchParams.set('v','mobile-shell-20261003');if(mode==='scenario'){url.searchParams.set('scenario',scenario.id);url.searchParams.set('cat',cat);}return url.href;}
function fluidMode(){return mobile.matches&&!fixedSimulation;}
function mobileFrameHeight(){return Math.max(420,Math.min(720,Math.round((visualViewport?.height||innerHeight)*.76)));}
function updateControls(){
  const live=mode==='live';
  $('mode-scenario').setAttribute('aria-pressed',String(!live));$('mode-live').setAttribute('aria-pressed',String(live));
  $('mode-note').textContent=live?'连续体验使用当前浏览器保存的预览数据；场景模拟不可用，手动投递仍可用。':'场景数据相互隔离；手动模拟只作用于当前场景，不改连续体验的本机数据。';
  $('quick-live').textContent=live?'正在看连续体验':'打开连续体验';$('quick-live').setAttribute('aria-pressed',String(live));
  setConnected(connected);
  $('cat-select').disabled=live;
  $('cat-note').textContent=live?'连续体验保持本机小猫，不通过审阅工具换猫。':'只替换当前审阅场景的参考猫。';
  $('scenario-list').setAttribute('aria-disabled',String(live));
  document.querySelectorAll('[data-scenario]').forEach(button=>{button.disabled=live;const selected=!live&&button.dataset.scenario===scenario.id;button.setAttribute('aria-current',String(selected));});
  $('tool-summary').textContent=live?'连续体验':`${SCENARIOS.length} 个场景`;
  $('preview-heading').textContent=live?'连续体验 · 本机保存':`初始样例 ${scenario.page} / ${scenario.label}`;
  $('scenario-note').textContent=live?'从当前保存的位置继续；这份预览不会伪造云端同步或后台事件。':scenario.note;
  $('open-preview').href=previewUrl();
  iframe.title=live?'有猫来信连续体验产品预览':`${scenario.page} ${scenario.label}产品预览`;
  document.querySelectorAll('[data-size]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.size===sizeKey())));
  $('fit-toggle').textContent=fit?'适配容器':'原尺寸';$('fit-toggle').setAttribute('aria-pressed',String(fit));
}
function resizePreview(){
  const fluid=fluidMode();
  stage.classList.toggle('is-fluid',fluid);
  $('fixed-toggle').hidden=!mobile.matches;
  $('fixed-toggle').setAttribute('aria-pressed',String(fixedSimulation));
  document.querySelector('.size-buttons').hidden=fluid;
  $('fit-toggle').hidden=fluid;
  if(fluid){
    const computed=getComputedStyle(stage);
    const available=Math.max(1,stage.clientWidth-parseFloat(computed.paddingLeft)-parseFloat(computed.paddingRight)-2);
    frameHeight=mobileFrameHeight();
    iframe.style.width=`${available}px`;iframe.width=available;
    iframe.style.height=`${frameHeight}px`;iframe.height=frameHeight;
    iframe.style.transform='none';mount.style.width=`${available}px`;mount.style.height=`${frameHeight}px`;
    $('viewport-caption').textContent=`手机独立视口 · ${available} × ${frameHeight} CSS px · 信件在框内滚动，审阅工具在框外`;
    return;
  }
  const computed=getComputedStyle(stage);
  const available=Math.max(1,stage.clientWidth-parseFloat(computed.paddingLeft)-parseFloat(computed.paddingRight));
  const scale=fit?Math.min(1,available/width):1;
  iframe.style.width=`${width}px`;iframe.style.height=`${height}px`;iframe.style.transform=`scale(${scale})`;
  iframe.width=width;iframe.height=height;mount.style.width=`${width*scale}px`;mount.style.height=`${height*scale}px`;
  const prescribed=mode==='scenario'&& (width!==scenario.width||height!==scenario.height)?` · 此场景原稿 ${scenario.width} × ${scenario.height}`:'';
  $('viewport-caption').textContent=`${sizeKey()} · ${width} × ${height} CSS px · 显示 ${Math.round(scale*100)}%${scale<1?'（仅缩放审阅画面，内部视口不变）':''}${prescribed} · 长内容在框内滚动`;
}
function showPreviewError(){
  if(connected)return;
  clearTimeout(loadTimer);mount.hidden=true;$('preview-error').hidden=false;
  $('connection-status').textContent='预览未能显示 · 可重新载入';
}
function waiting(){childPage=null;childState=null;pendingQuickOpen=null;setConnected(false);$('connection-status').textContent='正在载入产品预览…';$('state-summary').replaceChildren();const pair=document.createElement('div'),term=document.createElement('dt'),value=document.createElement('dd');term.textContent='预览';value.textContent='等待状态';pair.append(term,value);$('state-summary').append(pair);}
function loadPreview(){
  clearTimeout(loadTimer);waiting();updateControls();frameHeight=mobileFrameHeight();
  mount.hidden=false;$('preview-error').hidden=true;
  $('simulation-feedback').textContent='手动模拟只在预览就绪后启用。';iframe.src=previewUrl();resizePreview();
  loadTimer=setTimeout(()=>{if(!connected)showPreviewError();},7000);
}
function setMode(next){if(mode===next)return;mode=next;const url=new URL(location.href);if(next==='live')url.searchParams.set('mode','live');else url.searchParams.delete('mode');history.replaceState(null,'',url);if(next!=='live')queuedQuick=null;loadPreview();}
function selectScenario(id){const selected=SCENARIOS.find(item=>item.id===id);if(!selected)return;scenario=selected;width=selected.width;height=selected.height;loadPreview();if(matchMedia('(max-width:760px)').matches)$('review-tools').open=false;}
function describeState(state){
  const names={WELCOME:'待领养',ERROR:'身份读取异常',E:'在家首页',F:'旅行中同一个家',G:'需求卡与回应',H:'发送成功',I:'明信片阅读',J:'来信盒',K:'回应管理',R:'回应记录'};
  const draftNames={IDLE:'未触发保存',SAVING:'保存中',SAVED:'已保存',ERROR:'保存失败'};
  const submitNames={IDLE:'尚未发送',SUBMITTING:'发送中',SUCCESS:'已送出',ERROR:'发送失败',UNKNOWN:'结果待确认'};
  const letters=Array.isArray(state.letters)?state.letters:[];
  const current=letters.find(letter=>letter?.id===state.currentLetterId);
  const rows=[['页面',names[state.page]||String(state.page||'—')],['小猫',state.catState==='TRIP'?'旅行中':state.catState==='HOME'?'在家':'—'],['新信',state.newLetterId?String(state.newLetterId):'没有'],['草稿',draftNames[state.draftSaveState]||String(state.draftSaveState||'—')],['回应',submitNames[state.replySubmitState]||String(state.replySubmitState||'—')]];
  if(current)rows.push(['当前文字',`${Number.isFinite(current.draftLength)?current.draftLength:0} 字符`]);
  const fragment=document.createDocumentFragment();for(const [term,value] of rows){const item=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=term;dd.textContent=value;item.append(dt,dd);fragment.append(item);}$('state-summary').replaceChildren(fragment);
}
function quickFeedback(message){$('quick-feedback').textContent=message;}
function quickStateChanged(){
  const live=mode==='live',needsAdoption=live&&childPage==='WELCOME';
  $('quick-adopt').hidden=!needsAdoption;
  $('quick-open-letter').hidden=!live||!childState?.newLetterId;
  if(needsAdoption){queuedQuick=null;pendingQuickTrip=null;quickFeedback('这台浏览器还没有领养小猫。先领养，再回来手动投递。');return;}
  if(live&&childPage==='ERROR'){queuedQuick=null;pendingQuickTrip=null;quickFeedback('本机身份与记录暂时不一致。请先在预览中重新读取，原记录会保留。');return;}
  if(live&&queuedQuick){const action=queuedQuick;queuedQuick=null;runQuick(action);}
}
function postLiveAction(action,extra={}){const requestId=`quick-${++quickRequest}`;iframe.contentWindow.postMessage({type:'daily-review-action',action,requestId,...extra},location.origin);return requestId;}
function runQuick(kind){
  if(mode!=='live'){queuedQuick=kind;quickFeedback('正在打开连续体验…');setMode('live');return;}
  if(!connected||!childState){queuedQuick=kind;quickFeedback('正在载入连续体验…');loadPreview();return;}
  if(childPage==='WELCOME'||childPage==='ERROR'){quickStateChanged();return;}
  if(childState.newLetterId){quickFeedback('已有一封未读来信。先打开它，原有来信与草稿不会被覆盖。');$('quick-open-letter').hidden=false;return;}
  $('quick-open-letter').hidden=true;
  if(kind==='demand'){quickFeedback('正在手动投递一封需求来信…');postLiveAction('deliver-next-demand');return;}
  const sceneId=$('quick-scene').value;
  if(childState.catState!=='TRIP'){
    quickFeedback('正在手动让小猫出发，然后投递普通旅行信…');pendingQuickTrip={sceneId,requestId:postLiveAction('trip')};
  }else{quickFeedback('正在手动投递普通旅行信…');postLiveAction('deliver-travel',{sceneId,linked:false});}
}
scenarioButtons();demandLinks();
$('quick-live').addEventListener('click',()=>{if(mode==='live'){quickFeedback('正在连续体验；可在此手动投递测试来信。');return;}quickFeedback('正在打开连续体验…');setMode('live');});
$('quick-demand').addEventListener('click',()=>runQuick('demand'));
$('quick-travel').addEventListener('click',()=>runQuick('travel'));
$('quick-open-letter').addEventListener('click',()=>{if(mode!=='live'||!connected||!childState?.newLetterId){quickFeedback('当前没有待打开的未读来信。');return;}quickFeedback('正在打开这封来信…');pendingQuickOpen=postLiveAction('open-new-letter');});
$('mode-scenario').addEventListener('click',()=>setMode('scenario'));
$('mode-live').addEventListener('click',()=>setMode('live'));
$('cat-select').addEventListener('change',event=>{if(mode!=='scenario')return;cat=event.target.value;loadPreview();});
$('scenario-list').addEventListener('click',event=>{const button=event.target.closest('button[data-scenario]');if(button&&!button.disabled)selectScenario(button.dataset.scenario);});
document.querySelectorAll('[data-size]').forEach(button=>button.addEventListener('click',()=>{[width,height]=sizes[button.dataset.size];updateControls();resizePreview();}));
$('fit-toggle').addEventListener('click',()=>{fit=!fit;updateControls();resizePreview();});
$('fixed-toggle').addEventListener('click',()=>{fixedSimulation=!fixedSimulation;frameHeight=360;updateControls();resizePreview();});
$('reload-preview').addEventListener('click',loadPreview);
$('retry-preview').addEventListener('click',loadPreview);
$('reset-preview').addEventListener('click',()=>{
  if(!confirm('只清除本机的两批新版 Pages 预览测试数据，并重新从选猫开始？正式 /app/ 存档和旧版预览记录不会被清除。'))return;
  try{
    localStorage.removeItem(PREVIEW_IDENTITY_KEY);
    localStorage.removeItem('cat-letters-e3-g2r:daily-v1');
    const markerKey='cat-letters-e3-g2r:daily-v1:legacy-import';
    const marker=JSON.parse(localStorage.getItem(markerKey)||'{}');
    localStorage.setItem(markerKey,JSON.stringify({...marker,reset:true,suppressReimport:true}));
    sessionStorage.setItem('cat-letters-e3-g2r:adoption-session-v1',JSON.stringify({version:1,state:{step:'A',selectedCatId:null,catNameDraft:'',adoptionStatus:'UNCONFIRMED',confirmedCat:null},storedResult:null}));
    loadPreview();
    $('simulation-feedback').textContent='两批新版预览测试数据已重置。可以从选猫开始。';
  }catch{
    $('simulation-feedback').textContent='暂时没能重置测试数据；原记录仍需保留，请稍后再试。';
  }
});
$('simulation-actions').addEventListener('click',event=>{const button=event.target.closest('[data-simulate]');if(!button||!connected||mode!=='scenario')return;const definition=actions.find(item=>item[0]===button.dataset.simulate);if(!definition)return;iframe.contentWindow.postMessage({type:'daily-review-action',action:definition[0]},location.origin);$('simulation-feedback').textContent=`已发出手动模拟指令：${definition[2]}`;});
$('deliver-next-demand').addEventListener('click',()=>{if(!connected||mode!=='live'||$('deliver-next-demand').disabled)return;iframe.contentWindow.postMessage({type:'daily-review-action',action:'deliver-next-demand'},location.origin);$('demand-feedback').textContent='正在投递下一组…';});
for(const [id,action] of [['start-trip','trip'],['end-trip','home'],['deliver-travel','deliver-travel']])$(id).addEventListener('click',()=>{
  if(!connected||mode!=='live'||$(id).disabled)return;
  iframe.contentWindow.postMessage({type:'daily-review-action',action,sceneId:$('travel-scene').value,linked:$('travel-linked').checked},location.origin);
  $('travel-feedback').textContent='正在保存手动审阅操作…';
});
document.querySelectorAll('[data-live-failure]').forEach(button=>button.addEventListener('click',()=>{
  if(button.disabled||mode!=='live')return;
  iframe.contentWindow.postMessage({type:'daily-review-action',action:button.dataset.liveFailure},location.origin);
  $('mutation-feedback').textContent=`已设置：${button.textContent}。请在预览中执行一次更正或删除。`;
}));
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==iframe.contentWindow)return;
  if(event.data?.type==='demand-delivery-result'){
    if(mode==='live'){
      const message=event.data.message||'操作状态未知。';
      $('demand-feedback').textContent=message;$('travel-feedback').textContent=message;
      if(pendingQuickTrip&&event.data.requestId===pendingQuickTrip.requestId){
        const {sceneId}=pendingQuickTrip;pendingQuickTrip=null;
        if(event.data.status==='delivered'){
          quickFeedback('小猫已出发，正在投递普通旅行信…');
          postLiveAction('deliver-travel',{sceneId,linked:false});
        }else quickFeedback(message);
      }else{
        quickFeedback(message);
        if(event.data.status==='delivered'&&event.data.id)$('quick-open-letter').hidden=false;
      }
      if(pendingQuickOpen&&event.data.requestId===pendingQuickOpen){
        pendingQuickOpen=null;
        if(event.data.status==='opened')requestAnimationFrame(()=>stage.scrollIntoView({block:'start',behavior:'auto'}));
      }
    }
    return;
  }
  if(event.data?.type!=='daily-state'||!event.data.state||typeof event.data.state!=='object')return;
  clearTimeout(loadTimer);childState=event.data.state;childPage=childState.page;setConnected(true);mount.hidden=false;$('preview-error').hidden=true;
  $('connection-status').textContent=mode==='scenario'?'场景已就绪 · 隔离数据':'连续体验已就绪 · 本机保存';
  describeState(childState);quickStateChanged();
});
iframe.addEventListener('load',()=>{
  resizePreview();
  let path='';try{path=iframe.contentWindow.location.pathname;}catch{}
  if(path.includes('/ui-adoption-flow-v1/')){
    clearTimeout(loadTimer);setConnected(true);$('connection-status').textContent='领养流程已载入 · 本机保存';
    $('state-summary').replaceChildren();return;
  }
  if(connected)return;
  $('connection-status').textContent='页面已载入，等待产品状态…';
  setTimeout(()=>{if(!connected){let visible='';try{visible=iframe.contentDocument?.body.innerText.trim()||'';}catch{}if(!visible)showPreviewError();}},500);
});
function setToolDisclosure(){ $('review-tools').open=!mobile.matches; }
setToolDisclosure();mobile.addEventListener('change',setToolDisclosure);
let lastStageWidth=0;
new ResizeObserver(()=>{if(stage.clientWidth!==lastStageWidth){lastStageWidth=stage.clientWidth;resizePreview();}}).observe(stage);
window.addEventListener('resize',resizePreview);
visualViewport?.addEventListener('resize',resizePreview);
loadPreview();
