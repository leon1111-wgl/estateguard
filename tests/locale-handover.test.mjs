import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as engine from '../web/engine.mjs';

const row=(id,extra={})=>({id,camera:'客梯',zone:'门厅',track:'目标一',category:'bulky_load',start:'2026-10-24T08:00:00+08:00',end:'2026-10-24T08:00:10+08:00',score:.8,quality:.8,summary:'合成交班用例',evidence:['合成帧'],...extra});
const batch=(observations=[row('中-1'),row('a-1')])=>({schema_version:1,name:'跨语言交班合成用例',provenance:'synthetic',observations});
const entry=(event_id)=>({event_id,status:'needs_evidence',note:'核对搬运预约',at:'2026-10-24T00:02:00Z'});
function document(input=batch(),ids=['event:中-1']){
 const audit=ids.map(entry),decisions=Object.fromEntries(audit.map(({event_id,...value})=>[event_id,value]));
 return {format:'estateguard-workspace',version:1,batch:input,policy:{...engine.defaultPolicy},decisions,audit};
}

test('raw event IDs and member order are identical across locale and input order',()=>{
 const moduleURL=new URL('../web/engine.mjs',import.meta.url).href;
 const results=[];
 for(const lang of ['en_US.UTF-8','zh_CN.UTF-8'])for(const observations of [batch().observations,[...batch().observations].reverse()]){
  const code=`import {buildEvents} from ${JSON.stringify(moduleURL)};process.stdout.write(JSON.stringify(buildEvents(${JSON.stringify(batch(observations))})));`;
  results.push(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,LANG:lang,LC_ALL:lang},encoding:'utf8'})));
 }
 for(const events of results){assert.equal(events[0].id,'event:a-1');assert.deepEqual(events,results[0]);}
});

test('both legacy locale anchors preserve input and audit, support new saves and re-export',()=>{
 for(const id of ['event:中-1','event:a-1']){
  const original=document(batch(),[id]),snapshot=structuredClone(original);
  const ws=engine.importWorkspace(original);
  assert.equal(engine.buildWorkspaceEvents(ws)[0].id,id);
  assert.deepEqual(ws.batch,original.batch);assert.deepEqual(ws.audit,original.audit);assert.deepEqual(ws.decisions,original.decisions);
  const next=engine.applyDecision(ws,id,'open','交班后继续核查');
  assert.equal(next.audit[1].event_id,id);assert.deepEqual(next.audit[0],original.audit[0]);
  const restored=engine.importWorkspace(JSON.parse(engine.exportWorkspace(next)));
  assert.deepEqual(restored,next);assert.equal(engine.buildWorkspaceEvents(restored)[0].id,id);
  assert.deepEqual(original,snapshot);
 }
});

test('legacy eligibility compares equal instants with offsets, preserving punctuation and Unicode exactly',()=>{
 const ids=['a:1','中: e\u0301 ','中: é '];
 const input=batch(ids.map((id,i)=>row(id,i?{start:'2026-10-24T00:00:00Z',end:'2026-10-24T00:00:10Z'}:{})));
 for(const id of ids){
  const ws=engine.importWorkspace(document(input,[`event:${id}`]));
  assert.equal(engine.buildWorkspaceEvents(ws)[0].id,`event:${id}`);
  assert.deepEqual(ws.batch,input);
 }
});

test('two historical anchors for one event are rejected even with identical decisions',()=>{
 const input=document(batch(),['event:中-1','event:a-1']);
 assert.throws(()=>engine.importWorkspace(input),/同一事件.*多个编号/);
 assert.throws(()=>engine.exportWorkspace(input),/同一事件.*多个编号/);
});

test('later member and unknown IDs cannot claim an event',()=>{
 const input=batch([...batch().observations,row('later',{start:'2026-10-24T00:00:02Z',end:'2026-10-24T00:00:12Z'})]);
 for(const id of ['event:later','event:missing'])assert.throws(()=>engine.importWorkspace(document(input,[id])),/审查历史.*事件编号/);
});

test('different cameras, zones, tracks, categories, stable segments and time gaps retain separate anchors',()=>{
 const inputs=[{}, {camera:'货梯'}, {zone:'走廊'}, {track:'目标二'}, {category:'blocked_access'},
  {category:'illegal_parking',stable_segment_id:'段一'}, {category:'illegal_parking',stable_segment_id:'段二'},
  {start:'2026-10-24T00:05:00Z',end:'2026-10-24T00:05:10Z'}];
 const observations=inputs.flatMap((extra,i)=>[row(`中:${i}`,extra),row(`a:${i}`,extra)]);
 const ws=engine.importWorkspace(document(batch(observations),inputs.map((_,i)=>`event:中:${i}`)));
 const events=engine.buildWorkspaceEvents(ws);
 assert.equal(events.length,inputs.length);
 for(let i=0;i<inputs.length;i++)assert.deepEqual(events.find(e=>e.id===`event:中:${i}`).observation_ids,[`a:${i}`,`中:${i}`]);
});

test('decision/history mismatch and malformed histories are rejected without mutating input',()=>{
 const input=document();input.decisions={'event:a-1':input.decisions['event:中-1']};
 const snapshot=structuredClone(input);
 assert.throws(()=>engine.importWorkspace(input),/decisions do not match/);assert.deepEqual(input,snapshot);
 for(const audit of [null,{},[null],[{}],[{event_id:1}],Array(50001).fill(entry('event:中-1'))]){
  assert.throws(()=>engine.importWorkspace({...document(),audit}));
  assert.throws(()=>engine.buildWorkspaceEvents({...document(),audit}));
 }
});

test('clearing review for a rule reset returns to canonical IDs with no stale alias',()=>{
 const ws=engine.importWorkspace(document());
 const reset={...ws,policy:{...ws.policy,merge_gap_seconds:0},decisions:{},audit:[]};
 assert.equal(engine.buildWorkspaceEvents(reset)[0].id,'event:a-1');
 assert.throws(()=>engine.applyDecision(reset,'event:中-1','open','重新核查'),/Unknown event/);
 const next=engine.applyDecision(reset,'event:a-1','open','重新核查');
 assert.deepEqual(engine.importWorkspace(JSON.parse(engine.exportWorkspace(next))),next);
});
