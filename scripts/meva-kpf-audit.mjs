/** Parse audit of the MEVA annotation files behind the dev and test runs (added after the review of 0.5.0). Counts
 * KPF lines that could not be read; it scores nothing and writes no label content. Runs on GitHub Actions.
 * Usage: node scripts/meva-kpf-audit.mjs --out DIR */
import fs from 'node:fs';
import path from 'node:path';
import {kpfAudit} from './meva-kpf.mjs';
import {parseClip,annotationPath,rawURL} from './meva-subset.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((p,v,i,all)=>i%2?p:[...p,[v.replace(/^--/,''),all[i+1]]],[]));
const sub=JSON.parse(fs.readFileSync(new URL('../docs/validation/event-timeline-meva-subset.json',import.meta.url),'utf8'));
// The same pre-registered selection as the workflow's plan step: skip missing or < 20 MB, take the first 8 / 16.
const pick=(list,n)=>list.filter(c=>c.bytes&&c.bytes>=20e6).slice(0,n);
const rows=[];
for(const [split,clips] of [['dev',pick(sub.dev_candidates,8)],['test',pick(sub.test_candidates,16)]])for(const c of clips){
 const row={split,clip:c.name};
 for(const kind of ['activities','types']){const r=await fetch(rawURL(annotationPath(parseClip(c.name),kind)));if(!r.ok)throw new Error(`HTTP ${r.status} ${c.name} ${kind}`);row[kind]=kpfAudit(await r.text());}
 rows.push(row);console.log(JSON.stringify(row));
}
const total=k=>rows.reduce((a,r)=>a+r.activities[k]+r.types[k],0);
const out={checked_at:new Date().toISOString(),commit:process.env.GITHUB_SHA||null,run_id:process.env.GITHUB_RUN_ID||null,clips:rows.length,records:total('records'),skipped_lines:total('skipped'),skipped_data_lines:total('skipped_data'),rows};
fs.mkdirSync(args.out,{recursive:true});fs.writeFileSync(path.join(args.out,'kpf-audit.json'),JSON.stringify(out,null,1));
console.log(`clips ${out.clips} · records ${out.records} · skipped ${out.skipped_lines} (data ${out.skipped_data_lines})`);
if(out.skipped_data_lines)process.exit(1);
