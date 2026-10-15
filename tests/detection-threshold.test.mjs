import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),tf={};
// Evaluate the shipped UMD as CommonJS; the app package itself uses ESM.
new Function('exports','module','require',readFileSync(new URL('../web/vendor/tf.min.js',import.meta.url),'utf8'))(tf,{exports:tf},require);
const context=vm.createContext({tf});
vm.runInContext(readFileSync(new URL('../web/vendor/coco-ssd.min.js',import.meta.url),'utf8'),context);
await tf.setBackend('cpu');await tf.ready();

// Controlled graph output isolates postprocessing. Browser tests separately run
// real public-image inference; these tensors are not claimed as model output.
async function detect(boxes,scores,threshold){
 const detector=new context.cocoSsd.ObjectDetection('lite_mobilenet_v2');
 detector.model={executeAsync:async()=>{
  const raw=new Float32Array(boxes.length*90);
  scores.forEach(([category,score],i)=>raw[i*90+category]=score);
  return [tf.tensor3d(raw,[1,boxes.length,90]),tf.tensor4d(boxes.flat(),[1,boxes.length,1,4])];
 }};
 const input=tf.zeros([100,100,3],'int32');
 try{return JSON.parse(JSON.stringify(await detector.detect(input,50,threshold)));}
 finally{input.dispose();}
}
test('raising the score cutoff does not release a duplicate bus box',async()=>{
 const boxes=[[0,0,.4,.4],[.01,.01,.41,.41],[.5,.5,.9,.9]];
 const scores=[[5,.99],[5,.97],[5,.96]];
 for(const threshold of [.1,.5,.95]){
  const results=await detect(boxes,scores,threshold);
  assert.equal(results.length,2,`cutoff ${threshold} must retain two separated buses, suppressing the duplicate`);
  assert.deepEqual(results.map(x=>x.class),['bus','bus']);
 }
 assert.equal((await detect(boxes,scores,.98)).length,1);
});
test('lowering the score cutoff does not suppress moderately overlapping objects',async()=>{
 // IoU 1/3: separate hypotheses remain with the fixed 0.5 overlap threshold.
 const results=await detect([[0,0,.4,.4],[0,.2,.4,.6]],[[5,.99],[5,.8]],.1);
 assert.equal(results.length,2);
});
test('low-confidence detections are retained only when the user requests them',async()=>{
 const boxes=[[0,0,.4,.4],[.6,.6,.8,.8]],scores=[[5,.99],[0,.21]];
 assert.deepEqual((await detect(boxes,scores,.1)).map(x=>x.class),['bus','person']);
 assert.deepEqual((await detect(boxes,scores,.5)).map(x=>x.class),['bus']);
});
