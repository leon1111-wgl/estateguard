/** COCO val2017 detections from the page's own detector code (SSDLite via COCO-SSD, D-FINE via
 * web/detector-dfine.mjs), following docs/validation/detector-upgrade-protocol.md. Annotations never
 * enter the browser. Usage:
 *   node scripts/eval-detectors-coco.cjs --model ssdlite|dfine --images DIR --list images.json --out results.json [--workers 8] [--limit N]
 * images.json: [{id,file_name}]. Requires a local server for web/ (ESTATEGUARD_URL).
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,i,all)=>i%2?pairs:[...pairs,[value.replace(/^--/,''),all[i+1]]],[]));
const model=args.model,imagesDir=path.resolve(args.images),workers=Math.max(1,Number(args.workers||1));
assert(['ssdlite','dfine'].includes(model),'model must be ssdlite or dfine');
let list=JSON.parse(fs.readFileSync(args.list));if(args.limit)list=list.slice(0,Number(args.limit));
const shards=Array.from({length:workers},(_,w)=>list.slice(Math.floor(list.length*w/workers),Math.floor(list.length*(w+1)/workers)));
async function setup(browser,external){
 const context=await browser.newContext(),page=await context.newPage();
 page.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==new URL(base).origin)external.push(u);});
 await page.route(`${base}/__eval.html`,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>eval</title>'}));
 await page.route(`${base}/__coco/**`,route=>{const name=path.basename(new URL(route.request().url()).pathname);route.fulfill({status:200,contentType:'image/jpeg',body:fs.readFileSync(path.join(imagesDir,name))});});
 await page.goto(base+'/__eval.html');
 const env=await page.evaluate(async({base,model})=>{
  const {COCO_CLASSES,COCO_IDS,loadDfineDetector}=await import(base+'/detector-dfine.mjs');
  let detector,backend;
  if(model==='dfine'){detector=await loadDfineDetector({numThreads:1});backend=detector.backend;}
  else{
   for(const src of ['vendor/tf.min.js','vendor/coco-ssd.min.js'])await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=`${base}/${src}`;s.onload=resolve;s.onerror=reject;document.head.append(s);});
   await tf.setBackend('webgl');await tf.ready();detector=new cocoSsd.ObjectDetection('lite_mobilenet_v2',`${base}/models/ssdlite_mobilenet_v2/model.json`);await detector.load();backend=tf.getBackend();
  }
  const ids=Object.fromEntries(COCO_CLASSES.map((name,i)=>[name,COCO_IDS[i]])),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  // Same frame preparation as the analysis page: width capped at 960 before detection.
  window.detectOne=async(url,imageId)=>{
   const t0=performance.now(),bitmap=await createImageBitmap(await (await fetch(url)).blob()),scale=Math.min(1,960/bitmap.width);
   canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
   const t1=performance.now(),predictions=await detector.detect(canvas,100,.01),t2=performance.now();
   const sx=bitmap.width/canvas.width,sy=bitmap.height/canvas.height;bitmap.close();
   return {detections:predictions.map(p=>({image_id:imageId,category_id:ids[p.class],bbox:[p.bbox[0]*sx,p.bbox[1]*sy,p.bbox[2]*sx,p.bbox[3]*sy].map(v=>Math.round(v*100)/100),score:Math.round(p.score*1e6)/1e6})),detect_ms:t2-t1,total_ms:performance.now()-t0,tensors:globalThis.tf?.memory().numTensors??null};
  };
  return {backend,tfjs:globalThis.tf?.version?.tfjs??null};
 },{base,model});
 return {context,page,env};
}
async function worker({context,page},shard,w){
 const out=[],timing=[];let tensors=null;
 try{for(let i=0;i<shard.length;i++){const r=await page.evaluate(([url,id])=>window.detectOne(url,id),[`${base}/__coco/${shard[i].file_name}`,shard[i].id]);
  for(const d of r.detections)assert(Number.isInteger(d.category_id),'unmapped class');
  if(tensors===null)tensors=r.tensors;else assert.equal(r.tensors,tensors,'Tensor leak');
  out.push(...r.detections);timing.push({id:shard[i].id,detect_ms:r.detect_ms,total_ms:r.total_ms});
  if(i%500===0)console.log(`${model} worker ${w}: ${i+1}/${shard.length}`);}}
 finally{await context.close();}
 return {out,timing};
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--use-angle=metal','--enable-gpu'],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const external=[],started=Date.now();
 try{
  const pages=[];for(let w=0;w<workers;w++)pages.push(await setup(browser,external));
  const results=await Promise.all(pages.map((p,w)=>worker(p,shards[w],w)));
  const detections=results.flatMap(r=>r.out),timing=results.flatMap(r=>r.timing).sort((a,b)=>a.id-b.id);
  assert.deepEqual(external,[]);
  const q=(xs,p)=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
  const meta={model,images:list.length,detections:detections.length,workers,backend:pages[0].env.backend,browser:await browser.version(),wall_seconds:(Date.now()-started)/1000,
   detect_ms:{p50:q(timing.map(t=>t.detect_ms),.5),p95:q(timing.map(t=>t.detect_ms),.95)},total_ms:{p50:q(timing.map(t=>t.total_ms),.5),p95:q(timing.map(t=>t.total_ms),.95)},
   note:workers>1?'Timings come from parallel pages and are not latency measurements':'Single page; end-to-end includes fetch, decode, resize, inference and postprocessing'};
  fs.writeFileSync(args.out,JSON.stringify({meta,timing,detections}));
  console.log(JSON.stringify(meta));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
