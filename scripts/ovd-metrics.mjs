/** LVIS federated matching and the selection / shipping rules of docs/validation/open-vocab-protocol.md (pure). */
export const GRID=Object.freeze([.05,.1,.15,.2,.25,.3,.35,.4,.45,.5,.55,.6]);
export const RULES=Object.freeze({iou:.5,min_detections:10,min_class_precision:.5,min_classes:3,min_pooled_precision:.7});
export function iou(a,b){const w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1])),i=w*h;return i/(a[2]*a[3]+b[2]*b[3]-i||1);}
/** One image, one class: greedy one-to-one by score. Unmatched detections are FP only where the class is verified
 * exhaustively (positive and not in not_exhaustive) or verified absent (neg); otherwise they are ignored. */
export function matchImage(record,detections,cls,threshold){
 const dets=detections.filter(d=>d.class===cls&&d.score>=threshold).sort((a,b)=>b.score-a.score);
 const gt=record.gt?.[cls]||[],negative=(record.neg||[]).includes(cls),partial=(record.not_exhaustive||[]).includes(cls);
 const out={tp:0,fp:0,ignored:0,gt:gt.length,negative,positive:gt.length>0};
 if(!gt.length){if(negative)out.fp=dets.length;else out.ignored=dets.length;return out;}
 const used=new Set();
 for(const d of dets){let best=-1,bestIoU=RULES.iou;gt.forEach((g,i)=>{if(used.has(i))return;const v=iou(d.bbox,g);if(v>=bestIoU){bestIoU=v;best=i;}});
  if(best>=0){used.add(best);out.tp++;}else if(partial)out.ignored++;else out.fp++;}
 return out;
}
export function wilson(k,n,z=1.96){if(!n)return [null,null];const p=k/n,d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));return [(c-m)/d,(c+m)/d];}
export function classMetrics(records,detectionsById,cls,threshold){
 let tp=0,fp=0,gt=0,negImages=0,fpOnNeg=0,posImages=0;
 for(const r of records){const m=matchImage(r,detectionsById.get(r.id)||[],cls,threshold);tp+=m.tp;fp+=m.fp;gt+=m.gt;if(m.negative&&!m.positive){negImages++;fpOnNeg+=m.fp;}if(m.positive)posImages++;}
 const n=tp+fp;
 return {class:cls,threshold,tp,fp,detections:n,precision:n?tp/n:null,precision_ci95:wilson(tp,n),gt,recall:gt?tp/gt:null,positive_images:posImages,negative_images:negImages,fp_per_100_negative_images:negImages?100*fpOnNeg/negImages:null};
}
export function pooled(rows){const tp=rows.reduce((a,r)=>a+r.tp,0),fp=rows.reduce((a,r)=>a+r.fp,0),gt=rows.reduce((a,r)=>a+r.gt,0);return {classes:rows.map(r=>r.class),tp,fp,gt,precision:tp+fp?tp/(tp+fp):null,precision_ci95:wilson(tp,tp+fp),recall:gt?tp/gt:null};}
/** Classes kept at a threshold: at least 10 detections and precision ≥ 0.50. */
export function keptClasses(rows){return rows.filter(r=>r.detections>=RULES.min_detections&&r.precision>=RULES.min_class_precision);}
/** Dev rule: feasible if ≥ 3 kept classes with pooled precision ≥ 0.70; best = most pooled TP, then higher pooled
 * precision (appendix 2), then lower P95, then smaller file. */
export function selectOnDev(candidates){
 const options=[];
 for(const c of candidates)for(const t of GRID){const rows=c.classes.map(cls=>classMetrics(c.records,c.detections,cls,t));const kept=keptClasses(rows),p=pooled(kept);
  options.push({candidate:c.id,threshold:t,kept:kept.map(r=>r.class),pooled:p,feasible:kept.length>=RULES.min_classes&&p.precision>=RULES.min_pooled_precision,p95_ms:c.p95_ms,bytes:c.bytes,rows});}
 const feasible=options.filter(o=>o.feasible).sort((a,b)=>b.pooled.tp-a.pooled.tp||b.pooled.precision-a.pooled.precision||a.p95_ms-b.p95_ms||a.bytes-b.bytes);
 return {options,chosen:feasible[0]||null};
}
/** Test rule: drop frozen classes with ≥ 10 detections and precision < 0.50 (only removes); ship if ≥ 3 remain and pooled ≥ 0.70. */
export function decideOnTest(records,detectionsById,frozen){
 const rows=frozen.classes.map(cls=>classMetrics(records,detectionsById,cls,frozen.threshold));
 const removed=rows.filter(r=>r.detections>=RULES.min_detections&&r.precision<RULES.min_class_precision).map(r=>r.class);
 const remaining=rows.filter(r=>!removed.includes(r.class)),p=pooled(remaining);
 return {rows,removed,remaining:remaining.map(r=>r.class),pooled:p,ship:remaining.length>=RULES.min_classes&&p.precision>=RULES.min_pooled_precision};
}
