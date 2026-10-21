import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBatch, buildEvents, defaultPolicy, evaluate, applyDecision, exportWorkspace, importWorkspace} from '../web/engine.mjs';
const row=(extra={})=>({id:'a',camera:'lift-a',zone:'lift',track:'t1',category:'bulky_load',start:'2026-10-15T08:00:00+08:00',end:'2026-10-15T08:00:10+08:00',score:.9,quality:.9,summary:'Object in lift',evidence:['frame-a'],...extra});
const batch=(rows)=>({schema_version:1,name:'test',provenance:'synthetic',observations:rows});
test('analysis identity survives review export and legacy batches stay compatible',()=>{
 const input={...batch([row()]),analysis_id:'c2261a1f-3ef3-42aa-b5fb-79e690f7be72'};
 let ws=importWorkspace(input);
 ws=applyDecision(ws,buildEvents(input)[0].id,'needs_evidence','核对原始素材');
 const restored=importWorkspace(JSON.parse(exportWorkspace(ws)));
 assert.equal(restored.batch.analysis_id,input.analysis_id);
 assert.deepEqual(restored.audit,ws.audit);
 assert.equal(importWorkspace(batch([row()])).batch.analysis_id,undefined);
});
test('malformed optional analysis identities are rejected before importing a batch',()=>{
 for(const analysis_id of ['', '  ', null, 7, {}, 'x'.repeat(101)])
  assert.throws(()=>importWorkspace({...batch([row()]),analysis_id}),/analysis_id/);
});
test('repeated observations merge but different tracks and cameras stay distinct',()=>{
 const events=buildEvents(batch([row(),row({id:'b',start:'2026-10-15T08:00:12+08:00',end:'2026-10-15T08:00:20+08:00'}),row({id:'c',track:'t2'}),row({id:'d',camera:'lift-b'})]),defaultPolicy);
 assert.equal(events.length,3); assert.deepEqual(events.find(e=>e.observation_ids.includes('a')).observation_ids,['a','b']);
});
test('longer gaps start separate incidents',()=>assert.equal(buildEvents(batch([row(),row({id:'b',start:'2026-10-15T08:02:00+08:00',end:'2026-10-15T08:02:10+08:00'})]),defaultPolicy).length,2));
test('a moving permit does not excuse a blocked door',()=>{
 const e=buildEvents(batch([row({move_permit:true}),row({id:'b',category:'door_obstruction',move_permit:true})]),defaultPolicy);
 assert.equal(e.find(x=>x.category==='bulky_load').routing,'contextual_exception');
 assert.equal(e.find(x=>x.category==='door_obstruction').routing,'urgent_review');
});
test('uncertain urgent events retain urgency',()=>{
 const e=buildEvents(batch([row({category:'blocked_access',score:.1,quality:.1,evidence:[]})]),defaultPolicy)[0];
 assert.equal(e.routing,'insufficient_evidence'); assert.equal(e.urgent,true);
});
test('a high score without evidence does not mean confirmed',()=>assert.equal(buildEvents(batch([row({evidence:[]})]),defaultPolicy)[0].routing,'insufficient_evidence'));
test('a merge with an unapproved observation is not excused by one approved observation',()=>{
 const e=buildEvents(batch([row({move_permit:true}),row({id:'b'})]),defaultPolicy)[0];
 assert.equal(e.routing,'review');
});
test('parking dwell uses covered time, not a gap between frames',()=>{
 const events=buildEvents(batch([row({category:'illegal_parking'}),row({id:'b',category:'illegal_parking',start:'2026-10-15T08:00:35+08:00',end:'2026-10-15T08:00:45+08:00'})]),{...defaultPolicy,merge_gap_seconds:30,parking_grace_seconds:30});
 assert.equal(events[0].observed_seconds,20); assert.equal(events[0].routing,'short_observation');
});
test('overlapping observations do not double-count parking duration',()=>{
 const e=buildEvents(batch([row({category:'illegal_parking'}),row({id:'b',category:'illegal_parking'})]),{...defaultPolicy,parking_grace_seconds:15})[0];
 assert.equal(e.observed_seconds,10); assert.equal(e.routing,'short_observation');
});
for(const [name,extra] of [['timezone',{start:'2026-10-15T08:00:00'}],['reversed interval',{end:'2026-10-15T07:00:00+08:00'}],['unknown category',{category:'crime'}],['NaN score',{score:NaN}],['empty track',{track:''}],['boolean score',{score:true}],['string permit',{move_permit:'false'}]]){
 test('rejects '+name,()=>assert.throws(()=>validateBatch(batch([row(extra)]))));
}
test('duplicate observation IDs fail atomically',()=>assert.throws(()=>validateBatch(batch([row(),row()]))));
test('invalid policy values fail',()=>assert.throws(()=>buildEvents(batch([row()]),{...defaultPolicy,merge_gap_seconds:-1})));
test('one reference event can match only one prediction',()=>{
 const pred=buildEvents(batch([row()]),defaultPolicy);
 const ref=[{...pred[0],id:'ref'}];
 const r=evaluate([...pred,{...pred[0],id:'duplicate'}],ref);
 assert.equal(r.true_positive,1); assert.equal(r.false_positive,1); assert.equal(r.precision,.5);
});
test('wrong camera cannot match a reference',()=>{
 const pred=buildEvents(batch([row()]),defaultPolicy);
 const r=evaluate(pred,[{...pred[0],id:'ref',camera:'other'}]);
 assert.equal(r.missed,1); assert.equal(r.true_positive,0);
});
test('a decision requires a reason and reopening keeps history',()=>{
 let ws={batch:batch([row()]),policy:defaultPolicy,decisions:{},audit:[]};
 const id=buildEvents(ws.batch,ws.policy)[0].id;
 assert.throws(()=>applyDecision(ws,id,'dismissed',''));
 ws=applyDecision(ws,id,'dismissed','Scheduled move verified');
 ws=applyDecision(ws,id,'open','Recheck booking');
 assert.equal(ws.audit.length,2); assert.equal(ws.decisions[id].status,'open');
});
test('workspace roundtrip reproduces input and policy',()=>{
 const ws={batch:batch([row()]),policy:defaultPolicy,decisions:{},audit:[]};
 const r=importWorkspace(JSON.parse(exportWorkspace(ws)));
 assert.deepEqual(r.batch,ws.batch); assert.deepEqual(buildEvents(r.batch,r.policy),buildEvents(ws.batch,ws.policy));
});
test('tampered unknown decision IDs are rejected',()=>{
 const ws={batch:batch([row()]),policy:defaultPolicy,decisions:{alien:{status:'resolved',note:'ok'}},audit:[]};
 assert.throws(()=>importWorkspace(JSON.parse(exportWorkspace(ws))));
});

