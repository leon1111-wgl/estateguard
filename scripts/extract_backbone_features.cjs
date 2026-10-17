/** Frozen encoder embeddings for parking patches, computed by the app's own web/parking-encoders.mjs
 * in Chrome so offline and in-page features share decode, preprocessing and runtime. Labels never
 * enter the browser. Usage:
 *   node scripts/extract_backbone_features.cjs --encoder mobilenet|dinov2 --ids ids.csv --images DIR --out DIR [--workers 8]
 * ids.csv needs columns id,source_path,source_sha256. Requires a local server for web/ (ESTATEGUARD_URL).
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),base=process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766';
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,i,all)=>i%2?pairs:[...pairs,[value.replace(/^--/,''),all[i+1]]],[]));
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const encoder=args.encoder||'mobilenet',DIMS={mobilenet:1280,dinov2:768},DIM=DIMS[encoder];assert(DIM,'unknown encoder');
function readCsv(file){const [head,...lines]=fs.readFileSync(file,'utf8').trim().split('\n');const keys=head.split(',');return lines.map(line=>Object.fromEntries(line.split(',').map((v,i)=>[keys[i],v])));}
const rows=readCsv(args.ids),imagesDir=path.resolve(args.images),out=path.resolve(args.out);
assert(rows.length&&rows.every(r=>r.id&&r.source_path&&r.source_sha256),'ids csv needs id,source_path,source_sha256');
fs.mkdirSync(out,{recursive:true});
const lock=JSON.parse(fs.readFileSync(path.join(root,'web/assets.lock.json')));
const prefixes={mobilenet:p=>p.startsWith('models/ssdlite_mobilenet_v2/')||p==='vendor/tf.min.js',dinov2:p=>p.startsWith('models/dinov2-small/')||p.startsWith('vendor/onnxruntime-web/')};
const assets=lock.files.filter(r=>prefixes[encoder](r.path));assert(assets.length,'encoder assets missing from lock');
for(const asset of assets){const bytes=fs.readFileSync(path.join(root,'web',asset.path));assert.equal(bytes.length,asset.bytes);assert.equal(hash(bytes),asset.sha256,asset.path);}
const code=['web/parking-encoders.mjs','web/parking-transfer.mjs','web/model-assets.mjs'].map(p=>({path:p,sha256:hash(fs.readFileSync(path.join(root,p)))}));
// Each worker is one page running the app's single-thread configuration; shards resume independently.
const workers=Math.max(1,Number(args.workers||1)),shards=Array.from({length:workers},(_,w)=>[Math.floor(rows.length*w/workers),Math.floor(rows.length*(w+1)/workers)]);
const partial=w=>path.join(out,`features.partial.${w}.f32`);
// Pages load the encoder one at a time (a burst of 8 loads overwhelms the dev server), then run in parallel.
async function setup(browser,external){
 // Separate contexts keep CacheStorage writes from racing between pages.
 const context=await browser.newContext(),page=await context.newPage();
 page.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==new URL(base).origin)external.push(u);});
 await page.route(`${base}/__extract.html`,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>extract</title>'}));
 await page.route(`${base}/__patches/**`,route=>{const rel=decodeURIComponent(new URL(route.request().url()).pathname.replace('/__patches/',''));const target=path.resolve(imagesDir,rel);if(!target.startsWith(imagesDir+path.sep))return route.abort();route.fulfill({status:200,contentType:'image/jpeg',body:fs.readFileSync(target)});});
 await page.goto(base+'/__extract.html');
 const env=await page.evaluate(async({base,encoder})=>{
  const mod=await import(base+'/parking-encoders.mjs');
  window.encoder=await mod.loadEncoder(encoder,{numThreads:1});
  window.embedOne=async url=>{const bitmap=await mod.decodeImage(url);try{const values=await window.encoder.embed(bitmap);return {values:Array.from(values),tensors:globalThis.tf?.memory().numTensors??null};}finally{bitmap.close();}};
  return {backend:window.encoder.backend,feature_version:window.encoder.feature_version,tfjs:globalThis.tf?.version?.tfjs??null};
 },{base,encoder});
 if(encoder==='mobilenet')assert.match(env.backend,/webgl/i,'WebGL backend required for the published feature run');
 return {context,page,env};
}
async function worker({context,page,env},w){
 const [from,to]=shards[w],file=partial(w),done=fs.existsSync(file)?fs.statSync(file).size/(DIM*4):0;assert(Number.isInteger(done),'Corrupt partial feature file');
 const fd=fs.openSync(file,'a'),timings=[];let tensors=null;
 try{
  for(let i=from+done;i<to;i++){
   const r=rows[i];assert.equal(hash(fs.readFileSync(path.join(imagesDir,r.source_path))),r.source_sha256,r.id);
   const t=Date.now(),res=await page.evaluate(url=>window.embedOne(url),`${base}/__patches/${encodeURI(r.source_path)}`);timings.push(Date.now()-t);
   assert.equal(res.values.length,DIM);assert(res.values.every(Number.isFinite),'Nonfinite embedding');
   if(tensors===null)tensors=res.tensors;else assert.equal(res.tensors,tensors,'Tensor leak');
   fs.writeSync(fd,Buffer.from(new Float32Array(res.values).buffer));
   if((i-from)%1000===0)console.log(`worker ${w}: ${i-from+1}/${to-from}`);
  }
 }finally{fs.closeSync(fd);await context.close();}
 return {env,timings};
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--use-angle=metal','--enable-gpu'],...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const external=[],started=Date.now();
 try{
  const pages=[];for(let w=0;w<workers;w++)pages.push(await setup(browser,external));
  const results=await Promise.all(pages.map((ready,w)=>worker(ready,w)));
  const bytes=Buffer.concat(shards.map((_,w)=>fs.readFileSync(partial(w))));assert.equal(bytes.length,rows.length*DIM*4);
  fs.writeFileSync(path.join(out,'features.f32'),bytes);shards.forEach((_,w)=>fs.rmSync(partial(w)));
  const timings=results.flatMap(r=>r.timings).sort((a,b)=>a-b),env=results[0].env;
  const meta={format:'estateguard-backbone-features',version:2,encoder,feature_version:env.feature_version,dim:DIM,dtype:'float32',count:rows.length,ids:rows.map(r=>r.id),
   input:'fetch → Blob → createImageBitmap; web/parking-encoders.mjs embed(); batch size 1; single-thread WASM for DINOv2',backbone_assets:assets,code,browser:await browser.version(),...env,workers,
   per_patch_ms_median:timings.length?timings[Math.floor(timings.length/2)]:null,wall_seconds:(Date.now()-started)/1000,features_sha256:hash(bytes),ids_csv:path.relative(root,path.resolve(args.ids)),external_requests:external};
  assert.deepEqual(external,[]);
  fs.writeFileSync(path.join(out,'features.meta.json'),JSON.stringify(meta,null,1));
  console.log(JSON.stringify({out,encoder,count:rows.length,features_sha256:meta.features_sha256,per_patch_ms_median:meta.per_patch_ms_median,backend:env.backend,wall_seconds:meta.wall_seconds}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
