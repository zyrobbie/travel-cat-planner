import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {initialState,transition,validateSnapshot,LETTER_FIXTURES} from '../daily-state.mjs';
import {createDailyStore} from '../storage.mjs';
import {buildDemandReview} from '../scenarios.mjs';
import {DEMAND_SEQUENCE,demandImageStem,demandLetter,nextDemandForState} from '../demand-catalog.mjs';

const frozen=JSON.parse(readFileSync(new URL('../../src/content/frozen.json',import.meta.url),'utf8'));
const assets=JSON.parse(readFileSync(new URL('../assets/web/seven-demand-assets.json',import.meta.url),'utf8'));
const cats=['cat-01','cat-02','cat-03','cat-04'];
assert.equal(DEMAND_SEQUENCE.length,7);
assert.equal(assets.assetCount,28);assert.equal(assets.fileCount,56);
assert.deepEqual(DEMAND_SEQUENCE.map(item=>item.id),['need-01',...Array.from({length:6},(_,i)=>`need-d0${i+1}`)]);
for(const demand of DEMAND_SEQUENCE.slice(1)){
  const source=frozen.items.find(item=>item.id===demand.eventId);
  assert.ok(source,demand.eventId);
  assert.equal(demand.title,source.title);
  assert.equal(demand.body,source.body);
}
for(const demand of DEMAND_SEQUENCE)for(const catId of cats){
  const contentId=demand.eventId==='LIGHT'?'need-01':demand.eventId;
  const asset=assets.assets.find(item=>item.contentId===contentId&&item.appearanceId===catId);
  assert.ok(asset,`${demand.eventId}/${catId}`);
  assert.equal(asset.title,demand.title);
  for(const variant of asset.variants){
    assert.equal(variant.file,`${demandImageStem(demand.id,catId)}-${variant.width}.webp`);
    const bytes=readFileSync(new URL(`../assets/web/${variant.file}`,import.meta.url));
    assert.equal(bytes.length,variant.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),variant.sha256);
  }
  const review=buildDemandReview(demand.id,{catId});
  assert.equal(review.state.page,'G');
  assert.equal(review.state.appearanceId,catId);
  assert.equal(review.state.letters[demand.id].title,demand.title);
  assert.equal(review.state.letters[demand.id].data.body,demand.body);
  assert.equal(review.state.letters[demand.id].readState,'READ');
  assert.equal(validateSnapshot(review.state),true);
  assert.match(demandImageStem(demand.id,catId),new RegExp(`-${catId}$`));
  assert.equal(review.storageAdapter.getItem('cat-letters-e3-g2r:daily-v1'),null);
}

const saved=new Map();
const adapter={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,String(value))};
const store=createDailyStore({storage:adapter,key:'seven-demands-test'});
let state=initialState({catId:'cat-03',appearanceId:'cat-03',catName:'奶油',initialLetter:null});
state=store.persist(state).state;
for(const demand of DEMAND_SEQUENCE){
  assert.equal(nextDemandForState(state)?.id,demand.id);
  const arrival=transition(state,{type:'NEW_LETTER',letter:demandLetter(demand.id,'2026-10-02')});
  assert.equal(arrival.newLetterId,demand.id);
  assert.equal(arrival.catState,'HOME');
  assert.deepEqual(transition(arrival,{type:'NEW_LETTER',letter:demandLetter('need-d06','2026-10-02')}),arrival);
  state=store.persist(arrival).state;
  state=store.persist(transition(state,{type:'OPEN_NEED',letterId:demand.id})).state;
  if(demand.id==='need-01'){
    state=transition(state,{type:'EDIT',value:'留给追光的一句话'});
    state=store.persist(state).state;
  }
  state=store.persist(transition(state,{type:'BACK_HOME'})).state;
  assert.equal(validateSnapshot(state),true);
}
assert.equal(nextDemandForState(state),null);
assert.equal(state.letters['need-01'].draft,'留给追光的一句话');
assert.equal(store.load().state.letters['need-01'].draft,'留给追光的一句话');

let history=initialState({initialLetter:null});
history=transition(history,{type:'NEW_LETTER',letter:LETTER_FIXTURES['need-02']});
history=transition(history,{type:'OPEN_NEED',letterId:'need-02'});
assert.equal(history.letters['need-02'].readState,'READ');
assert.equal(nextDemandForState(history)?.id,'need-01');
const trip=transition(history,{type:'CAT_TRIP'});
assert.deepEqual(transition(trip,{type:'NEW_LETTER',letter:demandLetter('need-01','2026-10-02')}),trip);
console.log('PASS seven demands: frozen copy, 28 isolated fixtures, sequential delivery, draft persistence, old rain and trip compatibility');
