import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../web/engine.mjs';
import {makeCandidates} from '../web/vision-rules.mjs';

// Synthetic rule inputs test the handoff contract, not model detection quality.
const config={rule:'access',roi:[0,0,1,1],camera:'测试相机',zone:'测试通道',started_at:'2026-10-29T08:00:00+08:00',is_video:true};
const candidates=(media_name,times=[0])=>makeCandidates([{id:'track-1',class:'bus',samples:times.map(time=>({time,bbox:[.1,.2,.3,.4],score:.9}))}],{...config,media_name});
const batch=observations=>({schema_version:1,name:'证据引用契约测试',provenance:'人工构造轨迹，仅验证规则、校验和工作区往返。',observations});
const withEvidence=evidence=>batch([{...candidates('short.mp4')[0],evidence}]);
const asciiName=length=>'a'.repeat(length-4)+'.mp4';

for(const length of [233,255]){
 test(`生成器的 ${length} 字节合法 ASCII 文件名及时间后缀能完整送审`,()=>{
  const name=asciiName(length),observations=candidates(name);
  assert.equal(Buffer.byteLength(name),length);
  assert.deepEqual(observations[0].evidence,[`${name} @ 0.00s`]);
  assert.ok(observations[0].evidence[0].length>240);
  const input=batch(observations),before=structuredClone(input);
  assert.deepEqual(engine.validateBatch(input),before);
  assert.deepEqual(engine.buildEvents(input)[0].evidence,observations[0].evidence);
  assert.deepEqual(input,before,'validation must not rewrite the caller evidence');
 });
}

test('较大片段起点保留实际时间和完整 Unicode 文件名，既不截断也不规范化',()=>{
 const prefix='访客入口_🚗_',name=prefix+'a'.repeat(255-Buffer.byteLength(prefix)-4)+'.mp4',times=[3600.25,3601.25];
 assert.equal(Buffer.byteLength(name),255);
 const observations=candidates(name,times),refs=times.map(time=>`${name} @ ${time.toFixed(2)}s`);
 assert.deepEqual(observations[0].evidence,refs);
 assert.equal(observations[0].start,new Date(Date.parse(config.started_at)+times[0]*1000).toISOString());
 assert.equal(observations[0].end,new Date(Date.parse(config.started_at)+times[1]*1000).toISOString());
 assert.deepEqual(engine.validateBatch(batch(observations)).observations[0].evidence,refs);
});

test('证据标签独立上限为 512 UTF-16 单元，精确边界允许且不按 UTF-8 字节截断',()=>{
 const suffix=' @ 12345.67s',reference='📷'.repeat(250).slice(0,512-suffix.length)+suffix;
 assert.equal(reference.length,512);
 assert.ok(Buffer.byteLength(reference)>512);
 // Test accepted behavior before checking the exported declaration, so the old
 // version fails on the real validator rather than a missing named import.
 assert.deepEqual(engine.validateBatch(withEvidence([reference])).observations[0].evidence,[reference]);
 assert.equal(engine.MAX_EVIDENCE_LABEL_LENGTH,512);
 assert.throws(()=>engine.validateBatch(withEvidence([reference+'x'])));
});

test('长引用通过人工复核、工作区导出恢复后逐字保留且事件身份与历史不变',()=>{
 const name=asciiName(255),observations=candidates(name,[12.5,13.5]),input={...batch(observations),analysis_id:'evidence-long-name-test'};
 let workspace=engine.importWorkspace(input);
 const events=engine.buildWorkspaceEvents(workspace),id=events[0].id;
 workspace=engine.applyDecision(workspace,id,'needs_evidence','请核对完整原片名和 12.50 秒处的画面。');
 const before=structuredClone(workspace),exported=engine.exportWorkspace(workspace),restored=engine.importWorkspace(JSON.parse(exported));
 assert.deepEqual(workspace,before);
 assert.deepEqual(restored,workspace);
 assert.deepEqual(engine.buildWorkspaceEvents(restored),events);
 assert.equal(restored.batch.analysis_id,input.analysis_id);
 assert.deepEqual(restored.batch.observations[0].evidence,[`${name} @ 12.50s`,`${name} @ 13.50s`]);
 assert.deepEqual(restored.audit,workspace.audit);
 assert.deepEqual(restored.decisions,workspace.decisions);
});

