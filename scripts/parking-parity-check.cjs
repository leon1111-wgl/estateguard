/** Feature and calibrated-score parity between the page's frozen encoders and the offline pipeline, on the fixture
 * patches from CNRPark B and CNR-EXT. The limits (features 1e-4, calibrated scores 1e-6) are pinned to the published
 * macOS WebGL run; on Linux runners MobileNetV2 differs by about 1.55e-6 (docs/VALIDATION.md), so CI runs this check with
 * continue-on-error and the parking flow checks live in parking-transfer-check.cjs. Writes artifacts/parking-parity-validation.json.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/parking-transfer-parity.json')));
const report={checked_at:new Date().toISOString(),base,steps:{},ok:false};
const step=(name,value)=>{report.steps[name]=value;console.log(name,JSON.stringify(value).slice(0,240));};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(180000);
  const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==origin)external.push(r.url());});
  report.browser=await browser.version();
  // 1. Encoder parity on fixture patches from B and CNR-EXT, through the same module the page uses.
  await page.goto(base+'/');
  const parity=await page.evaluate(async({fixtures,base})=>{
   const enc=await import(base+'/parking-encoders.mjs'),tr=await import(base+'/parking-transfer.mjs'),out={};
   for(const key of ['mobilenet','dinov2']){
    const head=await (await fetch(`${base}/${enc.ENCODERS[key].head}`)).json(),encoder=await enc.loadEncoder(key),fx=fixtures[key];let feature=0,score=0,n=0;const ms=[];
    for(const s of [...fx.samples.map(x=>({...x,url:`${base}/data/parking/images/${x.id}.jpg`})),...(fx.ext_samples||[]).map(x=>({...x,url:`${base}/data/parking-ext/images/${x.id}.jpg`}))]){
     const bitmap=await enc.decodeImage(s.url),t=performance.now(),z=await encoder.embed(bitmap);ms.push(performance.now()-t);bitmap.close();
     for(let i=0;i<z.length;i++)feature=Math.max(feature,Math.abs(z[i]-s.features[i]));
     score=Math.max(score,Math.abs(tr.predictHead(z,head).calibrated-s.calibrated));n++;
    }
    out[key]={samples:n,max_feature_diff:feature,max_calibrated_diff:score,backend:encoder.backend,median_embed_ms:ms.sort((a,b)=>a-b)[Math.floor(ms.length/2)],load_ms:encoder.stats.load_ms};encoder.dispose();
   }
   return out;
  },{fixtures,base});
  report.measured=parity;
  for(const [k,v] of Object.entries(parity)){assert.ok(v.max_feature_diff<=1e-4,`${k} feature diff ${v.max_feature_diff}`);assert.ok(v.max_calibrated_diff<=1e-6,`${k} score diff ${v.max_calibrated_diff}`);}
  step('encoder_parity',parity);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);report.ok=true;
 }finally{await browser.close();fs.writeFileSync(path.join(out,'parking-parity-validation.json'),JSON.stringify(report,null,2));}
 console.log('PASS parking-parity-check');
})().catch(error=>{report.fatal_error=error.message;fs.writeFileSync(path.join(out,'parking-parity-validation.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
