/** Read-only error analysis of a frozen model; never an input to live prediction. */
const types=new Set(['all','false_free','false_occupied','low_score_false_free']);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function buildParkingAudit(manifest,predictions){
 if(!digest(manifest?.model_sha256)||!Array.isArray(manifest.samples)||!Array.isArray(predictions)||predictions.length!==manifest.samples.length)throw new Error('错例记录数量或模型标识不完整，请重试。');
 const samples=new Map(),groups=new Map(),seen=new Set(),errors=[];
 const summary={total:predictions.length,errors:0,false_free:0,false_occupied:0,low_score_false_free:0,band_samples:0,band_errors:0,outside_band_errors:0};
 for(const r of manifest.samples){
  if(!r||typeof r.id!=='string'||!r.id||samples.has(r.id)||![0,1].includes(r.label)||typeof r.camera!=='string'||!r.camera||typeof r.slot!=='string'||!r.slot)throw new Error('样本索引含重复或无效记录，请重试。');
  samples.set(r.id,r);
 }
 for(const p of predictions){
  const r=samples.get(p?.id),score=p?.score;
  if(!r||seen.has(p.id)||p.model_sha256!==manifest.model_sha256||p.label!==r.label||typeof score!=='number'||!Number.isFinite(score)||score<0||score>1||p.prediction!==Number(score>=.5)||p.correct!==(p.prediction===r.label))throw new Error('错例记录与当前样本、标签或模型版本不一致，请重试。');
  seen.add(p.id);
  const key=JSON.stringify([r.camera,r.slot]);
  if(!groups.has(key))groups.set(key,{key,camera:r.camera,slot:r.slot,total:0,occupied:0,false_free:0,false_occupied:0,low_score_false_free:0});
  const g=groups.get(key);g.total++;g.occupied+=r.label;
  const band=score>.35&&score<.65;summary.band_samples+=Number(band);
  if(p.correct)continue;
  const kind=r.label===1?'false_free':'false_occupied',low=kind==='false_free'&&score<=.35;
  summary.errors++;summary[kind]++;g[kind]++;
  summary.low_score_false_free+=Number(low);g.low_score_false_free+=Number(low);
  summary.band_errors+=Number(band);summary.outside_band_errors+=Number(!band);
  errors.push({id:r.id,camera:r.camera,date:r.date,time:r.time,slot:r.slot,label:r.label,prediction:p.prediction,score,error_type:kind,low_score_false_free:low,in_review_band:band,image:r.image,source_sha256:r.source_sha256});
 }
 const grouped=[...groups.values()].map(g=>({...g,false_free_rate:g.occupied?g.false_free/g.occupied:null}));
 grouped.sort((a,b)=>b.false_free-a.false_free||a.camera.localeCompare(b.camera)||a.slot.localeCompare(b.slot,undefined,{numeric:true}));
 return {model_sha256:manifest.model_sha256,dataset:structuredClone(manifest.dataset),summary,groups:grouped,errors};
}
export function filterParkingAudit(audit,{type='all',slot='all'}={}){
 if(!types.has(type)||slot!=='all'&&!audit.groups.some(g=>g.key===slot))throw new Error('错例筛选条件无效，请重新选择。');
 return audit.errors.filter(r=>{
  const matchesType=type==='all'||(type==='low_score_false_free'?r.low_score_false_free:r.error_type===type);
  return matchesType&&(slot==='all'||JSON.stringify([r.camera,r.slot])===slot);
 });
}
export function exportParkingAudit(audit,filters,predictionsHash){
 if(!digest(predictionsHash))throw new Error('缺少原始预测文件校验值，无法导出可复查结果。');
 const samples=filterParkingAudit(audit,filters);
 return structuredClone({format:'estateguard-parking-error-audit',version:1,prediction_source:'published-fixed-model-evaluation',model_sha256:audit.model_sha256,predictions_sha256:predictionsHash,dataset:audit.dataset,filters:{type:filters.type||'all',slot:filters.slot||'all'},summary:audit.summary,groups:audit.groups,matched_count:samples.length,samples,scope:'固定模型公开评测的事后错例分析，非本次浏览器推理或人工结论。未调整模型与阈值；看过的测试结果不能作为后续调参后的盲测。'});
}
