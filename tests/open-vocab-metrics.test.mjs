import test from 'node:test';
import assert from 'node:assert/strict';
import {matchImage,classMetrics,selectOnDev,decideOnTest,wilson} from '../scripts/ovd-metrics.mjs';
import {suppress,classSpans,decodeOwl,OPEN_VOCAB_CLASSES,GDINO_TEXT} from '../web/open-vocab.mjs';
const det=(cls,score,bbox)=>({class:cls,score,bbox});
test('federated matching: positive exhaustive, positive not exhaustive, negative, unverified',()=>{
 const r={id:1,gt:{box:[[0,0,10,10]]},neg:['ladder'],not_exhaustive:[]};
 const dets=[det('box',.9,[0,0,10,10]),det('box',.8,[0,0,10,10]),det('box',.7,[50,50,5,5]),det('ladder',.6,[1,1,5,5]),det('crate',.9,[0,0,3,3])];
 assert.deepEqual([matchImage(r,dets,'box',.5).tp,matchImage(r,dets,'box',.5).fp],[1,2]);
 assert.equal(matchImage(r,dets,'ladder',.5).fp,1);
 assert.deepEqual([matchImage(r,dets,'crate',.5).fp,matchImage(r,dets,'crate',.5).ignored],[0,1]);
 const partial={...r,not_exhaustive:['box']};assert.deepEqual([matchImage(partial,dets,'box',.5).tp,matchImage(partial,dets,'box',.5).fp,matchImage(partial,dets,'box',.5).ignored],[1,0,2]);
 assert.equal(matchImage(r,dets,'box',.95).tp,0);
});
test('IoU 0.5 boundary and one-to-one',()=>{
 const r={id:1,gt:{box:[[0,0,10,10]]},neg:[],not_exhaustive:[]};
 assert.equal(matchImage(r,[det('box',.9,[0,0,10,20])],'box',.1).tp,1);// IoU exactly 0.5
 assert.equal(matchImage(r,[det('box',.9,[0,0,10,21])],'box',.1).fp,1);
});
test('class metrics count FP per 100 negative images only on negative images',()=>{
 const records=[{id:1,gt:{box:[[0,0,10,10]]},neg:[],not_exhaustive:[]},{id:2,gt:{},neg:['box'],not_exhaustive:[]},{id:3,gt:{},neg:['box'],not_exhaustive:[]}];
 const d=new Map([[1,[det('box',.9,[0,0,10,10]),det('box',.9,[30,30,5,5])]],[2,[det('box',.9,[0,0,10,10])]],[3,[]]]);
 const m=classMetrics(records,d,'box',.5);
 assert.deepEqual([m.tp,m.fp,m.gt,m.negative_images,m.fp_per_100_negative_images],[1,2,1,2,50]);
 assert.ok(Math.abs(m.precision-1/3)<1e-12);
});
test('dev selection and test decision follow the pre-registered rules',()=>{
 const records=[],d=new Map();let id=0;
 for(const cls of ['box','cart','ladder','crate'])for(let i=0;i<12;i++){records.push({id,gt:{[cls]:[[0,0,10,10]]},neg:[],not_exhaustive:[]});d.set(id,[det(cls,.5,[0,0,10,10]),...(cls==='crate'?[det(cls,.5,[40,40,5,5])]:[])]);id++;}
 const sel=selectOnDev([{id:'X',records,detections:d,classes:['box','cart','ladder','crate'],p95_ms:1,bytes:1}]);
 assert.equal(sel.chosen.threshold,.05);assert.deepEqual(sel.chosen.kept,['box','cart','ladder','crate']);
 const dec=decideOnTest(records,d,{threshold:.05,classes:['box','cart','ladder','crate']});
 assert.equal(dec.ship,true);assert.deepEqual(dec.removed,[]);
 const worse=new Map([...d].map(([k,v])=>[k,v.map(x=>x.class==='crate'?x:{...x,bbox:[50,50,2,2]})]));
 assert.equal(decideOnTest(records,worse,{threshold:.05,classes:['box','cart','ladder','crate']}).ship,false);
 const none=selectOnDev([{id:'X',records,detections:worse,classes:['box','cart','ladder','crate'],p95_ms:1,bytes:1}]);
 assert.equal(none.chosen,null);
});
test('wilson interval brackets the proportion',()=>{const [lo,hi]=wilson(7,10);assert.ok(lo<.7&&hi>.7&&lo>0&&hi<1);});
test('lane post-processing: class NMS 0.5 and cross-class dedupe 0.9',()=>{
 const kept=suppress([det('box',.9,[0,0,10,10]),det('box',.8,[1,0,10,10]),det('carton',.85,[0,0,10,10]),det('carton',.7,[0,0,10,14]),det('box',.6,[40,40,5,5])],50);
 assert.deepEqual(kept.map(k=>[k.class,k.score]),[['box',.9],['carton',.7],['box',.6]]);
});
test('Grounding DINO prompt splits into the 11 classes; OWL decoding maps to pixels',()=>{
 assert.equal(GDINO_TEXT.split('. ').length,11);
 assert.throws(()=>classSpans([101,3482,1012,102]));
 const logits={dims:[1,2,11],data:new Float32Array(22).fill(-10)};logits.data[3]=2;// patch 0 → box
 const boxes={dims:[1,2,4],data:new Float32Array([.5,.5,.2,.4, .1,.1,.1,.1])};
 const out=decodeOwl(logits,boxes,200,100,.5);
 assert.equal(out.length,1);assert.equal(out[0].class,OPEN_VOCAB_CLASSES[3]);assert.deepEqual(out[0].bbox.map(v=>+v.toFixed(3)),[80,30,40,40]);
});
import {makeCandidates,OPEN_VOCAB_RULE_CLASSES} from '../web/vision-rules.mjs';
test('lane boxes feed the corridor and lift rules, labelled and at lower evidence quality; COCO paths unchanged',()=>{
 const base={roi:[0,0,1,1],camera:'C1',zone:'Z1',started_at:'2026-11-10T08:00:00Z',media_name:'a.jpg',is_video:false};
 const lane=(cls,bbox)=>({id:`ovd-${cls}`,class:cls,source:'open_vocab',samples:[{time:0,bbox,score:.4}]});
 const access=makeCandidates([lane('carton',[.1,.1,.1,.1]),lane('fire_extinguisher',[.1,.1,.1,.1])],{...base,rule:'access'});
 assert.equal(access.length,1);assert.equal(access[0].category,'blocked_access');assert.equal(access[0].quality,.3);assert.equal(access[0].source,'open_vocab');assert.match(access[0].summary,/^开放词汇检测 · 未核实/);assert.match(access[0].id,/^vision-ovd-/);
 const lift=makeCandidates([lane('trash_can',[0,0,.5,.5]),lane('cart',[0,0,.1,.1]),lane('cart',[0,0,.3,.3])],{...base,rule:'lift'});
 assert.deepEqual(lift.map(c=>c.category),['bulky_load']);
 // A lane box never takes the COCO path even if a class name collides, and COCO tracks keep quality 0.4.
 assert.equal(makeCandidates([{...lane('car',[.1,.1,.1,.1])}],{...base,rule:'access'}).length,0);
 const coco=makeCandidates([{id:'t1',class:'car',samples:[{time:0,bbox:[.1,.1,.1,.1],score:.9}]}],{...base,rule:'access'});
 assert.equal(coco[0].quality,.4);assert.equal(coco[0].source,undefined);
 assert.ok(!OPEN_VOCAB_RULE_CLASSES.access.includes('fire_extinguisher')&&!OPEN_VOCAB_RULE_CLASSES.lift.includes('trash_can'));
});
