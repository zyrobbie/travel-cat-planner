import {needCard,replyInput,updateReplyInputState,focusReply,icon,escapeHtml as e,homeNavigation,newLetterEntry} from '../ui-components-v1/daily-components.mjs';
import {initialState,transition,currentLetter,getHomeEntry,inboxLetters,LETTER_FIXTURES,canSubmit} from './daily-state.mjs';
import {createDailyStore,STORAGE_KEY} from './storage.mjs';
import {buildScenario,SCENARIOS} from './scenarios.mjs';
import {readPreviewIdentity} from '../ui-adoption-flow-v1/preview-identity.mjs';
const params=new URLSearchParams(location.search), app=document.querySelector('#app');
const scenarioId=params.get('scenario'), requestedCat=params.get('cat');
const invalidScenario=params.has('scenario')&&(!SCENARIOS.some(s=>s.id===scenarioId)
  || requestedCat!==null&&!/^cat-0[1-4]$/.test(requestedCat));
const fixture=!invalidScenario&&scenarioId?buildScenario(scenarioId,{catId:params.get('cat')||'cat-01'}):null;
const identityResult=fixture||invalidScenario?{ok:true,identity:null}:readPreviewIdentity();
const LIVE_STORAGE_KEY='cat-letters-e3-g2r:daily-v1';
if(invalidScenario){
  document.documentElement.dataset.page='INVALID_SCENARIO';
  app.innerHTML='<section class="daily-page entry-page"><span class="wordmark">有猫来信 · 审阅</span><div class="entry-message"><h1>找不到这个审阅场景</h1><p>场景参数不正确，本机连续体验记录没有被打开或修改。</p><a class="primary" href="./review.html">返回场景审阅</a></div></section>';
}else if(!fixture&&(!identityResult.ok||!identityResult.identity)){
  document.documentElement.dataset.page='WELCOME';
  app.innerHTML=`<section class="daily-page entry-page"><span class="wordmark">有猫来信</span><div class="entry-message"><h1>${identityResult.ok?'先和小猫见面吧':'暂时无法读取本机领养记录'}</h1><p>${identityResult.ok?'选定小猫后，就能一起回家。':'请保留当前浏览器数据，稍后重新读取；已有记录不会因此清空。'}</p><a class="primary" href="../ui-adoption-flow-v1/index.html">${identityResult.ok?'去选小猫':'重新读取'}</a></div></section>`;
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
  const legacy=createDailyStore({key:STORAGE_KEY}).load();
  if(legacy.recovered&&legacy.ok&&legacy.state.appearanceId===liveIdentity.catId&&legacy.state.catName===liveIdentity.name){
    const migrated=store.persist(legacy.state);
    if(migrated.ok)loaded=store.load();
  }
}
let state=fixture?.state||loaded.state, saveTimer,sendTimer,composing=false,externalChange=false,saveFailure=false;
if(!fixture&&(state.appearanceId!==liveIdentity.catId||state.catName!==liveIdentity.name)){
  app.innerHTML='<section class="daily-page entry-page"><span class="wordmark">有猫来信</span><div class="entry-message"><h1>本机记录与已确认的小猫不一致</h1><p>记录已保留。请不要清除浏览器数据，先重新读取确认。</p><a class="primary" href="./index.html">重新读取</a></div></section>';
  if(parent!==window)parent.postMessage({type:'daily-state',state:{page:'ERROR',catState:null,newLetterId:null,letters:[]}},location.origin);
}else{
const restored=currentLetter(state)?.draftSaveState==='SAVED'&&!!currentLetter(state)?.draft;
if(!fixture&&restored)ui.draftRestored=true;
if(params.get('textScale')==='200')document.documentElement.dataset.textScale='200';
const arrow=()=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
const bodyById={'need-01':'窗边的小光点，刚才还在我的爪子旁边。\n我一眨眼，它就跑远了。\n明天它还会来吗？','need-02':'窗外又下起雨了。\n我把爪子缩进软软的毯子里，听见雨滴轻轻敲着玻璃。\n你那边，也在下雨吗？'};
function homeArtwork(){
  const trip=state.catState==='TRIP';
  const alt=trip?'熟悉的家，小猫出门旅行了':`${state.catName}在熟悉的家里`;
  return `<div class="scene home-scene${trip?' is-away':''}" id="home-scene" aria-label="${e(alt)}">${ui.imageError?`<div class="scene-fallback"><p>图片暂时没能加载。</p><button class="secondary" data-action="retry-image">再试一次</button></div>`:`<img class="home-room" src="./assets/V1-home-main-empty.png" alt="" width="1536" height="1024">${trip?'':ui.catImageError?`<div class="home-cat-failure"><p>${e(state.catName)}的画面暂时没能加载。</p><button class="secondary" data-action="retry-image">再试一次</button></div>`:`<span class="home-cat-shadow ${state.appearanceId}" aria-hidden="true"></span><img class="home-cat ${state.appearanceId}" src="../ui-adoption-flow-v1/assets/V1-cat-fullbody-${state.appearanceId}.png" alt="${e(state.catName)}猫在家中" width="1122" height="1402">`}`}</div>`;
}
function dateText(date){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return '';
  const parsed=new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.valueOf())?'':new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'numeric',day:'numeric'}).format(parsed);
}
function isToday(date){
  const now=new Date();const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return date===today;
}
function entryHeading(letter){
  if(letter.type==='POSTCARD')return state.catState==='TRIP'?'远方寄来了一封信':'旅行时寄来的信，还没打开';
  if(state.catState==='TRIP')return '出门前的来信，还没打开';
  return isToday(letter.date)?'今天有一封来信':'有一封来信，还没打开';
}
function draftLetter(){return Object.values(state.letters).find(letter=>letter.type==='NEED_CARD'&&letter.readState==='READ'&&letter.draft&&letter.replySubmitState!=='SUCCESS');}
function home(){
  const trip=state.catState==='TRIP',entry=getHomeEntry(state),draft=draftLetter();
  return `<section class="daily-page home-page"><header class="page-top"><span class="wordmark">有猫来信</span><button class="quiet-link" data-action="inbox">回看来信 <span aria-hidden="true">↗</span></button></header><div class="home-content"><div class="home-heading"><h1>${e(state.catName)}</h1><span class="cat-status${trip?' trip':''}">${trip?'旅行中':'在家'}</span></div>${ui.loading?'<div class="neutral-loading" role="status">正在读取本机记录…</div>':state.loadError?`<section class="error-block" role="status"><h2>暂时没能读取本机记录</h2><p>可以再试一次。</p><button class="secondary" data-action="retry-load">重新读取</button></section>`:`${homeArtwork()}<div class="life-copy"><h2>${trip?`${e(state.catName)}出去旅行啦。`:`${e(state.catName)}在家里慢慢过日子。`}</h2>${trip?'<p>家还是原来的样子，它在外面转悠呢。</p>':''}</div>${entry?newLetterEntry({type:entry.type,unread:true,title:entryHeading(entry),date:dateText(entry.date)}):`<div class="empty-letter">${trip?'暂时没有新来信。':'今天没有新来信。'}</div>`}${draft?`<button type="button" class="quiet-link draft-entry" data-action="resume-draft" data-letter-id="${e(draft.id)}">继续上次未写完的回应</button>`:''}`}<div data-slot="page-storage-error"></div></div>${homeNavigation({active:'cat',unread:!!entry})}</section>`;
}
function backButton(){return `<button type="button" class="quiet-link back-button" data-action="return-letter">${arrow()}${state.returnPage==='J'?'返回来信盒':'回到家'}</button>`;}
function eventScene(letter){
  if(letter.id==='need-02')return '<div class="scene event-scene"><div class="scene-fallback"><p>这封信的画面暂不可用，文字仍可阅读。</p></div></div>';
  if(ui.imageError)return '<div class="scene event-scene"><div class="scene-fallback"><p>这封信的画面暂时没能加载。</p><button class="secondary" data-action="retry-image">再试一次</button></div></div>';
  if(letter.id==='need-01')return `<div class="scene event-scene"><img src="./assets/V1-home-window-${state.appearanceId}${state.appearanceId==='cat-03'?'-V1':''}.png" alt="${e(state.catName)}在窗边追逐一小块光" width="1536" height="1024"></div>`;
  return '<div class="scene event-scene"><div class="scene-fallback"><p>这封信的画面暂不可用，文字仍可阅读。</p></div></div>';
}
function replyOptions(){const letter=currentLetter(state);return {mode:'e3',id:'daily-reply',name:state.catName,value:letter?.draft||'',maxLength:2000,draftState:ui.draftRestored?'restored':state.draftSaveState.toLowerCase(),submitState:state.replySubmitState.toLowerCase(),systemState:state.checkState==='CHECK_ERROR'?'check-error':state.checkState==='SAFETY'?'blocked':'none',composing:composing||externalChange||state.loadError};}
function newMailNotice(){return state.newLetterId?'<aside class="new-mail-notice"><span>有一封新来信</span><button type="button" data-action="new-mail-home">回首页看看</button></aside>':'';}
function detail(){
  const l=currentLetter(state),body=bodyById[l.id]||l.data?.body;
  if(!body)return `<section class="daily-page detail-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">一封来信</h1><div class="error-block"><h2>这封信的正文暂时无法读取</h2><p>信件记录仍在，可以返回后重试。</p></div></section>`;
  const response=l.replySubmitState==='SUCCESS'?`<section class="paper sent-reply"><h2>你送出的回应</h2><p>${e(l.submittedText)}</p></section>`:`<details class="tip-box"${ui.tipsOpen?' open':''}><summary>看看小提示</summary><p>可以说说你今天看见的一点小事，也可以只写一句话。<br>这次不想回，也没关系。</p></details><div data-slot="recovery">${recoveryNotice()}</div>${replyInput(replyOptions())}<button type="button" class="text-button skip" data-action="skip"${state.replySubmitState==='SUBMITTING'?' disabled':''}>这次先不回</button>`;
  return `<section class="daily-page detail-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">一封来信</h1><p class="letter-date">收到：${e(dateText(l.date))}</p><div data-slot="new-mail">${newMailNotice()}</div>${eventScene(l)}${needCard({mode:'e3',catId:state.appearanceId,catName:state.catName,time:dateText(l.date),title:l.title,body,avatarUrl:`./assets/V1-cat-avatar-${state.appearanceId}.png`,replyTargetId:'daily-reply',replyAction:l.replySubmitState!=='SUCCESS'})}${response}<div data-slot="page-storage-error"></div></section>`;
}
function postcard(){
  const l=currentLetter(state),body=l?.data?.body;
  if(!body)return `<section class="daily-page detail-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">旅行来信</h1><div class="error-block"><h2>这封信的正文暂时无法读取</h2><p>信件记录仍在，可以返回后重试。</p></div></section>`;
  const approvedDemo=l.data?.storyId==='UI-DEMO-RHINE-20260928'&&l.data?.sceneId==='RHINE';
  const picture=approvedDemo?(ui.imageError?'<div class="scene-fallback"><p>旅行画面暂时没能加载。</p><button class="secondary" data-action="retry-image">再试一次</button></div>':`<img src="./assets/V1-postcard-rhine-${state.appearanceId}.png" alt="${e(state.catName)}在山上望着河流的旅行画面" width="1536" height="1024">`):'<div class="scene-fallback"><p>这封旅行信的画面暂不可用，文字仍可阅读。</p></div>';
  return `<section class="daily-page postcard-page"><header class="detail-top">${backButton()}</header><h1 class="detail-title">旅行来信</h1><p class="letter-date">收到：${e(dateText(l.date))}</p><div class="scene postcard-scene">${picture}</div><article class="paper postcard-letter">${l.data?.place?`<p class="postcard-place">${e(l.data.place)}</p>`:''}<h2>${e(l.title)}</h2><p>${e(body)}</p></article><button type="button" class="secondary keep-letter" data-action="return-letter">收好这封信</button><div data-slot="page-storage-error"></div></section>`;
}
function inbox(){
  const letters=inboxLetters(state);
  return `<section class="daily-page inbox-page"><header class="page-top"><span class="wordmark">有猫来信</span></header><div class="home-content"><h1 class="detail-title">来信盒</h1>${letters.length?`<ul class="inbox-list">${letters.map(l=>`<li><button class="paper inbox-item" type="button" data-action="open-inbox-letter" data-letter-id="${e(l.id)}"><span class="inbox-kind">${l.type==='POSTCARD'?'旅行来信':'小猫来信'}${l.readState==='UNREAD'?' · 未读':''}</span><strong>${e(l.title)}</strong><span class="meta">${e(dateText(l.date))}</span>${l.type==='NEED_CARD'&&l.draft&&l.replySubmitState!=='SUCCESS'?'<span class="meta">有一份未写完的回应</span>':''}</button></li>`).join('')}</ul>`:'<p class="empty-letter">来信盒里还没有信。</p>'}<div data-slot="page-storage-error"></div></div>${homeNavigation({active:'inbox',unread:!!state.newLetterId})}</section>`;
}
function recoveryNotice(){if(state.loadError)return '<aside class="inline-notice page-banner" role="status"><strong>暂时没能读取本机记录。</strong><p>当前文字仍在这里，可以重新读取后再送出。</p><button class="secondary" data-action="retry-load">重新读取</button></aside>';return state.submissionRecoveryRequired?'<aside class="inline-notice page-banner" role="status"><strong>正在确认刚才的发送结果。</strong><p>文字仍在这里，先重新读取结果。</p><button class="secondary" data-action="recover">重新读取</button></aside>':'';}
function success(){return `<section class="daily-page success-page"><header class="page-top"><span class="wordmark">有猫来信</span></header><div class="success-content"><div class="success-panel">${icon('check')}<h1 class="story-title">送出去啦。</h1></div>${state.refreshError?'<aside class="inline-notice"><strong>回应已经送出。</strong><p>暂时没能读取最新状态，可以重新读取，也可以先回到小猫身边。</p><button class="secondary" data-action="retry-refresh">重新读取</button></aside>':''}${ui.reading?'<p class="local-notice" role="status">回应已经送出，正在读取最新状态…</p>':''}<button class="primary" data-action="home">回到家</button></div></section>`;}
function keyboard(){return '<aside class="keyboard-study" aria-label="键盘布局示意"><p>键盘展开 · 布局示意</p><div class="key-row">'+['Q','W','E','R','T','Y','U','I','O','P'].map(x=>`<span class="key">${x}</span>`).join('')+'</div><div class="key-row">'+['A','S','D','F','G','H','J','K','L'].map(x=>`<span class="key">${x}</span>`).join('')+'</div><div class="key-row">'+['⇧','Z','X','C','V','B','N','M','⌫'].map(x=>`<span class="key">${x}</span>`).join('')+'</div><div class="key-row"><span class="key">123</span><span class="key">◉</span><span class="key key-wide">空格</span><span class="key">换行</span></div></aside>';}
function render(){document.documentElement.dataset.page=state.page;document.body.classList.toggle('keyboard-layout',!!ui.keyboard&&state.page==='G');app.innerHTML=(['E','F'].includes(state.page)?home():state.page==='G'?detail():state.page==='I'?postcard():state.page==='J'?inbox():success())+(ui.keyboard&&state.page==='G'?keyboard():'');
 if(ui.reading){const retry=app.querySelector('[data-action="retry-refresh"]');if(retry)retry.disabled=true;} app.querySelectorAll('.scene img').forEach(img=>img.addEventListener('error',()=>{if(img.classList.contains('home-cat'))ui.catImageError=true;else ui.imageError=true;render();},{once:true}));
 app.querySelectorAll('[data-action="home"],[data-action="skip"]').forEach(b=>b.disabled=state.replySubmitState==='SUBMITTING');
 const ta=app.querySelector('textarea');if(ta){ta.addEventListener('input',onInput);ta.addEventListener('compositionstart',()=>{composing=true;clearTimeout(saveTimer);patch();});ta.addEventListener('compositionend',()=>{composing=false;onInput();});growInput(ta);}
 if(ui.focus&&ta){ta.focus({preventScroll:true});ta.setSelectionRange(ta.value.length,ta.value.length);}
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
function saveDraft(){clearTimeout(saveTimer);if(externalChange||composing||state.replySubmitState==='SUBMITTING'||state.replySubmitState==='SUCCESS')return false;const l=currentLetter(state);if(!l||l.draftSaveState==='SAVED'&&l.savedRevision===l.draftRevision)return true;state=transition(state,{type:'BEGIN_SAVE'});patch();const r=store.saveDraft(state);if(r.event)state=transition(state,r.event);if(r.stale){externalChange=true;const pending=state.pendingSave;if(pending)state=transition(state,{type:'SAVE_ERROR',...pending});}patch();return r.ok;}
function goHome(eventType='BACK_HOME'){
 if(state.replySubmitState==='SUBMITTING')return;
 if(state.page==='G'&&currentLetter(state)?.draft&&!saveDraft()){saveFailure=true;patch();return;}
 ui.draftRestored=false;ui.focus=false;ui.imageError=false;ui.catImageError=false;
 if(apply({type:eventType},{save:true}))window.scrollTo(0,0);
}
function openLetter(letter){
 if(!letter||externalChange)return;
 const next=transition(state,{type:letter.type==='POSTCARD'?'OPEN_POSTCARD':'OPEN_NEED',letterId:letter.id});
 if(next.page===state.page&&next.currentLetterId===state.currentLetterId)return;
 const result=store.persist(next);
 if(!result.ok){saveFailure=true;if(result.stale||result.conflict)externalChange=true;patch();return;}
 state=result.state;saveFailure=false;ui.imageError=false;ui.catImageError=false;
 ui.draftRestored=letter.type==='NEED_CARD'&&!!letter.draft;
 ui.focus=false;render();window.scrollTo(0,0);
}
async function submit(){if(externalChange||composing||!canSubmit(state))return;clearTimeout(saveTimer);state=transition(state,{type:'BEGIN_SUBMIT'});const ticket=state.pendingSubmission?.requestId;if(!ticket)return;if(!persist()){if(!externalChange)state=transition(state,{type:'SEND_ERROR',letterId:state.currentLetterId,requestId:ticket});patch();return;}patch();app.querySelectorAll('[data-action="home"],[data-action="skip"]').forEach(b=>b.disabled=true);sendTimer=setTimeout(()=>{if(externalChange||state.submissionRecoveryRequired||state.pendingSubmission?.requestId!==ticket)return;const r=store.commitReply(state);if(r.event)state=transition(state,r.event);render();if(state.page==='H')window.scrollTo(0,0);},850);}
app.addEventListener('submit',event=>{event.preventDefault();submit();});
app.addEventListener('click',event=>{const b=event.target.closest('[data-action]');if(!b||b.disabled)return;const a=b.dataset.action;
 if(a==='focus-reply')focusReply(app,b.dataset.replyTarget);else if(a==='home'||a==='skip'||a==='new-mail-home')goHome();
 else if(a==='return-letter')goHome('RETURN_FROM_LETTER');
 else if(a==='inbox'||a==='history'){if(apply({type:'OPEN_INBOX'},{save:true}))window.scrollTo(0,0);}
 else if(a==='open-letter')openLetter(getHomeEntry(state));
 else if(a==='open-inbox-letter'||a==='resume-draft')openLetter(state.letters[b.dataset.letterId]);
 else if(a==='retry-image'){ui.imageError=false;ui.catImageError=false;render();}
 else if(a==='retry-load'){ui.loading=false;const r=store.load(state);state=state.page==='G'&&r.ok?transition(state,{type:'LOAD_SUCCESS'}):r.state;render();}
 else if(a==='retry-refresh'){ui.reading=false;const r=store.load(state);if(r.ok)state=transition(r.state,{type:'REFRESH_SUCCESS'});else state=transition(state,{type:'REFRESH_ERROR'});render();}
 else if(a==='recover'){const r=store.recoverSubmission(state);if(r.event)state=transition(state,r.event);if(!state.submissionRecoveryRequired)persist();render();}
 else if(['retry-draft','draft-retry'].includes(a))saveDraft();
 else if(['retry-check','check-retry'].includes(a))submit();
 else if(a==='retry-persist'){persist();patch();}
 else if(a==='external-reload'){clearTimeout(sendTimer);clearTimeout(saveTimer);if(currentLetter(state)?.draft&&!confirm('重新读取会替换本页的未保存文字。请先复制保留文字，再继续读取。'))return;externalChange=false;const r=store.load(state);state=r.state;render();}
});
window.addEventListener('pagehide',()=>{if(!fixture&&!externalChange&&state.page==='G'&&state.replySubmitState!=='SUBMITTING'){const ta=app.querySelector('textarea');if(ta)state=transition(state,{type:'EDIT',value:ta.value});composing=false;saveDraft();}});
window.addEventListener('storage',ev=>{if(!fixture&&ev.key===store.key){clearTimeout(saveTimer);clearTimeout(sendTimer);externalChange=true;patch();}});
window.addEventListener('message',ev=>{if(!fixture||ev.origin!==location.origin||ev.source!==parent||ev.data?.type!=='daily-review-action')return;const action=ev.data.action;
 if(action==='arrive-need')apply({type:'NEW_LETTER',letter:LETTER_FIXTURES['need-02']},{paint:state.page!=='G',save:true});
 if(action==='arrive-postcard')apply({type:'NEW_LETTER',letter:LETTER_FIXTURES['postcard-rhine-demo']},{paint:state.page!=='G',save:true});
 if(action==='trip'||action==='home')apply({type:action==='trip'?'CAT_TRIP':'CAT_HOME'},{paint:state.page!=='G',save:true});
 if(action==='read-postcard'){const l=Object.values(state.letters).find(l=>l.type==='POSTCARD');if(l)apply({type:'POSTCARD_READ',letterId:l.id},{paint:state.page!=='G',save:true});}
 if(action==='old-draft'){const l=Object.values(state.letters).find(l=>l.type==='NEED_CARD'&&l.readState==='READ');if(l){ui.draftRestored=!!l.draft;apply({type:'OPEN_NEED',letterId:l.id},{save:true});}}
 if(action==='send-error')failures.sendError=1;if(action==='save-error')failures.draftError=1;if(action==='check-error')failures.checkError=1;if(action==='safety')failures.safetyBlocked=1;
 if(action==='refresh-error'){apply({type:state.page==='H'?'REFRESH_ERROR':'LOAD_ERROR'});}
 if(action==='reset'&&fixture){clearTimeout(sendTimer);clearTimeout(saveTimer);failures={};const demoMemory=new Map();store=createDailyStore({storage:{getItem:k=>demoMemory.get(k)??null,setItem:(k,v)=>demoMemory.set(k,v),removeItem:k=>demoMemory.delete(k)}});state=initialState({catId:state.appearanceId,appearanceId:state.appearanceId,catName:state.catName,initialLetter:null});ui={};externalChange=false;saveFailure=false;render();}
});
render();
}
}
