import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDailyStore,STORAGE_KEY,LIVE_STORAGE_KEY,LEGACY_IMPORT_MARKER_KEY} from '../storage.mjs';
import {initialState,transition,validateSnapshot} from '../daily-state.mjs';
import {makeTravelDelivery,sourceEntries,VERIFIED_REVIEW_REPLIES} from '../response-history.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/old-schema1-seed.json',import.meta.url),'utf8'));
const memory=(seed={})=>{const data=new Map(Object.entries(seed));return {data,
  getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};};
const storeFor=(storage,key=LIVE_STORAGE_KEY,failFixtures={})=>createDailyStore({storage,key,failFixtures});
const seeded=memory(fixture.localStorage),store=storeFor(seeded);
const oldBytes=seeded.getItem(LIVE_STORAGE_KEY);
let state=store.load().state;
assert.equal(state.schemaVersion,2);assert.equal(state.catState,'TRIP');
assert.equal(state.letters['need-01'].draft,fixture.expected.lightDraft);
assert.equal(state.letters['need-02'].submittedText,fixture.expected.rainText);
assert.equal(state.letters['need-d03'].submittedText,fixture.expected.giftText);
assert.equal(state.responses['response-need-d03'].currentRevision,1);
assert.equal(JSON.parse(oldBytes).receipts[fixture.expected.receiptIds[1]].revision,2);
assert.equal(seeded.getItem(LIVE_STORAGE_KEY),oldBytes,'read migration never rewrites old bytes');
assert.equal(store.persist(state).ok,true);
assert.equal(JSON.parse(seeded.getItem(LIVE_STORAGE_KEY)).version,2);
assert.equal(validateSnapshot(store.load().state),true);

const stale=structuredClone(store.load().state);
const ticket={type:'CORRECT',responseId:'response-need-d03',letterId:'need-d03',expectedRevision:1,
  key:'correct-gift',text:'更正后的心意。',at:'2026-10-03T10:00:00+08:00'};
assert.equal(store.mutateResponse(ticket).ok,true);
assert.equal(store.mutateResponse(ticket).reused,true);
let latest=store.load().state;
assert.equal(latest.responses[ticket.responseId].currentRevision,2);
assert.equal(latest.responses[ticket.responseId].revisions.length,2);
assert.equal(latest.letters['need-d03'].submittedText,ticket.text);
assert.equal(JSON.parse(seeded.getItem(LIVE_STORAGE_KEY)).receipts[fixture.expected.receiptIds[1]].text,fixture.expected.giftText);
stale.revision=latest.revision+2;
assert.equal(store.persist(stale).ok,false,'newer navigation revision must not erase response history');
assert.equal(store.load().state.responses[ticket.responseId].currentRevision,2);

const before=storeFor(seeded,LIVE_STORAGE_KEY,{mutationUnknownBefore:1});
const pending={type:'CORRECT',responseId:'response-need-d03',letterId:'need-d03',expectedRevision:2,
  key:'unknown-before',text:'未知未写入。',at:'2026-10-03T11:00:00+08:00'};
assert.equal(before.mutateResponse(pending).unknown,true);
assert.equal(before.recoverMutation(pending).committed,false);
const after=storeFor(seeded,LIVE_STORAGE_KEY,{mutationUnknownAfter:1,mutationReadError:1});
const saved={...pending,key:'unknown-after'};
assert.equal(after.mutateResponse(saved).unknown,true);
assert.equal(after.mutateResponse(saved).unknown,true,'failed reread remains unknown');
assert.equal(after.recoverMutation(saved).committed,true);
assert.equal(after.mutateResponse(saved).reused,true);
assert.equal(store.load().state.responses[ticket.responseId].revisions.length,3);

