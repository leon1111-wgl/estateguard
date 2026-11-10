/** Stage 1 of docs/validation/open-vocab-protocol.md (Actions only): single-thread WASM latency of one open-vocabulary
 * candidate in Chromium, through the page's own module. Label-free: deterministic noise images plus one smoke image.
 * Usage: node scripts/open-vocab-latency.cjs <candidate id>   (needs web/__hf from open-vocab-mirror.mjs and a server
 * for web/ at ESTATEGUARD_URL). Writes artifacts/open-vocab/latency-<id>.json. */
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const id=process.argv[2];if(!id)throw new Error('candidate id required');
const BUDGET={p95_ms:20000,init_ms:60000},SIZES=[[1280,720],[1024,768],[720,1280]],WARMUP=1,TIMED=10;
(async()=>{
 const browser=await chromium.launch(),context=await browser.newContext(),page=await context.newPage();
 const errors=[],external=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());console.log(`[page ${m.type()}] ${m.text().slice(0,300)}`);});
 page.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==new URL(base).origin)external.push(u);});
 await page.route(`${base}/__eval.html`,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>eval</title>'}));
 await page.goto(base+'/__eval.html');
 const result=await page.evaluate(async({base,id,BUDGET,SIZES,WARMUP,TIMED})=>{
  const ov=await import(base+'/open-vocab.mjs');
  const t0=performance.now();let lane;
  // A candidate that cannot start on this runtime is a stage-1 result, recorded rather than thrown.
  // A load that does not finish in 10 minutes is recorded as a load failure (appendix 3 runs hung without output).
  try{lane=await Promise.race([ov.loadOpenVocab(id,{remoteHost:base+'/__hf/',onProgress:p=>{if(!window.__p||p.loaded-window.__p>50e6){window.__p=p.loaded;console.info(`loaded ${(p.loaded/1e6).toFixed(0)} / ${(p.total/1e6).toFixed(0)} MB`);}}}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('model load did not finish within 10 minutes')),600000))]);console.info(`session ready after ${Math.round(performance.now()-t0)} ms`);}catch(error){return {candidate:id,...ov.OPEN_VOCAB_CANDIDATES[id],load_error:String(error.message||error),within_budget:false,budget:BUDGET,user_agent:navigator.userAgent};}
  const init_ms=performance.now()-t0;
  const rand=seed=>()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
  async function noiseBlob(w,h,seed){const c=new OffscreenCanvas(w,h),x=c.getContext('2d'),d=x.createImageData(w,h),r=rand(seed);for(let i=0;i<d.data.length;i+=4){d.data[i]=r()*255;d.data[i+1]=r()*255;d.data[i+2]=r()*255;d.data[i+3]=255;}x.putImageData(d,0,0);return c.convertToBlob({type:'image/png'});}
  async function endToEnd(blob){const s=performance.now();const bmp=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;c.getContext('2d').drawImage(bmp,0,0);const dets=await lane.detect(c,{floor:.05});return {ms:performance.now()-s,boxes:dets.length};}
  const runs=[];let stopped=null;
  for(const [w,h] of SIZES){const blob=await noiseBlob(w,h,w*h);for(let i=0;i<WARMUP;i++)await endToEnd(blob);
   for(let i=0;i<TIMED;i++){const r=await endToEnd(blob);runs.push({size:`${w}x${h}`,...r});console.info(`run ${runs.length}: ${w}x${h} ${Math.round(r.ms)} ms`);
    // Pre-declared early stop (appendix 1): three timed runs all over twice the budget end the measurement.
    if(runs.length===3&&runs.every(x=>x.ms>2*BUDGET.p95_ms)){stopped='three timed runs over 2× the P95 budget';break;}}
   if(stopped)break;}
  const ms=runs.map(r=>r.ms).sort((a,b)=>a-b),q=p=>ms[Math.min(ms.length-1,Math.ceil(p*ms.length)-1)];
  // Smoke image (label-free): our decoding vs the library's own post-processing on the same raw outputs.
  const bmp=await createImageBitmap(await (await fetch(base+'/samples/bus.jpg')).blob());const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;c.getContext('2d').drawImage(bmp,0,0);
  const raw=await lane.detect(c,{floor:.05,raw:true});let library=null;
  try{if(lane.candidate.family==='owl'){const r=raw.processor.image_processor.post_process_object_detection(raw.outputs,.05,[[c.height,c.width]],true)[0];library=r.boxes.map((b,i)=>({class:ov.OPEN_VOCAB_CLASSES[r.classes[i]],score:r.scores[i],xyxy:b})).sort((a,b)=>b.score-a.score).slice(0,5);}
   else{const r=raw.processor.post_process_grounded_object_detection(raw.outputs,raw.inputs.input_ids,{box_threshold:.05,text_threshold:.05,target_sizes:[[c.height,c.width]]})[0];library=r.boxes.map((b,i)=>({label:r.labels[i],score:r.scores[i],xyxy:b})).sort((a,b)=>b.score-a.score).slice(0,5);}}catch(e){library={error:String(e)};}
  return {candidate:id,...lane.candidate,threads:lane.threads,cross_origin_isolated:globalThis.crossOriginIsolated===true,hardware_concurrency:navigator.hardwareConcurrency,user_agent:navigator.userAgent,
   init_ms,timed_runs:runs.length,stopped,p50_ms:q(.5),p95_ms:q(.95),max_ms:ms.at(-1),runs,
   budget:BUDGET,within_budget:!stopped&&runs.length===SIZES.length*TIMED&&q(.95)<=BUDGET.p95_ms&&init_ms<=BUDGET.init_ms,
   smoke:{image:'samples/bus.jpg',ours:raw.detections.slice(0,5),library}};
 },{base,id,BUDGET,SIZES,WARMUP,TIMED});
 result.page_errors=errors;result.cross_origin_requests=external.length;
 fs.mkdirSync('artifacts/open-vocab',{recursive:true});fs.writeFileSync(path.join('artifacts/open-vocab',`latency-${id}.json`),JSON.stringify(result,null,1));
 if(result.load_error){console.log(JSON.stringify({candidate:id,load_error:result.load_error}));await browser.close();return;}
 console.log(JSON.stringify({candidate:id,init_ms:Math.round(result.init_ms),p50_ms:Math.round(result.p50_ms),p95_ms:Math.round(result.p95_ms),within_budget:result.within_budget,stopped:result.stopped,errors:errors.length,external:external.length,smoke_ours:result.smoke.ours.slice(0,3),smoke_library:result.smoke.library&&result.smoke.library.slice?result.smoke.library.slice(0,3):result.smoke.library}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
