/** Score open-vocabulary detections against an LVIS subset (Actions only; labels stay on the runner).
 * dev:  node scripts/open-vocab-score.mjs --stage dev --subset S.json --detections DIR --latency docs/validation/open-vocab-latency.json --out R.json
 * test: node scripts/open-vocab-score.mjs --stage test --subset S.json --detections DIR --config web/data/open-vocab/config.json --out R.json */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {selectOnDev,decideOnTest,classMetrics,GRID,RULES} from './ovd-metrics.mjs';
import {OPEN_VOCAB_CLASSES,OPEN_VOCAB_CANDIDATES} from '../web/open-vocab.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((p,v,i,a)=>i%2?p:[...p,[v.replace(/^--/,''),a[i+1]]],[]));
const subset=JSON.parse(readFileSync(args.subset)),records=subset.images;
const byCandidate=new Map();
for(const f of readdirSync(args.detections,{recursive:true}).filter(f=>/detections-.*\.json$/.test(String(f)))){
 const d=JSON.parse(readFileSync(join(args.detections,String(f))));if(d.split!==subset.split)continue;
 const m=byCandidate.get(d.candidate)||{images:new Map(),shards:new Set(),errors:0,size_mismatches:0};
 for(const im of d.images){m.images.set(im.id,im.detections);if(!im.size_matches)m.size_mismatches++;}m.shards.add(d.shard);m.errors+=d.page_errors.length;byCandidate.set(d.candidate,m);
}
for(const [id,m] of byCandidate)if(m.images.size!==records.length)throw new Error(`${id}: ${m.images.size} of ${records.length} images scored`);
const strip=o=>({...o,rows:undefined});
let report;
if(args.stage==='dev'){
 const latency=JSON.parse(readFileSync(args.latency));
 const candidates=[...byCandidate].map(([id,m])=>({id,records,detections:m.images,classes:[...OPEN_VOCAB_CLASSES],p95_ms:latency.candidates[id].p95_ms,bytes:OPEN_VOCAB_CANDIDATES[id].bytes}));
 const {options,chosen}=selectOnDev(candidates);
 report={stage:'dev',split:subset.split,images:records.length,rules:RULES,grid:GRID,candidates:[...byCandidate.keys()],
  chosen:chosen?{candidate:chosen.candidate,threshold:chosen.threshold,classes:chosen.kept,pooled:chosen.pooled,rows:chosen.rows}:null,
  per_candidate_at_each_threshold:options.map(strip),
  per_class_rows:options.map(o=>({candidate:o.candidate,threshold:o.threshold,rows:o.rows}))};
}else{
 const frozen=JSON.parse(readFileSync(args.config));const m=byCandidate.get(frozen.candidate);if(!m)throw new Error('frozen candidate missing');
 const decision=decideOnTest(records,m.images,frozen);
 report={stage:'test',split:subset.split,images:records.length,rules:RULES,frozen,decision,
  all_classes_at_threshold:OPEN_VOCAB_CLASSES.map(c=>classMetrics(records,m.images,c,frozen.threshold))};
}
report.health=Object.fromEntries([...byCandidate].map(([id,m])=>[id,{images:m.images.size,shards:[...m.shards].sort(),page_errors:m.errors,size_mismatches:m.size_mismatches}]));
writeFileSync(args.out,JSON.stringify(report,null,1));
const pct=v=>v==null?'—':`${(100*v).toFixed(1)}%`;
const lines=[`# Open-vocabulary lane · ${report.stage} (${records.length} LVIS v1 val images)`,''];
if(report.stage==='dev'){lines.push(report.chosen?`Chosen: **${report.chosen.candidate}** at t = ${report.chosen.threshold}, classes ${report.chosen.classes.join(', ')}; pooled precision ${pct(report.chosen.pooled.precision)}, recall ${pct(report.chosen.pooled.recall)}, TP ${report.chosen.pooled.tp}`:'No feasible configuration: the lane stays hidden.','');
 lines.push('| candidate | t | kept classes | pooled TP | pooled precision | feasible |','| --- | --- | --- | --- | --- | --- |');for(const o of report.per_candidate_at_each_threshold)lines.push(`| ${o.candidate} | ${o.threshold} | ${o.kept.join(' ')||'—'} | ${o.pooled.tp} | ${pct(o.pooled.precision)} | ${o.feasible?'yes':'no'} |`);}
else{lines.push(`Ship: **${report.decision.ship}** · removed ${report.decision.removed.join(', ')||'none'} · pooled precision ${pct(report.decision.pooled.precision)}, recall ${pct(report.decision.pooled.recall)}`,'');}
const rows=report.stage==='dev'?(report.chosen?.rows||[]):report.all_classes_at_threshold;
lines.push('','| class | TP | FP | precision (95% CI) | recall | FP / 100 neg images |','| --- | --- | --- | --- | --- | --- |');
for(const r of rows)lines.push(`| ${r.class} | ${r.tp} | ${r.fp} | ${pct(r.precision)} (${pct(r.precision_ci95[0])}–${pct(r.precision_ci95[1])}) | ${pct(r.recall)} | ${r.fp_per_100_negative_images==null?'—':r.fp_per_100_negative_images.toFixed(1)} |`);
writeFileSync(args.out.replace(/\.json$/,'.md'),lines.join('\n')+'\n');console.log(lines.join('\n'));
