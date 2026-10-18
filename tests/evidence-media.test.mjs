import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceStore} from '../web/evidence-media.mjs';

function fixture(){
 const requests=[],released=[],changes=[];
 const store=createEvidenceStore({prepare:(file,{signal})=>new Promise((resolve,reject)=>requests.push({file,signal,resolve,reject})),release:item=>released.push(item.name),onChange:id=>changes.push(id)});
 const item=name=>({name,type:'image/jpeg',url:`blob:${name}`});
 return {store,requests,released,changes,item};
}
test('failed replacement preserves the usable evidence and exposes the attempted filename',async()=>{
 const {store,requests,released,item}=fixture();
 let task=store.replace('A',{name:'old.jpg'});requests[0].resolve(item('old.jpg'));await task;
 task=store.replace('A',{name:'broken.jpg'});
 assert.equal(store.state('A').status,'loading');assert.equal(store.state('A').item.name,'old.jpg');assert.deepEqual(released,[]);
 requests[1].reject(new Error('无法解码'));assert.equal(await task,false);
 assert.equal(store.state('A').status,'error');assert.equal(store.state('A').attemptedName,'broken.jpg');assert.equal(store.state('A').item.name,'old.jpg');assert.deepEqual(released,[]);
 task=store.replace('A',{name:'new.jpg'});requests[2].resolve(item('new.jpg'));assert.equal(await task,true);
 assert.equal(store.state('A').item.name,'new.jpg');assert.deepEqual(released,['old.jpg']);
});
test('a late success is released and cannot overwrite a newer successful selection',async()=>{
 const {store,requests,released,item}=fixture();
 const old=store.replace('A',{name:'slow.jpg'}),next=store.replace('A',{name:'latest.jpg'});
 assert.equal(requests[0].signal.aborted,true);
 requests[1].resolve(item('latest.jpg'));await next;
 requests[0].resolve(item('slow.jpg'));assert.equal(await old,false);
 assert.equal(store.state('A').item.name,'latest.jpg');assert.deepEqual(released,['slow.jpg']);
});
test('a late failure cannot replace the newer ready status',async()=>{
 const {store,requests,item}=fixture();
 const old=store.replace('A',{name:'slow-bad.jpg'}),next=store.replace('A',{name:'latest.jpg'});
 requests[1].resolve(item('latest.jpg'));await next;
 requests[0].reject(new Error('旧请求失败'));await old;
 assert.equal(store.state('A').status,'ready');assert.equal(store.state('A').item.name,'latest.jpg');
});
test('different events can finish independently without changing each other',async()=>{
 const {store,requests,item}=fixture();
 const a=store.replace('A',{name:'A.jpg'}),b=store.replace('B',{name:'B.jpg'});
 requests[1].resolve(item('B.jpg'));await b;
 assert.equal(store.state('A').status,'loading');assert.equal(requests[0].signal.aborted,false);
 requests[0].resolve(item('A.jpg'));await a;
 assert.equal(store.state('A').item.name,'A.jpg');assert.equal(store.state('B').item.name,'B.jpg');
});
test('workspace replacement cancels pending loads and rejects a late result even for reused event IDs',async()=>{
 const {store,requests,released,item}=fixture();
 const old=store.replace('A',{name:'old-workspace.jpg'});store.clear();
 assert.equal(requests[0].signal.aborted,true);assert.equal(store.state('A').status,'empty');
 const next=store.replace('A',{name:'new-workspace.jpg'});requests[1].resolve(item('new-workspace.jpg'));await next;
 requests[0].resolve(item('old-workspace.jpg'));await old;
 assert.equal(store.state('A').item.name,'new-workspace.jpg');assert.deepEqual(released,['old-workspace.jpg']);
 store.clear();assert.deepEqual(released,['old-workspace.jpg','new-workspace.jpg']);
});
test('model candidates share one verified file and release it only after its final event stops using it',async()=>{
 const {store,requests,released,item}=fixture();
 const batch=store.replace(['A','B'],{name:'model-source.jpg'});
 assert.equal(requests.length,1);
 const a=store.replace('A',{name:'manual-A.jpg'});assert.equal(requests[0].signal.aborted,false);
 requests[1].resolve(item('manual-A.jpg'));await a;
 requests[0].resolve(item('model-source.jpg'));await batch;
 assert.equal(store.state('A').item.name,'manual-A.jpg');assert.equal(store.state('B').item.name,'model-source.jpg');
 const shared=store.replace(['A','B'],{name:'shared.jpg'});requests[2].resolve(item('shared.jpg'));await shared;
 assert.deepEqual(released,['manual-A.jpg','model-source.jpg']);
 const replacement=store.replace('A',{name:'new-A.jpg'});requests[3].resolve(item('new-A.jpg'));await replacement;
 assert.equal(released.includes('shared.jpg'),false);store.clear();
 assert.equal(released.filter(n=>n==='shared.jpg').length,1);
});
