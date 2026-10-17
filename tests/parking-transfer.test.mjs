import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateHead,predictHead,standardize,adaptHead,selectRouting,routeScore,cpUpper,minimumEvidence,dinoInput,dinoPool,DINO_SIZE,DINO_MEAN,DINO_STD} from '../web/parking-transfer.mjs';
import {frameSummary,filterParkingRows} from '../web/parking-model.mjs';

const read=path=>readFileSync(new URL(path,import.meta.url));
const fixtures=JSON.parse(read('./fixtures/parking-transfer-parity.json'));
const evaluation=JSON.parse(read('../web/data/parking-transfer/evaluation.json'));
const specs={mobilenet:{path:'../web/models/parking-transfer/model.json',feature_version:'ssdlite-mnv2-conv1-gap-v1',features:1280},dinov2:{path:'../web/models/parking-dinov2/model.json',feature_version:'dinov2-small-int8-cls-mean-112-v1',features:768}};
const close=(a,b,tol,msg)=>assert.ok(Math.abs(a-b)<=tol,`${msg}: ${a} vs ${b}`);

for(const [key,spec] of Object.entries(specs)){
 const bytes=read(spec.path),head=validateHead(JSON.parse(bytes),spec),fx=fixtures[key];
 test(`${key}: published head matches evaluation and fixtures`,()=>{
  const sha=createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha,fx.model_sha256);assert.equal(sha,evaluation.models[key].model_sha256);
  assert.equal(head.routing.t_free,fx.routing.t_free);assert.equal(head.routing.t_busy,fx.routing.t_busy);
 });
 test(`${key}: browser head scores equal Python on real features`,()=>{
  for(const s of fx.samples){const out=predictHead(s.features,head);close(out.score,s.score,1e-12,s.id);close(out.calibrated,s.calibrated,1e-12,s.id);}
 });
 test(`${key}: L2-SP adaptation matches Python step for step`,()=>{
  const a=fx.adaptation,result=adaptHead(a.features.map(f=>standardize(f,head)),a.labels,head);
  close(result.b,a.b,1e-9,'bias');a.w_head.forEach((w,i)=>close(result.w[i],w,1e-9,`w${i}`));
  close(Math.hypot(...result.w),a.w_norm,1e-8,'norm');assert.equal(result.n,a.labels.length);
  fx.samples.forEach((s,i)=>close(predictHead(s.features,head,result).calibrated,a.scores[i],1e-9,s.id));
  // The source head itself is never mutated by adaptation.
  assert.deepEqual(head.w.slice(0,4),JSON.parse(bytes).w.slice(0,4));
 });
 test(`${key}: Learn-then-Test thresholds equal the Python selection`,()=>{
  const r=selectRouting(fx.routing.p,fx.routing.y);
  assert.equal(r.t_free,fx.routing.t_free);assert.equal(r.t_busy,fx.routing.t_busy);assert.equal(r.tests.length,30);
 });
 test(`${key}: camera·slot·date counting matches Python on all of B`,()=>{
  const u=fx.unit_routing,r=selectRouting(u.p,u.y,{alpha_free:u.alpha_free,alpha_busy:u.alpha_busy,units:u.units});
  assert.equal(r.t_free,u.t_free);assert.equal(r.t_busy,u.t_busy);assert.deepEqual(r.tests.map(t=>[t.accepted,t.errors]),u.tests);
  // One day of 53 slots is at most 53 units: far too few to certify 5% even with zero errors.
  assert.equal(r.calibration_units,53);
 });
 test(`${key}: head validation rejects another encoder's features`,()=>{
  const other=Object.values(specs).find(s=>s!==spec);
  assert.throws(()=>validateHead(JSON.parse(bytes),other),/特征版本/);
  assert.throws(()=>predictHead(new Array(other.features).fill(0),head),/维度/);
 });
}

