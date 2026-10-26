/** Shared-core cancellation regression. Successful scores use the existing public patch and real MLP32.
 * Only the first core JSON response and named image decode completion are gated; product JS is never routed. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8768').replace(/\/$/,''),out=process.env.ESTATEGUARD_ARTIFACT_DIR||path.join(root,'artifacts');
const patch=fs.readFileSync(path.join(root,'web/data/parking/images/B-20150708-0805-1.jpg'));
const report={started_at:new Date().toISOString(),base,scope:'Actual public CNRPark crop and real MLP32 upload inference. Explicit first-core-fetch stalls/503 and decode-completion gates test cancellation; no product-source interception, fabricated scores, training or field-accuracy claim.',checks:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 const fresh=async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{
   const originalFetch=window.fetch.bind(window),decode=HTMLImageElement.prototype.decode,create=URL.createObjectURL.bind(URL),names=new Map();
   window.__coreGate={requests:0,released:false};window.__decodeGate=null;
   window.fetch=async function(resource,options){
    const url=new URL(resource instanceof Request?resource.url:String(resource),location.href);
    if(url.pathname.endsWith('/models/parking-occupancy/model.json')){
     window.__coreGate.requests++;
     if(window.__coreGate.requests===1){window.__coreGate.held=true;const mode=await new Promise(resolve=>window.__coreGate.release=resolve);window.__coreGate.released=true;if(mode==='fail')return new Response('EXPLICIT_TEST_CORE_503',{status:503});}
    }
    return originalFetch(resource,options);
   };
   URL.createObjectURL=function(blob){const url=create(blob);if(blob instanceof File)names.set(url,blob.name);return url;};
   HTMLImageElement.prototype.decode=async function(){const value=await decode.call(this);if(names.get(this.src)==='held-after-cancel.jpg'){const gate={released:false};window.__decodeGate=gate;await new Promise(resolve=>gate.release=resolve);gate.released=true;}return value;};
  });
  const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.page_errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).origin!==new URL(base).origin)report.external_requests.push(r.url());});
  await page.goto(base+'/#parking');await page.waitForFunction(()=>window.__coreGate?.held);return {page,context};
 };
 const upload=(page,name)=>page.locator('#parking-upload').setInputFiles({name,mimeType:'image/jpeg',buffer:patch});
 const state=page=>page.evaluate(()=>({status:document.querySelector('#parking-upload-status').textContent,result:document.querySelector('#parking-upload-result').textContent,image:!!document.querySelector('#parking-upload-result img'),model:document.querySelector('#parking-model-choice').value,file_disabled:document.querySelector('#parking-upload').disabled,run_disabled:document.querySelector('#parking-run').disabled,model_disabled:document.querySelector('#parking-model-choice').disabled,play_disabled:document.querySelector('#parking-play').disabled,cancel_hidden:document.querySelector('#parking-upload-cancel').hidden,requests:window.__coreGate.requests,core_released:window.__coreGate.released}));
 const cancelCore=async page=>{
  await upload(page,'cancel-before-core.jpg');await page.waitForSelector('#parking-upload-cancel:visible');const started=Date.now();await page.locator('#parking-upload-cancel').click();
  await page.waitForFunction(()=>document.querySelector('#parking-upload-status').textContent.startsWith('已取消')&&!document.querySelector('#parking-upload').disabled&&document.querySelector('#parking-upload-cancel').hidden,null,{timeout:2000});
  const cancelled=await state(page);assert.equal(cancelled.core_released,false);assert.equal(cancelled.result,'');assert.equal(cancelled.model_disabled,false);assert.equal(cancelled.run_disabled,false);assert.equal(cancelled.play_disabled,false);return {elapsed_ms:Date.now()-started,...cancelled};
 };
 const completed=async(page,name)=>{await page.waitForFunction(name=>document.querySelector('#parking-upload-status').textContent===`已完成「${name}」的分析。`&&!document.querySelector('#parking-upload').disabled,name);const result=await state(page);assert.match(result.result,/MLP32/);assert.match(result.result,/2\.85%/);assert.equal(result.image,true);assert.equal(result.cancel_hidden,true);return result;};
 try{
  {const {page,context}=await fresh();const cancelled=await cancelCore(page);await page.evaluate(()=>window.__coreGate.release('ok'));await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53&&document.querySelector('#parking-model-choice').value==='dinov2');const late=await state(page);assert.equal(late.status,cancelled.status);assert.equal(late.result,'');await page.locator('#parking-model-choice').selectOption('mlp32');await upload(page,'real-after-core.jpg');const retry=await completed(page,'real-after-core.jpg');assert.equal(retry.requests,1);report.checks.push({name:'cancel_does_not_wait_for_core_late_success_does_not_publish_cancelled_file',passed:true,cancelled,late,retry});await context.close();}
  {const {page,context}=await fresh();const cancelled=await cancelCore(page);await page.locator('#parking-model-choice').selectOption('mlp32');await upload(page,'held-after-cancel.jpg');const waiting=await state(page);assert.equal(waiting.file_disabled,true);await page.evaluate(()=>window.__coreGate.release('ok'));await page.waitForFunction(()=>window.__decodeGate&&document.querySelectorAll('.parking-tile').length===53);const held=await state(page);assert.equal(held.model,'mlp32');assert.equal(held.image,false);for(const key of ['file_disabled','run_disabled','model_disabled','play_disabled'])assert.equal(held[key],true,key);assert.doesNotMatch(held.status,/已取消/);await page.evaluate(()=>window.__decodeGate.release());const retry=await completed(page,'held-after-cancel.jpg');assert.equal(retry.requests,1);report.checks.push({name:'immediate_retry_owns_lock_after_shared_core_resolves',passed:true,cancelled,waiting,held,retry});await context.close();}
  {const {page,context}=await fresh();const cancelled=await cancelCore(page);await page.evaluate(()=>window.__coreGate.release('fail'));await page.waitForFunction(()=>document.querySelector('#parking-model-status').textContent==='加载失败，可重试');const failed=await state(page);assert.equal(failed.status,cancelled.status);assert.equal(failed.result,'');assert.equal(failed.file_disabled,false);await page.locator('#parking-model-choice').selectOption('mlp32');await upload(page,'real-after-core-error.jpg');const retry=await completed(page,'real-after-core-error.jpg');assert.equal(retry.requests,2);report.checks.push({name:'late_core_failure_keeps_cancelled_upload_and_next_upload_retries_core',passed:true,cancelled,failed,retry});await context.close();}
  assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.external_requests,[]);report.ok=true;
 }catch(error){report.error=error.stack||String(error);throw error;}
 finally{await browser.close();fs.writeFileSync(path.join(out,'parking-upload-core-validation.json'),JSON.stringify(report,null,2));}
 console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,report:path.join(out,'parking-upload-core-validation.json')}));
})().catch(error=>{console.error(error);process.exitCode=1;});
