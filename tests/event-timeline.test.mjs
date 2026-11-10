import test from 'node:test';
import assert from 'node:assert/strict';
import {trackFrames,buildTimeline,TIMELINE_SETTINGS,TIMELINE_RULES,TIMELINE_LIMITS} from '../web/event-timeline.mjs';

const det=(cls,bbox,score=.9)=>({class:cls,bbox,score});
const frames=(n,fn)=>Array.from({length:n},(_,t)=>({time:t,detections:fn(t).filter(Boolean)}));
const only=(timeline,rule)=>timeline.events.filter(e=>e.rule===rule);
// Rule tests fix the dwell at 3 s so they do not depend on the default chosen on MEVA dev.
const timeline=(f,o={})=>buildTimeline(f,{...o,settings:{dwell_seconds:3,...(o.settings||{})}});

test('a walking person who moves more than a box width per sample stays one track',()=>{
 // 0.06 per second with a 0.04-wide box: consecutive boxes never overlap, so IoU alone would split every sample.
 const f=frames(6,t=>[det('person',[.2+.06*t,.4,.04,.12])]);
 assert.equal(trackFrames(f).length,1);
});
test('a car that is reported as a truck in one frame keeps its track',()=>{
 const f=frames(4,t=>[det(t===2?'truck':'car',[.3,.3,.2,.1])]);
 const tracks=trackFrames(f);assert.equal(tracks.length,1);assert.equal(tracks[0].class,'car');
});
test('low-score detections continue a track but never start one',()=>{
 const f=frames(3,t=>[det('person',[.4,.4,.05,.15],t===1?.3:.9),t===1?det('person',[.1,.1,.05,.15],.3):null]);
 const tracks=trackFrames(f);assert.equal(tracks.length,1);assert.equal(tracks[0].samples.length,3);
 assert.equal(trackFrames(frames(3,()=>[det('person',[.4,.4,.05,.15],.3)])).length,0);
});
test('a gap longer than the association gap starts a new track',()=>{
 const f=[0,1,4,5].map(time=>({time,detections:[det('car',[.3,.3,.2,.1])]}));
 assert.equal(trackFrames(f).length,2);
});
test('two people side by side do not swap or merge',()=>{
 const f=frames(5,t=>[det('person',[.2+.02*t,.4,.05,.15]),det('person',[.5-.02*t,.4,.05,.15])]);
 const tracks=trackFrames(f);assert.equal(tracks.length,2);
 for(const tr of tracks){const xs=tr.samples.map(s=>s.bbox[0]);assert.ok(xs.every((x,i)=>!i||Math.sign(x-xs[i-1])===Math.sign(xs[1]-xs[0])));}
});
test('the same input always gives the same timeline',()=>{
 const f=frames(12,t=>[det('car',[Math.min(.1+.1*t,.5),.5,.12,.08]),t>3?det('person',[.6,.3,.04,.12]):null]);
 assert.deepEqual(buildTimeline(f,{aspect:16/9}),buildTimeline(structuredClone(f),{aspect:16/9}));
});

test('vehicle_stop: a car that drives in and stops for the dwell time is one event with the stop as keyframe',()=>{
 const f=frames(12,t=>[det('car',[Math.min(.1+.1*t,.5),.5,.12,.08])]);
 const [e,...rest]=only(timeline(f,{aspect:16/9}),'vehicle_stop');
 assert.equal(rest.length,0);
 // Last moving sample t=3, first stopped sample t=4, confirmed after 3 s at t=7.
 assert.deepEqual([e.start,e.keyframe_time,e.end],[3,4,7]);
 assert.equal(e.condition_seconds,7);assert.equal(e.condition_open,true);
});
test('vehicle_stop: a car parked for the whole clip never "stops"',()=>{
 assert.equal(only(timeline(frames(20,()=>[det('car',[.4,.5,.12,.08])])),'vehicle_stop').length,0);
});
test('vehicle_stop: a stop shorter than the dwell time is not an event',()=>{
 const xs=[.1,.2,.3,.3,.3,.4,.5,.6];
 assert.equal(only(timeline(xs.map((x,time)=>({time,detections:[det('car',[x,.5,.12,.08])]}))),'vehicle_stop').length,0);
});
test('vehicle_stop: a stop outside the zone is ignored, inside it counts',()=>{
 const f=frames(12,t=>[det('car',[Math.min(.1+.1*t,.5),.5,.12,.08])]);
 assert.equal(only(timeline(f,{zone:[0,0,.3,1]}),'vehicle_stop').length,0);
 assert.equal(only(timeline(f,{zone:[.4,.4,.4,.4]}),'vehicle_stop').length,1);
});
test('vehicle_stop: stop, drive on, stop again gives two events',()=>{
 const xs=[.1,.2,.3,.3,.3,.3,.3,.4,.5,.6,.6,.6,.6,.6];
 const ev=only(timeline(xs.map((x,time)=>({time,detections:[det('car',[x,.5,.12,.08])]}))),'vehicle_stop');
 assert.deepEqual(ev.map(e=>e.keyframe_time),[2,9]);assert.equal(ev[0].condition_open,false);
});

