import {needCard,replyInput,updateReplyInputState,focusReply,icon,escapeHtml as e,homeNavigation,newLetterEntry} from '../ui-components-v1/daily-components.mjs?v=g2r-reply-fix-01';
import {catImageSources} from '../ui-adoption-flow-v1/runtime-images.mjs';
import {initialState,transition,currentLetter,getHomeEntry,inboxLetters,LETTER_FIXTURES,canSubmit} from './daily-state.mjs?v=batch3-20261003-3';
import {createDailyStore,STORAGE_KEY,LIVE_STORAGE_KEY,LEGACY_IMPORT_MARKER_KEY} from './storage.mjs?v=batch3-20261003-3';
import {buildScenario,buildDemandReview,SCENARIOS} from './scenarios.mjs?v=seven-demands-20261002';
import {demandById,demandImageStem,demandLetter,nextDemandForState} from './demand-catalog.mjs';
import {makeTravelDelivery,storyById,sourceEntries,currentRevision,travelScenes} from './response-history.mjs?v=batch3-20261003-3';
import {readPreviewIdentity} from '../ui-adoption-flow-v1/preview-identity.mjs';
const params=new URLSearchParams(location.search), app=document.querySelector('#app');
function syncVisualViewport(){
  const viewport=window.visualViewport;
  // At normal scale, keep the shell inside the actually visible rectangle.
  // At pinch zoom, leave the layout viewport in place so the user can pan it.
  const zoomed=viewport&&Math.abs(viewport.scale-1)>0.01;
  const height=zoomed?window.innerHeight:(viewport?.height||window.innerHeight);
  const top=zoomed?0:(viewport?.pageTop??((viewport?.offsetTop||0)+window.scrollY));
  document.documentElement.style.setProperty('--daily-viewport-height',`${Math.max(1,height)}px`);
  document.documentElement.style.setProperty('--daily-viewport-top',`${top}px`);
}
syncVisualViewport();
window.visualViewport?.addEventListener('resize',syncVisualViewport);
window.visualViewport?.addEventListener('scroll',syncVisualViewport);
window.addEventListener('resize',syncVisualViewport);
window.addEventListener('scroll',syncVisualViewport);
const scenarioId=params.get('scenario'),reviewDemandId=params.get('reviewDemand'),requestedCat=params.get('cat');
const reviewing=params.has('scenario')||params.has('reviewDemand');
const invalidReview=reviewing&&(params.has('scenario')&&params.has('reviewDemand')
  || params.has('scenario')&&!SCENARIOS.some(s=>s.id===scenarioId)
  || params.has('reviewDemand')&&!demandById(reviewDemandId)
  || requestedCat!==null&&!/^cat-0[1-4]$/.test(requestedCat));
const fixture=invalidReview?null:scenarioId?buildScenario(scenarioId,{catId:requestedCat||'cat-01'})
  :reviewDemandId?buildDemandReview(reviewDemandId,{catId:requestedCat||'cat-01'}):null;
