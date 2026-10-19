/** Actual-model score/NMS regression. The two-bus fixture is synthetic, not field evidence. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),out=path.join(__dirname,'../artifacts');
const upstreamBytes=fs.readFileSync(path.join(__dirname,'../tests/fixtures/coco-ssd-2.2.3.upstream.min.js'));
const upstreamHash=crypto.createHash('sha256').update(upstreamBytes).digest('hex');
const assetLock=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/assets.lock.json'))),patchedHash=assetLock.files.find(row=>row.path==='vendor/coco-ssd.min.js').sha256;
const report={started_at:new Date().toISOString(),base,scope:'Real model execution on a public CC0 photo and a synthetic two-copy layout; not real-world accuracy or violation evidence.',baseline_vendor_sha256:'8875b8c1bb57723990c9d6506226e0e51cd21b8b6943eb53201086096de52df5',runs:[],checks:[],page_errors:[],external_requests:[]};
const iou=(a,b)=>{const intersection=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));return intersection/(a[2]*a[3]+b[2]*b[3]-intersection);};
fs.mkdirSync(out,{recursive:true});
const check=(name,body)=>{try{body();report.checks.push({name,passed:true});console.log(`PASS: ${name}`);}catch(error){report.checks.push({name,passed:false,error:error.message});console.error(`FAIL: ${name}: ${error.message}`);}};
const confirmContext=async page=>{await page.locator('#vision-camera').fill('阈值回归公开图片');await page.locator('#vision-zone').fill('测试区域');await page.locator('#vision-start').fill('2026-10-16T08:00');await page.locator('#vision-context-confirmed').check();};

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(30000);page.on('pageerror',error=>report.page_errors.push(error.message));
  page.on('request',request=>{if(request.url().startsWith('http')&&new URL(request.url()).origin!==new URL(base).origin)report.external_requests.push(request.url());});
  await page.goto(`${base}/?detector=ssdlite#analyze`);await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);
  await page.locator('#vision-rule').selectOption('access');await confirmContext(page);
  const run=async(score,fixture,target=page)=>{
   await target.locator('#vision-score').fill(String(score));await target.locator('#run-analysis').click();
   await target.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent),null,{timeout:120000});assert.match(await target.locator('#vision-message').innerText(),/^分析完成/);
   const[download]=await Promise.all([target.waitForEvent('download'),target.locator('#download-detections').click()]);const data=JSON.parse(fs.readFileSync(await download.path()));
   const row={fixture,input_minimum_score:score,detections:data.frames[0].detections,tracks:data.tracks.length,candidates:data.candidates,params:data.params,complete:data.complete,frame_count:data.frames.length};report.runs.push(row);return row;
  };
  const low=await run(.1,'public-bus');await page.screenshot({path:path.join(out,'detection-threshold-low.png'),fullPage:true});const normal=await run(.5,'public-bus'),high=await run(.95,'public-bus');
  await page.screenshot({path:path.join(out,'detection-threshold-high.png'),fullPage:true});
  // Serve the preserved, unmodified upstream runtime and its matching hash to a
  // separate browser context; model weights and image bytes remain real and unchanged.
  const upstream=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});upstream.on('pageerror',error=>report.page_errors.push(error.message));
  upstream.on('request',request=>{if(request.url().startsWith('http')&&new URL(request.url()).origin!==new URL(base).origin)report.external_requests.push(request.url());});
  const legacyLock=structuredClone(assetLock),legacyAsset=legacyLock.files.find(row=>row.path==='vendor/coco-ssd.min.js');legacyAsset.sha256=upstreamHash;legacyAsset.bytes=upstreamBytes.length;
  await upstream.route('**/assets.lock.json',route=>route.fulfill({json:legacyLock}));await upstream.route('**/vendor/coco-ssd.min.js',route=>route.fulfill({body:upstreamBytes,contentType:'text/javascript'}));
  await upstream.goto(`${base}/?detector=ssdlite#analyze`);await upstream.locator('#sample-image').click();await upstream.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);await upstream.locator('#vision-rule').selectOption('access');
  await confirmContext(upstream);
  const baseline=await run(.5,'public-bus-original-coco-ssd-2.2.3',upstream);
  check('default threshold matches actual upstream inference box by box and score by score',()=>{assert.equal(upstreamHash,report.baseline_vendor_sha256);assert.equal(normal.detections.length,baseline.detections.length);assert.equal(normal.candidates.length,baseline.candidates.length);assert.equal(normal.detections.length,1);for(let i=0;i<baseline.detections.length;i++){assert.equal(normal.detections[i].class,baseline.detections[i].class);assert.ok(Math.abs(normal.detections[i].score-baseline.detections[i].score)<1e-6);assert.ok(normal.detections[i].bbox.every((value,index)=>Math.abs(value-baseline.detections[i].bbox[index])<1e-6));}});
  check('a higher minimum score cannot create duplicate bus candidates',()=>{const buses=high.detections.filter(row=>row.class==='bus');if(buses.length>1)report.high_threshold_bus_iou=iou(buses[0].bbox,buses[1].bbox);assert.equal(buses.length,1,`same bus produced ${buses.length} boxes, IoU ${report.high_threshold_bus_iou}`);assert.equal(high.candidates.length,1);assert.equal(high.tracks,1);assert.ok(high.detections.every(row=>row.score>=.95));});
  check('low-score person remains available and higher cutoffs only retain matching detections',()=>{assert.ok(low.detections.some(row=>row.class==='person'&&row.score>=.1&&row.score<.5));for(const [lower,higher] of [[low,normal],[normal,high]])for(const detection of higher.detections)assert.ok(lower.detections.some(previous=>previous.class===detection.class&&iou(previous.bbox,detection.bbox)>.99&&Math.abs(previous.score-detection.score)<.001),'higher cutoff introduced a new object');});
  check('export identifies every actual score and suppression parameter',()=>{for(const row of [low,normal,high]){const p=row.params;assert.equal(p.minimum_score,row.input_minimum_score);assert.equal(p.offset_seconds,0);assert.equal(p.sample_interval_seconds,1);assert.equal(p.max_frames,20);assert.equal(p.max_detections,50);assert.equal(p.nms_iou_threshold,.5);assert.equal(p.postprocess,'coco-ssd-2.2.3-fixed-nms-v1');assert.equal(row.complete,true);assert.equal(row.frame_count,1);}});

  // Two separated copies preserve actual photo pixels but are only a test composition.
  const encoded=await page.evaluate(async()=>{const image=new Image();image.src='samples/bus.jpg';await image.decode();const canvas=document.createElement('canvas');canvas.width=1304;canvas.height=426;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,640,426);ctx.drawImage(image,664,0,640,426);return canvas.toDataURL('image/png').split(',')[1];});
  await page.locator('#analysis-file').setInputFiles({name:'synthetic-two-bus-copies.png',mimeType:'image/png',buffer:Buffer.from(encoded,'base64')});await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪'));
  await confirmContext(page);
  const separated=await run(.5,'synthetic-two-public-photo-copies');await page.screenshot({path:path.join(out,'detection-threshold-separated.png'),fullPage:true});
  check('separated synthetic buses remain separate detections and candidates',()=>{const buses=separated.detections.filter(row=>row.class==='bus');assert.equal(buses.length,2);assert.ok(iou(buses[0].bbox,buses[1].bbox)<.1);assert.equal(separated.candidates.length,2);});

  // The upstream run populated a real old-hash cache entry. Reload that same
  // context against today's manifest, then require the patched script and behavior.
  const scriptURL=new URL('vendor/coco-ssd.min.js',base+'/').href,cacheName='estateguard-public-model-v1';
  const cachedBefore=await upstream.evaluate(async name=>(await(await caches.open(name)).keys()).map(request=>request.url),cacheName);
  await upstream.unroute('**/assets.lock.json');await upstream.unroute('**/vendor/coco-ssd.min.js');const scriptRequests=[];upstream.on('request',request=>{if(request.url()===scriptURL)scriptRequests.push(request.url());});
  await upstream.reload();await upstream.locator('#sample-image').click();await upstream.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);await upstream.locator('#vision-rule').selectOption('access');await confirmContext(upstream);const refreshed=await run(.95,'public-bus-patched-after-old-cache',upstream);
  const cachedAfter=await upstream.evaluate(async name=>(await(await caches.open(name)).keys()).map(request=>request.url),cacheName);report.cache_upgrade={old_sha256:upstreamHash,new_sha256:patchedHash,script_requests:scriptRequests,cached_before:cachedBefore,cached_after:cachedAfter};
  check('old-hash cached runtime is replaced on reload before high-threshold analysis',()=>{assert.notEqual(patchedHash,upstreamHash);assert.ok(cachedBefore.includes(`${scriptURL}?sha256=${upstreamHash}`));assert.equal(scriptRequests.length,1);assert.ok(cachedAfter.includes(`${scriptURL}?sha256=${patchedHash}`));assert.equal(refreshed.detections.filter(row=>row.class==='bus').length,1);assert.equal(refreshed.candidates.length,1);assert.equal(refreshed.params.minimum_score,.95);assert.equal(refreshed.params.nms_iou_threshold,.5);});

  // Simulate the previous release manifest without requiring Git history in a
  // shallow checkout. The historical c199050 red evidence is preserved separately.
  // Today's UI must reject the original runtime before producing a mislabeled report.
  const mixed=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});mixed.on('pageerror',error=>report.page_errors.push(error.message));
  const previousLock=structuredClone(assetLock),previousAsset=previousLock.files.find(row=>row.path==='vendor/coco-ssd.min.js');previousAsset.sha256=upstreamHash;previousAsset.bytes=upstreamBytes.length;for(const key of ['local_patch','upstream_sha256','reproduce'])delete previousAsset[key];
  await mixed.route('**/assets.lock.json',route=>route.fulfill({json:previousLock}));await mixed.route('**/vendor/coco-ssd.min.js',route=>route.fulfill({body:upstreamBytes,contentType:'text/javascript'}));
  await mixed.goto(`${base}/?detector=ssdlite#analyze`);await mixed.locator('#sample-image').click();await mixed.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);await mixed.locator('#vision-rule').selectOption('access');await confirmContext(mixed);await mixed.locator('#vision-score').fill('.95');await mixed.locator('#run-analysis').click();
  await mixed.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent),null,{timeout:120000});
  const mixture=await mixed.evaluate(()=>({message:document.querySelector('#vision-message').textContent,run_disabled:document.querySelector('#run-analysis').disabled,file_disabled:document.querySelector('#analysis-file').disabled,rule_disabled:document.querySelector('#vision-rule').disabled,send_disabled:document.querySelector('#send-candidates').disabled,results_hidden:document.querySelector('#vision-results').hidden}));
  if(mixture.message.startsWith('分析完成')){const[download]=await Promise.all([mixed.waitForEvent('download'),mixed.locator('#download-detections').click()]);mixture.incorrect_report=JSON.parse(fs.readFileSync(await download.path()));}
  report.mixed_deployment=mixture;await mixed.screenshot({path:path.join(out,'detection-threshold-mixed-deployment.png'),fullPage:true});
  await mixed.unroute('**/assets.lock.json');await mixed.unroute('**/vendor/coco-ssd.min.js');const retry=await run(.95,'public-bus-after-mixed-deployment-retry',mixed);
  check('old release manifest is rejected without candidates and corrected resources can be retried',()=>{assert.match(mixture.message,/^分析失败/);assert.equal(mixture.run_disabled,false);assert.equal(mixture.file_disabled,false);assert.equal(mixture.rule_disabled,false);assert.equal(mixture.send_disabled,true);assert.equal(mixture.results_hidden,true);assert.equal(retry.detections.filter(row=>row.class==='bus').length,1);assert.equal(retry.candidates.length,1);assert.equal(retry.params.nms_iou_threshold,.5);});
 }catch(error){report.fatal_error=error.message;console.error(error);}
 finally{
  await browser.close();report.finished_at=new Date().toISOString();report.passed=report.checks.filter(row=>row.passed).length;report.failed=report.checks.filter(row=>!row.passed).length;report.ok=!report.fatal_error&&report.failed===0&&report.page_errors.length===0&&report.external_requests.length===0;
  fs.writeFileSync(path.join(out,'detection-threshold-validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:'artifacts/detection-threshold-validation.json',passed:report.passed,failed:report.failed,fatal_error:report.fatal_error,page_errors:report.page_errors,ok:report.ok}));if(!report.ok)process.exitCode=1;
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
