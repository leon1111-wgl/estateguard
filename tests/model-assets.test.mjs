import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createModelAssetLoader} from '../web/model-assets.mjs';
const bytes=new TextEncoder().encode('verified public model');
const file={path:'models/test.bin',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
function cache(){const values=new Map();return {values,match:async key=>values.get(key)?.clone(),put:async(key,value)=>values.set(key,value.clone()),delete:async key=>values.delete(key)};}
function loader(options={}){return createModelAssetLoader({baseURL:'https://example.test/',files:[file],fetchFn:async()=>new Response(bytes),cacheStorage:null,...options});}
test('download progress counts actual bytes and verified cache avoids the next fetch',async()=>{
 const saved=cache(),storage={open:async()=>saved},progress=[];let calls=0;
 const config={cacheStorage:storage,fetchFn:async()=>{calls++;return new Response(bytes);},onProgress:value=>progress.push(value)};
 assert.deepEqual(new Uint8Array(await loader(config).read(file.path)),bytes);
 const warm=loader(config);await warm.read(file.path);assert.equal(calls,1);assert.equal(warm.summary().cacheBytes,bytes.length);
 assert.ok(progress.some(value=>value.networkBytes===bytes.length));assert.equal(progress.at(-1).loaded,bytes.length);
});
test('corrupt cache is discarded and only a verified replacement is stored',async()=>{
 const saved=cache(),storage={open:async()=>saved};await loader({cacheStorage:storage}).read(file.path);
 const key=[...saved.values.keys()][0];saved.values.set(key,new Response('wrong'));
 let calls=0;await loader({cacheStorage:storage,fetchFn:async()=>{calls++;return new Response(bytes);}}).read(file.path);
 assert.equal(calls,1);assert.deepEqual(new Uint8Array(await saved.values.get(key).arrayBuffer()),bytes);
});
test('hash mismatch and oversized network assets never enter the cache',async()=>{
 const saved=cache(),storage={open:async()=>saved};
 await assert.rejects(loader({cacheStorage:storage,fetchFn:async()=>new Response(new Uint8Array(bytes.length))}).read(file.path),/校验/);
 await assert.rejects(loader({cacheStorage:storage,fetchFn:async()=>new Response(new Uint8Array(bytes.length+1))}).read(file.path),/大小/);
 assert.equal(saved.values.size,0);
});
test('cancellation aborts a pending network request and stores no partial asset',async()=>{
 const controller=new AbortController(),saved=cache();let started;
 const ready=new Promise(resolve=>started=resolve);
 const job=loader({signal:controller.signal,cacheStorage:{open:async()=>saved},fetchFn:async(_url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();})}).read(file.path);
 await ready;controller.abort();await assert.rejects(job,error=>error.name==='AbortError');assert.equal(saved.values.size,0);
});
test('stalled download times out without leaving a partial cache entry',async()=>{
 const saved=cache();const job=loader({timeoutMs:20,cacheStorage:{open:async()=>saved},fetchFn:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}).read(file.path);
 await assert.rejects(job,/超时/);assert.equal(saved.values.size,0);
});
test('blocked or full cache falls back to verified network data',async()=>{
 const unavailable=loader({cacheStorage:{open:async()=>{throw new Error('disabled');}}});await unavailable.read(file.path);assert.equal(unavailable.summary().cacheAvailable,false);
 const full=cache();full.put=async()=>{throw new Error('quota');};const bounded=loader({cacheStorage:{open:async()=>full}});assert.deepEqual(new Uint8Array(await bounded.read(file.path)),bytes);assert.equal(bounded.summary().cacheAvailable,false);
});
test('a browser denying access to the CacheStorage property still loads the model',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'caches');
 Object.defineProperty(globalThis,'caches',{configurable:true,get(){throw new DOMException('blocked','SecurityError');}});
 try{const unavailable=loader({cacheStorage:undefined});await unavailable.read(file.path);assert.equal(unavailable.summary().cacheAvailable,false);}
 finally{if(original)Object.defineProperty(globalThis,'caches',original);else delete globalThis.caches;}
});
test('cancelling while optional storage hangs releases the loader without waiting for storage',async()=>{
 for(const operation of ['open','match','put']){
  const controller=new AbortController(),saved=cache();let started;
  const ready=new Promise(resolve=>started=resolve),hang=()=>{started();return new Promise(()=>{});};
  const storage=operation==='open'?{open:hang}:{open:async()=>saved};if(operation!=='open')saved[operation]=hang;
  const job=loader({signal:controller.signal,cacheStorage:storage}).read(file.path);await ready;controller.abort();
  let timer;try{await assert.rejects(Promise.race([job,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Cancellation remained blocked by cache')),100))]),error=>error.name==='AbortError');}finally{clearTimeout(timer);}
 }
});
test('unresponsive optional storage times out and the model loads from the network',async()=>{
 const value=loader({cacheStorage:{open:()=>new Promise(()=>{})},cacheTimeoutMs:20});
 let timer;try{const buffer=await Promise.race([value.read(file.path),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Storage fallback remained blocked')),100))]);assert.deepEqual(new Uint8Array(buffer),bytes);assert.equal(value.summary().cacheAvailable,false);}finally{clearTimeout(timer);}
});
