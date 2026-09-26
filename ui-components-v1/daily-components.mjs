/** Shared NeedCard / ReplyInput. Legacy defaults preserve the approved demo.
 * E3 is presentation only: the caller owns storage, safety checks and sending.
 */
const ASSETS = new URL('./assets/', import.meta.url);
let serial = 0;
export function resetComposerIds() { serial = 0; }
export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
const icons={arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',check:'<path d="m5 12 4 4L19 6"/>',mic:'<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',leaf:'<path d="M5 19C1 7 12 4 20 4c0 10-5 15-13 13M5 21 16 9"/>'};
export const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;

/** Complete body; focus action never expands/truncates the card. */
export function needCard(options = {}) {
  const {mode = 'legacy', variant = 'default'} = options;
  const e3 = mode === 'e3', alt = variant === 'content', active = variant === 'active';
  const catId = /^cat-0[1-4]$/.test(options.catId) ? options.catId : (alt ? 'cat-03' : 'cat-01');
  const identity = {'cat-01':'橘白猫','cat-02':'狸花猫','cat-03':'奶油白猫','cat-04':'三花猫'}[catId];
  const name = escapeHtml(options.catName ?? (alt ? '小白' : '小橘'));
  const time = escapeHtml(options.time ?? (alt ? '昨天 16:40' : '今天 09:20'));
  const title = escapeHtml(options.title ?? (alt ? '可以陪我听一会儿雨吗？' : '阳光会在这里等我吗？'));
  const body = escapeHtml(options.body ?? (alt ? '雨落在窗台上，一下，一下。\n我听着听着，就忘记刚才想去哪里了。\n你那边也下雨了吗？' : '窗边的小光点，刚才还在我的爪子旁边。\n我一眨眼，它就跑远了。\n明天它还会来吗？'));
  const avatar = escapeHtml(options.avatarUrl ?? (e3 ? new URL(`V1-cat-avatar-${catId}.png`,ASSETS).href : `assets/V1-cat-avatar-${catId}.png`));
  const avatarAlt = escapeHtml(options.avatarAlt ?? `${identity}头像`);
  const attrs = e3 ? ' data-component="need-card" data-mode="e3"' : '';
  const imageAttrs = e3 ? ` data-slot="need-avatar" data-cat-image="${catId}"` : '';
  const action = e3 ? `data-action="focus-reply" data-reply-target="${escapeHtml(options.replyTargetId ?? 'daily-reply')}"` : 'data-action="reply"';
  return `<article class="paper note-card" aria-label="日常需求卡${alt?'内容变化':''}"${attrs}><header class="sender"><img class="avatar" src="${avatar}" alt="${avatarAlt}" draggable="false"${imageAttrs}><div><div class="sender-name">${name}</div><time class="meta">${time}</time></div></header><h3 class="story-title">${title}</h3><p class="body-copy">${body}</p><div class="card-actions"><button class="primary ${active?'is-pressed is-focus':''}" ${action} data-recipient="${name}"${e3?' type="button"':''}>给它回信${icon('arrow')}</button></div></article>`;
}
export function daily(variant = 'default') { return needCard({variant}); }

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', {granularity:'grapheme'}) : null;
export function countReplyCharacters(value = '') {
  const text = String(value ?? '');
  return segmenter ? [...segmenter.segment(text)].length : Array.from(text).length;
}

/** All state is explicit. SAVED is never inferred from the presence of text. */
export function replyInputState(options = {}) {
  const value = String(options.value ?? '');
  const maximum = Number.isInteger(options.maxLength) && options.maxLength > 0 ? options.maxLength : 2000;
  const count = countReplyCharacters(value);
  const draft = String(options.draftState ?? 'idle').toLowerCase();
  const submit = String(options.submitState ?? 'idle').toLowerCase();
  const system = String(options.systemState ?? 'none').toLowerCase();
  const busy = submit === 'submitting', checking = system === 'checking';
  const tooLong = count > maximum;
  const draftMessages = {idle:'',saving:'草稿保存中…',saved:'草稿已保存在本机',error:'草稿保存失败，当前文字还在。',restored:'已恢复这封信的本机草稿。'};
  const systemMessages = {none:'',checking:'系统正在检查这段文字，请稍候。',blocked:'这段文字需要先完成系统安全处理，暂未送出。', 'check-error':'系统检查未完成，文字还在，可以重试检查。'};
  const helper = tooLong ? `最多可以写 ${maximum} 字，当前文字已保留，请稍作调整。` : submit === 'error' ? '好像没有送出去，再试一次吧。' : '一句话也可以。';
  return {value,maximum,count,draft,submit,system,busy,checking,tooLong,
    error:tooLong || submit === 'error',
    disabled:!value.trim() || tooLong || busy || submit === 'success' || system !== 'none' || Boolean(options.composing),
    readOnly:busy || checking || submit === 'success',
    helper,draftMessage:draftMessages[draft] ?? '',
    systemMessage:system === 'none' ? '' : String(options.systemMessage ?? systemMessages[system] ?? '系统状态未确认，暂未送出。'),
    buttonText:busy ? '正在送出…' : '送出去'};
}

// One form skeleton is used by both the historical demo and the E3 variant.
function composerForm({formClass,name,formAttrs,label,id,describedBy,placeholder,inputAttrs,value,helperClass,helperAttrs='',helper,extra='',actions,feedback}) {
  return `<form class="paper composer ${formClass}" data-name="${name}" ${formAttrs}><label for="${id}">${label}</label><textarea id="${id}" aria-describedby="${describedBy}" placeholder="${placeholder}" ${inputAttrs}>${value}</textarea><p class="helper ${helperClass}" id="${id}-help"${helperAttrs}>${helper}</p>${extra}<div class="card-actions">${actions}</div>${feedback}</form>`;
}

export function replyInput(options = {}) {
  const {mode = 'legacy', state = 'empty'} = options;
  const name = escapeHtml(options.name ?? options.catName ?? '小橘');
  const id = escapeHtml(options.id ?? `reply-${++serial}`);
  if (mode !== 'e3') {
    const filled=['filled','error','sending'].includes(state);
    if(state==='success')return `<section class="paper composer" aria-label="回信成功状态"><div class="success-panel">${icon('check')}<h3>回信已收好</h3><p>你写下的话，留在了这一刻。</p></div><button class="text-button" data-action="reset-reply">再看看这封信${icon('arrow')}</button></section>`;
    if(state==='voice')return `<section class="paper composer"><label>说给${name}听</label><div class="voice-state">${icon('mic')}<span>轻轻说，我在听。</span><span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div><p class="helper">说完后，可以先看看文字。</p><div class="card-actions"><button class="secondary" data-action="reset-reply">改用文字</button><button class="primary" data-action="voice-end">说好了${icon('check')}</button></div></section>`;
    return composerForm({formClass:state==='error'?'is-error':'',name,formAttrs:state==='sending'?'aria-busy="true"':'',label:`写给${name}`,id,describedBy:`${id}-help`,placeholder:'把想说的话，慢慢写下来…',inputAttrs:state==='sending'?'readonly':'',value:filled?'明天我们再一起等它吧。就算它晚一点来，我也会陪着你。':'',helperClass:state==='error'?'error-copy':'',helper:state==='error'?'这次没寄出去，写好的话还在。':'一句话也可以。',actions:`<button type="button" class="secondary" data-action="voice">${icon('mic')}用语音说</button><button type="submit" class="primary" ${(!filled||state==='sending')?'disabled':''}>${state==='sending'?'正在寄出…':state==='error'?'再寄一次':`寄给${name}`}${state==='sending'?'':icon('arrow')}</button>`,feedback:'<div class="reply-feedback" aria-live="polite"></div>'});
  }
  const s = replyInputState(options);
  return composerForm({
    formClass:`composer--e3${s.error?' is-error':''}`, name,
    formAttrs:`data-component="reply-input" data-mode="e3" data-draft-state="${escapeHtml(s.draft)}" data-submit-state="${escapeHtml(s.submit)}" data-system-state="${escapeHtml(s.system)}" aria-busy="${s.busy || s.checking}"`,
    label:escapeHtml(options.label ?? `写给${options.name ?? options.catName ?? '小橘'}`), id,
    describedBy:`${id}-help ${id}-count ${id}-draft ${id}-system`, placeholder:escapeHtml(options.placeholder ?? '写几句就好……'),
    inputAttrs:`data-slot="reply-input" aria-invalid="${s.tooLong}" ${s.readOnly?'readonly':''}`, value:escapeHtml(s.value),
    helperClass:s.error?'error-copy':'', helperAttrs:' data-slot="reply-helper" aria-live="polite"', helper:escapeHtml(s.helper),
    extra:`<div class="reply-meta"><span class="meta${s.tooLong?' error-copy':''}" id="${id}-count" data-slot="reply-count">${s.count} / ${s.maximum} 字</span><span class="meta${s.draft==='error'?' error-copy':''}" id="${id}-draft" data-slot="draft-status" role="status">${escapeHtml(s.draftMessage)}</span><button type="button" class="text-button draft-retry" data-action="retry-draft" data-slot="draft-retry"${s.draft==='error'?'':' hidden'}>重试保存</button></div><div class="inline-notice reply-system-notice" id="${id}-system" data-slot="system-notice" role="status"${s.system==='none'?' hidden':''}><strong>系统提示</strong><p data-slot="system-message">${escapeHtml(s.systemMessage)}</p><button type="button" class="text-button" data-action="retry-check" data-slot="system-retry"${s.system==='check-error'?'':' hidden'}>重试检查${icon('arrow')}</button></div>`,
    actions:`<button type="submit" class="primary" data-slot="submit-button" ${s.disabled?'disabled':''}>${s.buttonText}${s.busy?'':icon('arrow')}</button>`,
    feedback:'<div class="reply-feedback" data-slot="reply-feedback" aria-live="polite"></div>'
  });
}
export function composer(state = 'empty', name = '小橘') { return replyInput({state,name}); }

/** Updates only text/state nodes: never replaces, truncates or reassigns textarea.value.
 * To change the draft itself, the controller must set textarea.value explicitly.
 */
export function updateReplyInputState(form, options = {}) {
  const input = form.querySelector('[data-slot="reply-input"]');
  if (!input || form.dataset.mode !== 'e3') return null;
  const s = replyInputState({draftState:form.dataset.draftState,submitState:form.dataset.submitState,systemState:form.dataset.systemState,...options,value:input.value});
  const slot = name => form.querySelector(`[data-slot="${name}"]`);
  form.dataset.draftState=s.draft; form.dataset.submitState=s.submit; form.dataset.systemState=s.system;
  form.classList.toggle('is-error',s.error);
  form.setAttribute('aria-busy',String(s.busy || s.checking));
  input.readOnly=s.readOnly; input.setAttribute('aria-invalid',String(s.tooLong));
  const helper=slot('reply-helper'); helper.textContent=s.helper; helper.classList.toggle('error-copy',s.error);
  const count=slot('reply-count'); count.textContent=`${s.count} / ${s.maximum} 字`; count.classList.toggle('error-copy',s.tooLong);
  const draft=slot('draft-status'); draft.textContent=s.draftMessage; draft.classList.toggle('error-copy',s.draft==='error');
  slot('draft-retry').hidden=s.draft!=='error';
  slot('system-notice').hidden=s.system==='none'; slot('system-message').textContent=s.systemMessage; slot('system-retry').hidden=s.system!=='check-error';
  const button=slot('submit-button'); button.disabled=s.disabled; button.innerHTML=s.buttonText+(s.busy?'':icon('arrow'));
  return s;
}
export function focusReply(root, targetId = 'daily-reply') {
  const input = [...root.querySelectorAll('textarea[data-slot="reply-input"]')].find(node => node.id === targetId);
  if (!input) return false;
  input.focus({preventScroll:true}); input.scrollIntoView({block:'center',behavior:'auto'});
  return true;
}

/** E3 home navigation is a minimal component-layer addition, not the demo nav. */
export function homeNavigation({active='cat',unread=false} = {}) {
  const current = active === 'inbox' ? 'inbox' : 'cat';
  return `<nav class="daily-nav" aria-label="主导航" data-component="home-navigation"><button type="button" data-action="home"${current==='cat'?' aria-current="page"':''}>小猫</button><button type="button" data-action="inbox"${current==='inbox'?' aria-current="page"':''} aria-label="来信盒${unread?'，有一封未读来信':''}">来信盒${unread?'<span class="daily-unread-dot" aria-hidden="true"></span>':''}</button></nav>`;
}

/** One quiet unread entry, never a task card or the complete need-card body. */
export function newLetterEntry({type='NEED_CARD',unread=true} = {}) {
  const postcard = type === 'POSTCARD';
  const title = postcard ? '远方来了一封信！' : '今天有一封来信';
  const cta = postcard ? '打开看看' : '看看来信';
  return `<section class="paper new-letter-entry" data-component="new-letter-entry" data-letter-type="${postcard?'POSTCARD':'NEED_CARD'}" aria-label="${unread?'新来信':'来信'}"><div class="new-letter-heading"><h2>${title}</h2>${unread?'<span class="meta new-letter-status"><span class="daily-unread-dot" aria-hidden="true"></span>未读</span>':''}</div><div class="card-actions"><button type="button" class="primary" data-action="open-letter">${cta}${icon('arrow')}</button></div></section>`;
}
