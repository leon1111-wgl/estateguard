import test from 'node:test';
import assert from 'node:assert/strict';
import {trackDetections,makeCandidates} from '../web/vision-rules.mjs';
const d=(box=[.1,.2,.3,.3],label='car')=>({bbox:box,class:label,score:.9});
const config={rule:'access',roi:[0,0,1,1],camera:'local-camera',zone:'Test zone',started_at:'2026-10-15T08:00:00+08:00',media_name:'test.mp4',dwell_seconds:2,is_video:true,expected_direction:'right'};
test('object-only inference with unknown capture time produces no dated event',()=>{
 const tracks=trackDetections([{time:0,detections:[d()]}]);
 assert.deepEqual(makeCandidates(tracks,{...config,rule:'objects',started_at:null}),[]);
 assert.throws(()=>makeCandidates(tracks,{...config,started_at:null}),/时间/);
});
test('nearby same-class boxes link into an anonymous track',()=>{
 const t=trackDetections([{time:0,detections:[d()]},{time:1,detections:[d([.11,.2,.3,.3])]}]);assert.equal(t.length,1);assert.equal(t[0].samples.length,2);
});
test('different objects cannot both claim the same predecessor',()=>{
 const t=trackDetections([{time:0,detections:[d()]},{time:1,detections:[d(),d([.12,.2,.3,.3])]}]);assert.equal(t.length,2);
});
test('objects outside the designated region produce no access cue',()=>{
 const t=trackDetections([{time:0,detections:[d()]}]);assert.equal(makeCandidates(t,{...config,roi:[.7,.7,.2,.2]}).length,0);
});
test('object detection alone does not classify a person as an obstruction',()=>{
 const t=trackDetections([{time:0,detections:[d(undefined,'person')]}]);assert.equal(makeCandidates(t,config).length,0);
});
test('a single image cannot establish parking dwell',()=>{
 const t=trackDetections([{time:0,detections:[d()]}]);assert.equal(makeCandidates(t,{...config,rule:'parking',is_video:false}).length,0);
});
test('persistent stationary vehicle can generate a review candidate',()=>{
 const t=trackDetections([0,1,2,3].map(time=>({time,detections:[d()]})));const r=makeCandidates(t,{...config,rule:'parking'});assert.equal(r.length,1);assert.equal(r[0].category,'illegal_parking');assert.ok(r[0].quality<.5);
});
test('an object leaving the region cannot combine separate visits into dwell',()=>{
 const t=trackDetections([0,1,2,3].map((time,i)=>({time,detections:[d([i===2?.45:.1,.2,.5,.3])]})));assert.equal(makeCandidates(t,{...config,rule:'parking',roi:[0,0,.55,1],dwell_seconds:3}).length,0);
});
test('unrelated object classes do not become bulky-load claims',()=>{
 const t=trackDetections([{time:0,detections:[d(undefined,'cat')]}]);assert.equal(makeCandidates(t,{...config,rule:'lift'}).length,0);
});
test('direction rule requires movement opposite the configured direction',()=>{
 const t=trackDetections([.6,.5,.4].map((x,i)=>({time:i,detections:[d([x,.2,.3,.3])]})));
 assert.equal(makeCandidates(t,{...config,rule:'direction',expected_direction:'right'})[0].category,'wrong_way');
 assert.equal(makeCandidates(t,{...config,rule:'direction',expected_direction:'left'}).length,0);
});
test('a missing observation longer than the association gap starts a new track',()=>{
 const t=trackDetections([{time:0,detections:[d()]},{time:1,detections:[]},{time:2,detections:[d()]}]);assert.equal(t.length,2);
});
