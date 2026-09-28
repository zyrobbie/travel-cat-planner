import assert from 'node:assert/strict';
import {initialState,transition as t,homePage,getHomeEntry,currentLetter,inboxLetters,LETTER_FIXTURES,validateSnapshot} from '../daily-state.mjs';
import {createDailyStore,STORAGE_KEY} from '../storage.mjs';
import {SCENARIOS,buildScenario} from '../scenarios.mjs';

const adopted={catId:'cat-02',appearanceId:'cat-02',catName:'团团',initialLetter:null};
const fresh=initialState(adopted);
assert.equal(fresh.page,'E');assert.equal(fresh.catName,'团团');assert.equal(fresh.newLetterId,null);
assert.equal(validateSnapshot(fresh),true);
const storageData=new Map();
const storage={getItem:key=>storageData.get(key)??null,setItem:(key,value)=>storageData.set(key,String(value))};
const newKey='cat-letters-e3-g2r:daily-v1';
const live=createDailyStore({storage,key:newKey,initialOptions:adopted});
assert.equal(live.load().state.appearanceId,'cat-02');
assert.equal(live.load().state.newLetterId,null);
assert.equal(storageData.has(STORAGE_KEY),false);

const combinations=[];
for(const world of ['HOME','TRIP'])for(const type of ['NONE','NEED_CARD','POSTCARD']){
  let state=initialState({...adopted,catState:world});
  if(type!=='NONE'){
    if(world==='TRIP'&&type==='NEED_CARD'){
      state=t(initialState(adopted),{type:'NEW_LETTER',letter:LETTER_FIXTURES['need-01']});
      state=t(state,{type:'CAT_TRIP'});
    }else state=t(state,{type:'NEW_LETTER',letter:LETTER_FIXTURES[type==='POSTCARD'?'postcard-01':'need-01']});
  }
  assert.equal(homePage(state),world==='HOME'?'E':'F');
  assert.equal(getHomeEntry(state)?.type??'NONE',type);
  assert.equal(validateSnapshot(state),true);
  combinations.push(`${world}+${type}`);
}
assert.equal(combinations.length,6);

let trip=t(initialState(adopted),{type:'CAT_TRIP'});
assert.deepEqual(t(trip,{type:'NEW_LETTER',letter:LETTER_FIXTURES['need-01']}),trip);
trip=t(trip,{type:'NEW_LETTER',letter:LETTER_FIXTURES['postcard-01']});
assert.equal(getHomeEntry(trip).type,'POSTCARD');
trip=t(trip,{type:'OPEN_POSTCARD',letterId:'postcard-01'});
assert.equal(trip.page,'I');assert.equal(trip.newLetterId,null);assert.equal(currentLetter(trip).readState,'READ');
trip=t(trip,{type:'RETURN_FROM_LETTER'});
assert.equal(trip.page,'F');assert.equal(trip.catState,'TRIP');
trip=t(trip,{type:'CAT_HOME'});
assert.equal(trip.page,'E');assert.equal(inboxLetters(trip).length,1);
trip=t(trip,{type:'OPEN_INBOX'});
trip=t(trip,{type:'OPEN_POSTCARD',letterId:'postcard-01'});
assert.equal(trip.returnPage,'J');assert.equal(t(trip,{type:'RETURN_FROM_LETTER'}).page,'J');

let oldNeed=t(initialState(adopted),{type:'NEW_LETTER',letter:LETTER_FIXTURES['need-01']});
oldNeed=t(oldNeed,{type:'CAT_TRIP'});
oldNeed=t(oldNeed,{type:'OPEN_NEED',letterId:'need-01'});
assert.equal(oldNeed.page,'G');assert.equal(oldNeed.newLetterId,null);assert.equal(oldNeed.catState,'TRIP');
oldNeed=t(oldNeed,{type:'EDIT',value:'尚未送出的草稿'});
assert.equal(t(oldNeed,{type:'RETURN_FROM_LETTER'}).page,'F');
assert.equal(oldNeed.letters['need-01'].draft,'尚未送出的草稿');
for(const scenario of SCENARIOS)assert.equal(buildScenario(scenario.id).state.page,scenario.page,scenario.id);
const resumed=buildScenario('G-draft-restored-M');
assert.equal(resumed.ui.draftRestored,true);
assert.equal(resumed.ui.replyExpanded,true);
assert.equal(resumed.state.currentLetterId,'need-01');
assert.ok(resumed.state.letters['need-01'].draft.length>0);
assert.equal(createDailyStore({storage:resumed.storageAdapter}).load(resumed.state).state.page,'E');
console.log('PASS G2R model: six combinations, trip delivery rule, read/release, inbox return, independent draft and 41 review fixtures');
