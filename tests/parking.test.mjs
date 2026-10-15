import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractFeatures,predictPatch,classifyScore,frameSummary,exportParkingReview,importParkingReview} from '../web/parking-model.mjs';
import * as parkingModel from '../web/parking-model.mjs';
test('uniform RGB pixels have zero texture and fixed feature dimensions',()=>{const rgba=new Uint8ClampedArray(32*32*4);for(let i=0;i<rgba.length;i+=4)rgba.set([128,128,128,255],i);const f=extractFeatures(rgba);assert.equal(f.length,240);for(let c=0;c<16;c++)for(let j=3;j<15;j++)assert.equal(f[c*15+j],0);});
test('uncertain score is kept for review and never called illegal parking',()=>{assert.equal(classifyScore(.5),'uncertain');assert.equal(classifyScore(.1),'free');assert.equal(classifyScore(.9),'busy');assert.throws(()=>classifyScore(NaN));});
test('missing predictions remain unanalysed rather than free',()=>{const rows=[{id:'a'},{id:'b'},{id:'c'}];const s=frameSummary(rows,new Map([['a',.9],['b',.5]]));assert.deepEqual(s,{total:3,free:0,busy:1,uncertain:1,pending:1});});
test('saved notes are bound to sample and model with atomic validation',()=>{const context={model_sha256:'abc',sample_ids:['A:1','B:1']};const reviews={'A:1':{decision:'busy',note:'查看原图确认',at:'2026-10-15T16:00:00Z'}};const out=exportParkingReview(context,reviews);assert.deepEqual(importParkingReview(out,context),reviews);assert.throws(()=>importParkingReview({...out,model_sha256:'other'},context));assert.throws(()=>importParkingReview({...out,reviews:{...reviews,'unknown':reviews['A:1']}},context));});
test('browser math matches actual Python training outputs, including held-out errors',()=>{
 const model=JSON.parse(readFileSync(new URL('../web/models/parking-occupancy/model.json',import.meta.url)));
 const fixtures=JSON.parse(readFileSync(new URL('./fixtures/parking-parity.json',import.meta.url)));
 assert.ok(fixtures.length>=8);
 for(const row of fixtures){
  const rgba=Uint8ClampedArray.from(Array.from({length:1024},(_,i)=>[...row.rgb.slice(i*3,i*3+3),255]).flat());
  const features=extractFeatures(rgba);
  assert.ok(Math.max(...features.map((v,i)=>Math.abs(v-row.features[i])))<1e-10,`feature mismatch: ${row.id}`);
  assert.ok(Math.abs(predictPatch(rgba,model)-row.score)<1e-10,`score mismatch: ${row.id}`);
 }
});
test('a complete parking export above 8 MiB remains compact and can be restored',()=>{
 const ids=Array.from({length:4500},(_,i)=>`B-${i}`),context={model_sha256:'model',sample_ids:ids};
 const reviews=Object.fromEntries(ids.map(id=>[id,{decision:'busy',note:'x'.repeat(2000),at:'2026-10-15T16:00:00Z'}]));
 const payload=exportParkingReview(context,reviews);payload.samples=[{id:ids[0],predicted_occupied_score:.9,dataset_label:1}];
 assert.equal(typeof parkingModel.serializeParkingReview,'function','exports need a shared bounded serializer');
 const serialized=parkingModel.serializeParkingReview(payload,context);
 assert.ok(Buffer.byteLength(serialized)>8*1024*1024);
 assert.equal(serialized,JSON.stringify(JSON.parse(serialized)));
 assert.equal(Object.keys(importParkingReview(JSON.parse(serialized),context)).length,4500);
});
test('parking import rejects an oversized complete document, including report metadata',()=>{
 const context={model_sha256:'model',sample_ids:['B-1']};
 const payload=exportParkingReview(context,{});payload.extra='x'.repeat(32*1024*1024);
 assert.throws(()=>importParkingReview(payload,context),/32 MiB/);
});
test('oversized parking review exports fail without mutating the saved decisions',()=>{
 const ids=Array.from({length:17000},(_,i)=>`B-${i}`),context={model_sha256:'model',sample_ids:ids};
 const reviews=Object.fromEntries(ids.map(id=>[id,{decision:'busy',note:'x'.repeat(2000),at:'2026-10-15T16:00:00Z'}]));
 assert.throws(()=>exportParkingReview(context,reviews),/32 MiB/);
 assert.equal(Object.keys(reviews).length,17000);
 assert.equal(reviews['B-0'].note.length,2000);
});
function reviewNotesAtBytes(ids,bytes){
 const reviews=Object.fromEntries(ids.map(id=>[id,{decision:'busy',note:'x',at:'2026-10-15T16:00:00Z'}]));
 let remaining=bytes-Buffer.byteLength(JSON.stringify(reviews));
 for(const entry of Object.values(reviews)){
  const chars=Math.min(2000-entry.note.length,Math.floor(remaining/3));entry.note+='中'.repeat(chars);remaining-=chars*3;
  const ascii=Math.min(2000-entry.note.length,remaining);entry.note+='x'.repeat(ascii);remaining-=ascii;
  if(!remaining)break;
 }
 assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(reviews)),bytes);return reviews;
}
test('import reserves 8 MiB for future predictions instead of allowing notes to fill the document',()=>{
 const ids=Array.from({length:6000},(_,i)=>`B-${i}`),context={model_sha256:'model',sample_ids:ids};
 const reviews=reviewNotesAtBytes(ids,24*1024*1024+1);
 const payload={format:'estateguard-parking-review',version:1,model_sha256:'model',reviews};
 assert.throws(()=>importParkingReview(payload,context),/人工.*24 MiB/);
 assert.throws(()=>exportParkingReview(context,reviews),/人工.*24 MiB/);
});
test('maximum allowed notes remain exportable after predictions for the entire test corpus',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../web/data/parking/manifest.json',import.meta.url)));
 const ids=manifest.samples.map(r=>r.id),context={model_sha256:manifest.model_sha256,sample_ids:ids};
 const reviews=reviewNotesAtBytes(ids,24*1024*1024),payload=exportParkingReview(context,reviews);
 payload.dataset=manifest.dataset;
 payload.samples=manifest.samples.map(r=>({id:r.id,camera:r.camera,slot:r.slot,source_time:`${r.date} ${r.time}`,source_timezone:manifest.dataset.timezone,split:r.split,image:r.image,source_sha256:r.source_sha256,predicted_occupied_score:.12345678901234567,prediction:0,review_state:'free',dataset_label:r.label}));
 const serialized=parkingModel.serializeParkingReview(payload,context);
 assert.ok(Buffer.byteLength(serialized)<=32*1024*1024);
 assert.equal(Object.keys(importParkingReview(JSON.parse(serialized),context)).length,6413);
});
