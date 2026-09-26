import {initialState,transition,countName,validateName,canContinue} from './flow-state.mjs';
import {cats,scenarios} from './scenarios.mjs';

const root=document.getElementById('flow');
const params=new URLSearchParams(location.search);
const scene=scenarios.find(s=>s.id===params.get('scene'));
const RULE='每个账号只能领养一只小猫。确认后，将无法更换或领养其他小猫。请确认你的选择。';
const escapeText=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=n=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${n==='check'?'<path d="m5 12 4 4L19 6"/>':'<path d="M5 12h14m-5-5 5 5-5 5"/>'}</svg>`;
let state=initialState();
let touched=false,composing=false,reading=false,handedOff=false;
let failed=new Set(),fixtureFailed=new Set(),requestNumber=0;
let storedResult=null;
const STORAGE_KEY='cat-letters-ui-adoption-flow-v1:tab-demo';
let recoveryBlocked=false;
const simulatedOutcome=['ERROR','UNKNOWN'].includes(params.get('outcome'))?params.get('outcome'):'CONFIRMED';
let nextOutcome=simulatedOutcome;
if(scene){
  state={...state,step:scene.page,selectedCatId:scene.cat??null,catNameDraft:scene.name??'',adoptionStatus:scene.status??'UNCONFIRMED'};
  touched=!!scene.error;reading=!!scene.reading;
  if(scene.fail){failed.add(scene.fail);fixtureFailed.add(scene.fail);}
  if(['UNKNOWN','CONFIRMED'].includes(state.adoptionStatus))storedResult={catId:state.selectedCatId,name:state.catNameDraft};
  if(state.adoptionStatus==='CONFIRMED')state.confirmedCat={...storedResult};
}else{
  restore();
}
function validRecord(record){return !!record&&cats.some(c=>c.id===record.catId)&&typeof record.name==='string'&&!validateName(record.name);}
function restore(){
  try{
    const raw=sessionStorage.getItem(STORAGE_KEY);if(!raw)return;
    const saved=JSON.parse(raw),s=saved.state;
    if(saved.version!==1||!s||!['A','B','C'].includes(s.step)||!['UNCONFIRMED','SUBMITTING','UNKNOWN','ERROR','CONFIRMED'].includes(s.adoptionStatus)||typeof s.catNameDraft!=='string')throw Error('Invalid demo snapshot');
    if(s.selectedCatId!==null&&!cats.some(c=>c.id===s.selectedCatId))throw Error('Invalid cat');
    if(s.step!=='A'&&!s.selectedCatId)throw Error('Missing cat');
    if(['SUBMITTING','UNKNOWN','CONFIRMED'].includes(s.adoptionStatus)&&(s.step!=='C'||validateName(s.catNameDraft)))throw Error('Invalid pending record');
    if(s.adoptionStatus==='CONFIRMED'&&(!validRecord(s.confirmedCat)||s.confirmedCat.catId!==s.selectedCatId||s.confirmedCat.name!==s.catNameDraft))throw Error('Invalid confirmed record');
    state={step:s.step,selectedCatId:s.selectedCatId,catNameDraft:s.catNameDraft,adoptionStatus:s.adoptionStatus,confirmedCat:s.confirmedCat??null};
    storedResult=validRecord(saved.storedResult)?saved.storedResult:saved.storedResult?.status==='ERROR'?{status:'ERROR'}:null;
    if(storedResult?.status==='ERROR')nextOutcome='CONFIRMED';
    if(state.adoptionStatus==='SUBMITTING')state.adoptionStatus='UNKNOWN';
    recoveryBlocked=false;
  }catch{recoveryBlocked=true;}
}
function persist(){
  if(scene||recoveryBlocked)return !recoveryBlocked;
  try{sessionStorage.setItem(STORAGE_KEY,JSON.stringify({version:1,state,storedResult}));return true;}catch{return false;}
}
if(params.get('text')==='200')document.documentElement.classList.add('large-type');
if(scene?.keyboard){
  document.body.classList.add('keyboard-demo','keyboard-open');
  const keyboard=document.getElementById('keyboard-model');keyboard.hidden=false;
  keyboard.innerHTML=`<div class="keyboard-caption">系统键盘占位示意 · 不代表真机键盘测试</div>${['QWERTYUIOP','ASDFGHJKL','ZXCVBNM'].map(row=>`<div class="keyboard-row">${[...row].map(k=>`<span class="keyboard-key">${k}</span>`).join('')}</div>`).join('')}<div class="keyboard-row"><span class="keyboard-key">123</span><span class="keyboard-key wide">空格</span><span class="keyboard-key">完成</span></div>`;
}

const isLocked=()=>['SUBMITTING','UNKNOWN','CONFIRMED'].includes(state.adoptionStatus);
const currentCat=()=>cats.find(c=>c.id===(state.confirmedCat?.catId??state.selectedCatId));
function top(showBack=false){return `<header class="flow-top ${showBack?'has-back':''}">${showBack?`<button class="text-button back-button" data-action="back">${icon('arrow')}返回</button>`:''}<div class="brand">有猫来信</div></header>`;}
function imageMarkup(cat){return failed.has(cat.id)?`<div class="image-failure" role="status"><strong>${cat.name}</strong>图片暂时没加载出来</div>`:`<img src="assets/${cat.file}" alt="${cat.name}猫完整全身像" data-cat-image="${cat.id}" draggable="false">`;}
function catPreview(cat){return `<div class="single-cat" aria-label="已选${cat.name}猫">${imageMarkup(cat)}${failed.has(cat.id)?`<button class="text-button retry-image" data-retry="${cat.id}">重新加载</button>`:''}</div>`;}
function chooseView(){
  return `${top()}<h1 class="flow-heading" tabindex="-1">选一只你喜欢的小猫吧</h1><p class="flow-intro">以后，它会一直是陪你生活和旅行的那一只。</p><fieldset class="adoption-cats"><legend class="visually-hidden">选择小猫外观</legend>${cats.map(cat=>`<div class="cat-tile ${failed.has(cat.id)?'has-failure':''}"><label class="choice-card"><input type="radio" name="selected-cat" value="${cat.id}" aria-label="选择${cat.name}猫" ${state.selectedCatId===cat.id?'checked':''}><span class="cat-visual">${imageMarkup(cat)}</span><h3>${cat.name}</h3><span class="choice-control"><span class="radio-ring">${icon('check')}</span><span class="choice-word">${state.selectedCatId===cat.id?'已选择':'未选择'}</span></span></label>${failed.has(cat.id)?`<button class="text-button retry-image" data-retry="${cat.id}">重新加载</button>`:''}</div>`).join('')}</fieldset><footer class="flow-footer"><p class="local-note">当前为本机测试体验。</p><button class="primary" data-action="next" ${canContinue(state)?'':'disabled'}>继续${icon('arrow')}</button></footer>`;
}
function nameView(){
  const error=(touched||countName(state.catNameDraft)>12)?validateName(state.catNameDraft):'';
  return `${top(true)}<h1 class="flow-heading" tabindex="-1">给它起个名字吧</h1>${catPreview(currentCat())}<form class="name-form" novalidate><label class="name-label" for="cat-name">小猫的名字</label><input class="name-input" id="cat-name" name="catName" type="text" autocomplete="off" enterkeyhint="next" placeholder="给它起个名字" value="${escapeText(state.catNameDraft)}" aria-invalid="${!!error}" aria-describedby="name-help name-count"><div class="field-support"><p id="name-help" class="${error?'field-error':''}" aria-live="polite">${error||'最多 12 个字'}</p><span id="name-count" class="count">${countName(state.catNameDraft)} / 12</span></div><button class="primary" type="submit" ${canContinue(state)?'':'disabled'}>继续${icon('arrow')}</button></form><p class="local-note">当前为本机测试体验。</p>`;
}
function confirmView(){
  const status=state.adoptionStatus;
  const locked=isLocked();
  let feedback='',buttons='';
  if(status==='SUBMITTING'){
    feedback='<p class="outcome-message pending-line" role="status"><span class="pending-dot" aria-hidden="true"></span>正在确认领养……</p>';
    buttons='<button class="primary" disabled>正在确认领养……</button>';
  }else if(status==='UNKNOWN'){
    feedback='<p class="outcome-message pending-line" role="status"><span class="pending-dot" aria-hidden="true"></span>正在确认你的小猫……</p>';
    buttons=`<button class="primary" data-action="read" ${reading?'disabled':''}>${reading?'正在读取……':'重新读取'}</button>`;
  }else if(status==='CONFIRMED'){
    feedback='<p class="outcome-message is-success" role="status">已确认领养</p>';
    buttons=`<button class="primary" data-action="continue" ${handedOff?'disabled':''}>继续和它生活${icon('arrow')}</button>`;
  }else{
    if(status==='ERROR')feedback='<p class="outcome-message" role="alert">好像没有保存成功，再试一次吧。</p>';
    buttons=`<button class="secondary" data-action="back">再看看</button><button class="primary" data-action="confirm">${status==='ERROR'?'再试一次':'确认领养'}</button>`;
  }
  return `${top(!locked)}<h1 class="flow-heading" tabindex="-1">${status==='CONFIRMED'?'确认领养':'确认领养'}</h1>${catPreview(currentCat())}<h2 class="cat-name">${escapeText(state.confirmedCat?.name??state.catNameDraft.trim())}</h2><p class="cat-welcome">以后，就和它一起生活啦。</p><div class="inline-notice adoption-rule">${RULE}</div>${feedback}<div class="confirm-actions ${locked?'one':''}" ${status==='SUBMITTING'||reading?'aria-busy="true"':''}>${buttons}</div><p class="local-note">当前为本机测试体验；这里演示正式版的领养规则。</p>${handedOff?'<p class="handoff-note" role="status">初遇与领养流程已完成。后续体验页面将在下一批设计中衔接。</p>':''}`;
}
function attachImageErrors(){
  root.querySelectorAll('img[data-cat-image]').forEach(img=>{
    const fail=()=>{if(!failed.has(img.dataset.catImage)){failed.add(img.dataset.catImage);render();}};
    img.addEventListener('error',fail,{once:true});
    if(img.complete&&img.naturalWidth===0)fail();
  });
}
function render(focusHeading=false){
  if(recoveryBlocked){
    root.innerHTML=`${top()}<h1 class="flow-heading">正在确认你的小猫……</h1><p class="outcome-message" role="alert">暂时无法读取已保存的体验。已有信息会保留，请重新读取。</p><div class="confirm-actions one"><button class="primary" data-action="recover">重新读取</button></div>`;
    root.dataset.status='UNKNOWN';return;
  }
  if(state.step!=='A'&&!currentCat())state=initialState();
  root.className=`flow-page ${state.step==='A'?'choose-page':state.step==='B'?'name-page centered':'confirm-page centered'}`;
  root.dataset.step=state.step;root.dataset.status=state.adoptionStatus;
  root.innerHTML=state.step==='A'?chooseView():state.step==='B'?nameView():confirmView();
  history.replaceState(null,'',`${location.pathname}${location.search}#UI-01${state.step}`);
  attachImageErrors();
  persist();
  if(focusHeading){root.querySelector('h1').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
}
function dispatch(event,focus=false){state=transition(state,event);render(focus);}
function updateName(){
  const input=root.querySelector('#cat-name');if(!input)return;
  state=transition(state,{type:'SET_NAME',value:input.value});
  persist();
  if(composing)return;
  const error=(touched||countName(input.value)>12)?validateName(input.value):'';
  input.setAttribute('aria-invalid',String(!!error));
  const help=root.querySelector('#name-help');help.textContent=error||'最多 12 个字';help.className=error?'field-error':'';
  root.querySelector('#name-count').textContent=`${countName(input.value)} / 12`;
  root.querySelector('form .primary').disabled=!canContinue(state);
}
function submit(){
  const previous=state.adoptionStatus;
  state=transition(state,{type:'BEGIN_SUBMIT'});
  if(state.adoptionStatus!=='SUBMITTING'||!['UNCONFIRMED','ERROR'].includes(previous))return;
  const request=++requestNumber,cat={catId:state.selectedCatId,name:state.catNameDraft.trim()};
  const outcome=nextOutcome;nextOutcome='CONFIRMED';
  storedResult=outcome==='ERROR'?{status:'ERROR'}:cat;
  if(!persist()){storedResult=null;state=transition(state,{type:'RESOLVE_SUBMIT',status:'ERROR'});render();return;}
  render();
  setTimeout(()=>{if(request!==requestNumber)return;state=transition(state,{type:'RESOLVE_SUBMIT',status:outcome,...(outcome==='CONFIRMED'?{confirmedCat:storedResult}:{})});render();},900);
}
function readResult(){
  if(state.adoptionStatus!=='UNKNOWN'||reading)return;
  reading=true;state=transition(state,{type:'BEGIN_READ'});render();
  setTimeout(()=>{reading=false;state=transition(state,{type:'RESOLVE_READ',confirmedCat:storedResult,status:storedResult?.status});render();},900);
}
root.addEventListener('change',e=>{
  if(e.target.matches('input[name=selected-cat]')){
    state=transition(state,{type:'SELECT_CAT',catId:e.target.value});
    persist();
    root.querySelectorAll('input[name=selected-cat]').forEach(input=>{input.checked=input.value===state.selectedCatId;input.closest('label').querySelector('.choice-word').textContent=input.checked?'已选择':'未选择';});
    root.querySelector('[data-action=next]').disabled=!canContinue(state);
  }
});
root.addEventListener('input',e=>{if(e.target.id==='cat-name')updateName();});
root.addEventListener('compositionstart',e=>{if(e.target.id==='cat-name'){composing=true;root.querySelector('form .primary').disabled=true;}});
root.addEventListener('compositionend',e=>{if(e.target.id==='cat-name'){composing=false;updateName();}});
root.addEventListener('focusout',e=>{if(e.target.id==='cat-name'){touched=true;updateName();}});
root.addEventListener('submit',e=>{e.preventDefault();if(composing)return;touched=true;updateName();if(canContinue(state))dispatch({type:'NEXT'},true);});
root.addEventListener('click',e=>{
  const retry=e.target.closest('[data-retry]');
  if(retry){fixtureFailed.delete(retry.dataset.retry);failed.delete(retry.dataset.retry);render();return;}
  const button=e.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action;
  if(action==='recover'){restore();render();return;}
  if(action==='next')dispatch({type:'NEXT'},true);
  if(action==='back'){touched=false;dispatch({type:'BACK'},true);}
  if(action==='confirm')submit();
  if(action==='read')readResult();
  if(action==='continue'&&state.adoptionStatus==='CONFIRMED'){handedOff=true;render();}
});
function syncKeyboard(){
  if(scene?.keyboard)return;
  document.body.classList.toggle('keyboard-open',state.step==='B'&&!!window.visualViewport&&window.visualViewport.height<window.innerHeight*.78);
}
window.visualViewport?.addEventListener('resize',syncKeyboard);
render();
if(scene?.focus)requestAnimationFrame(()=>root.querySelector('#cat-name')?.focus({preventScroll:true}));
