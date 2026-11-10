/** MEVA detection pass for the event-timeline evaluation (docs/validation/event-timeline-protocol.md). Runs only on
 * GitHub Actions: each clip is downloaded to the runner, frames are taken at the fixed rate with ffmpeg (Chromium
 * cannot decode MEVA's AVI), scaled like the page (width ≤ 960), and passed through the page's own D-FINE-N module
 * (web/detector-dfine.mjs) in headless Chromium. Labels are never read here. Video and frames are deleted after each
 * clip; only detections leave the job.
 * Usage: node scripts/meva-timeline.cjs --clips clips.json --out DIR [--workers 4]
 * clips.json: [{name, video}] (written by the plan step from docs/validation/event-timeline-meva-subset.json). */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const args=Object.fromEntries(process.argv.slice(2).reduce((p,v,i,all)=>i%2?p:[...p,[v.replace(/^--/,''),all[i+1]]],[]));
const clips=JSON.parse(fs.readFileSync(args.clips,'utf8')),out=path.resolve(args.out),workers=Math.max(1,Number(args.workers||4));
fs.mkdirSync(out,{recursive:true});
const INTERVAL=1,MAX_FRAMES=300,FLOOR=.25;
const run=(cmd,a)=>execFileSync(cmd,a,{encoding:'utf8',maxBuffer:1<<26});
async function download(url,file){
 const r=await fetch(url);if(!r.ok)throw new Error(`HTTP ${r.status} for ${url}`);
 const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'w');let bytes=0;
 for await(const chunk of r.body){const b=Buffer.from(chunk);hash.update(b);fs.writeSync(fd,b);bytes+=b.length;}
 fs.closeSync(fd);return {bytes,sha256:hash.digest('hex')};
}
async function setup(browser,external){
 const context=await browser.newContext(),page=await context.newPage();
 page.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==new URL(base).origin)external.push(u);});
 await page.route(`${base}/__eval.html`,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>eval</title>'}));
 await page.route(`${base}/__frames/**`,route=>{const name=path.basename(new URL(route.request().url()).pathname);route.fulfill({status:200,contentType:'image/png',body:fs.readFileSync(path.join(page.frameDir,name))});});
 await page.goto(base+'/__eval.html');
 const backend=await page.evaluate(async({base,floor})=>{
  const {loadDfineDetector}=await import(base+'/detector-dfine.mjs');
  const detector=await loadDfineDetector({numThreads:1}),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  // Frames arrive already scaled like the page's analysis canvas; detection gets the same call as the page.
  window.detectFrame=async url=>{const bitmap=await createImageBitmap(await (await fetch(url)).blob());canvas.width=bitmap.width;canvas.height=bitmap.height;ctx.drawImage(bitmap,0,0);bitmap.close();
   const t=performance.now(),p=await detector.detect(canvas,50,floor);
   return {ms:performance.now()-t,detections:p.map(d=>({class:d.class,score:Math.round(d.score*1e6)/1e6,bbox:[d.bbox[0]/canvas.width,d.bbox[1]/canvas.height,d.bbox[2]/canvas.width,d.bbox[3]/canvas.height].map(v=>Math.round(Math.max(0,v)*1e5)/1e5)}))};};
  return detector.backend;
 },{base,floor:FLOOR});
 return {context,page,backend};
}
(async()=>{
 const browser=await chromium.launch({headless:true}),external=[];
 const pages=[];for(let w=0;w<workers;w++)pages.push(await setup(browser,external));
 const summary={workers,backend:pages[0].backend,browser:await browser.version(),clips:[]};
 try{
  for(const clip of clips){
   const t0=Date.now(),work=fs.mkdtempSync(path.join(os.tmpdir(),'meva-')),video=path.join(work,'clip.avi'),frames=path.join(work,'frames');fs.mkdirSync(frames);
   try{
    const dl=await download(clip.video,video),t1=Date.now();
    const probe=JSON.parse(run('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height,r_frame_rate,nb_frames,codec_name:format=duration','-of','json',video]));
    const s=probe.streams[0],[num,den]=s.r_frame_rate.split('/').map(Number),fps=num/den,duration=Number(probe.format.duration),step=Math.round(fps*INTERVAL);
    const scale=Math.min(1,960/s.width,1920/s.height),w=Math.round(s.width*scale/2)*2,h=Math.round(s.height*scale/2)*2;
    // Every step-th decoded frame (frame n = k·step, time n/fps), the same instants the page would seek to.
    run('ffmpeg',['-v','error','-i',video,'-vf',`select=not(mod(n\\,${step})),scale=${w}:${h}:flags=bilinear`,'-fps_mode','vfr','-frames:v',String(MAX_FRAMES),path.join(frames,'%05d.png')]);
    const files=fs.readdirSync(frames).filter(f=>f.endsWith('.png')).sort(),t2=Date.now();
    const results=new Array(files.length);let next=0;
    await Promise.all(pages.map(async p=>{p.page.frameDir=frames;while(next<files.length){const i=next++;results[i]=await p.page.evaluate(u=>window.detectFrame(u),`${base}/__frames/${files[i]}`);}}));
    const t3=Date.now(),ms=results.map(r=>r.ms).sort((a,b)=>a-b);
    const record={clip:clip.name,video:{url:clip.video,bytes:dl.bytes,sha256:dl.sha256,codec:s.codec_name,width:s.width,height:s.height,fps,duration_seconds:duration},
     sampling:{interval_seconds:INTERVAL,step_frames:step,analysed_width:w,analysed_height:h,detection_floor:FLOOR,max_detections:50},
     frames:results.map((r,k)=>({frame:k*step,time:k*step/fps,detections:r.detections})),
     timing_seconds:{download:(t1-t0)/1000,extract:(t2-t1)/1000,detect:(t3-t2)/1000,detect_ms_p50:ms[Math.floor(ms.length/2)],detect_ms_p95:ms[Math.floor(ms.length*.95)]}};
    fs.writeFileSync(path.join(out,`${clip.name}.json`),JSON.stringify(record));
    summary.clips.push({clip:clip.name,frames:results.length,...record.timing_seconds,bytes:dl.bytes,width:s.width,height:s.height,fps});
    console.log(clip.name,JSON.stringify(record.timing_seconds));
   }catch(e){summary.clips.push({clip:clip.name,error:String(e.message||e)});console.error(clip.name,e);}
   finally{fs.rmSync(work,{recursive:true,force:true});}
  }
 }finally{await browser.close();}
 summary.external_requests=external;
 fs.writeFileSync(path.join(out,'_detect-summary.json'),JSON.stringify(summary,null,2));
 if(external.length||summary.clips.some(c=>c.error))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
