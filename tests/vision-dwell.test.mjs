import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {trackDetections,makeCandidates} from '../web/vision-rules.mjs';
import {buildEvents,defaultPolicy,validateBatch,applyDecision,exportWorkspace,importWorkspace} from '../web/engine.mjs';
const observed=JSON.parse(readFileSync(new URL('./fixtures/vision-dwell-observed.json',import.meta.url)));
const config={rule:'parking',roi:[0,0,1,1],camera:'规则测试',zone:'测试区域',started_at:'2026-10-19T08:00:00+08:00',media_name:'合成短片.mp4',dwell_seconds:5,is_video:true};
const at=seconds=>new Date(Date.parse(config.started_at)+seconds*1000).toISOString();
const fromSamples=samples=>[{id:'track-1',class:'bus',samples}];
const positions=xs=>xs.map((x,time)=>({time,bbox:[x,.2,.3,.3],score:time<3?.99:.8}));
test('真实推理错例：驶入阶段不再否决后续稳定停留，候选证据仅来自稳定段',()=>{
 const candidates=makeCandidates(fromSamples(observed.cases['arrive-stop']),config);
 assert.equal(candidates.length,1);const c=candidates[0];assert.equal(c.start,at(3));assert.equal(c.end,at(10));
 const samples=observed.cases['arrive-stop'].filter(s=>s.time>=3);
 assert.equal(c.score,Math.max(...samples.map(s=>s.score)));
 assert.deepEqual(c.evidence,samples.map(s=>`${config.media_name} @ ${s.time.toFixed(2)}s`));
 assert.doesNotMatch(c.summary,/单图时间窗/);
});
test('同批真实推理：全程静止仍一个候选，持续移动不产生候选',()=>{
 const still=makeCandidates(fromSamples(observed.cases.stationary),config);
 assert.equal(still.length,1);assert.equal(still[0].start,at(0));assert.equal(still[0].end,at(10));
 assert.equal(makeCandidates(fromSamples(observed.cases.moving),config).length,0);
});
test('先停稳再驶离，仅已达标的稳定段计入候选',()=>{
 const c=makeCandidates(fromSamples(positions([.1,.1,.1,.1,.1,.1,.2,.3,.4])),config);
 assert.equal(c.length,1);assert.equal(c[0].start,at(0));assert.equal(c[0].end,at(5));assert.equal(c[0].evidence.length,6);
});
test('移动分开的两次停稳保留各自区间，不拼成整次访问',()=>{
 const c=makeCandidates(fromSamples(positions([.1,.1,.1,.1,.2,.3,.4,.4,.4,.4])),{...config,dwell_seconds:3});
 assert.deepEqual(c.map(r=>[r.start,r.end]),[[at(0),at(3)],[at(6),at(9)]]);
 assert.notEqual(c[0].id,c[1].id);
});
test('稳定窗口不能靠相邻小位移串成长期移动，也不能忽略往返摆动',()=>{
 assert.equal(makeCandidates(fromSamples(positions(Array.from({length:15},(_,i)=>.1+i*.02))),config).length,0);
 const xs=[.2,.25,.15,.25,.15,.25,.15,.25];
 assert.equal(makeCandidates(fromSamples(positions(xs)),config).length,0);
});
test('丢检间隙、出区域、不同轨迹和单张图片不拼接停留',()=>{
 const samples=positions([.1,.1,.1,.1,.1,.1]).map((s,i)=>({...s,time:i+(i>2?4:0)}));
 assert.equal(makeCandidates(fromSamples(samples),config).length,0);
 const frames=positions([.1,.1,.1,.1,.1,.1]).map((s,i)=>({time:i,detections:i===3?[]:[{class:'bus',bbox:s.bbox,score:s.score}]}));
 assert.equal(makeCandidates(trackDetections(frames),config).length,0);
 const outside=positions([.1,.1,.1,.6,.1,.1,.1]);
 assert.equal(makeCandidates(fromSamples(outside),{...config,roi:[0,0,.5,1]}).length,0);
 assert.equal(makeCandidates([{id:'a',class:'bus',samples:positions([.1,.1,.1])},{id:'b',class:'bus',samples:positions([.1,.1,.1])}],config).length,0);
 assert.equal(makeCandidates(fromSamples(observed.cases.stationary),{...config,is_video:false}).length,0);
});
test('视频与图片的时间说明符合实际输入，其他规则保持可用',()=>{
 const tracks=fromSamples(positions([.1,.1,.1]));
 assert.doesNotMatch(makeCandidates(tracks,{...config,rule:'access'})[0].summary,/单图时间窗/);
 assert.match(makeCandidates(tracks,{...config,rule:'access',is_video:false})[0].summary,/单图时间窗/);
});
const batch=observations=>({schema_version:1,name:'稳定片段回归',provenance:'人工构造轨迹，仅验证规则与交接',observations});
test('离开区域再返回的两个稳定段送审后仍独立，不能叠加跨过宽限期',()=>{
 const candidates=makeCandidates(fromSamples(positions([.1,.1,.1,.6,.1,.1,.1])),{...config,roi:[0,0,.5,1],dwell_seconds:2});
 assert.equal(candidates.length,2);assert.equal(candidates[0].track,candidates[1].track);
 assert.notEqual(candidates[0].stable_segment_id,candidates[1].stable_segment_id);
 const policy={...defaultPolicy,quality_threshold:.4,parking_grace_seconds:3};
 const events=buildEvents(batch(candidates),policy);
 assert.equal(events.length,2);
 assert.deepEqual(events.map(e=>[e.observed_seconds,e.routing]),[[2,'short_observation'],[2,'short_observation']]);
 let workspace={batch:batch(candidates),policy,decisions:{},audit:[]};
 workspace=applyDecision(workspace,events[0].id,'needs_evidence','请核对第一次停留的现场画面');
 const restored=importWorkspace(JSON.parse(exportWorkspace(workspace)));
 assert.deepEqual(restored,workspace);assert.deepEqual(buildEvents(restored.batch,restored.policy),events);
 assert.equal(restored.decisions[events[1].id],undefined);
});
test('停车稳定段标识严格校验；旧观察和同段重复观察维持原合并行为',()=>{
 const c=makeCandidates(fromSamples(observed.cases.stationary),config)[0];
 for(const id of [null,0,{},'', ' ', 'a'.repeat(101)])assert.throws(()=>validateBatch(batch([{...c,stable_segment_id:id}])),/稳定片段/);
 assert.throws(()=>validateBatch(batch([{...c,category:'blocked_access'}])),/稳定片段/);
 const rows=[c,{...c,id:'重复观察'}];
 assert.equal(buildEvents(batch(rows)).length,1);
 assert.equal(buildEvents(batch(rows))[0].observed_seconds,10);
 const legacy=rows.map(({stable_segment_id,...r})=>r);
 assert.equal(buildEvents(batch(legacy)).length,1);
 assert.equal(Object.hasOwn(buildEvents(batch(legacy))[0],'stable_segment_id'),false);
 assert.equal(buildEvents(batch([c,{...legacy[1],id:'无片段旧观察'}])).length,2);
});
test('稳定片段时长与采样间隙边界明确，短窗口冲突后仍可恢复',()=>{
 const samples=positions([.1,.1,.1]).map((s,i)=>({...s,time:i*1.6}));
 assert.equal(makeCandidates(fromSamples(samples),{...config,dwell_seconds:3.2}).length,1);
 assert.equal(makeCandidates(fromSamples(samples),{...config,dwell_seconds:3.201}).length,0);
 const gap=samples.map((s,i)=>({...s,time:s.time+(i===2?.0001:0)}));
 assert.equal(makeCandidates(fromSamples(gap),{...config,dwell_seconds:3.2}).length,0);
 const recovered=makeCandidates(fromSamples(positions([.1,.1,.3,.3,.3,.3,.3,.3])),config);
 assert.deepEqual(recovered.map(c=>[c.start,c.end]),[[at(2),at(7)]]);
});
