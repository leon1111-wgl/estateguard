/** Loading-failure regressions for the default D-FINE detector and the ONNX runtime it shares with the
 * parking DINOv2 encoder. Network responses are held or failed; models and inference are real.
 * Run with ESTATEGUARD_URL, PLAYWRIGHT_MODULE and CHROME_PATH when needed. Writes artifacts/detector-loading-validation.json.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const report={started_at:new Date().toISOString(),base,cases:[],page_errors:[],external_requests:[]};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 // Each case gets a fresh context, so no CacheStorage or in-memory runtime carries over.
 const open=async(hash)=>{const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(60000);
  page.on('pageerror',e=>report.page_errors.push(e.message));page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==origin)report.external_requests.push(r.url());});
  await page.goto(`${base}/?detector=dfine#${hash}`);return page;};
 const hold=async(page,pattern)=>{let release,seen;const gate=new Promise(r=>release=r),reached=new Promise(r=>seen=r);await page.route(pattern,async route=>{seen();await gate;try{await route.continue();}catch{}});return {seen:()=>reached,release:async()=>{release();await page.unroute(pattern);}};};
 const sample=async page=>{await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);};
 const unlocked=()=>!document.querySelector('#run-analysis').disabled&&!document.querySelector('#vision-rule').disabled&&!document.querySelector('#vision-detector').disabled;
 const finished=async page=>{await page.waitForFunction(()=>/^(分析完成|分析失败|模型加载已取消)/.test(document.querySelector('#vision-message').textContent),null,{timeout:120000});return page.locator('#vision-message').textContent();};
 const bus=async page=>{assert.match(await finished(page),/^分析完成/);const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);const r=JSON.parse(fs.readFileSync(await d.path()));const b=r.frames[0].detections.find(x=>x.class==='bus');assert.ok(b?.score>.9);assert.equal(r.params.detector,'dfine');return {score:b.score,model_loading:r.model_loading};};
 const test=async(name,body)=>{const entry={name,status:'running'},t=Date.now();report.cases.push(entry);try{entry.evidence=await body();entry.status='passed';console.log(`PASS: ${name}`);}catch(e){entry.status='failed';entry.error=e.message;console.error(`FAIL: ${name}: ${e.message}`);}finally{entry.duration_ms=Date.now()-t;}};
 try{
  await test('cancelling a stalled D-FINE download unlocks controls within one second and a retry succeeds',async()=>{
   const page=await open('analyze');await sample(page);const h=await hold(page,'**/models/dfine-n/model.onnx');
   await page.locator('#run-analysis').click();await h.seen();const t=Date.now();await page.locator('#stop-analysis').click();
   await page.waitForFunction(unlocked,null,{timeout:1000});const unlockMs=Date.now()-t;assert.match(await page.locator('#vision-message').textContent(),/取消/);
   await h.release();await page.locator('#run-analysis').click();const r=await bus(page);await page.close();return {unlock_ms:unlockMs,retry:r};
  });
  await test('a failed model download is reported and the next run recovers',async()=>{
   const page=await open('analyze');await sample(page);let failures=0;await page.route('**/models/dfine-n/model.onnx',route=>{failures++;route.fulfill({status:500,body:'unavailable'});});
   await page.locator('#run-analysis').click();const msg=await finished(page);assert.match(msg,/分析失败.*500/);await page.waitForFunction(unlocked);
   await page.unroute('**/models/dfine-n/model.onnx');await page.locator('#run-analysis').click();const r=await bus(page);await page.close();return {message:msg,failures,retry_score:r.score};
  });
  await test('a stalled asset list times out after 30 s instead of waiting forever',async()=>{
   const page=await open('analyze');await sample(page);const h=await hold(page,'**/assets.lock.json');
   const t=Date.now();await page.locator('#run-analysis').click();await h.seen();const msg=await finished(page);const ms=Date.now()-t;
   assert.match(msg,/模型清单加载超时/);assert.ok(ms>=29000&&ms<45000,`timeout after ${ms} ms`);await page.waitForFunction(unlocked);await h.release();await page.close();return {message:msg,elapsed_ms:ms};
  });
  // One page session: the page that started the shared runtime download cancels; the other must still finish.
  const startParking=async page=>{await page.evaluate(()=>{location.hash='parking';});await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53);await page.locator('#parking-run').click();};
  const startAnalyze=async page=>{await page.evaluate(()=>{location.hash='analyze';});await sample(page);await page.locator('#run-analysis').click();};
  for(const [first,second] of [['parking','analyze'],['analyze','parking']]){
   await test(`cancelling the ${first} page that started the shared runtime download leaves it running for the ${second} page`,async()=>{
    const page=await open(first);const h=await hold(page,'**/vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm');
    await (first==='parking'?startParking:startAnalyze)(page);await h.seen();
    await (second==='parking'?startParking:startAnalyze)(page);await page.waitForTimeout(300);
    if(first==='parking'){await page.evaluate(()=>{location.hash='parking';});await page.locator('#parking-stop').click();await page.waitForFunction(()=>document.querySelector('#parking-stop').hidden);}
    else{await page.evaluate(()=>{location.hash='analyze';});await page.locator('#stop-analysis').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);}
    await h.release();
    if(second==='analyze'){await page.evaluate(()=>{location.hash='analyze';});const r=await bus(page);await page.close();return {survivor:'analyze',bus:r.score};}
    await page.evaluate(()=>{location.hash='parking';});await page.waitForFunction(()=>/^当前快照分析完成/.test(document.querySelector('#parking-message').textContent),null,{timeout:120000});
    const msg=await page.locator('#parking-message').textContent();assert.match(msg,/53 \/ 53/);await page.close();return {survivor:'parking',message:msg.slice(0,80)};
   });
  }
 }finally{await browser.close();}
 report.passed=report.cases.filter(c=>c.status==='passed').length;report.failed=report.cases.filter(c=>c.status==='failed').length;report.ok=report.failed===0&&!report.page_errors.length&&!report.external_requests.length;
 fs.writeFileSync(path.join(out,'detector-loading-validation.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({report:'artifacts/detector-loading-validation.json',passed:report.passed,failed:report.failed,page_errors:report.page_errors,external_requests:report.external_requests,ok:report.ok}));
 if(!report.ok)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