test('object_left: a bag that appears mid-clip and stays unattended is an event',()=>{
 const f=frames(12,t=>[t>=4?det('backpack',[.5,.7,.04,.05]):null]);
 const [e]=only(timeline(f),'object_left');
 assert.deepEqual([e.start,e.keyframe_time,e.end],[3,4,7]);
});
test('object_left: a bag already there in the first frame is not an event',()=>{
 assert.equal(only(timeline(frames(12,()=>[det('suitcase',[.5,.7,.04,.05])])),'object_left').length,0);
});
test('object_left: the stay only starts once no person box covers the bag',()=>{
 const f=frames(14,t=>[det('handbag',[.5,.7,.04,.05]),t<6?det('person',[.48,.5,.08,.3]):null]);
 const [e,...rest]=only(timeline(f),'object_left');
 assert.equal(rest.length,0);assert.deepEqual([e.keyframe_time,e.end],[6,9]);
});
test('object_left: a bag carried by a person is never left',()=>{
 const f=frames(10,t=>[det('person',[.2+.03*t,.4,.06,.2]),det('backpack',[.21+.03*t,.45,.03,.05])]);
 assert.equal(only(timeline(f),'object_left').length,0);
});

test('person_appears: a person who appears away from the edges is an event at the first sighting',()=>{
 const f=frames(8,t=>[t>=3?det('person',[.5,.4,.04,.12]):null]);
 const [e]=only(timeline(f),'person_appears');
 assert.deepEqual([e.start,e.keyframe_time,e.end],[2,3,4]);
});
test('person_appears: walking in from the frame edge, present from the start, seen once, or outside the zone is not',()=>{
 assert.equal(only(timeline(frames(8,t=>[t>=3?det('person',[.005,.4,.04,.12]):null])),'person_appears').length,0);
 assert.equal(only(timeline(frames(8,()=>[det('person',[.5,.4,.04,.12])])),'person_appears').length,0);
 assert.equal(only(timeline(frames(8,t=>[t===3?det('person',[.5,.4,.04,.12]):null])),'person_appears').length,0);
 assert.equal(only(timeline(frames(8,t=>[t>=3?det('person',[.5,.4,.04,.12]):null]),{zone:[0,0,.3,.3]}),'person_appears').length,0);
});

test('events are numbered in time order and carry rule, track, class, score and box',()=>{
 const f=frames(12,t=>[det('car',[Math.min(.1+.1*t,.5),.5,.12,.08]),t>=2?det('person',[.7,.3,.04,.12],.8):null]);
 const tl=timeline(f,{aspect:16/9});
 assert.deepEqual(tl.events.map(e=>e.id),['e001','e002']);
 assert.deepEqual(tl.events.map(e=>e.rule),['person_appears','vehicle_stop']);
 for(const e of tl.events){for(const k of ['label','track','class','score','bbox','start','end','duration','keyframe_time'])assert.ok(e[k]!==undefined,k);assert.ok(e.end>e.start);}
});
test('settings and input are validated',()=>{
 assert.throws(()=>timeline([{time:0,detections:[]},{time:0,detections:[]}]),/重复/);
 assert.throws(()=>timeline([],{zone:[0,0,0,1]}),/区域/);
 assert.throws(()=>timeline([],{settings:{detection_floor:.8,minimum_score:.5}}),/下限/);
 assert.throws(()=>timeline([],{rules:['door_opens']}),/未知/);
});
test('the rules state what they see and what they miss; the limits say that no event is not safety',()=>{
 for(const r of Object.values(TIMELINE_RULES)){assert.ok(r.sees.length>10);assert.ok(r.misses.length>10);}
 assert.match(TIMELINE_LIMITS[0],/不等于安全/);
 assert.match(TIMELINE_RULES.object_left.misses,/纸箱/);
 assert.equal(Object.isFrozen(TIMELINE_SETTINGS),true);
});
test('a panning camera is flagged on the timeline without changing any event',()=>{
 // Four parked cars that all shift together twice: the camera moved, not the cars.
 const pan=t=>t<3?0:t<5?.15:t<8?.15:t<10?.3:.3,moving=t=>(t>=3&&t<5)||(t>=8&&t<10);
 const f=frames(14,t=>[0,1,2,3].map(k=>det('car',[.05+.2*k+(t>=3&&t<5?.075*(t-2):t>=8&&t<10?.15+.075*(t-7):pan(t)),.5,.1,.06])));
 const tl=buildTimeline(f,{aspect:16/9});
 assert.deepEqual(tl.warnings,['camera_motion']);assert.ok(tl.camera_motion_times.length>=2);
 const still=buildTimeline(frames(14,t=>[det('car',[Math.min(.1+.1*t,.5),.5,.12,.08]),det('car',[.1,.2,.1,.06]),det('car',[.4,.2,.1,.06]),det('car',[.7,.2,.1,.06])]),{aspect:16/9});
 assert.deepEqual(still.warnings,[]);
 assert.ok(moving(3));
});
