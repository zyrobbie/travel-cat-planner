import assert from 'node:assert/strict';
import {PREVIEW_IDENTITY_KEY,readPreviewIdentity,confirmPreviewIdentity} from '../preview-identity.mjs';

const values=new Map();
const storage={
  getItem:key=>values.get(key)??null,
  setItem:(key,value)=>values.set(key,String(value)),
  removeItem:key=>values.delete(key),
};
const queues=new Map();
const lockManager={
  request(name,_options,callback){
    const previous=queues.get(name)??Promise.resolve();
    const current=previous.then(callback);
    queues.set(name,current.catch(()=>{}));
    return current;
  },
};
const first={catId:'cat-03',name:'奶团'};
assert.deepEqual(readPreviewIdentity(storage),{ok:true,identity:null});
assert.equal((await confirmPreviewIdentity(first,storage,lockManager)).ok,true);
assert.deepEqual(readPreviewIdentity(storage).identity,first);
assert.equal((await confirmPreviewIdentity(first,storage,lockManager)).reused,true);
assert.equal((await confirmPreviewIdentity({catId:'cat-02',name:'另一个'},storage,lockManager)).error,'ALREADY_CONFIRMED');
assert.deepEqual(readPreviewIdentity(storage).identity,first);
assert.equal((await confirmPreviewIdentity({catId:'cat-05',name:'错误'},storage,lockManager)).error,'INVALID_IDENTITY');
assert.deepEqual(readPreviewIdentity(storage).identity,first);
values.set(PREVIEW_IDENTITY_KEY,'{"version":1,"catId":"cat-99","name":"伪造"}');
assert.equal(readPreviewIdentity(storage).ok,false);
assert.equal((await confirmPreviewIdentity(first,storage,lockManager)).ok,false);
assert.equal(values.get(PREVIEW_IDENTITY_KEY).includes('cat-99'),true);
values.delete(PREVIEW_IDENTITY_KEY);
const writeDenied={getItem:storage.getItem,setItem(){throw Error('QUOTA')}};
assert.equal((await confirmPreviewIdentity(first,writeDenied,lockManager)).ok,false);
assert.deepEqual(readPreviewIdentity(storage),{ok:true,identity:null});
assert.equal((await confirmPreviewIdentity(first,storage,{})).error,'LOCK_UNAVAILABLE');
assert.deepEqual(readPreviewIdentity(storage),{ok:true,identity:null});
const second={catId:'cat-02',name:'另一个'};
const results=await Promise.all([
  confirmPreviewIdentity(first,storage,lockManager),
  confirmPreviewIdentity(second,storage,lockManager),
]);
assert.equal(results.filter(result=>result.ok).length,1);
assert.equal(results.filter(result=>result.error==='ALREADY_CONFIRMED').length,1);
assert.deepEqual(readPreviewIdentity(storage).identity,first);
console.log('PASS preview identity: serialized cross-tab confirmation, invalid-record protection and write failure');
