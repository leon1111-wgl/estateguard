/** Independent real-browser checks for the public model download lifecycle.
 * Run with PLAYWRIGHT_MODULE, CHROME_PATH and ESTATEGUARD_URL when needed.
 * MODEL_LOADING_CASE accepts comma-separated name fragments for a focused regression.
 * Network responses may be held or failed; the actual model and inference are never mocked.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const shardPath='models/ssdlite_mobilenet_v2/group1-shard1of5';
const cacheName='estateguard-public-model-v1';
const assets=JSON.parse(fs.readFileSync(path.join(root,'web/assets.lock.json'))).files.filter(file=>/^(?:vendor\/(?:tf\.min|coco-ssd\.min)\.js|models\/ssdlite_mobilenet_v2\/(?:model\.json|group1-shard[1-5]of5))$/.test(file.path));
const allowedAssets=new Set(assets.map(file=>new URL(file.path,base+'/').href));
const withoutQuery=value=>{const url=new URL(value);url.search='';return url.href;};
const report={started_at:new Date().toISOString(),base,cache_name:cacheName,case_filter:process.env.MODEL_LOADING_CASE||null,cases:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});
const controls=page=>page.evaluate(()=>({
 run_disabled:document.querySelector('#run-analysis').disabled,
 file_disabled:document.querySelector('#analysis-file').disabled,
 rule_disabled:document.querySelector('#vision-rule').disabled,
 stop_visible:!document.querySelector('#stop-analysis').hidden,
 message:document.querySelector('#vision-message').textContent,
 model_status:document.querySelector('#model-status').textContent,
 file:document.querySelector('#analysis-file-info').textContent,
 candidates_enabled:!document.querySelector('#send-candidates').disabled,
 results_visible:!document.querySelector('#vision-results').hidden
}));

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 const pages=[];
 const prepareSample=async page=>{await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);await page.locator('#vision-rule').selectOption('access');await page.locator('#vision-camera').fill('模型加载回归');await page.locator('#vision-zone').fill('测试区域');await page.locator('#vision-start').fill('2026-10-16T08:00');await page.locator('#vision-context-confirmed').check();};
 const open=async({disableCache=false,holdCachePut=false}={})=>{
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});pages.push(page);page.setDefaultTimeout(15000);
  page.on('pageerror',error=>report.page_errors.push(error.message));page.on('request',request=>{if(request.url().startsWith('http')&&new URL(request.url()).origin!==new URL(base).origin)report.external_requests.push(request.url());});
  if(disableCache)await page.addInitScript(()=>Object.defineProperty(window,'caches',{configurable:true,get(){throw new DOMException('CacheStorage is disabled for this test','SecurityError');}}));
  if(holdCachePut)await page.addInitScript(()=>{
   const original=Cache.prototype.put;window.__modelCachePutEntered=false;
   Cache.prototype.put=async function(request,response){const url=typeof request==='string'?request:request.url;if(url.includes('/vendor/tf.min.js')&&!window.__modelCachePutEntered){window.__modelCachePutEntered=true;await new Promise(resolve=>window.__releaseModelCachePut=resolve);}return original.call(this,request,response);};
  });
  await page.goto(`${base}/?detector=ssdlite#analyze`);await prepareSample(page);return page;
 };
 const bounded=async(promise,label,ms=15000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${label}`)),ms);})]);}finally{clearTimeout(timer);}};
 const holdShard=async(page,assetPath=shardPath)=>{
  let release,signal,settle,released=false;
  const seen=new Promise(resolve=>signal=resolve),gate=new Promise(resolve=>release=resolve),settled=new Promise(resolve=>settle=resolve),pattern=`**/${assetPath}`;
  await page.route(pattern,async route=>{signal();await gate;try{await route.continue();}catch{}finally{settle();}});
  return {seen:()=>bounded(seen,assetPath),release:async()=>{if(!released){released=true;release();await page.unroute(pattern);}await Promise.race([settled,new Promise(resolve=>setTimeout(resolve,1000))]);}};
 };
 const cancel=async(page,evidence)=>{
  const originalFile=await page.locator('#analysis-file-info').innerText(),started=Date.now();await page.locator('#stop-analysis').click();
  try{await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled&&!document.querySelector('#analysis-file').disabled&&!document.querySelector('#vision-rule').disabled,null,{timeout:1000});}
  catch{evidence.after_cancel_ms=Date.now()-started;evidence.state=await controls(page);await page.screenshot({path:path.join(out,'model-loading-cancel.png'),fullPage:true});throw new Error(`Cancel did not unlock controls within 1 s: ${JSON.stringify(evidence.state)}`);}
  evidence.after_cancel_ms=Date.now()-started;evidence.state=await controls(page);assert.equal(evidence.state.file,originalFile);assert.equal(evidence.state.candidates_enabled,false);assert.equal(evidence.state.results_visible,false);assert.doesNotMatch(evidence.state.message,/^分析完成/);
 };
 const result=async page=>{
  await page.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent),null,{timeout:120000});
  assert.match(await page.locator('#vision-message').innerText(),/^分析完成/);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);const data=JSON.parse(fs.readFileSync(await download.path()));
  assert.equal(data.complete,true);assert.equal(data.frames.length,1);const bus=data.frames[0].detections.find(row=>row.class==='bus');assert.ok(bus?.score>.8,'actual public bus pixels must produce a bus detection');assert.equal(data.candidates.length,1);
  return {score:bus.score,backend:data.backend,frames:data.frames.length,candidates:data.candidates.length,total_ms:data.metrics.total_ms,model_loading:data.model_loading};
 };
 const run=async page=>{await page.locator('#run-analysis').click();return result(page);};
 const modelRequests=page=>{const requests=[];page.on('request',request=>{if(allowedAssets.has(request.url()))requests.push(request.url());});return requests;};
 const cacheKeys=page=>page.evaluate(async name=>{if(!(await caches.keys()).includes(name))throw new Error('Expected public model cache is absent');const cache=await caches.open(name);return (await cache.keys()).map(request=>request.url);},cacheName);
 const test=async(name,body)=>{if(process.env.MODEL_LOADING_CASE&&!process.env.MODEL_LOADING_CASE.split(',').some(fragment=>name.includes(fragment)))return;const entry={name,status:'running',evidence:{}},started=Date.now();report.cases.push(entry);try{await body(entry.evidence);entry.status='passed';console.log(`PASS: ${name}`);}catch(error){entry.status='failed';entry.error=error.message;console.error(`FAIL: ${name}: ${error.message}`);}finally{entry.duration_ms=Date.now()-started;for(const page of pages.splice(0))await page.close();}};
 try{
  await test('cancelling a stalled model shard unlocks the current media within one second',async evidence=>{
   const page=await open(),held=await holdShard(page);
   try{
    await page.locator('#run-analysis').click();await held.seen();await cancel(page,evidence);
    await page.locator('#analysis-file').setInputFiles({name:'取消后重新选择.jpg',mimeType:'image/jpeg',buffer:fs.readFileSync(path.join(root,'web/samples/bus.jpg'))});
    await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪'));const replacement=await controls(page);
    await held.release();await page.waitForTimeout(600);const settled=await controls(page);assert.deepEqual(settled,replacement,'late old download must not overwrite the newer selected media or status');evidence.after_old_request_settles=settled;
   }finally{await held.release();}
  });

  await test('retry after cancellation runs actual bus inference',async evidence=>{
   const page=await open(),held=await holdShard(page);try{await page.locator('#run-analysis').click();await held.seen();await cancel(page,evidence);}finally{await held.release();}
   evidence.retry=await run(page);
  });

  await test('a failed shard shows a recoverable error and a retry succeeds',async evidence=>{
   const page=await open(),pattern=`**/${shardPath}`;let failures=0;await page.route(pattern,route=>{failures++;return route.fulfill({status:500,contentType:'text/plain',body:'Controlled model shard failure'});});
   await page.locator('#run-analysis').click();await page.waitForFunction(()=>document.querySelector('#vision-message').classList.contains('error')&&!document.querySelector('#run-analysis').disabled,null,{timeout:30000});
   evidence.failed_requests=failures;evidence.failure=await controls(page);assert.ok(failures>0);assert.match(evidence.failure.message,/失败|连接|重试/);assert.match(evidence.failure.model_status,/失败|重试/);assert.equal(evidence.failure.file_disabled,false);assert.equal(evidence.failure.rule_disabled,false);assert.equal(evidence.failure.candidates_enabled,false);
   await page.unroute(pattern);evidence.retry=await run(page);
  });

  await test('download progress reports completed bytes while a real shard is still pending',async evidence=>{
   const page=await open(),held=await holdShard(page,'models/ssdlite_mobilenet_v2/group1-shard5of5');
   try{
    await page.locator('#run-analysis').click();await held.seen();
    await page.waitForFunction(()=>{const progress=document.querySelector('#model-load-progress'),detail=document.querySelector('#model-load-detail');return progress&&progress.value>0&&progress.value<progress.max&&detail?.textContent.trim();});
    const snapshot=await page.locator('#model-load-progress').evaluate(element=>({progress:{tag:element.tagName,value:element.value,max:element.max,visible:element.getClientRects().length>0},detail:document.querySelector('#model-load-detail').textContent}));
    evidence.progress=snapshot.progress;evidence.detail=snapshot.detail;assert.equal(evidence.progress.tag,'PROGRESS');assert.equal(evidence.progress.visible,true);assert.match(evidence.detail,/MB|MiB|KB|KiB|字节|%|下载|校验/);
    assert.equal(await page.locator('#run-analysis').isDisabled(),true);assert.equal(await page.locator('#send-candidates').isDisabled(),true);
    await page.screenshot({path:path.join(out,'model-loading-progress.png'),fullPage:true});await held.release();evidence.inference=await result(page);
   }finally{await held.release();}
  });

  await test('a same-context reload uses only validated public model cache entries',async evidence=>{
   const page=await open();evidence.cold=await run(page);const keys=await cacheKeys(page);assert.equal(keys.length,8);assert.ok(keys.every(url=>allowedAssets.has(withoutQuery(url))),`unexpected cached media or non-model resource: ${JSON.stringify(keys)}`);evidence.cache_keys=keys;
   const requests=modelRequests(page);evidence.in_memory=await run(page);assert.equal(evidence.in_memory.model_loading.reused_in_memory,true);assert.equal(evidence.in_memory.model_loading.network_bytes,0);assert.equal(evidence.in_memory.model_loading.cache_bytes,0);assert.equal(evidence.in_memory.model_loading.load_ms,0);assert.deepEqual(requests,[]);assert.ok(Math.abs(evidence.cold.score-evidence.in_memory.score)<1e-8);
   await page.reload();await prepareSample(page);evidence.warm=await run(page);evidence.warm_model_requests=requests;assert.deepEqual(requests,[],'validated CacheStorage reuse must not request model assets again');assert.ok(Math.abs(evidence.cold.score-evidence.warm.score)<1e-8);
  });

  await test('a same-length corrupted cached shard is rejected and downloaded again',async evidence=>{
   const page=await open();evidence.before=await run(page);
   evidence.corrupted=await page.evaluate(async({name,suffix})=>{const cache=await caches.open(name),key=(await cache.keys()).find(request=>new URL(request.url).pathname.endsWith(suffix));if(!key)throw new Error('No shard found to corrupt');const response=await cache.match(key),bytes=new Uint8Array(await response.arrayBuffer());bytes[0]^=1;await cache.put(key,new Response(bytes,{headers:response.headers}));return {url:key.url,bytes:bytes.length};},{name:cacheName,suffix:shardPath});
   const requests=modelRequests(page);await page.reload();await prepareSample(page);evidence.after=await run(page);evidence.model_requests=requests;assert.ok(requests.includes(withoutQuery(evidence.corrupted.url)),'corrupt bytes must trigger a network replacement');
   const restoredHash=await page.evaluate(async({name,url})=>{const cache=await caches.open(name),response=await cache.match(url),hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');},{name:cacheName,url:evidence.corrupted.url});
   assert.equal(restoredHash,assets.find(asset=>asset.path===shardPath).sha256);assert.ok(Math.abs(evidence.before.score-evidence.after.score)<1e-8);evidence.restored_sha256=restoredHash;
  });

  await test('blocked CacheStorage falls back to a real network model load',async evidence=>{
   const page=await open({disableCache:true}),requests=modelRequests(page);evidence.inference=await run(page);evidence.model_requests=requests;assert.ok(requests.includes(new URL(shardPath,base+'/').href));assert.equal(new Set(requests).size,8);evidence.final_state=await controls(page);assert.equal(evidence.final_state.run_disabled,false);
  });

  await test('a hanging cache.put can be cancelled without late state replacement',async evidence=>{
   const page=await open({holdCachePut:true});
   try{
    await page.locator('#run-analysis').click();await page.waitForFunction(()=>window.__modelCachePutEntered===true);await cancel(page,evidence);
    await page.locator('#analysis-file').setInputFiles({name:'缓存等待取消后.jpg',mimeType:'image/jpeg',buffer:fs.readFileSync(path.join(root,'web/samples/bus.jpg'))});
    await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪'));const replacement=await controls(page);
    await page.evaluate(()=>window.__releaseModelCachePut());await page.waitForTimeout(600);const settled=await controls(page);assert.deepEqual(settled,replacement);evidence.after_old_cache_put=settled;
   }finally{await page.evaluate(()=>window.__releaseModelCachePut?.());}
  });
 }finally{
  await browser.close();report.finished_at=new Date().toISOString();report.passed=report.cases.filter(row=>row.status==='passed').length;report.failed=report.cases.filter(row=>row.status==='failed').length;report.ok=report.failed===0&&report.page_errors.length===0&&report.external_requests.length===0;
  fs.writeFileSync(path.join(out,'model-loading-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:'artifacts/model-loading-validation.json',passed:report.passed,failed:report.failed,page_errors:report.page_errors,ok:report.ok}));if(!report.ok)process.exitCode=1;
 }
})().catch(error=>{report.fatal_error=error.message;report.ok=false;fs.writeFileSync(path.join(out,'model-loading-validation.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