test('Clopper-Pearson bounds match Python and known closed forms',()=>{
 for(const c of fixtures.cp)close(cpUpper(c.x,c.n,c.level),c.upper,1e-9,JSON.stringify(c));
 // Zero errors: upper bound is 1-level^(1/n).
 close(cpUpper(0,300,.05),1-.05**(1/300),1e-9,'closed form');
 assert.equal(cpUpper(0,0,.05),1);assert.equal(cpUpper(5,5,.05),1);
 assert.equal(minimumEvidence(.01,.05/30),637);
});

test('routing sends everything to review until thresholds are certified',()=>{
 assert.equal(routeScore(.001,null),'review');assert.equal(routeScore(.999,{t_free:null,t_busy:null}),'review');
 const r={t_free:.2,t_busy:.6};
 assert.equal(routeScore(.2,r),'free');assert.equal(routeScore(.21,r),'review');assert.equal(routeScore(.6,r),'busy');
 assert.throws(()=>routeScore(Number.NaN,r),/无效/);
 // Too few confirmations cannot certify a 1% target, whatever the scores look like.
 const few=selectRouting(Array(100).fill(.01),Array(100).fill(0));assert.equal(few.t_free,null);
 const many=selectRouting(Array(700).fill(.01),Array(700).fill(0));assert.equal(many.t_free,.01);assert.equal(many.t_busy,null);
});

test('repeated snapshots of one slot count once as evidence',()=>{
 const n=700,scores=Array(n).fill(.01),labels=Array(n).fill(0);
 assert.equal(selectRouting(scores,labels).t_free,.01);
 const units=scores.map((_,i)=>`B|${i%50}|20150708`),r=selectRouting(scores,labels,{units});
 assert.equal(r.t_free,null);assert.equal(r.calibration_units,50);
 labels[3]=1;labels[53]=1;assert.equal(selectRouting(scores,labels,{units}).tests[2].errors,1);
});
test('frame summary and filters use the routed state for transfer models',()=>{
 const rows=[{id:'a',label:1},{id:'b',label:0},{id:'c',label:1}],scores=new Map([['a',.9],['b',.1]]);
 const routed=(id)=>({a:'busy',b:'uncertain'})[id];
 assert.deepEqual(frameSummary(rows,scores,routed),{total:3,free:0,busy:1,uncertain:1,pending:1});
 assert.deepEqual(filterParkingRows(rows,scores,{},'model_uncertain',routed).map(r=>r.id),['b','c']);
 // Default classifier keeps the original MLP32 bands.
 assert.deepEqual(frameSummary(rows,scores),{total:3,free:1,busy:1,uncertain:0,pending:1});
});

test('DINOv2 preprocessing resizes with half-pixel bilinear and ImageNet normalisation',()=>{
 const solid=new Uint8ClampedArray(4*7*5).fill(255),out=dinoInput(solid,7,5);
 assert.equal(out.length,3*DINO_SIZE*DINO_SIZE);
 for(let c=0;c<3;c++)close(out[c*DINO_SIZE*DINO_SIZE+123],(1-DINO_MEAN[c])/DINO_STD[c],1e-6,`channel ${c}`);
 // 2x1 image: left black, right white. Half-pixel centres give exact ramps at known positions.
 const ramp=new Uint8ClampedArray([0,0,0,255,255,255,255,255]),r=dinoInput(ramp,2,1,4),value=i=>r[i]*DINO_STD[0]+DINO_MEAN[0];
 [0,.25,.75,1].forEach((v,i)=>close(value(i),v,1e-6,`ramp ${i}`));
 assert.throws(()=>dinoInput(new Uint8ClampedArray(3),1,1),/尺寸/);
});

test('DINOv2 pooling concatenates CLS with the mean patch token',()=>{
 const dim=3,tokens=3,hidden=new Float32Array([9,9,9,1,2,3,3,4,5]),out=dinoPool(hidden,tokens,dim);
 assert.deepEqual(Array.from(out),[9,9,9,2,3,4]);
 assert.throws(()=>dinoPool(hidden,4,dim),/尺寸/);
});