test('旧短引用与版本 1 工作区仍可原样恢复，不补造身份或更改引用',()=>{
 const references=['frame-a','本地素材.mp4 @ 2.00s','e\u0301vidence.jpg @ 0.00s'],input=withEvidence(references);
 let workspace=engine.importWorkspace(input);
 const id=engine.buildWorkspaceEvents(workspace)[0].id;
 workspace=engine.applyDecision(workspace,id,'dismissed','原始画面确认，不需处置。');
 const document=JSON.parse(engine.exportWorkspace(workspace));
 assert.equal(document.version,1);
 const restored=engine.importWorkspace(document);
 assert.deepEqual(restored,workspace);
 assert.deepEqual(restored.batch.observations[0].evidence,references);
 assert.equal(Object.hasOwn(restored.batch,'analysis_id'),false);
});

test('大于 512、空白和非字符串引用仍被拒绝，失败不改变输入',()=>{
 for(const reference of ['x'.repeat(513),'',' \t\n ',null,0,false,{},[]]){
  const input=withEvidence([reference]),before=structuredClone(input);
  assert.throws(()=>engine.validateBatch(input));
  assert.deepEqual(input,before);
 }
});

test('20 条证据引用可用，第 21 条仍被拒绝',()=>{
 const refs=Array.from({length:20},(_,i)=>`short.mp4 @ ${i}.00s`);
 assert.deepEqual(engine.validateBatch(withEvidence(refs)).observations[0].evidence,refs);
 assert.throws(()=>engine.validateBatch(withEvidence([...refs,'short.mp4 @ 20.00s'])),/20/);
});

test('其他字段限制独立保留：批次名 240、来源 1000、标识 100、摘要 2000',()=>{
 const input=withEvidence(['short.mp4 @ 0.00s']);
 for(const [field,limit] of [['name',240],['provenance',1000],['analysis_id',100]]){
  assert.doesNotThrow(()=>engine.validateBatch({...input,[field]:'x'.repeat(limit)}));
  assert.throws(()=>engine.validateBatch({...input,[field]:'x'.repeat(limit+1)}),new RegExp(field));
 }
 for(const [field,limit] of [['id',100],['camera',100],['zone',100],['track',100],['summary',2000]]){
  const changed=value=>({...input,observations:[{...input.observations[0],[field]:value}]});
  assert.doesNotThrow(()=>engine.validateBatch(changed('x'.repeat(limit))));
  assert.throws(()=>engine.validateBatch(changed('x'.repeat(limit+1))),new RegExp(field));
 }
});

test('引用扩容不扩大批次 5 MiB 和工作区 32 MiB 总字节上限',()=>{
 assert.equal(engine.MAX_BATCH_BYTES,5*1024*1024);
 assert.equal(engine.MAX_WORKSPACE_BYTES,32*1024*1024);
 const row=withEvidence(Array.from({length:20},()=> 'x'.repeat(512))).observations[0];
 const oversized=batch(Array.from({length:512},(_,i)=>({...row,id:`ref-${i}`})));
 assert.ok(Buffer.byteLength(JSON.stringify(oversized))>engine.MAX_BATCH_BYTES);
 assert.throws(()=>engine.validateBatch(oversized),/batch.*5 MiB/i);
 const workspace=engine.importWorkspace(withEvidence(['short']));
 const document={format:'estateguard-workspace',version:1,...workspace,extra:'x'.repeat(engine.MAX_WORKSPACE_BYTES)};
 assert.throws(()=>engine.importWorkspace(document),/workspace.*32 MiB/i);
});
