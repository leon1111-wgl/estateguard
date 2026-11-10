import test from 'node:test';
import assert from 'node:assert/strict';
import {mappable,hungarianMin,alignClip,falseAlarmTime,pmissAt,naudc,scoreActivity,wilson} from '../scripts/actev-score.mjs';

const close=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps,`${a} ≠ ${b}`);
test('a reference of at least 1 s needs 1 s of overlap; a shorter one needs half its length',()=>{
 assert.equal(mappable({start:10,end:14},{start:13,end:20}),true);
 assert.equal(mappable({start:10,end:14},{start:13.5,end:20}),false);
 assert.equal(mappable({start:10,end:10.6},{start:10.3,end:12}),true);
 assert.equal(mappable({start:10,end:10.6},{start:10.4,end:12}),false);
});
test('Hungarian finds the minimum-cost assignment',()=>{
 assert.deepEqual(hungarianMin([[4,1,3],[2,0,5],[3,2,2]]),[1,0,2]);
 assert.deepEqual(hungarianMin([[1,9,9],[9,9,1]]),[0,2]);
});
test('alignment is one-to-one and prefers the higher-confidence system instance',()=>{
 const refs=[{start:0,end:5},{start:20,end:25}],sys=[{start:1,end:4,score:.4},{start:2,end:5,score:.9},{start:21,end:23,score:.5}];
 const pairs=alignClip(refs,sys);
 assert.deepEqual(pairs,[{ref:0,sys:1},{ref:1,sys:2}]);
 // One long system instance cannot count for two references (plan section 6.5).
 assert.equal(alignClip(refs,[{start:0,end:30,score:1}]).length,1);
});
test('false-alarm time counts system time beyond the reference count, including overlapping system instances',()=>{
 const r=falseAlarmTime([{start:10,end:20}],[{start:5,end:15},{start:12,end:14}],100);
 // 5–10 s outside the reference, plus 12–14 s where two system instances overlap one reference.
 close(r.false_alarm_seconds,7);close(r.non_reference_seconds,90);
 close(falseAlarmTime([],[{start:95,end:130}],100).false_alarm_seconds,5);
});
test('Pmiss at a Tfa follows the plan: 1.0 before the first point, linear between points, the minimum after the last',()=>{
 const det=[{tfa:.01,pmiss:.8},{tfa:.03,pmiss:.4},{tfa:.05,pmiss:.3}];
 assert.equal(pmissAt(det,.005),1);close(pmissAt(det,.02),.6);assert.equal(pmissAt(det,.5),.3);
 close(naudc([{tfa:0,pmiss:.5}],.2),.5,1e-6);
 close(naudc(det,.2),(0.01*1+0.02*.6+.02*.35+.15*.3)/.2,1e-3);
});
test('scoreActivity aggregates clips: perfect output scores Pmiss 0 at Tfa 0',()=>{
 const s=scoreActivity([{id:'a',duration:60,refs:[{start:10,end:14}],sys:[{start:10,end:14,score:.9}]},{id:'b',duration:60,refs:[{start:5,end:9}],sys:[{start:5,end:9,score:.8}]}]);
 assert.equal(s.references,2);assert.equal(s.operating_point.pmiss,0);assert.equal(s.operating_point.tfa,0);
 assert.equal(s.pmiss_at_tfa['0.02'],0);close(s.naudc,0);assert.equal(s.temporal_iou.mean,1);
});
test('scoreActivity: no system output means every reference is missed',()=>{
 const s=scoreActivity([{id:'a',duration:60,refs:[{start:10,end:14}],sys:[]}]);
 assert.equal(s.operating_point.pmiss,1);assert.equal(s.pmiss_at_tfa['0.02'],1);close(s.naudc,1);
});
test('scoreActivity: a false alarm raises Tfa and the miss stays a miss',()=>{
 const s=scoreActivity([{id:'a',duration:100,refs:[{start:10,end:14}],sys:[{start:50,end:54,score:.9},{start:11,end:13,score:.5}]}]);
 assert.equal(s.det.length,2);close(s.det[0].tfa,4/96);assert.equal(s.det[0].pmiss,1);assert.equal(s.det[1].pmiss,0);
 assert.equal(s.operating_point.unmatched_system_instances,1);
});
test('Wilson interval',()=>{const [lo,hi]=wilson(5,10);close(lo,.2366,1e-3);close(hi,.7634,1e-3);assert.equal(wilson(0,0),null);});
