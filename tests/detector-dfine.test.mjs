import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {COCO_CLASSES,COCO_IDS,DFINE,dfineInput,dfinePostprocess} from '../web/detector-dfine.mjs';

const logit=p=>Math.log(p/(1-p));
function outputs(entries,queries=DFINE.queries,classes=DFINE.classes){
 const logits=new Float32Array(queries*classes).fill(-20),boxes=new Float32Array(queries*4);
 for(const {q,c,p,box} of entries){logits[q*classes+c]=logit(p);boxes.set(box,q*4);}
 return {logits,boxes};
}

test('class names and COCO ids match the COCO-SSD bundle used by the rules',()=>{
 const bundle=readFileSync(new URL('../web/vendor/coco-ssd.min.js',import.meta.url),'utf8');
 const pairs=[...bundle.matchAll(/id:(\d+),displayName:"([^"]*)"/g)].map(m=>[Number(m[1]),m[2]]).sort((a,b)=>a[0]-b[0]);
 assert.deepEqual(pairs.map(p=>p[1]),COCO_CLASSES);assert.deepEqual(pairs.map(p=>p[0]),COCO_IDS);
 for(const name of ['car','truck','bus','motorcycle','couch','chair','bed','dining table','refrigerator','suitcase'])assert.ok(COCO_CLASSES.includes(name),name);
});

test('top-k over query×class scores maps normalised centre boxes to source pixels',()=>{
 const {logits,boxes}=outputs([{q:7,c:5,p:.96,box:[.5,.5,.5,.25]},{q:3,c:0,p:.8,box:[.1,.2,.1,.2]},{q:3,c:2,p:.6,box:[.1,.2,.1,.2]}]);
 const out=dfinePostprocess(logits,boxes,800,600,{maxDetections:10,minScore:.5});
 assert.deepEqual(out.map(d=>d.class),['bus','person','car']);
 // One query can carry several classes, as in DETR focal-loss post-processing; no NMS is applied.
 assert.equal(out[1].bbox.join(),out[2].bbox.join());
 assert.deepEqual(out[0].bbox.map(v=>Math.round(v*1e6)/1e6),[200,225,400,150]);
 assert.ok(Math.abs(out[0].score-.96)<1e-6);
});

test('score floor, ordering, cap and clipping are deterministic',()=>{
 const {logits,boxes}=outputs([{q:1,c:1,p:.3,box:[.95,.95,.2,.2]},{q:2,c:1,p:.3,box:[.5,.5,.1,.1]},{q:4,c:9,p:.2,box:[.5,.5,.1,.1]}]);
 const out=dfinePostprocess(logits,boxes,100,100,{maxDetections:2,minScore:.25});
 assert.equal(out.length,2);assert.deepEqual(out.map(d=>d.classIndex),[1,1]);
 // Equal scores keep the lower flat index first; boxes are clipped to the frame.
 const [a]=out;assert.ok(a.bbox[0]+a.bbox[2]<=100&&a.bbox[1]+a.bbox[3]<=100);assert.equal(Math.round(a.bbox[2]),15);
 assert.equal(dfinePostprocess(logits,boxes,100,100,{minScore:.99}).length,0);
 assert.throws(()=>dfinePostprocess(new Float32Array(3),boxes,100,100),/尺寸/);
});

test('input is NCHW RGB scaled to 0..1 without mean/std normalisation',()=>{
 const size=2,rgba=new Uint8ClampedArray([255,0,0,255, 0,255,0,255, 0,0,255,255, 51,102,153,0]);
 const x=dfineInput(rgba,size);
 assert.deepEqual(Array.from(x).map(v=>Math.round(v*100)/100),[1,0,0,.2, 0,1,0,.4, 0,0,1,.6]);
 assert.throws(()=>dfineInput(rgba,3),/尺寸/);
});

test('near-identical boxes collapse across classes only when dedupe is on',()=>{
 const {logits,boxes}=outputs([{q:1,c:2,p:.8,box:[.5,.5,.4,.3]},{q:1,c:7,p:.7,box:[.5,.5,.4,.3]},{q:2,c:7,p:.65,box:[.501,.5,.4,.3]},{q:3,c:0,p:.6,box:[.5,.5,.1,.3]}]);
 const raw=dfinePostprocess(logits,boxes,100,100,{minScore:.5});assert.equal(raw.length,4);
 const kept=dfinePostprocess(logits,boxes,100,100,{minScore:.5,dedupeIoU:.9});
 // Car wins over the truck on the same box; a person inside the car's box (IoU < 0.9) stays.
 assert.deepEqual(kept.map(d=>d.class),['car','person']);
 assert.equal(DFINE.dedupeIoU,.9);
});