const identityResult=fixture||invalidReview?{ok:true,identity:null}:readPreviewIdentity();
if(invalidReview){
  document.documentElement.dataset.page='INVALID_SCENARIO';
  app.innerHTML='<section class="daily-page entry-page"><span class="wordmark">有猫来信 · 审阅</span><div class="entry-message"><h1>找不到这个审阅场景</h1><p>场景参数不正确，本机连续体验记录没有被打开或修改。</p><a class="primary" href="./review.html">返回场景审阅</a></div></section>';
}else if(!fixture&&(!identityResult.ok||!identityResult.identity)){
  document.documentElement.dataset.page='WELCOME';
  app.innerHTML=`<section class="daily-page entry-page"><span class="wordmark">有猫来信</span><div class="entry-message"><h1>${identityResult.ok?'先和小猫见面吧':'暂时无法读取本机领养记录'}</h1><p>${identityResult.ok?'选定小猫后，就能一起回家。':'请保留当前浏览器数据，稍后重新读取；已有记录不会因此清空。'}</p><a class="primary" href="../ui-adoption-flow-v1/index.html?v=compact-fluid-20260928">${identityResult.ok?'去选小猫':'重新读取'}</a></div></section>`;
  if(parent!==window)parent.postMessage({type:'daily-state',state:{page:'WELCOME',catState:null,newLetterId:null,letters:[]}},location.origin);
}else{
const liveIdentity=identityResult.identity;
let ui=fixture?.ui||{}, failures=fixture?.failFixtures||{};
let store=createDailyStore({storage:fixture?.storageAdapter,failFixtures:failures,
  key:fixture?STORAGE_KEY:LIVE_STORAGE_KEY,
  initialOptions:fixture?{}:{catId:liveIdentity.catId,appearanceId:liveIdentity.catId,catName:liveIdentity.name,initialLetter:null}});
let loaded=fixture?null:store.load();
if(!fixture&&loaded.fresh){
  // The former daily preview remains untouched. Import it only when its
  // independent sample identity exactly matches the confirmed adopted cat.
  let marker=null;
  try{marker=localStorage.getItem(LEGACY_IMPORT_MARKER_KEY);}catch{marker='unavailable';}
  if(marker){
    let reset=false;try{reset=JSON.parse(marker)?.reset===true;}catch{}
    if(reset){
      const created=store.persist(loaded.state);
      if(created.ok){
        try{localStorage.setItem(LEGACY_IMPORT_MARKER_KEY,JSON.stringify({...JSON.parse(marker),reset:false}));loaded=store.load();}
        catch{loaded={ok:false,state:transition(created.state,{type:'LOAD_ERROR'})};}
      }else loaded={ok:false,state:transition(loaded.state,{type:'LOAD_ERROR'})};
    }else loaded={ok:false,state:transition(loaded.state,{type:'LOAD_ERROR'})};
  }
  else{
    const legacy=createDailyStore({key:STORAGE_KEY}).load();
    if(legacy.recovered&&legacy.ok&&legacy.state.appearanceId===liveIdentity.catId&&legacy.state.catName===liveIdentity.name){
      try{
        localStorage.setItem(LEGACY_IMPORT_MARKER_KEY,JSON.stringify({sourceKey:STORAGE_KEY,catId:liveIdentity.catId,catName:liveIdentity.name}));
        const migrated=store.persist(legacy.state);
        if(migrated.ok)loaded=store.load();
        else{localStorage.removeItem(LEGACY_IMPORT_MARKER_KEY);loaded={ok:false,state:transition(loaded.state,{type:'LOAD_ERROR'})};}
      }catch{loaded={ok:false,state:transition(loaded.state,{type:'LOAD_ERROR'})};}
    }
  }
}
let state=fixture?.state||loaded.state, saveTimer,sendTimer,composing=false,externalChange=false,saveFailure=false;
if(!fixture&&(state.appearanceId!==liveIdentity.catId||state.catName!==liveIdentity.name)){
  app.innerHTML='<section class="daily-page entry-page"><span class="wordmark">有猫来信</span><div class="entry-message"><h1>本机记录与已确认的小猫不一致</h1><p>记录已保留。请不要清除浏览器数据，先重新读取确认。</p><a class="primary" href="./index.html">重新读取</a></div></section>';
  if(parent!==window)parent.postMessage({type:'daily-state',state:{page:'ERROR',catState:null,newLetterId:null,letters:[]}},location.origin);
}else{
const restored=currentLetter(state)?.draftSaveState==='SAVED'&&!!currentLetter(state)?.draft;
if(!fixture&&restored)ui.draftRestored=true;
ui.inboxFilter??='all';ui.unreadOnly??=false;ui.firstRead??=false;ui.sourceOpen??=false;
let inboxScroll=0,historyScroll=0,postcardScroll=0,mutationSerial=0,correctionTimer=null,lastRenderedView='';
const currentScroller=()=>app.querySelector('.page-scroll')||app.querySelector('.daily-page');
function scrollToTop(){currentScroller()?.scrollTo({top:0,behavior:'instant'});if(window.scrollY)window.scrollTo({top:0,behavior:'instant'});}
function restoreScroll(top){currentScroller()?.scrollTo({top,behavior:'instant'});}
function mountPageShell(){
  const page=app.querySelector('.daily-page'),nav=page?.querySelector(':scope > .daily-nav');
  if(!nav)return;
  page.classList.add('has-bottom-nav');
  const scroll=document.createElement('div');scroll.className='page-scroll';
  while(page.firstChild!==nav)scroll.append(page.firstChild);
  page.insertBefore(scroll,nav);
}
if(params.get('textScale')==='200')document.documentElement.dataset.textScale='200';
const arrow=()=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
const bodyById={'need-01':'窗边的小光点，刚才还在我的爪子旁边。\n我一眨眼，它就跑远了。\n明天它还会来吗？','need-02':'窗外又下起雨了。\n我把爪子缩进软软的毯子里，听见雨滴轻轻敲着玻璃。\n你那边，也在下雨吗？'};
function sceneImage(stem,alt,extra=''){
  const image=width=>`./assets/web/${stem}-${width}.webp${ui.imageRetry?`?retry=${ui.imageRetry}`:''}`;
  return `<img ${extra} src="${image(600)}" srcset="${image(600)} 600w, ${image(1200)} 1200w" sizes="(max-width:699px) calc(100vw - 32px), 564px" decoding="async" fetchpriority="high" alt="${e(alt)}" width="1536" height="1024">`;
}
function homeArtwork(){
  const trip=state.catState==='TRIP';
  const alt=trip?'熟悉的家，小猫出门旅行了':`${state.catName}在熟悉的家里`;
  const source=catImageSources(state.appearanceId,ui.imageRetry||0);
  return `<div class="scene home-scene${trip?' is-away':''}" id="home-scene" aria-label="${e(alt)}">${ui.imageError||ui.catImageError?`<div class="scene-fallback"><p>${ui.catImageError?`${e(state.catName)}的画面暂时没能加载。`:'图片暂时没能加载。'}</p><button class="secondary" data-action="retry-image">再试一次</button></div>`:`<div class="scene-loading" role="status">正在布置小猫的家…</div>${sceneImage('home-empty','','class="home-room"')}${trip?'':`<span class="home-cat-shadow ${state.appearanceId}" aria-hidden="true"></span><img class="home-cat ${state.appearanceId}" src="${source.src}" srcset="${source.srcset}" sizes="${source.sizes}" decoding="async" alt="${e(state.catName)}猫在家中" width="1122" height="1402">`}`}</div>`;
}
function dateText(date){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return '';
  const parsed=new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.valueOf())?'':new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'numeric',day:'numeric'}).format(parsed);
}
function versionTimeText(at){
  if(typeof at!=='string'||!at)return '';
  const value=new Date(at);
  return Number.isNaN(value.valueOf())?'':new Intl.DateTimeFormat('zh-CN',
    {year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(value);
}
function isToday(date){
  const now=new Date();const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return date===today;
}
function entryHeading(letter){
  if(letter.type==='POSTCARD')return '旅行时寄来的信，还没打开';
  if(state.catState==='TRIP')return '出门前的来信，还没打开';
  return isToday(letter.date)?'今天有一封来信':'有一封来信，还没打开';
}
function draftLetter(){return Object.values(state.letters).find(letter=>letter.type==='NEED_CARD'&&letter.readState==='READ'&&letter.draft&&letter.replySubmitState!=='SUCCESS');}
function home(){
  const trip=state.catState==='TRIP',entry=getHomeEntry(state),draft=draftLetter();
  return `<section class="daily-page home-page"><header class="page-top"><span class="wordmark">有猫来信</span><button class="quiet-link" data-action="inbox">回看来信 <span aria-hidden="true">↗</span></button></header><div class="home-content"><div class="home-heading"><h1>${e(state.catName)}</h1><span class="cat-status${trip?' trip':''}">${trip?'旅行中':'在家'}</span></div>${ui.loading?'<div class="neutral-loading" role="status">正在读取本机记录…</div>':state.loadError?`<section class="error-block" role="status"><h2>暂时没能读取本机记录</h2><p>可以再试一次。</p><button class="secondary" data-action="retry-load">重新读取</button></section>`:`${homeArtwork()}${trip?`<div class="life-copy"><h2>${e(state.catName)}出去旅行啦。</h2><p>家还是原来的样子，它在外面转悠呢。</p></div>`:''}${entry?newLetterEntry({type:entry.type,unread:true,title:entryHeading(entry),date:dateText(entry.date)}):`<div class="empty-letter">${trip?'暂时没有新来信。':'今天没有新来信。'}</div>`}${draft?`<button type="button" class="quiet-link draft-entry" data-action="resume-draft" data-letter-id="${e(draft.id)}">继续上次未写完的回应</button>`:''}`}<div data-slot="page-storage-error"></div></div>${homeNavigation({active:'cat',unread:!!entry})}</section>`;
}
function backButton(){return `<button type="button" class="quiet-link back-button" data-action="return-letter">${arrow()}${state.returnPage==='J'?'返回来信盒':'回到家'}</button>`;}
function eventScene(letter){
  if(letter.id==='need-02')return '<div class="scene event-scene"><div class="scene-fallback"><p>这封信的画面暂不可用，文字仍可阅读。</p></div></div>';
  if(ui.imageError)return '<div class="scene event-scene"><div class="scene-fallback"><p>这封信的画面暂时没能加载。</p><button class="secondary" data-action="retry-image">再试一次</button></div></div>';
  const demand=demandById(letter.id);
  if(demand){
    const stem=demandImageStem(letter.id,state.appearanceId);
    const alt=letter.id==='need-01'?`${state.catName}在窗边追逐一小块光`:`${state.catName}的${demand.title}来信画面`;
    return `<div class="scene event-scene"><div class="scene-loading" role="status">正在展开来信画面…</div>${sceneImage(stem,alt)}</div>`;
  }
  return '<div class="scene event-scene"><div class="scene-fallback"><p>这封信的画面暂不可用，文字仍可阅读。</p></div></div>';
}
function replyOptions(){const letter=currentLetter(state);return {mode:'e3',id:'daily-reply',name:state.catName,value:letter?.draft||'',maxLength:2000,draftState:ui.draftRestored?'restored':state.draftSaveState.toLowerCase(),submitState:state.replySubmitState.toLowerCase(),systemState:state.checkState==='CHECK_ERROR'?'check-error':state.checkState==='SAFETY'?'blocked':'none',composing:composing||externalChange||state.loadError};}
function newMailNotice(){return state.newLetterId?'<aside class="new-mail-notice"><span>有一封新来信</span><button type="button" data-action="new-mail-home">回首页看看</button></aside>':'';}
function detail(){
  const l=currentLetter(state),demand=demandById(l.id);
  const body=l.data?.body||demand?.body||bodyById[l.id];
  if(!body)return `<section class="daily-page detail-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">一封来信</h1><div class="error-block"><h2>这封信的正文暂时无法读取</h2><p>信件记录仍在，可以返回后重试。</p></div></section>`;
  const tip=l.data?.tip||demand?.tip||'可以说说你今天看见的一点小事，也可以只写一句话。\n这次不想回，也没关系。';
  const mustShow=state.replySubmitState==='SUBMITTING'||state.replySubmitState==='ERROR'||state.submissionRecoveryRequired||state.draftSaveState==='ERROR'||state.loadError||saveFailure||externalChange||state.checkState!=='IDLE';
  if(mustShow)ui.replyExpanded=true;
  const expanded=ui.replyExpanded||mustShow;
  const record=state.responses[l.responseId];
  const response=l.replySubmitState==='SUCCESS'?`<section class="paper sent-reply"><div class="response-heading"><h2>你送出的回应</h2><span class="meta">${record?.status==='DELETED'?'已删除':record?.currentRevision>1?'已更正':''}</span></div>${record?.status==='DELETED'?'<p>这条回应已删除。</p>':`<p>${e(currentRevision(record)?.text??l.submittedText)}</p><div class="management-actions"><button type="button" class="text-button" data-action="open-manage">查看与管理回应</button></div>`}</section>`:expanded?`<details class="tip-box"${ui.tipsOpen?' open':''}><summary>看看小提示</summary><p>${e(tip).replace(/\n/g,'<br>')}</p></details><div data-slot="recovery">${recoveryNotice()}</div>${replyInput(replyOptions())}`:'';
  return `<section class="daily-page detail-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">一封来信</h1><p class="letter-date">收到：${e(dateText(l.date))}</p><div data-slot="new-mail">${newMailNotice()}</div>${eventScene(l)}${needCard({mode:'e3',catId:state.appearanceId,catName:state.catName,time:dateText(l.date),title:l.title,body,avatarUrl:`./assets/web/avatar-${state.appearanceId}-160.webp`,replyTargetId:'daily-reply',replyActionType:'expand-reply',skipAction:true,replyAction:l.replySubmitState!=='SUCCESS'})}${response}<div data-slot="page-storage-error"></div></section>`;
}
function postcardScene(l){
  const scene=l.data?.sceneId;
  const approved=travelScenes.includes(scene)&&!!storyById(l.data?.storyId)||l.data?.storyId==='UI-DEMO-RHINE-20260928'&&scene==='RHINE';
  const picture=approved?(ui.imageError?'<div class="scene-fallback"><p>旅行画面暂时没能加载，文字仍可阅读。</p><button class="secondary" data-action="retry-image">再试一次</button></div>':`<div class="scene-loading" role="status">正在展开旅行画面…</div>${sceneImage(`postcard-${scene.toLowerCase()}-${state.appearanceId}`,`${state.catName}的${e(l.data?.place||'旅行')}画面`)}`):'<div class="scene-fallback"><p>这封旅行信的画面暂不可用，文字仍可阅读。</p></div>';
  return `<div class="scene postcard-scene">${picture}</div>`;
}
function sourceBlock(letter){
  const items=sourceEntries(state,letter,{firstRead:ui.firstRead});
  if(!items.length)return '';
  return `<details class="source-fold"${ui.sourceOpen?' open':''}><summary>看看以前说过的话</summary>${items.map(item=>`<section class="paper source-note"><span class="meta">${e(state.letters[item.letterId]?.title||'一封来信')} · 来源版本 ${item.revision}</span>${item.status==='deleted'?'<p class="source-status">这条回应已删除。</p>':`${versionTimeText(item.at)?`<p class="version-note">版本时间：${e(versionTimeText(item.at))}</p>`:''}${item.status==='corrected'?'<p class="source-status">这条回应后来已更正。以下是寄出时使用的旧版本。</p>':''}<blockquote>${e(item.text)}</blockquote><button type="button" class="text-button" data-action="manage-source" data-letter-id="${e(item.letterId)}">管理这条回应</button>`}</section>`).join('')}</details>`;
}
function postcard(){
  const l=currentLetter(state),body=l?.data?.body;
  if(!body)return `<section class="daily-page detail-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">旅行来信</h1><div class="error-block"><h2>这封信的正文暂时无法读取</h2><p>信件记录仍在，可以返回后重试。</p></div></section>`;
  return `<section class="daily-page postcard-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">旅行来信</h1><p class="letter-date">收到：${e(dateText(l.date))}</p>${postcardScene(l)}<article class="paper postcard-letter">${l.data?.place?`<p class="postcard-place">${e(l.data.place)}</p>`:''}<h2>${e(l.title)}</h2><div class="story-paragraphs">${body.split('\n\n').map(part=>`<p>${e(part).replace(/\n/g,'<br>')}</p>`).join('')}</div></article>${sourceBlock(l)}<div class="reading-footer"><button type="button" class="quiet-link" data-action="home">回到家</button><button type="button" class="secondary" data-action="return-letter">收好这封信</button></div><div data-slot="page-storage-error"></div></section>`;
}
function inbox(){
  const all=inboxLetters(state),letters=all.filter(l=>(ui.inboxFilter==='all'||ui.inboxFilter==='need'&&l.type==='NEED_CARD'||ui.inboxFilter==='travel'&&l.type==='POSTCARD')&&(!ui.unreadOnly||l.readState==='UNREAD'));
  const filters=[['all','全部'],['need','小猫来信'],['travel','旅行来信']];
  return `<section class="daily-page inbox-page"><header class="page-top"><span class="wordmark">有猫来信</span></header><div class="home-content"><div class="inbox-heading"><h1>来信盒</h1><button type="button" class="quiet-link" data-action="open-history">管理我的回应</button></div><p class="inbox-subtitle">它写过的小事，都收在这里。</p><div class="filters" role="group" aria-label="筛选来信">${filters.map(([id,label])=>`<button type="button" class="filter" data-action="set-filter" data-filter="${id}" aria-pressed="${ui.inboxFilter===id}">${label}</button>`).join('')}<label class="unread-toggle"><input type="checkbox" id="unread-only"${ui.unreadOnly?' checked':''}>只看未读</label></div>${letters.length?`<ul class="inbox-list">${letters.map(l=>`<li><button class="paper inbox-item" type="button" data-action="open-inbox-letter" data-letter-id="${e(l.id)}"><span class="row"><span class="kind-label">${l.type==='POSTCARD'?'旅行来信':'小猫来信'}</span><span class="${l.readState==='UNREAD'?'unread-label':'mail-date'}">${l.readState==='UNREAD'?'<i class="daily-unread-dot"></i>未读':'已读'}</span></span><strong>${e(l.title)}</strong><span class="mail-date">收到：${e(dateText(l.date))}</span>${l.type==='NEED_CARD'&&l.draft&&l.replySubmitState!=='SUCCESS'?'<span class="meta">有一份未写完的回应</span>':''}</button></li>`).join('')}</ul>`:`<section class="empty-state"><h2>${all.length?'没有符合筛选的来信':'来信盒里还没有信。'}</h2><p>${all.length?'换一个筛选，以前的信都还在。':'小猫写给你的信，会收在这里。'}</p>${all.length?'<button class="text-button" data-action="clear-filter">查看全部</button>':''}</section>`}<div data-slot="page-storage-error"></div></div>${homeNavigation({active:'inbox',unread:!!state.newLetterId})}</section>`;
}
function manage(){
  const l=currentLetter(state),response=state.responses[l?.responseId],draft=state.correctionDrafts[l?.id];
  if(!l||!response)return `<section class="daily-page detail-page"><div class="error-block">这条回应暂时无法读取。</div><button class="secondary" data-action="return-manage">返回</button></section>`;
  const demand=demandById(l.id),body=l.data?.body||demand?.body||bodyById[l.id]||'';
  const stale=draft&&draft.baseRevision!==response.currentRevision;
  const revision=response.status==='ACTIVE'?currentRevision(response):null;
  const current=revision?.text??null;
  const currentTime=versionTimeText(revision?.at);
  const editor=ui.editing&&response.status==='ACTIVE'&&draft?`<form class="paper composer editor" id="correction-form"><label for="correction">更正这条回应</label><p class="edit-description">更正会保留新版本。已经寄来的旅行故事，以及它当时引用的文字，都不会被新文字替换。</p><textarea id="correction" aria-describedby="correction-help"${ui.pendingMutation?' readonly':''}>${e(draft.text)}</textarea><p id="correction-help" class="edit-count">${[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(draft.text)].length} / 2000 字</p>${stale?'<p class="mutation-notice">回应版本已变化。这份旧草稿仍在，请重新读取并核对后操作。</p>':''}${ui.correctionError?`<p class="mutation-notice" role="status">${e(ui.correctionError)}</p>`:''}<div class="card-actions"><button type="button" class="text-button" data-action="cancel-edit">取消</button><button type="submit" class="primary"${stale||ui.pendingMutation?' disabled':''}>保存更正</button></div></form>`:'';
  return `<section class="daily-page detail-page manage-page"><header class="detail-top"><button class="quiet-link back-button" data-action="return-manage">${arrow()}${state.manageReturnPage==='I'?'返回旅行信':state.manageReturnPage==='R'?'返回回应列表':'返回来信'}</button></header><h1 class="detail-title">以前的来信</h1><p class="letter-date">收到：${e(dateText(l.date))}</p>${eventScene(l)}${body?needCard({mode:'e3',catId:state.appearanceId,catName:state.catName,time:dateText(l.date),title:l.title,body,avatarUrl:`./assets/web/avatar-${state.appearanceId}-160.webp`,replyAction:false}):`<section class="error-block">原信正文暂时无法读取，回应记录仍在。</section>`}<section class="paper sent-reply"><div class="response-heading"><h2>你送出的回应</h2><span class="meta">${response.status==='DELETED'?'已删除':`版本 ${response.currentRevision}${response.currentRevision>1?' · 已更正':''}`}</span></div>${response.status==='DELETED'?'<p>这条回应已删除。</p>':`${currentTime?`<p class="version-note">${response.currentRevision>1?'更正':'送出'}：${e(currentTime)}</p>`:''}<p class="body-copy">${e(current)}</p><div class="management-actions"><button type="button" class="text-button" data-action="edit-correction"${ui.pendingMutation?' disabled':''}>更正这条回应</button><button type="button" class="text-button quiet-danger" data-action="ask-delete"${ui.pendingMutation?' disabled':''}>删除这条回应</button></div>`}</section>${ui.mutationNotice?`<p class="mutation-notice" role="status">${e(ui.mutationNotice)}</p>`:''}${editor}${ui.correctionError&&!ui.editing?`<p class="mutation-notice" role="status">${e(ui.correctionError)}</p>`:''}${ui.pendingMutation?`<aside class="mutation-notice" role="status">操作结果还不确定。请先重新读取，避免重复提交。<button type="button" class="secondary" data-action="recover-mutation">重新读取结果</button></aside>`:''}<div class="reading-footer"><button type="button" class="quiet-link" data-action="home">回到家</button></div><div data-slot="page-storage-error"></div></section>`;
}
function historyList(){
  const letters=Object.values(state.letters).filter(letter=>letter.type==='NEED_CARD'&&letter.replySubmitState==='SUCCESS')
    .sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  return `<section class="daily-page detail-page history-page"><header class="detail-top"><button type="button" class="quiet-link back-button" data-action="return-history">${arrow()}返回来信盒</button></header><h1 class="detail-title history-title">管理我的回应</h1>${letters.length?`<ul class="inbox-list">${letters.map(letter=>`<li><button type="button" class="paper inbox-item" data-action="open-history-letter" data-letter-id="${e(letter.id)}"><span class="kind-label">送给${e(state.catName)}的回应${state.responses[letter.responseId]?.status==='DELETED'?' · 已删除':''}</span><strong>${e(letter.title)}</strong><span class="mail-date">收到：${e(dateText(letter.date))}</span></button></li>`).join('')}</ul>`:'<section class="empty-state"><h2>还没有送出的回应</h2><p>以后可以从这里回看。</p></section>'}${homeNavigation({active:'inbox',unread:!!state.newLetterId})}</section>`;
}
function recoveryNotice(){if(state.loadError)return '<aside class="inline-notice page-banner" role="status"><strong>暂时没能读取本机记录。</strong><p>当前文字仍在这里，可以重新读取后再送出。</p><button class="secondary" data-action="retry-load">重新读取</button></aside>';return state.submissionRecoveryRequired?'<aside class="inline-notice page-banner" role="status"><strong>正在确认刚才的发送结果。</strong><p>文字仍在这里，先重新读取结果。</p><button class="secondary" data-action="recover">重新读取</button></aside>':'';}
function success(){return `<section class="daily-page success-page"><header class="page-top"><span class="wordmark">有猫来信</span></header><div class="success-content"><div class="success-panel">${icon('check')}<h1 class="story-title">送出去啦。</h1></div>${state.refreshError?'<aside class="inline-notice"><strong>回应已经送出。</strong><p>暂时没能读取最新状态，可以重新读取，也可以先回到小猫身边。</p><button class="secondary" data-action="retry-refresh">重新读取</button></aside>':''}${ui.reading?'<p class="local-notice" role="status">回应已经送出，正在读取最新状态…</p>':''}<button class="primary" data-action="home">回到家</button></div></section>`;}
function keyboard(){return '<aside class="keyboard-study" aria-label="键盘布局示意"><p>键盘展开 · 布局示意</p><div class="key-row">'+['Q','W','E','R','T','Y','U','I','O','P'].map(x=>`<span class="key">${x}</span>`).join('')+'</div><div class="key-row">'+['A','S','D','F','G','H','J','K','L'].map(x=>`<span class="key">${x}</span>`).join('')+'</div><div class="key-row">'+['⇧','Z','X','C','V','B','N','M','⌫'].map(x=>`<span class="key">${x}</span>`).join('')+'</div><div class="key-row"><span class="key">123</span><span class="key">◉</span><span class="key key-wide">空格</span><span class="key">换行</span></div></aside>';}
function replaceScene(){
 const old=app.querySelector('.scene');if(!old)return;
 const markup=['E','F'].includes(state.page)?homeArtwork():['G','K'].includes(state.page)?eventScene(currentLetter(state)):state.page==='I'?postcardScene(currentLetter(state)):null;
 if(!markup)return;
 const template=document.createElement('template');template.innerHTML=markup;
 const next=template.content.firstElementChild;old.replaceWith(next);watchSceneImages(next);notify();
}
function watchSceneImages(root=app){(root.matches?.('.scene')?[root]:[...root.querySelectorAll('.scene')]).forEach(scene=>{
 const images=[...scene.querySelectorAll('img')];if(!images.length)return;
 const fail=(broken)=>{if(!scene.isConnected)return;const badImage=broken||images.find(img=>img.complete&&img.naturalWidth===0);if(badImage?.classList.contains('home-cat'))ui.catImageError=true;else ui.imageError=true;replaceScene();};
 const timer=setTimeout(fail,8000);
 Promise.all(images.map(img=>(typeof img.decode==='function'?img.decode():new Promise((resolve,reject)=>{if(img.complete)return img.naturalWidth?resolve():reject();img.addEventListener('load',resolve,{once:true});img.addEventListener('error',reject,{once:true});})).catch(()=>{throw img;}))).then(()=>{clearTimeout(timer);if(scene.isConnected)scene.classList.add('is-ready');},broken=>{clearTimeout(timer);fail(broken);});
});}
function watchAvatar(){const img=app.querySelector('img[data-slot="need-avatar"]');if(!img)return;
 const fail=()=>{if(!img.isConnected)return;const fallback=document.createElement('span');fallback.className='avatar avatar-fallback';fallback.textContent='猫';fallback.setAttribute('role','img');fallback.setAttribute('aria-label',`${state.catName}的头像暂时没能加载`);img.replaceWith(fallback);};
 const timer=setTimeout(fail,8000);
 const loaded=typeof img.decode==='function'?img.decode():new Promise((resolve,reject)=>{if(img.complete)return img.naturalWidth?resolve():reject();img.addEventListener('load',resolve,{once:true});img.addEventListener('error',reject,{once:true});});
 loaded.then(()=>clearTimeout(timer),()=>{clearTimeout(timer);fail();});
}
function render(){const view=`${state.page}:${state.currentLetterId||''}`,sameView=view===lastRenderedView,oldScroll=currentScroller()?.scrollTop||0;
 if(state.page!=='K')ui.mutationNotice='';document.documentElement.dataset.page=state.page;document.body.classList.toggle('keyboard-layout',!!ui.keyboard&&state.page==='G');app.innerHTML=(['E','F'].includes(state.page)?home():state.page==='G'?detail():state.page==='I'?postcard():state.page==='J'?inbox():state.page==='K'?manage():state.page==='R'?historyList():success())+(ui.keyboard&&state.page==='G'?keyboard():'');
 mountPageShell();
 if(ui.pendingMutation&&state.page!=='K')(app.querySelector('.page-scroll')||app.querySelector('.daily-page'))?.insertAdjacentHTML('beforeend','<aside class="inline-notice pending-global" role="status">一项管理操作的结果尚未确认。<button class="secondary" data-action="recover-mutation">重新读取结果</button></aside>');
 currentScroller()?.scrollTo({top:sameView?oldScroll:0,behavior:'instant'});lastRenderedView=view;
 if(window.scrollY)window.scrollTo({top:0,behavior:'instant'});
 if(ui.reading){const retry=app.querySelector('[data-action="retry-refresh"]');if(retry)retry.disabled=true;} watchSceneImages();watchAvatar();
 app.querySelectorAll('[data-action="home"],[data-action="skip"]').forEach(b=>b.disabled=state.replySubmitState==='SUBMITTING');
 const ta=app.querySelector('textarea');if(ta&&ta.id!=='correction'){ta.addEventListener('input',onInput);ta.addEventListener('compositionstart',()=>{composing=true;clearTimeout(saveTimer);patch();});ta.addEventListener('compositionend',()=>{composing=false;onInput();});growInput(ta);}
 const correction=app.querySelector('#correction');if(correction){correction.addEventListener('input',onCorrectionInput);growInput(correction);}
 const fold=app.querySelector('.source-fold');if(fold)fold.addEventListener('toggle',()=>{ui.sourceOpen=fold.open;});
 if(ui.focus&&ta){focusReply(app,'daily-reply');ta.setSelectionRange(ta.value.length,ta.value.length);ui.focus=false;}
 if(ui.keyboard&&ta)requestAnimationFrame(()=>app.querySelector('.composer').scrollIntoView({block:'start',behavior:'instant'}));
 patch();notify();}
function growInput(ta){ta.style.height='auto';ta.style.height=Math.max(168,Math.min(360,ta.scrollHeight+2))+'px';}
function patch(){const form=app.querySelector('.composer');if(form)updateReplyInputState(form,replyOptions());const notice=app.querySelector('[data-slot="new-mail"]');if(notice)notice.innerHTML=newMailNotice();const recovery=app.querySelector('[data-slot="recovery"]');if(recovery)recovery.innerHTML=recoveryNotice();const slot=app.querySelector('[data-slot="page-storage-error"]');if(slot)slot.innerHTML=externalChange?'<aside class="inline-notice" role="status">另一个页面更新了本机记录。当前文字仍在这里。<button class="secondary" data-action="external-reload">重新读取</button></aside>':saveFailure?'<aside class="inline-notice" role="status">本机记录暂时没能保存，当前文字仍在这里。请保留此页面再试一次。<button class="secondary" data-action="retry-persist">重试保存</button></aside>':'';notify();}
function notify(){window.__dailyState=structuredClone(state);window.__dailyUI={...ui,externalChange,saveFailure};if(parent!==window)parent.postMessage({type:'daily-state',state:{page:state.page,catState:state.catState,newLetterId:state.newLetterId,currentLetterId:state.currentLetterId,draftSaveState:state.draftSaveState,replySubmitState:state.replySubmitState,letters:Object.values(state.letters).map(l=>({id:l.id,type:l.type,read:l.readState,draftLength:l.draft.length,reply:l.replySubmitState}))}},location.origin);}
function persist(){if(externalChange)return false;const r=store.persist(state);if(r.ok){state=r.state;saveFailure=false;}else{saveFailure=true;if(r.stale||r.conflict){externalChange=true;clearTimeout(sendTimer);clearTimeout(saveTimer);}}return r.ok;}
function apply(event,{paint=true,save=false}={}){
 const next=transition(state,event);
 if(save){
  const result=store.persist(next);
  if(!result.ok){saveFailure=true;if(result.stale||result.conflict)externalChange=true;patch();return false;}
  state=result.state;saveFailure=false;
 }else state=next;
 if(paint)render();else patch();return true;
}
function onInput(){const ta=app.querySelector('textarea');if(!ta)return;ui.draftRestored=false;state=transition(state,{type:'EDIT',value:ta.value});growInput(ta);patch();clearTimeout(saveTimer);if(!composing&&!externalChange)saveTimer=setTimeout(()=>saveDraft(),550);}
function onCorrectionInput(event){
  if(state.page!=='K'||ui.pendingMutation)return;
  state=transition(state,{type:'EDIT_CORRECTION',value:event.target.value});
  const count=[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(event.target.value)].length;
  app.querySelector('#correction-help').textContent=`${count} / 2000 字`;
  app.querySelector('#correction-form [type="submit"]').disabled=!event.target.value.trim()||count>2000||
    state.correctionDrafts[state.currentLetterId]?.baseRevision!==state.responses[currentLetter(state)?.responseId]?.currentRevision;
  clearTimeout(correctionTimer);correctionTimer=setTimeout(saveCorrectionDraft,550);
}
function saveCorrectionDraft(){
  clearTimeout(correctionTimer);
  if(state.page!=='K'||externalChange)return false;
  const input=app.querySelector('#correction');
  if(input)state=transition(state,{type:'EDIT_CORRECTION',value:input.value});
  const result=store.persist(state);
  if(result.ok){state=result.state;ui.correctionError='';notify();return true;}
  ui.correctionError='本机保存失败，当前文字还在。请保留本页重试。';
  if(result.stale||result.conflict)externalChange=true;
  patch();return false;
}
function confirmDeleteDialog(){
  const letter=currentLetter(state),response=state.responses[letter?.responseId];
  if(!letter||!response||response.status!=='ACTIVE'||ui.pendingMutation)return;
  const dialog=document.createElement('dialog');dialog.className='confirm-dialog';dialog.setAttribute('aria-labelledby','delete-heading');
  dialog.innerHTML=`<h2 id="delete-heading">删除这条回应？</h2><p class="confirm-object">「${e(letter.title)}」里你送出的回应 · 版本 ${response.currentRevision}</p><p>删除后，它不会再被用于未来的旅行来信。\n已经寄到你这里的旧明信片不会被偷偷改掉。</p><p>保存的原文和旧版本也会清除。所有来源中的回应原文也将不再显示。删除无法撤销。</p><div class="card-actions"><button type="button" class="secondary" data-action="cancel-delete">取消</button><button type="button" class="primary" data-action="confirm-delete">删除</button></div>`;
  app.append(dialog);dialog.showModal();dialog.querySelector('[data-action="cancel-delete"]').focus();
}
function runMutation(type){
  if(ui.pendingMutation||externalChange||state.page!=='K')return;
  const letter=currentLetter(state),response=state.responses[letter?.responseId],draft=state.correctionDrafts[letter?.id];
  if(!letter||!response||response.status!=='ACTIVE'||type==='CORRECT'&&!draft)return;
  if(type==='CORRECT'&&!saveCorrectionDraft())return;
  if(type==='CORRECT'&&draft.baseRevision!==response.currentRevision){ui.correctionError='回应版本已变化，请重新读取并核对后操作。';render();return;}
  const ticket={type,responseId:response.id,letterId:letter.id,expectedRevision:type==='CORRECT'?draft.baseRevision:response.currentRevision,
    key:`mutation-${globalThis.crypto?.randomUUID?.()||`${Date.now()}-${++mutationSerial}`}`,
    text:type==='CORRECT'?draft.text:null,at:new Date().toISOString()};
  if(type==='DELETE'){
    const cleaned=store.redactImportedLegacy({letterId:letter.id,catId:state.appearanceId,catName:state.catName});
    if(!cleaned.ok){ui.correctionError='旧预览副本暂时没能清除。回应仍保留，请稍后重试。';render();return;}
  }
  const result=store.mutateResponse(ticket);
  if(result.ok){state=result.state;ui.pendingMutation=null;ui.correctionError='';ui.editing=false;
    ui.mutationNotice=type==='DELETE'?'回应已删除，已寄旅行信仍保留。':'更正已保存。';render();return;}
  if(result.unknown){ui.pendingMutation=ticket;ui.correctionError='操作结果还不确定，请先重新读取。';render();return;}
  if(result.stale){externalChange=true;ui.correctionError='回应已在另一处变化，请重新读取后核对。';render();return;}
  ui.correctionError='这次没能保存，当前文字仍在。请重试。';render();
}
function recoverMutation(){
  const ticket=ui.pendingMutation;if(!ticket)return;
  const result=store.recoverMutation(ticket);
  if(!result.ok){ui.correctionError='暂时无法确认结果。请保留本页，稍后重新读取。';render();return;}
  state=result.state;ui.pendingMutation=null;ui.correctionError='';externalChange=false;
  ui.mutationNotice=result.committed?(ticket.type==='DELETE'?'已确认：回应已删除。':'已确认：更正已保存。'):
    '已确认：上次操作未写入；草稿和原回应仍保留。';
  const opened=transition(state,{type:'OPEN_NEED',letterId:ticket.letterId,at:new Date().toISOString()});
  const managed=transition(opened,{type:'OPEN_MANAGE'});
  const saved=store.persist(managed);
  if(saved.ok)state=saved.state;
  ui.editing=!result.committed&&ticket.type==='CORRECT'&&state.responses[ticket.responseId]?.status==='ACTIVE';
  render();
}
function saveDraft(){clearTimeout(saveTimer);if(externalChange||composing||state.replySubmitState==='SUBMITTING'||state.replySubmitState==='SUCCESS')return false;const l=currentLetter(state);if(!l||l.draftSaveState==='SAVED'&&l.savedRevision===l.draftRevision)return true;state=transition(state,{type:'BEGIN_SAVE'});patch();const r=store.saveDraft(state);if(r.event)state=transition(state,r.event);if(r.stale){externalChange=true;const pending=state.pendingSave;if(pending)state=transition(state,{type:'SAVE_ERROR',...pending});}patch();return r.ok;}
function goHome(eventType='BACK_HOME'){
 if(state.replySubmitState==='SUBMITTING')return;
 if(state.page==='G'&&currentLetter(state)?.draft&&!saveDraft()){saveFailure=true;patch();return;}
 ui.draftRestored=false;ui.focus=false;ui.replyExpanded=false;ui.imageError=false;ui.catImageError=false;
 if(apply({type:eventType},{save:true}))scrollToTop();
}
function openLetter(letter,{resume=false}={}){
 if(!letter||externalChange)return;
 const firstRead=letter.type==='POSTCARD'&&letter.readState==='UNREAD';
 const next=transition(state,{type:letter.type==='POSTCARD'?'OPEN_POSTCARD':'OPEN_NEED',letterId:letter.id,at:new Date().toISOString()});
 if(next.page===state.page&&next.currentLetterId===state.currentLetterId){if(resume){ui.replyExpanded=true;render();}return;}
 const result=store.persist(next);
 if(!result.ok){saveFailure=true;if(result.stale||result.conflict)externalChange=true;patch();return;}
 state=result.state;saveFailure=false;ui.imageError=false;ui.catImageError=false;
 ui.firstRead=firstRead;ui.sourceOpen=false;ui.mutationNotice='';
 ui.draftRestored=letter.type==='NEED_CARD'&&!!letter.draft;
 ui.replyExpanded=resume&&letter.type==='NEED_CARD';
 ui.focus=false;render();scrollToTop();
}
async function submit(){if(externalChange||composing||!canSubmit(state))return;clearTimeout(saveTimer);state=transition(state,{type:'BEGIN_SUBMIT'});const ticket=state.pendingSubmission?.requestId;if(!ticket)return;if(!persist()){if(!externalChange)state=transition(state,{type:'SEND_ERROR',letterId:state.currentLetterId,requestId:ticket});patch();return;}patch();app.querySelectorAll('[data-action="home"],[data-action="skip"]').forEach(b=>b.disabled=true);sendTimer=setTimeout(()=>{if(externalChange||state.submissionRecoveryRequired||state.pendingSubmission?.requestId!==ticket)return;const r=store.commitReply(state);if(r.event)state=transition(state,r.event);render();if(state.page==='H')scrollToTop();},850);}
app.addEventListener('submit',event=>{event.preventDefault();if(event.target.id==='correction-form')runMutation('CORRECT');else submit();});
app.addEventListener('click',event=>{const b=event.target.closest('[data-action]');if(!b||b.disabled)return;const a=b.dataset.action;
 if(a==='expand-reply'){if(!ui.replyExpanded){ui.replyExpanded=true;render();}focusReply(app,b.dataset.replyTarget);}
 else if(a==='focus-reply')focusReply(app,b.dataset.replyTarget);else if(a==='home'||a==='skip'||a==='new-mail-home')goHome();
 else if(a==='return-letter'){goHome('RETURN_FROM_LETTER');if(state.page==='J')restoreScroll(inboxScroll);}
 else if(a==='return-manage'){clearTimeout(correctionTimer);if(ui.editing&&!saveCorrectionDraft())return;ui.editing=false;if(apply({type:'RETURN_MANAGE'},{save:true})){if(state.page==='R')restoreScroll(historyScroll);else if(state.page==='I')restoreScroll(postcardScroll);else scrollToTop();}}
 else if(a==='open-manage'){if(apply({type:'OPEN_MANAGE'},{save:true})){ui.editing=false;ui.correctionError='';scrollToTop();}}
 else if(a==='open-history'){inboxScroll=currentScroller()?.scrollTop||0;if(apply({type:'OPEN_HISTORY'},{save:true}))scrollToTop();}
 else if(a==='return-history'){if(apply({type:'RETURN_HISTORY'},{save:true}))restoreScroll(inboxScroll);}
 else if(a==='open-history-letter'){historyScroll=currentScroller()?.scrollTop||0;if(apply({type:'OPEN_HISTORY_LETTER',letterId:b.dataset.letterId},{save:true})){ui.editing=false;scrollToTop();}}
 else if(a==='manage-source'){postcardScroll=currentScroller()?.scrollTop||0;if(apply({type:'OPEN_SOURCE_HISTORY',letterId:b.dataset.letterId},{save:true})){ui.editing=false;scrollToTop();}}
 else if(a==='edit-correction'){if(apply({type:'BEGIN_CORRECTION'},{save:true})){ui.editing=true;render();app.querySelector('#correction')?.focus();}}
 else if(a==='cancel-edit'){clearTimeout(correctionTimer);if(!saveCorrectionDraft())return;ui.editing=false;render();}
 else if(a==='ask-delete')confirmDeleteDialog();
 else if(a==='cancel-delete'){app.querySelector('dialog')?.close();app.querySelector('dialog')?.remove();}
 else if(a==='confirm-delete'){app.querySelector('dialog')?.close();app.querySelector('dialog')?.remove();runMutation('DELETE');}
 else if(a==='recover-mutation')recoverMutation();
 else if(a==='set-filter'){ui.inboxFilter=b.dataset.filter;render();scrollToTop();}
 else if(a==='clear-filter'){ui.inboxFilter='all';ui.unreadOnly=false;render();scrollToTop();}
 else if(a==='inbox'||a==='history'){inboxScroll=0;if(apply({type:'OPEN_INBOX'},{save:true}))scrollToTop();}
 else if(a==='open-letter')openLetter(getHomeEntry(state));
 else if(a==='open-inbox-letter'||a==='resume-draft'){if(a==='open-inbox-letter')inboxScroll=currentScroller()?.scrollTop||0;openLetter(state.letters[b.dataset.letterId],{resume:a==='resume-draft'});}
 else if(a==='retry-image'){ui.imageError=false;ui.catImageError=false;ui.imageRetry=(ui.imageRetry||0)+1;replaceScene();}
 else if(a==='retry-load'){ui.loading=false;const r=store.load(state);state=state.page==='G'&&r.ok?transition(state,{type:'LOAD_SUCCESS'}):r.state;render();}
 else if(a==='retry-refresh'){ui.reading=false;const r=store.load(state);if(r.ok)state=transition(r.state,{type:'REFRESH_SUCCESS'});else state=transition(state,{type:'REFRESH_ERROR'});render();}
 else if(a==='recover'){const r=store.recoverSubmission(state);if(r.event)state=transition(state,r.event);if(!state.submissionRecoveryRequired)persist();render();}
 else if(['retry-draft','draft-retry'].includes(a))saveDraft();
 else if(['retry-check','check-retry'].includes(a))submit();
 else if(a==='retry-persist'){persist();patch();}
 else if(a==='external-reload'){clearTimeout(sendTimer);clearTimeout(saveTimer);clearTimeout(correctionTimer);const correction=state.page==='K'?app.querySelector('#correction')?.value:null;if((currentLetter(state)?.draft||correction)&&!confirm('重新读取会替换本页的未保存文字。请先复制保留文字，再继续读取。'))return;externalChange=false;const r=store.load(state);state=r.state;render();}
});
app.addEventListener('change',event=>{if(event.target.id==='unread-only'){ui.unreadOnly=event.target.checked;render();scrollToTop();}});
window.addEventListener('pagehide',()=>{if(!fixture&&!externalChange&&state.page==='G'&&state.replySubmitState!=='SUBMITTING'){const ta=app.querySelector('textarea');if(ta)state=transition(state,{type:'EDIT',value:ta.value});composing=false;saveDraft();}if(!fixture&&!externalChange&&state.page==='K')saveCorrectionDraft();});
window.addEventListener('storage',ev=>{
 if(fixture||ev.key!==store.key)return;
 clearTimeout(saveTimer);clearTimeout(sendTimer);clearTimeout(correctionTimer);
 const oldLetterId=state.currentLetterId,oldPage=state.page;
 const correctionText=oldPage==='K'?app.querySelector('#correction')?.value:null;
 const correctionBase=state.correctionDrafts?.[oldLetterId]?.baseRevision;
 const replyText=oldPage==='G'&&state.letters[oldLetterId]?.replySubmitState!=='SUCCESS'?
   app.querySelector('#daily-reply')?.value:null;
 const remote=store.load(state);
 if(!remote.ok){
   externalChange=true;window.__dailyState=null;window.__dailyUI={externalChange:true};
   app.innerHTML='<section class="daily-page entry-page"><div class="error-block"><h2>本机记录已在另一页面变化</h2><p>暂时无法安全读取最新内容。请保留页面，稍后重新读取。</p><button class="secondary" data-action="external-reload">重新读取</button></div></section>';
   return;
 }
 state=remote.state;externalChange=false;ui.firstRead=false;ui.sourceOpen=false;
 const active=state.letters[oldLetterId],record=state.responses[active?.responseId];
 if(typeof correctionText==='string'&&record?.status==='ACTIVE'){
   state=transition(state,{type:'OPEN_NEED',letterId:oldLetterId});
   state=transition(state,{type:'OPEN_MANAGE'});
   state.correctionDrafts[oldLetterId]={text:correctionText,baseRevision:correctionBase,responseId:record.id};
   state.revision+=1;
   externalChange=true;
   ui.correctionError='另一个页面更新了记录；当前文字仍在本页，请复制保留后重新读取。';
 }else if(typeof replyText==='string'&&active?.type==='NEED_CARD'&&active.replySubmitState!=='SUCCESS'){
   state=transition(state,{type:'OPEN_NEED',letterId:oldLetterId});
   state=transition(state,{type:'EDIT',value:replyText});
   externalChange=true;saveFailure=true;
 }
 const pendingResponse=state.responses[ui.pendingMutation?.responseId];
 if(pendingResponse?.status==='DELETED'){
   ui.pendingMutation={key:ui.pendingMutation.key,type:ui.pendingMutation.type,
     responseId:pendingResponse.id,letterId:pendingResponse.letterId,
     expectedRevision:ui.pendingMutation.expectedRevision,text:null};
   ui.editing=false;
 }
 if(record?.status==='DELETED'){
   ui.editing=false;ui.correctionError='';ui.mutationNotice='这条回应已在另一页面删除。';
 }
 render();
});
window.addEventListener('message',ev=>{if(ev.origin!==location.origin||ev.source!==parent||ev.data?.type!=='daily-review-action')return;const action=ev.data.action;
 if(!fixture){
  if(['mutation-failure','mutation-unknown-before','mutation-unknown-after','mutation-read-error'].includes(action)){
    const key={'mutation-failure':'mutationError','mutation-unknown-before':'mutationUnknownBefore',
      'mutation-unknown-after':'mutationUnknownAfter','mutation-read-error':'mutationReadError'}[action];
    failures[key]=1;return;
  }
  if(!['deliver-next-demand','trip','home','deliver-travel','open-new-letter'].includes(action))return;
  const report=(status,message,id)=>parent.postMessage({type:'demand-delivery-result',status,message,id,requestId:ev.data.requestId},location.origin);
  if(externalChange||saveFailure||state.loadError){report('blocked','本机记录尚未就绪，请先重新读取或保存。');return;}
  if(action==='open-new-letter'){
    const letter=state.letters[state.newLetterId];
    if(!letter){report('blocked','当前没有未读来信。');return;}
    openLetter(letter);
    report(state.currentLetterId===letter.id?'opened':'blocked',state.currentLetterId===letter.id?'已打开这封来信。':'暂时没能打开来信。',letter.id);
    return;
  }
  if(action==='trip'||action==='home'){
    const changed=apply({type:action==='trip'?'CAT_TRIP':'CAT_HOME'},{save:true});
    report(changed?'delivered':'blocked',changed?(action==='trip'?'小猫已出发，原有来信仍在。':'小猫已回家，原有来信仍在。'):'状态暂时没能保存。');
    return;
  }
  if(state.newLetterId){report('blocked','先读完当前未读来信，再投递下一组。');return;}
  if(action==='deliver-travel'){
    if(state.catState!=='TRIP'){report('blocked','请先在审阅工具中让小猫出发旅行。');return;}
    const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const built=makeTravelDelivery(state,{sceneId:ev.data.sceneId,linked:ev.data.linked===true,date});
    if(!built.ok){report('blocked',built.error==='NO_VERIFIED_SOURCE'?'没有已人工核对的对应回应原文；可选择普通旅行信。':built.error==='ALREADY_DELIVERED'?'这篇旅行信已经收到。':'旅行场景参数不正确。');return;}
    const delivered=apply({type:'NEW_LETTER',letter:built.letter},{paint:state.page!=='G',save:true});
    report(delivered&&state.newLetterId===built.letter.id?'delivered':'blocked',
      delivered&&state.newLetterId===built.letter.id?`已收到「${built.letter.title}」。`:'暂时没能保存这封旅行信。',built.letter.id);
    return;
  }
  if(state.catState==='TRIP'){report('blocked','小猫旅行中；先回家再接收新的需求卡。');return;}
  if(state.page==='H'){report('blocked','先从送出成功页回到家。');return;}
  const next=nextDemandForState(state);
  if(!next){report('complete','七组需求卡都已进入这只小猫的来信记录。');return;}
  const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const delivered=apply({type:'NEW_LETTER',letter:demandLetter(next.id,date)},{paint:state.page!=='G',save:true});
  report(delivered&&state.newLetterId===next.id?'delivered':'blocked',
    delivered&&state.newLetterId===next.id?`已收到「${next.title}」；打开来信即可阅读。`:'暂时没能保存这封来信；原有记录仍在。',next.id);
  return;
 }
 if(action==='arrive-need')apply({type:'NEW_LETTER',letter:LETTER_FIXTURES['need-02']},{paint:state.page!=='G',save:true});
 if(action==='arrive-postcard')apply({type:'NEW_LETTER',letter:LETTER_FIXTURES['postcard-rhine-demo']},{paint:state.page!=='G',save:true});
 if(action==='trip'||action==='home')apply({type:action==='trip'?'CAT_TRIP':'CAT_HOME'},{paint:state.page!=='G',save:true});
 if(action==='read-postcard'){const l=Object.values(state.letters).find(l=>l.type==='POSTCARD');if(l)apply({type:'POSTCARD_READ',letterId:l.id},{paint:state.page!=='G',save:true});}
 if(action==='old-draft'){const l=Object.values(state.letters).find(l=>l.type==='NEED_CARD'&&l.readState==='READ');if(l){ui.draftRestored=!!l.draft;ui.replyExpanded=true;apply({type:'OPEN_NEED',letterId:l.id},{save:true});}}
 if(action==='send-error')failures.sendError=1;if(action==='save-error')failures.draftError=1;if(action==='check-error')failures.checkError=1;if(action==='safety')failures.safetyBlocked=1;
 if(action==='refresh-error'){apply({type:state.page==='H'?'REFRESH_ERROR':'LOAD_ERROR'});}
 if(action==='reset'&&fixture){clearTimeout(sendTimer);clearTimeout(saveTimer);failures={};const demoMemory=new Map();store=createDailyStore({storage:{getItem:k=>demoMemory.get(k)??null,setItem:(k,v)=>demoMemory.set(k,v),removeItem:k=>demoMemory.delete(k)}});state=initialState({catId:state.appearanceId,appearanceId:state.appearanceId,catName:state.catName,initialLetter:null});ui={};externalChange=false;saveFailure=false;render();}
});
render();
}
}