for(const [name,start,end] of [
 ['February 30','2026-02-30T08:00:00+08:00','2026-03-02T08:00:10+08:00'],
 ['February 29 in a non-leap year','2026-02-29T08:00:00Z','2026-03-01T08:00:10Z'],
 ['February 29 in a non-leap century','2100-02-29T08:00:00Z','2100-03-01T08:00:10Z'],
 ['April 31','2026-04-31T08:00:00Z','2026-05-01T08:00:10Z'],
 ['24-hour midnight notation','2026-10-15T24:00:00Z','2026-10-16T00:00:10Z']
]){
 test(`rejects ${name} instead of silently shifting the incident date`,()=>{
  assert.throws(()=>validateBatch(batch([row({start,end})])),/start.*valid.*timestamp/i);
 });
}
test('rejects an impossible end date independently of a valid start',()=>{
 assert.throws(()=>validateBatch(batch([row({start:'2024-02-29T23:59:50Z',end:'2024-02-30T00:00:00Z'})])),/end.*valid.*timestamp/i);
});
for(const year of ['2000','2024']){
 test(`accepts February 29 in leap year ${year} with an explicit offset`,()=>{
  const event=buildEvents(batch([row({start:`${year}-02-29T23:59:50.125+08:00`,end:`${year}-03-01T00:00:00.125+08:00`})]))[0];
  assert.equal(event.start,`${year}-02-29T15:59:50.125Z`);
  assert.equal(event.end,`${year}-02-29T16:00:00.125Z`);
  assert.equal(event.observed_seconds,10);
 });
}
test('null workspace input produces a useful validation error',()=>{
 assert.throws(()=>importWorkspace(null),/Expected a JSON object/i);
});

