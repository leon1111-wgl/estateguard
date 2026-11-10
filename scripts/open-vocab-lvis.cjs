/** Stage 2 of docs/validation/open-vocab-protocol.md (Actions only): run one candidate over one shard of an LVIS subset
 * through the page's own module (single-thread WASM per page, several pages in separate contexts). Labels never enter
 * the browser: pages receive only image bytes. Usage:
 *   node scripts/open-vocab-lvis.cjs --candidate A-q8 --subset artifacts/open-vocab/subset-dev.json --shard 0 --shards 4 [--workers 4]
 * Writes artifacts/open-vocab/detections-<candidate>-<split>-<shard>.json. */
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const args=Object.fromEntries(process.argv.slice(2).reduce((p,v,i,a)=>i%2?p:[...p,[v.replace(/^--/,''),a[i+1]]],[]));
const shard=Number(args.shard||0),shards=Number(args.shards||1),workers=Number(args.workers||4),candidate=args.candidate;
const subset=JSON.parse(fs.readFileSync(args.subset));
const list=subset.images.filter((_,i)=>i%shards===shard).map(r=>({id:r.id,url:r.coco_url,width:r.width,height:r.height}));
const cache='/tmp/lvis-images';fs.mkdirSync(cache,{recursive:true});
async function download(item){const file=path.join(cache,`${item.id}.jpg`);if(fs.existsSync(file))return file;
 for(let attempt=1;;attempt++){try{const r=await fetch(item.url);if(!r.ok)throw new Error(`HTTP ${r.status}`);fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));return file;}catch(e){if(attempt>=4)throw new Error(`${item.url}: ${e.message}`);await new Promise(s=>setTimeout(s,2000*attempt));}}}
(async()=>{
 for(let i=0;i<list.length;i+=16)await Promise.all(list.slice(i,i+16).map(download));
 const browser=await chromium.launch(),queue=[...list],results=[],errors=[];
 async function worker(w){
  const context=await browser.newContext(),page=await context.newPage();
  page.on('pageerror',e=>errors.push(`w${w}: ${e}`));
  await page.route(`${base}/__eval.html`,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>eval</title>'}));
  await page.route(`${base}/__lvis/**`,route=>route.fulfill({status:200,contentType:'image/jpeg',body:fs.readFileSync(path.join(cache,path.basename(new URL(route.request().url()).pathname)))}));
  await page.goto(base+'/__eval.html');
  await page.evaluate(async({base,candidate})=>{const ov=await import(base+'/open-vocab.mjs');window.__lane=await ov.loadOpenVocab(candidate,{remoteHost:base+'/__hf/'});},{base,candidate});
  for(let item;(item=queue.shift());){
   const r=await page.evaluate(async({base,id})=>{const s=performance.now();const bmp=await createImageBitmap(await (await fetch(`${base}/__lvis/${id}.jpg`)).blob());const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;c.getContext('2d').drawImage(bmp,0,0);
    const d=await window.__lane.detect(c,{floor:.05,maxDetections:100});return {width:c.width,height:c.height,ms:performance.now()-s,detections:d.map(x=>({class:x.class,score:+x.score.toFixed(5),bbox:x.bbox.map(v=>+v.toFixed(2))}))};},{base,id:item.id});
   results.push({id:item.id,size_matches:r.width===item.width&&r.height===item.height,...r});
   if(results.length%25===0)console.log(`${candidate} shard ${shard}: ${results.length}/${list.length}`);
  }
  await context.close();
 }
 await Promise.all(Array.from({length:workers},(_,w)=>worker(w)));
 await browser.close();
 const out={candidate,split:subset.split,shard,shards,workers,images:results.sort((a,b)=>a.id-b.id),page_errors:errors};
 fs.mkdirSync('artifacts/open-vocab',{recursive:true});fs.writeFileSync(`artifacts/open-vocab/detections-${candidate}-${subset.split}-${shard}.json`,JSON.stringify(out));
 const ms=results.map(r=>r.ms).sort((a,b)=>a-b);
 console.log(JSON.stringify({candidate,split:subset.split,shard,images:results.length,expected:list.length,size_mismatches:results.filter(r=>!r.size_matches).length,p50_ms:ms[Math.floor(ms.length/2)],errors:errors.length}));
 if(results.length!==list.length||errors.length)process.exit(1);
})().catch(e=>{console.error(e);process.exit(1);});
