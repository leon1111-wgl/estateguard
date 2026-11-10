/** Collect stage-1 results (artifacts of open-vocab-eval.yml latency runs) into docs/validation/open-vocab-latency.json.
 * Usage: node scripts/open-vocab-latency-summary.mjs <run id>=<dir> [<run id>=<dir> …]   (dirs hold latency-*.json) */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const out={protocol:'docs/validation/open-vocab-protocol.md (stage 1, appendices 1 and 3)',budget:null,candidates:{}};
for(const arg of process.argv.slice(2)){
 const [run,dir]=arg.split('=');
 for(const f of readdirSync(dir,{recursive:true}).map(String).filter(f=>/latency-.*\.json$/.test(f))){
  const r=JSON.parse(readFileSync(join(dir,f),'utf8'));out.budget=r.budget;
  out.candidates[r.candidate]={run_id:Number(run),model:r.model,repo:r.repo,revision:r.revision,file:r.file,bytes:r.bytes,runtime:r.runtime,
   ...(r.load_error?{load_error:r.load_error,within_budget:false}:{init_ms:Math.round(r.init_ms),p50_ms:Math.round(r.p50_ms),p95_ms:Math.round(r.p95_ms),max_ms:Math.round(r.max_ms),timed_runs:r.timed_runs,stopped:r.stopped,within_budget:r.within_budget,threads:r.threads,cross_origin_isolated:r.cross_origin_isolated,hardware_concurrency:r.hardware_concurrency,page_errors:r.page_errors.length,smoke_top3:r.smoke.ours.slice(0,3).map(d=>({class:d.class,score:+d.score.toFixed(3),bbox:d.bbox.map(v=>Math.round(v))})),smoke_library_top3:Array.isArray(r.smoke.library)?r.smoke.library.slice(0,3).map(d=>({label:d.class??d.label,score:+d.score.toFixed(3),xyxy:d.xyxy.map(v=>Math.round(v))})):r.smoke.library}),
   user_agent:r.user_agent};
 }
}
writeFileSync('docs/validation/open-vocab-latency.json',JSON.stringify(out,null,1)+'\n');
for(const [id,c] of Object.entries(out.candidates))console.log(id,c.load_error?`load error: ${c.load_error.slice(0,90)}`:`init ${c.init_ms} ms · P50 ${c.p50_ms} · P95 ${c.p95_ms} · within ${c.within_budget}${c.stopped?` (stopped: ${c.stopped})`:''}`);
