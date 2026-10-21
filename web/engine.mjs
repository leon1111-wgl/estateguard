/** Shared incident engine. Input observations are hypotheses, never legal findings. */
export const categories = {
 bulky_load:{label:'Bulky load in passenger lift',area:'Lift',urgent:false,action:'Check the move booking, lift designation and protective arrangements.'},
 door_obstruction:{label:'Lift door obstruction',area:'Lift',urgent:true,action:'Review the door sequence and ask the duty team to check the obstruction.'},
 lift_impact:{label:'Possible lift impact',area:'Lift',urgent:true,action:'Inspect before/after evidence. A contact cue alone does not establish damage or intent.'},
 illegal_parking:{label:'Parking outside permitted space',area:'Parking',urgent:false,action:'Check bay markings, loading permissions and observed dwell time.'},
 blocked_access:{label:'Access route obstruction',area:'Shared space',urgent:true,action:'Check the designated route and arrange a prompt on-site assessment.'},
 wrong_way:{label:'Possible wrong-way movement',area:'Parking',urgent:true,action:'Check the trajectory against the site traffic plan; a still frame is not enough.'},
 waste_dumping:{label:'Waste outside collection area',area:'Refuse',urgent:false,action:'Check the collection schedule and location before requesting a cleanup.'},
 waste_overflow:{label:'Refuse container overflow',area:'Refuse',urgent:false,action:'Verify container capacity and assign a collection follow-up.'}
};
export const defaultPolicy=Object.freeze({score_threshold:.6,quality_threshold:.5,merge_gap_seconds:30,parking_grace_seconds:30});
export const statuses=['open','confirmed_concern','dismissed','needs_evidence','resolved'];
export const MAX_BATCH_BYTES=5*1024*1024;
export const MAX_WORKSPACE_BYTES=32*1024*1024;
export const MAX_AUDIT_ENTRIES=50000;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const utf8=new TextEncoder();
function requireValue(ok,message){if(!ok)throw new Error(message);}
function textValue(x,key,max=240){requireValue(typeof x==='string'&&x.trim().length>0&&x.length<=max,`${key}: enter 1–${max} characters.`);}
function numberValue(x,key,min,max){requireValue(typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max,`${key}: expected a finite number from ${min} to ${max}.`);}
function timeValue(x,key){
 const parts=typeof x==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(x);
 const message=`${key}: use a valid calendar date and ISO timestamp (hours 00–23) with Z or an explicit timezone offset.`;
 requireValue(parts,message);
 const [year,month,day,hour,minute,second]=parts.slice(1).map(Number);
 const leap=year%4===0&&(year%100!==0||year%400===0);
 const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 requireValue(month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour<=23&&minute<=59&&second<=59&&Number.isFinite(Date.parse(x)),message);
}
function jsonWithinLimit(data,limit,label){
 const json=JSON.stringify(data);
 requireValue(typeof json==='string'&&utf8.encode(json).byteLength<=limit,`${label} exceeds ${limit/(1024*1024)} MiB. Export the current review and start a smaller shift before adding more data.`);
 return json;
}
function workspaceDocument(ws){return {format:'estateguard-workspace',version:1,batch:ws.batch,policy:ws.policy,decisions:ws.decisions,audit:ws.audit,exported_at:new Date().toISOString()};}
function serializeWorkspace(ws){return jsonWithinLimit(workspaceDocument(ws),MAX_WORKSPACE_BYTES,'Workspace');}
export function validatePolicy(policy){
 requireValue(object(policy),'Policy must be an object.');
 for(const key of ['score_threshold','quality_threshold'])numberValue(policy[key],key,0,1);
 numberValue(policy.merge_gap_seconds,'merge_gap_seconds',0,3600);
 numberValue(policy.parking_grace_seconds,'parking_grace_seconds',0,3600);
 return {...policy};
}
export function validateBatch(batch){
 requireValue(object(batch)&&batch.schema_version===1,'Expected a batch with schema_version: 1.');
 jsonWithinLimit(batch,MAX_BATCH_BYTES,'Observation batch');
 textValue(batch.name,'name'); textValue(batch.provenance,'provenance',1000);
 if(batch.analysis_id!==undefined)textValue(batch.analysis_id,'analysis_id',100);
 requireValue(Array.isArray(batch.observations)&&batch.observations.length>0&&batch.observations.length<=10000,'observations must contain 1–10,000 records.');
 const ids=new Set();
 batch.observations.forEach((r,i)=>{
  requireValue(object(r),`Record ${i+1} must be an object.`);
  for(const key of ['id','camera','zone','track'])textValue(r[key],`Record ${i+1} ${key}`,100);
  requireValue(!ids.has(r.id),`Duplicate observation id: ${r.id}`); ids.add(r.id);
  requireValue(Object.hasOwn(categories,r.category),`Record ${r.id}: unknown category.`);
  if(r.stable_segment_id!==undefined)requireValue(r.category==='illegal_parking'&&typeof r.stable_segment_id==='string'&&r.stable_segment_id.trim().length>0&&r.stable_segment_id.length<=100,'稳定片段标识仅用于停车观察，必须为 1–100 字的非空字符串。');
  timeValue(r.start,`${r.id} start`); timeValue(r.end,`${r.id} end`);
  requireValue(Date.parse(r.end)>Date.parse(r.start),`${r.id}: end must be later than start.`);
  requireValue(Date.parse(r.end)-Date.parse(r.start)<=86400000,`${r.id}: intervals longer than 24 hours must be split.`);
  numberValue(r.score,`${r.id} score`,0,1); numberValue(r.quality,`${r.id} quality`,0,1);
  textValue(r.summary,`${r.id} summary`,2000);
  requireValue(Array.isArray(r.evidence)&&r.evidence.length<=20,`${r.id}: evidence must be an array of at most 20 local reference labels.`);
  r.evidence.forEach(e=>textValue(e,`${r.id} evidence`,240));
  requireValue(r.move_permit===undefined||typeof r.move_permit==='boolean',`${r.id}: move_permit must be boolean.`);
 });
 return structuredClone(batch);
}
function coveredSeconds(rows){
 const spans=rows.map(r=>[Date.parse(r.start),Date.parse(r.end)]).sort((a,b)=>a[0]-b[0]);
 let total=0,[start,end]=spans[0];
 for(const [s,e] of spans.slice(1)){if(s<=end)end=Math.max(end,e);else{total+=end-start;start=s;end=e;}}
 return (total+end-start)/1000;
}
function finishEvent(rows,policy){
 const first=rows[0], score=Math.max(...rows.map(r=>r.score)),quality=Math.min(...rows.map(r=>r.quality));
 const urgent=categories[first.category].urgent, evidence=[...new Set(rows.flatMap(r=>r.evidence))];
 const observed_seconds=coveredSeconds(rows), allEvidence=rows.every(r=>r.evidence.length>0);
 let routing='review',reason='Candidate concern. Confirm site context and evidence before acting.';
 if(quality<policy.quality_threshold||!allEvidence){routing='insufficient_evidence';reason='Low quality or missing reference evidence. Manual verification is needed.';}
 else if(first.category==='bulky_load'&&rows.every(r=>r.move_permit===true)){routing='contextual_exception';reason='All observations have a declared move permit. Verify its validity; other risk categories remain separate.';}
 else if(score<policy.score_threshold){routing=urgent?'insufficient_evidence':'below_threshold';reason=urgent?'Low-score urgent-category cue retained for manual triage.':'Below this site’s review threshold; retained for audit.';}
 else if(first.category==='illegal_parking'&&observed_seconds<policy.parking_grace_seconds){routing='short_observation';reason='Observed coverage is shorter than the site’s parking grace period; gaps are excluded.';}
 else if(urgent){routing='urgent_review';reason='Prioritised for a human check; this is not a confirmed violation.';}
 return {id:`event:${first.id}`,camera:first.camera,zone:first.zone,track:first.track,...(first.stable_segment_id!==undefined?{stable_segment_id:first.stable_segment_id}:{}),category:first.category,start:new Date(Math.min(...rows.map(r=>Date.parse(r.start)))).toISOString(),end:new Date(Math.max(...rows.map(r=>Date.parse(r.end)))).toISOString(),score,quality,urgent,routing,reason,observed_seconds,evidence,observation_ids:rows.map(r=>r.id),summaries:[...new Set(rows.map(r=>r.summary))]};
}
export function buildEvents(input,policy=defaultPolicy){
 const batch=validateBatch(input); validatePolicy(policy);
 const groups=new Map();
 for(const r of batch.observations){const key=JSON.stringify([r.camera,r.zone,r.track,r.category,r.stable_segment_id??null]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
 const events=[];
 for(const rows of groups.values()){
  rows.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.id.localeCompare(b.id));
  let pending=[],end=-Infinity;
  for(const row of rows){
   if(pending.length&&Date.parse(row.start)>end+policy.merge_gap_seconds*1000){events.push(finishEvent(pending,policy));pending=[];end=-Infinity;}
   pending.push(row);end=Math.max(end,Date.parse(row.end));
  }
  if(pending.length)events.push(finishEvent(pending,policy));
 }
 return events.sort((a,b)=>Number(b.urgent)-Number(a.urgent)||Date.parse(a.start)-Date.parse(b.start)||a.id.localeCompare(b.id));
}
export const inReviewQueue=e=>['review','urgent_review','insufficient_evidence'].includes(e.routing);
function overlap(a,b){const x=Math.max(0,Math.min(Date.parse(a.end),Date.parse(b.end))-Math.max(Date.parse(a.start),Date.parse(b.start)));const u=Math.max(Date.parse(a.end),Date.parse(b.end))-Math.min(Date.parse(a.start),Date.parse(b.start));return u?x/u:0;}
export function evaluate(predicted,reference,threshold=.1){
 numberValue(threshold,'temporal IoU threshold',.001,1);
 const candidates=[];
 predicted.forEach((p,i)=>reference.forEach((r,j)=>{if(['camera','zone','track','category'].every(k=>p[k]===r[k])){const iou=overlap(p,r);if(iou>=threshold)candidates.push({i,j,iou});}}));
 candidates.sort((a,b)=>b.iou-a.iou||a.i-b.i||a.j-b.j);
 const usedP=new Set(),usedR=new Set(),matches=[];
 for(const pair of candidates)if(!usedP.has(pair.i)&&!usedR.has(pair.j)){usedP.add(pair.i);usedR.add(pair.j);matches.push({prediction:predicted[pair.i].id,reference:reference[pair.j].id,iou:pair.iou});}
 const tp=usedP.size;
 return {predictions:predicted.length,references:reference.length,true_positive:tp,false_positive:predicted.length-tp,missed:reference.length-tp,precision:predicted.length?tp/predicted.length:null,recall:reference.length?tp/reference.length:null,matches,missed_ids:reference.filter((_,j)=>!usedR.has(j)).map(r=>r.id)};
}
export function applyDecision(workspace,id,status,note){
 requireValue(statuses.includes(status),'Unknown decision.'); textValue(note,'Review note',2000);
 requireValue(Array.isArray(workspace.audit)&&workspace.audit.length<MAX_AUDIT_ENTRIES,'Audit history is limited to 50,000 entries. Export this review and start a new one before saving more decisions.');
 requireValue(buildEvents(workspace.batch,workspace.policy).some(e=>e.id===id),'Unknown event. Reload the queue.');
 const next=structuredClone(workspace),entry={event_id:id,status,note:note.trim(),at:new Date().toISOString()};
 next.decisions[id]={status:entry.status,note:entry.note,at:entry.at};next.audit.push(entry);
 // Reject growth before returning a new state; the previous review remains exportable.
 serializeWorkspace(next);return next;
}
export function exportWorkspace(ws){
 requireValue(object(ws),'Expected a workspace object to export.');
 // Apply the same validation as import, so every successful export can be resumed.
 const checked=importWorkspace(workspaceDocument(ws));
 return serializeWorkspace(checked);
}
export function importWorkspace(data){
 requireValue(object(data),'Expected a JSON object containing an observation batch or an EstateGuard workspace.');
 if(data.format!=='estateguard-workspace')return {batch:validateBatch(data),policy:{...defaultPolicy},decisions:{},audit:[]};
 requireValue(data.version===1,'Unsupported workspace version.');
 jsonWithinLimit(data,MAX_WORKSPACE_BYTES,'Workspace');
 const batch=validateBatch(data.batch),policy=validatePolicy(data.policy),valid=new Set(buildEvents(batch,policy).map(e=>e.id));
 requireValue(object(data.decisions)&&Array.isArray(data.audit)&&data.audit.length<=MAX_AUDIT_ENTRIES,'Invalid review history. Audit history is limited to 50,000 entries.');
 const rebuilt={};
 for(const entry of data.audit){requireValue(object(entry)&&valid.has(entry.event_id)&&statuses.includes(entry.status),'Invalid audit event.');textValue(entry.note,'Audit note',2000);timeValue(entry.at,'Audit time');rebuilt[entry.event_id]={status:entry.status,note:entry.note,at:entry.at};}
 requireValue(Object.keys(data.decisions).length===Object.keys(rebuilt).length,'Review decisions do not match audit history.');
 for(const [id,d] of Object.entries(data.decisions))requireValue(valid.has(id)&&object(d)&&['status','note','at'].every(k=>d[k]===rebuilt[id]?.[k]),'Review decisions do not match audit history.');
 const checked={batch,policy,decisions:rebuilt,audit:structuredClone(data.audit)};
 // Include export-envelope overhead even for imports that omit exported_at.
 serializeWorkspace(checked);return checked;
}
