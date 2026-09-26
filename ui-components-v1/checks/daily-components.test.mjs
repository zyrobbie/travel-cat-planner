import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {daily,composer,resetComposerIds,needCard,replyInput,replyInputState,countReplyCharacters,escapeHtml,updateReplyInputState,focusReply,homeNavigation,newLetterEntry} from '../daily-components.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=file=>fs.readFileSync(path.join(base,file));
const saved=JSON.parse(read('checks/legacy-output.json'));
for(const [variant,expected] of saved.daily)assert.equal(daily(variant),expected,`daily:${variant}`);
for(const [state,name,expected] of saved.composer){resetComposerIds();assert.equal(composer(state,name),expected,`composer:${state}:${name}`);}
const baseline=JSON.parse(read('checks/frozen-baseline.json'));
for(const [file,hash] of Object.entries(baseline.hashes))assert.equal(crypto.createHash('sha256').update(read(file)).digest('hex'),hash,file);
assert.equal(countReplyCharacters('a👨‍👩‍👧‍👦你é'),4);
for(const [n,disabled] of [[0,true],[1999,false],[2000,false],[2001,true]])assert.equal(replyInputState({value:'猫'.repeat(n)}).disabled,disabled,`length:${n}`);
assert.equal(replyInputState({value:' \n\t'}).disabled,true);
assert.equal(replyInputState({value:'猫',composing:true}).disabled,true);
for(const systemState of ['checking','blocked','check-error','unknown'])assert.equal(replyInputState({value:'猫',systemState}).disabled,true);
assert.equal(replyInputState({value:'猫',submitState:'submitting'}).readOnly,true);
assert.equal(replyInputState({value:'猫',submitState:'success'}).disabled,true);
assert.equal(replyInputState({value:'猫',submitState:'error'}).disabled,false);
for(const state of ['idle','saving','saved','error','restored'])assert.equal(replyInputState({value:'猫',draftState:state}).draft,state);
assert.equal(replyInputState({value:'猫'}).draftMessage,'');
assert.equal(replyInputState({value:'猫',draftState:'SAVED'}).draftMessage,'草稿已保存在本机');
const dangerous='</textarea><img src=x onerror="alert(1)"> & \'猫\'';
const html=replyInput({mode:'e3',name:dangerous,value:dangerous,systemState:'blocked',systemMessage:dangerous});
assert(!html.includes('<img src=x'));assert(html.includes(escapeHtml(dangerous)));
assert.equal((html.match(/<textarea/g)||[]).length,1);
assert(!html.includes('用语音说'));assert(!html.includes('data-action="voice"'));assert(html.includes('送出去'));assert(!html.includes('maxlength='));
const body='猫'.repeat(3000)+'\n最后一句';
const card=needCard({mode:'e3',body,catName:dangerous,catId:'cat-02'});
assert(card.includes(body));assert(!card.includes('展开全文'));assert(card.includes('data-action="focus-reply"'));assert(card.includes('V1-cat-avatar-cat-02.png'));assert(!card.includes('<img src=x'));
// Narrow DOM boundary stub verifies the important invariant: status updates never
// replace the textarea, overwrite its value or change the user's selection.
const makeNode=()=>({textContent:'',hidden:false,innerHTML:'',attributes:{},classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v;}});
const slots=Object.fromEntries(['reply-input','reply-helper','reply-count','draft-status','draft-retry','system-notice','system-message','system-retry','submit-button'].map(key=>[key,makeNode()]));
const input=slots['reply-input'];input.id='reply-test';input.value='正在写的草稿';input.selectionStart=3;input.selectionEnd=3;
let focused=false,scrolled=false;input.focus=()=>{focused=true;};input.scrollIntoView=()=>{scrolled=true;};
const form={dataset:{mode:'e3',draftState:'idle',submitState:'idle',systemState:'none'},classList:{toggle(){}},setAttribute(){},querySelector(selector){return slots[selector.match(/data-slot="([^"]+)"/)[1]];}};
const status=updateReplyInputState(form,{draftState:'error',submitState:'error',value:'must not overwrite'});
assert.equal(input.value,'正在写的草稿');assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,3);assert.equal(status.value,input.value);assert.equal(slots['draft-retry'].hidden,false);assert.equal(slots['submit-button'].disabled,false);
updateReplyInputState(form,{draftState:'saved',submitState:'submitting'});assert.equal(input.readOnly,true);assert.equal(slots['submit-button'].disabled,true);assert.equal(slots['draft-retry'].hidden,true);
updateReplyInputState(form,{submitState:'idle',systemState:'check-error',systemMessage:dangerous});assert.equal(slots['system-message'].textContent,dangerous);assert.equal(slots['system-retry'].hidden,false);assert.equal(slots['submit-button'].disabled,true);
assert.equal(focusReply({querySelectorAll:()=>[input]},'reply-test'),true);assert(focused&&scrolled);assert.equal(focusReply({querySelectorAll:()=>[input]},'missing'),false);
for(const active of ['cat','inbox']){const nav=homeNavigation({active,unread:true});assert.equal((nav.match(/<button/g)||[]).length,2);assert.equal((nav.match(/aria-current="page"/g)||[]).length,1);assert(nav.includes('data-action="home"'));assert(nav.includes('data-action="inbox"'));assert(nav.includes('未读来信'));}
for(const type of ['NEED_CARD','POSTCARD']){const entry=newLetterEntry({type});assert.equal((entry.match(/data-action="open-letter"/g)||[]).length,1);assert(entry.includes('未读'));assert(!/完成|奖励|任务/.test(entry));}
console.log(JSON.stringify({legacyOutputCases:15,frozenFiles:Object.keys(baseline.hashes).length,characterBoundaries:'PASS',escapedInput:'PASS',inPlaceDraftPreservation:'PASS',e3StatesAndNavigation:'PASS'}));
