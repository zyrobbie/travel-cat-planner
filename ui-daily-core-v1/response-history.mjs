// Pure third-batch state helpers. Only a submitted revision can become a source.
import {TRAVEL_STORIES} from './travel-stories.mjs?v=batch3-20261003';

const clone=value=>structuredClone(value);
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const sceneStory={RHINE:['L-RHINE','O-RHINE-01'],FIREFLY:['L-FIREFLY','O-FIREFLY-01'],LIGHTHOUSE:['L-LIGHTHOUSE','O-LIGHTHOUSE-01']};
const places={RHINE:'德国 · 莱茵河谷',FIREFLY:'日本 · 辰野',LIGHTHOUSE:'苏格兰 · 天空岛'};
// Hand-reviewed examples from the approved design review. They are never
// injected into a live record. Arbitrary user wording cannot be classified here.
export const VERIFIED_REVIEW_REPLIES=Object.freeze({
  'need-d01':'累了可以歇一会儿。不想聊天的时候，也可以告诉阿橘：我想安静地待一会儿。',
  'need-d03':'我喜欢的是你想着我的心意呀。小礼物也可以装着很大的喜欢。',
  'need-d04':'不知道说什么的时候，陪在它旁边也可以。陪伴也是表达关心的一种方式。',
  'need-d05':'面对新朋友可以先看看，不需要马上加入。按让自己舒服的速度，慢慢来就好。',
});
const linkedRequirements={RHINE:['need-d01'],FIREFLY:['need-d04','need-d03'],LIGHTHOUSE:['need-d05']};
const normalizeReviewText=value=>String(value??'').normalize('NFKC').replace(/[\s\p{P}]+/gu,'');
export const travelScenes=Object.freeze(Object.keys(sceneStory));
export const storyById=id=>TRAVEL_STORIES.find(story=>story.id===id)||null;
export const currentRevision=response=>response?.revisions.find(item=>item.revision===response.currentRevision)||null;
export function upgradeHistory(snapshot){
  if(snapshot.schemaVersion===2)return clone(snapshot);
  if(snapshot.schemaVersion!==1)throw new Error('INVALID_SCHEMA');
  const state=clone(snapshot);
  state.schemaVersion=2;
  state.responses={};state.correctionDrafts={};state.mutationLog={};
  state.manageReturnPage=null;state.manageReturnLetterId=null;
  for(const letter of Object.values(state.letters)){
    letter.readAt??=null;letter.sourceRefs??=[];
    letter.responseId??=null;
    if(letter.type==='NEED_CARD'&&letter.replySubmitState==='SUCCESS'){
      const id=`response-${letter.id}`;
      letter.responseId=id;
      state.responses[id]={id,letterId:letter.id,status:'ACTIVE',currentRevision:1,
        revisions:[{revision:1,text:letter.submittedText,at:null}]};
    }
  }
  return state;
}
export function recordSubmission(state,letter,text,at=null){
  const id=`response-${letter.id}`;
  if(state.responses[id])return;
  letter.responseId=id;
  state.responses[id]={id,letterId:letter.id,status:'ACTIVE',currentRevision:1,
    revisions:[{revision:1,text,at}]};
}
export function validateHistory(state){
  if(state.schemaVersion!==2||!state.responses||!state.correctionDrafts||!state.mutationLog||
    typeof state.responses!=='object'||typeof state.correctionDrafts!=='object'||typeof state.mutationLog!=='object')return false;
  for(const letter of Object.values(state.letters)){
    if(letter.readAt!==null&&typeof letter.readAt!=='string'||!Array.isArray(letter.sourceRefs))return false;
    for(const ref of letter.sourceRefs){
      const response=state.responses[ref.responseId];
      if(!response?.revisions.some(item=>item.revision===ref.revision)||
        !Number.isInteger(ref.start)||!Number.isInteger(ref.end)||ref.start<0||ref.end<ref.start)return false;
    }
    if(letter.replySubmitState==='SUCCESS'){
      const response=state.responses[letter.responseId];
      if(!response||response.letterId!==letter.id)return false;
      if(response.status==='DELETED'&&letter.submittedText!==null)return false;
      if(response.status==='ACTIVE'&&letter.submittedText!==currentRevision(response)?.text)return false;
    }
  }
  for(const [id,response] of Object.entries(state.responses)){
    if(!validId(id)||response?.id!==id||!state.letters[response.letterId]||
      !['ACTIVE','DELETED'].includes(response.status)||!Number.isInteger(response.currentRevision)||
      !Array.isArray(response.revisions)||!response.revisions.some(item=>item.revision===response.currentRevision))return false;
    if(response.status==='DELETED'&&response.revisions.some(item=>item.text!==null))return false;
    if(response.status==='ACTIVE'&&response.revisions.some(item=>typeof item.text!=='string'))return false;
  }
  for(const [letterId,draft] of Object.entries(state.correctionDrafts)){
    if(!state.letters[letterId]||typeof draft?.text!=='string'||!Number.isInteger(draft.baseRevision)||
      state.letters[letterId].responseId!==draft.responseId)return false;
  }
  return true;
}
export function sourceEntries(state,letter,{firstRead=false}={}){
  if(firstRead||!letter?.sourceRefs?.length)return [];
  return letter.sourceRefs.map(ref=>{
    const response=state.responses[ref.responseId];
    const version=response?.revisions.find(item=>item.revision===ref.revision);
    if(!response||response.status==='DELETED'||version?.text==null)
      return {status:'deleted',revision:ref.revision,text:null,letterId:response?.letterId,at:null};
    return {status:response.currentRevision===ref.revision?'current':'corrected',
      revision:ref.revision,text:version.text.slice(ref.start,ref.end),letterId:response.letterId,at:version.at};
  });
}
// Only an explicit review action may deliver a travel letter. The literal
// eligibility check prevents a synthetic claim being attributed to arbitrary text.
export function makeTravelDelivery(state,{sceneId,linked=false,date}){
  if(!travelScenes.includes(sceneId)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date))
    return {ok:false,error:'INVALID_DELIVERY'};
  const refs=[];
  if(linked){
    for(const letterId of linkedRequirements[sceneId]){
      const letter=state.letters[letterId],response=state.responses[letter?.responseId],version=currentRevision(response);
      if(response?.status!=='ACTIVE'||normalizeReviewText(version?.text)!==normalizeReviewText(VERIFIED_REVIEW_REPLIES[letterId]))
        return {ok:false,error:'NO_VERIFIED_SOURCE'};
      refs.push({responseId:response.id,revision:version.revision,start:0,end:version.text.length});
    }
  }
  const story=storyById(sceneStory[sceneId][linked?0:1]);
  const id=`postcard-${story.id}`;
  if(state.letters[id])return {ok:false,error:'ALREADY_DELIVERED'};
  return {ok:true,letter:{id,type:'POSTCARD',date,title:story.title,
    data:{storyId:story.id,sceneId,place:places[sceneId],body:story.body},sourceRefs:refs}};
}
export function redactResponse(state,receipts,response){
  response.status='DELETED';
  for(const item of response.revisions)item.text=null;
  delete response.lastMutation;
  const letter=state.letters[response.letterId];
  letter.submittedText=null;letter.draft='';letter.pendingSave=null;
  if(letter.pendingSubmission){letter.pendingSubmission.text=null;letter.pendingSubmission=null;}
  if(state.pendingSubmission?.letterId===letter.id)state.pendingSubmission=null;
  delete state.correctionDrafts[letter.id];
  for(const receipt of Object.values(receipts))if(receipt.letterId===letter.id){receipt.text=null;receipt.redacted=true;}
}
export function applyMutation(state,receipts,{type,responseId,expectedRevision,key,text,at}){
  const old=state.mutationLog[key];
  if(old){
    if(old.responseId!==responseId||old.type!==type||old.expectedRevision!==expectedRevision)throw new Error('MUTATION_KEY_CONFLICT');
    return {reused:true};
  }
  const response=state.responses[responseId];
  if(!response||response.status!=='ACTIVE'||response.currentRevision!==expectedRevision)
    throw new Error('STALE_RESPONSE');
  const letter=state.letters[response.letterId];
  if(type==='CORRECT'){
    const value=String(text??'').trim();
    const count=[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(value)].length;
    if(!value||count>2000)throw new Error('INVALID_CORRECTION');
    response.currentRevision+=1;
    response.revisions.push({revision:response.currentRevision,text:value,at:at||null});
    letter.submittedText=value;
    delete state.correctionDrafts[letter.id];
  }else if(type==='DELETE')redactResponse(state,receipts,response);
  else throw new Error('INVALID_MUTATION');
  state.mutationLog[key]={type,responseId,expectedRevision};
  state.revision+=1;
  return {reused:false};
}
