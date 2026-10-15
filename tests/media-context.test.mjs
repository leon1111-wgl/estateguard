import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecordingTime,confirmContext,isContextConfirmed,reusableScene,restoreScene,validateContext} from '../web/media-context.mjs';
const params={rule:'access',camera:'A',zone:'东门',roi:[.1,.2,.7,.6],started_at:'2026-10-16T08:01:02+08:00',offset_seconds:2,is_video:true,expected_direction:'right',dwell_seconds:5,minimum_score:.5};
test('unknown capture time stays unknown and supplied seconds use UTC+8',()=>{
 assert.equal(parseRecordingTime(''),null);
 assert.equal(parseRecordingTime('2026-10-16T08:01'),'2026-10-16T08:01:00+08:00');
 assert.equal(parseRecordingTime('2026-10-16T08:01:02'),'2026-10-16T08:01:02+08:00');
 assert.equal(Date.parse(parseRecordingTime('2026-10-16T00:00')) ,Date.parse('2026-10-15T16:00:00Z'));
});
test('impossible calendar dates are rejected rather than normalized into another day',()=>{
 for(const value of ['2026-02-29T08:00','2026-04-31T08:00','2026-10-16T24:00','2026-10-16T08:60'])assert.throws(()=>parseRecordingTime(value));
 assert.equal(parseRecordingTime('2024-02-29T08:00'),'2024-02-29T08:00:00+08:00');
});
test('only the current committed media and unchanged context can reuse confirmation',()=>{
 const confirmed=confirmContext(1,params,'2026-10-16T01:00:00Z');
 assert.equal(isContextConfirmed(confirmed,1,{...params,minimum_score:.9,dwell_seconds:8}),true);
 assert.equal(isContextConfirmed(confirmed,2,params),false);
 for(const changed of [{camera:'B'},{zone:'西门'},{roi:[0,0,1,1]},{started_at:'2026-10-17T08:00:00+08:00'},{offset_seconds:3},{rule:'parking'},{expected_direction:'left'}])assert.equal(isContextConfirmed(confirmed,1,{...params,...changed}),false);
 assert.equal(isContextConfirmed(null,1,params),false);
});
test('candidate rules require source, time and a confirmation for this media',()=>{
 assert.throws(()=>validateContext(params,1,null),/核对/);
 for(const changed of [{camera:''},{zone:''},{started_at:null}])assert.throws(()=>confirmContext(1,{...params,...changed}));
 const confirmed=confirmContext(1,params);
 assert.doesNotThrow(()=>validateContext(params,1,confirmed));
 assert.throws(()=>validateContext(params,2,confirmed),/核对/);
 assert.doesNotThrow(()=>validateContext({...params,rule:'objects',camera:'',zone:'',started_at:null},2,null));
});
test('scene reuse never carries time or sampling offset into the next recording',()=>{
 const scene=reusableScene(params,{width:960,height:640});
 const restored=restoreScene(scene,{width:960,height:640});
 assert.equal(restored.settings.camera,'A');assert.deepEqual(restored.settings.roi,[.1,.2,.7,.6]);
 assert.equal(restored.settings.started_at,null);assert.equal(restored.settings.offset_seconds,0);assert.equal(restored.roi_reset,false);
 restored.settings.roi[0]=.9;assert.equal(scene.settings.roi[0],.1);
});
test('different dimensions reset ROI even when only the resolution changes',()=>{
 const scene=reusableScene(params,{width:960,height:640});
 for(const size of [{width:640,height:960},{width:480,height:320}]){
  const restored=restoreScene(scene,size);assert.deepEqual(restored.settings.roi,[0,0,1,1]);assert.equal(restored.roi_reset,true);assert.equal(restored.settings.started_at,null);
 }
});