// A full-match review whitelist is conservative. Negated or merely similar
// text cannot become attributed evidence even when it contains a keyword.
let review=initialState({initialLetter:null});
for(const [letterId,text] of Object.entries(VERIFIED_REVIEW_REPLIES)){
  review.letters[letterId]={id:letterId,type:'NEED_CARD',date:'2026-10-01',title:letterId,data:{},readState:'READ',
    draft:'',draftRevision:1,savedRevision:1,draftSaveState:'IDLE',replySubmitState:'SUCCESS',checkState:'IDLE',
    pendingSave:null,pendingSubmission:null,receiptId:`receipt-${letterId}`,submittedText:text,
    responseId:`response-${letterId}`,readAt:null,sourceRefs:[]};
  review.responses[`response-${letterId}`]={id:`response-${letterId}`,letterId,status:'ACTIVE',currentRevision:1,
    revisions:[{revision:1,text,at:null}]};
}
assert.equal(makeTravelDelivery(review,{sceneId:'FIREFLY',linked:true,date:'2026-10-03'}).ok,true);
const negative=structuredClone(review);
negative.responses['response-need-d04'].revisions[0].text='我不同意陪着就好，不要在这里陪我。';
negative.letters['need-d04'].submittedText=negative.responses['response-need-d04'].revisions[0].text;
assert.equal(makeTravelDelivery(negative,{sceneId:'FIREFLY',linked:true,date:'2026-10-03'}).error,'NO_VERIFIED_SOURCE');
assert.equal(makeTravelDelivery(negative,{sceneId:'FIREFLY',linked:false,date:'2026-10-03'}).ok,true);

const linked=makeTravelDelivery(review,{sceneId:'RHINE',linked:true,date:'2026-10-03'}).letter;
review=transition(review,{type:'NEW_LETTER',letter:linked});
review=transition(review,{type:'OPEN_POSTCARD',letterId:linked.id,at:'2026-10-03T12:00:00+08:00'});
assert.equal(sourceEntries(review,review.letters[linked.id],{firstRead:true}).length,0);
assert.equal(sourceEntries(review,review.letters[linked.id],{firstRead:false}).length,1);
assert.equal(review.letters[linked.id].data.body,linked.data.body);

// Deletion clears both the live envelope and a matching imported legacy copy.
const legacy=memory({...fixture.localStorage,[STORAGE_KEY]:oldBytes,
  [LEGACY_IMPORT_MARKER_KEY]:JSON.stringify({sourceKey:STORAGE_KEY,catId:'cat-02',catName:'白金'})});
const dual=storeFor(legacy);
assert.equal(dual.persist(dual.load().state).ok,true);
assert.equal(dual.redactImportedLegacy({letterId:'need-d03',catId:'cat-02',catName:'白金'}).ok,true);
const deleteTicket={type:'DELETE',responseId:'response-need-d03',letterId:'need-d03',expectedRevision:1,key:'delete-gift'};
assert.equal(dual.mutateResponse(deleteTicket).ok,true);
const live=JSON.parse(legacy.getItem(LIVE_STORAGE_KEY));
assert.equal(live.state.letters['need-d03'].submittedText,null);
assert.ok(live.state.responses[deleteTicket.responseId].revisions.every(item=>item.text===null));
assert.equal(live.receipts[fixture.expected.receiptIds[1]].text,null);
assert.equal(live.receipts[fixture.expected.receiptIds[1]].redacted,true);
assert.equal(dual.load().state.responses[deleteTicket.responseId].status,'DELETED');
const old=JSON.parse(legacy.getItem(STORAGE_KEY));
assert.equal(old.state.letters['need-d03'].submittedText,null);
assert.equal(old.receipts[fixture.expected.receiptIds[1]],undefined);
assert.equal(old.state.letters['need-02'].submittedText,fixture.expected.rainText,'other old reply preserved');
assert.equal(dual.persist(stale).ok,false,'stale response cannot resurrect deleted text');
const importedWithoutMarker=JSON.parse(oldBytes);importedWithoutMarker.receipts={};
const preMarker=memory({[LIVE_STORAGE_KEY]:JSON.stringify(importedWithoutMarker),[STORAGE_KEY]:oldBytes});
const preMarkerStore=storeFor(preMarker);
assert.equal(preMarkerStore.redactImportedLegacy({letterId:'need-d03',catId:'cat-02',catName:'白金'}).ok,true);
assert.equal(JSON.parse(preMarker.getItem(STORAGE_KEY)).state.letters['need-d03'].submittedText,null,
  'PR12 import without marker still removes matching old original');
assert.equal(JSON.parse(preMarker.getItem(STORAGE_KEY)).state.letters['need-02'].submittedText,fixture.expected.rainText);
console.log('PASS batch3: schema1 migration, version/receipt separation, correction idempotency, both unknown outcomes, stale rejection, exact-source guard, first-read, dual-copy deletion');