// Use actual supported records to reach the boundary, without oversized metadata.
function batchAtBytes(bytes){
 const input=batch(Array.from({length:6000},(_,i)=>row({id:`obs-${i}`,track:`track-${i}`})));
 let remaining=bytes-Buffer.byteLength(JSON.stringify(input));
 for(const observation of input.observations){
  const extra=Math.min(2000-observation.summary.length,remaining);
  observation.summary+='x'.repeat(extra);remaining-=extra;
  if(!remaining)break;
 }
 assert.equal(remaining,0,'test batch must fit within supported summary lengths');
 assert.equal(Buffer.byteLength(JSON.stringify(input)),bytes);
 return input;
}
const workspaceOf=input=>({batch:input,policy:{...defaultPolicy},decisions:{},audit:[]});
const envelope=ws=>({format:'estateguard-workspace',version:1,...ws});
test('a maximum-size batch plus review history exports a resumable workspace without duplicate events',()=>{
 const ws=importWorkspace(batchAtBytes(5*1024*1024));
 const note='Checked booking and evidence. '.repeat(60),at='2026-10-15T08:00:00Z';
 ws.audit=Array.from({length:10000},()=>({event_id:'event:obs-0',status:'needs_evidence',note,at}));
 ws.decisions['event:obs-0']={status:'needs_evidence',note,at};
 const exported=exportWorkspace(ws),data=JSON.parse(exported);
 assert.equal(Object.hasOwn(data,'events'),false,'derived events must be rebuilt, not duplicated in the handover');
 assert.equal(exported,JSON.stringify(data),'workspace serialization must not add indentation overhead');
 assert.ok(Buffer.byteLength(exported)>5*1024*1024);
 assert.ok(Buffer.byteLength(exported)<=32*1024*1024);
 const restored=importWorkspace(data);
 assert.equal(restored.batch.observations.length,6000);
 assert.equal(restored.audit.length,10000);
 assert.deepEqual(restored.decisions['event:obs-0'],{status:'needs_evidence',note,at});
 assert.deepEqual(restored.batch,ws.batch);
});
test('raw batches above 5 MiB are rejected even when their records are individually valid',()=>{
 assert.throws(()=>importWorkspace(batchAtBytes(5*1024*1024+1)),/batch.*5 MiB/i);
});
test('workspace imports above 32 MiB are rejected instead of accepting unrecoverable history',()=>{
 const ws=workspaceOf(batch([row()])),note='x'.repeat(2000),at='2026-10-15T08:00:00Z';
 ws.audit=Array.from({length:18000},()=>({event_id:'event:a',status:'needs_evidence',note,at}));
 ws.decisions['event:a']={status:'needs_evidence',note,at};
 assert.throws(()=>importWorkspace(envelope(ws)),/workspace.*32 MiB/i);
});
test('oversized workspace export fails clearly without changing the caller workspace',()=>{
 const ws=workspaceOf(batch([row()])),note='x'.repeat(2000),at='2026-10-15T08:00:00Z';
 ws.audit=Array.from({length:18000},()=>({event_id:'event:a',status:'needs_evidence',note,at}));
 ws.decisions['event:a']={status:'needs_evidence',note,at};
 assert.throws(()=>exportWorkspace(ws),/workspace.*32 MiB/i);
 assert.equal(ws.audit.length,18000);
 assert.equal(ws.decisions['event:a'].note,note);
});
test('export rejects a decision that cannot be reconstructed from its audit history',()=>{
 const ws=workspaceOf(batch([row()]));
 ws.decisions['event:a']={status:'resolved',note:'No audit entry',at:'2026-10-15T08:00:00Z'};
 assert.throws(()=>exportWorkspace(ws),/history/i);
});
test('saving beyond the audit entry limit is rejected without changing the current review',()=>{
 const ws=workspaceOf(batch([row()])),at='2026-10-15T08:00:00Z';
 ws.audit=Array.from({length:50000},()=>({event_id:'event:a',status:'open',note:'Review retained',at}));
 ws.decisions['event:a']={status:'open',note:'Review retained',at};
 assert.throws(()=>applyDecision(ws,'event:a','resolved','Site visit complete'),/audit.*50,000/i);
 assert.equal(ws.audit.length,50000);
 assert.equal(ws.decisions['event:a'].status,'open');
});
test('a new review cannot push a resumable workspace beyond its byte limit',()=>{
 const ws=workspaceOf(batch([row()])),at='2026-10-15T08:00:00.000Z';
 ws.audit=Array.from({length:17000},()=>({event_id:'event:a',status:'open',note:'Pending',at}));
 ws.decisions['event:a']={status:'open',note:'Pending',at};
 let remaining=32*1024*1024-256-Buffer.byteLength(JSON.stringify({...envelope(ws),exported_at:at}));
 // Keep the final note unchanged so the decisions/audit pair still agrees.
 for(const entry of ws.audit.slice(0,-1)){
  const extra=Math.min(2000-entry.note.length,remaining);
  entry.note+='x'.repeat(extra);remaining-=extra;
  if(!remaining)break;
 }
 assert.equal(remaining,0);
 const current=importWorkspace(envelope(ws));
 assert.throws(()=>applyDecision(current,'event:a','resolved','x'.repeat(2000)),/workspace.*32 MiB/i);
 assert.equal(current.audit.length,17000);
 assert.equal(current.decisions['event:a'].status,'open');
});
