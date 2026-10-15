import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildParkingAudit,filterParkingAudit,exportParkingAudit} from '../web/parking-audit.mjs';
const hash='a'.repeat(64),sourceHash='b'.repeat(64);
function fixture(){
 const labels=[1,1,0,0,1,0],scores=[.35,.5,.65,.5,.65,.35];
 const samples=labels.map((label,i)=>({id:`sample-${i}`,camera:i===1?'A':'B',slot:'12',date:'20150708',time:`${String(8+i).padStart(2,'0')}00`,label,image:`images/${i}.jpg`,source_sha256:sourceHash}));
 const manifest={model_sha256:hash,dataset:{name:'synthetic fixture',timezone:'unknown'},samples};
 const predictions=samples.map((r,i)=>({id:r.id,label:r.label,score:scores[i],prediction:Number(scores[i]>=.5),correct:Number(scores[i]>=.5)===r.label,model_sha256:hash}));
 return {manifest,predictions};
}
test('audit counts threshold boundaries without hiding errors outside the review band',()=>{
 const {manifest,predictions}=fixture(),a=buildParkingAudit(manifest,predictions);
 assert.equal(a.summary.total,6);assert.equal(a.summary.errors,3);
 assert.equal(a.summary.false_free,1);assert.equal(a.summary.false_occupied,2);
 assert.equal(a.summary.low_score_false_free,1);assert.equal(a.summary.band_samples,2);
 assert.equal(a.summary.band_errors,1);assert.equal(a.summary.outside_band_errors,2);
 assert.equal(a.groups.find(g=>g.camera==='B').occupied,2);
 assert.equal(a.groups.find(g=>g.camera==='B').false_free_rate,.5);
 assert.equal(a.groups.find(g=>g.camera==='A').false_free_rate,0);
});
test('filters keep camera identities separate and an empty match does not mean no dataset errors',()=>{
 const {manifest,predictions}=fixture(),a=buildParkingAudit(manifest,predictions);
 assert.deepEqual(filterParkingAudit(a,{type:'false_free',slot:'["B","12"]'}).map(r=>r.id),['sample-0']);
 assert.deepEqual(filterParkingAudit(a,{type:'false_free',slot:'["A","12"]'}),[]);
 assert.equal(a.summary.errors,3);
 assert.throws(()=>filterParkingAudit(a,{type:'other',slot:'all'}));
 assert.throws(()=>filterParkingAudit(a,{type:'all',slot:'unknown'}));
});
test('mismatched models, labels, duplicate rows, missing rows and inconsistent predictions fail before use',()=>{
 for(const mutate of [p=>p[0].model_sha256='c'.repeat(64),p=>p[0].label=0,p=>p[0].score=NaN,p=>p[0].prediction=1,p=>p[0].correct=true,p=>p.push(p[0]),p=>p.pop(),p=>p[0].id='unknown']){
  const {manifest,predictions}=fixture();mutate(predictions);assert.throws(()=>buildParkingAudit(manifest,predictions));
 }
 const {manifest,predictions}=fixture();manifest.samples[1].id=manifest.samples[0].id;assert.throws(()=>buildParkingAudit(manifest,predictions));
});
test('filtered audit exports retain exact provenance and remain separate from human review and live inference',()=>{
 const {manifest,predictions}=fixture(),a=buildParkingAudit(manifest,predictions);
 const filters={type:'low_score_false_free',slot:'["B","12"]'};
 const exported=exportParkingAudit(a,filters,sourceHash);
 assert.equal(exported.format,'estateguard-parking-error-audit');
 assert.equal(exported.prediction_source,'published-fixed-model-evaluation');
 assert.equal(exported.model_sha256,hash);assert.equal(exported.predictions_sha256,sourceHash);
 assert.equal(exported.matched_count,1);assert.deepEqual(exported.filters,filters);
 assert.equal(exported.samples[0].score,.35);assert.equal(exported.samples[0].source_sha256,sourceHash);
 assert.equal('reviews' in exported,false);assert.equal('live_predictions' in exported,false);
 exported.samples[0].score=.9;assert.equal(filterParkingAudit(a,filters)[0].score,.35);
 assert.throws(()=>exportParkingAudit(a,filters,'missing-hash'));
});
test('full published fixed-model audit reproduces the independently counted dangerous errors',()=>{
 const load=path=>JSON.parse(readFileSync(new URL(path,import.meta.url)));
 const a=buildParkingAudit(load('../web/data/parking/manifest.json'),load('../web/data/parking/test-predictions.json'));
 assert.equal(a.summary.total,6413);assert.equal(a.summary.errors,1485);
 assert.equal(a.summary.false_free,1134);assert.equal(a.summary.false_occupied,351);
 assert.equal(a.summary.low_score_false_free,1037);assert.equal(a.summary.band_samples,263);
 assert.equal(a.summary.band_errors,127);assert.equal(a.summary.outside_band_errors,1358);
 assert.equal(filterParkingAudit(a,{type:'false_free',slot:'["B","12"]'}).length,103);
 assert.equal(filterParkingAudit(a,{type:'low_score_false_free',slot:'["B","12"]'}).length,102);
 assert.equal(filterParkingAudit(a,{type:'false_occupied',slot:'["B","12"]'}).length,0);
});
