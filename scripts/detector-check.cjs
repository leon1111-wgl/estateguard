/** Real-browser acceptance for the detector choice on the analysis page: D-FINE-N and SSDLite on the
 * CC0 sample, exported settings, rule candidates, switching, results table and phone layout.
 * Run with ESTATEGUARD_URL, PLAYWRIGHT_MODULE and CHROME_PATH when needed. Writes artifacts/detector-validation.json.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const evaluation=JSON.parse(fs.readFileSync(path.join(root,'web/data/detector/evaluation.json')));
const report={checked_at:new Date().toISOString(),base,steps:{},ok:false};
const step=(name,value)=>{report.steps[name]=value;console.log(name,JSON.stringify(value).slice(0,260));};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(120000);
  const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==origin)external.push(r.url());});
  report.browser=await browser.version();
  await page.goto(base+'/#analyze');
  // The published default and its score floor are applied once the evaluation record loads.
  const expected=evaluation.default_decision.default;
  await page.waitForFunction(()=>!/评测记录加载后/.test(document.querySelector('#vision-detector-help').textContent));
  assert.equal(await page.locator('#vision-detector').inputValue(),expected);
  assert.equal(Number(await page.locator('#vision-score').inputValue()),expected==='dfine'?evaluation.models.dfine.operating_threshold:.5);
  // Untouched floors follow the detector: D-FINE 0.6, SSDLite 0.5.
  await page.locator('#vision-detector').selectOption('ssdlite');assert.equal(Number(await page.locator('#vision-score').inputValue()),.5);
  await page.locator('#vision-detector').selectOption('dfine');assert.equal(Number(await page.locator('#vision-score').inputValue()),evaluation.models.dfine.operating_threshold);
  // The lift rule shows the bulky-item precision warning from the published per-class counts.
  await page.locator('#vision-rule').selectOption('lift');assert.match(await page.locator('#vision-detector-help').textContent(),/客梯大件 6 类.*精确率/);await page.locator('#vision-rule').selectOption('objects');
  step('default',{detector:expected,score:await page.locator('#vision-score').inputValue(),help:await page.locator('#vision-detector-help').textContent()});
  const exportReport=async()=>{const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
  const analyse=async()=>{await page.locator('#run-analysis').click();await page.waitForFunction(()=>/^分析完成/.test(document.querySelector('#vision-message').textContent));return exportReport();};
  await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);
  const runs={};
  for(const key of ['dfine','ssdlite']){
   await page.locator('#vision-detector').selectOption(key);await page.locator('#vision-score').fill('0.5');
   const r=await analyse(),bus=r.frames[0].detections.filter(d=>d.class==='bus').sort((a,b)=>b.score-a.score)[0];
   assert.equal(r.params.detector,key);assert.equal(r.params.postprocess,key==='dfine'?'dfine-topk-dedupe090-v1':'coco-ssd-2.2.3-fixed-nms-v1');assert.equal(r.params.nms_iou_threshold,key==='dfine'?null:.5);
   assert.ok(bus&&bus.score>.9,`${key} bus score ${bus?.score}`);assert.ok(r.model.includes(key==='dfine'?'D-FINE':'SSDLite'));
   runs[key]={bus_score:bus.score,bus_bbox:bus.bbox,detections:r.frames[0].detections.length,backend:r.backend,inference_ms:r.metrics.mean_inference_ms,model_loading:r.model_loading};
  }
  // Same bus, two detectors: boxes overlap strongly.
  const [a,b]=[runs.dfine.bus_bbox,runs.ssdlite.bus_bbox],ix=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),iy=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1])),iou=ix*iy/(a[2]*a[3]+b[2]*b[3]-ix*iy);
  assert.ok(iou>.8,`bus boxes disagree ${iou}`);
  step('sample_both_detectors',{...runs,bus_iou:iou});
  // Switching back reuses the loaded model; a score floor the user typed is never overwritten.
  await page.locator('#vision-score').fill('0.45');
  await page.locator('#vision-detector').selectOption('dfine');assert.equal(Number(await page.locator('#vision-score').inputValue()),.45);
  await page.locator('#vision-detector').selectOption('ssdlite');await page.locator('#vision-detector').selectOption('dfine');assert.equal(Number(await page.locator('#vision-score').inputValue()),.45);
  const again=await analyse();assert.equal(again.model_loading.reused_in_memory,true);
  // The model bar follows the selection: each loaded detector shows its own backend, no stale progress.
  for(const [key,pattern] of [['ssdlite',/WEBGL/],['dfine',/WASM/]]){await page.locator('#vision-detector').selectOption(key);assert.match(await page.locator('#model-backend').textContent(),pattern);assert.equal(await page.locator('#model-loading').isHidden(),true);assert.match(await page.locator('#vision-score-help').textContent(),key==='dfine'?/IoU ≥ 0.9/:/按固定规则合并/);}
  // Rule candidates still come from the shared tracking/rule code.
  await page.locator('#vision-rule').selectOption('access');await page.locator('#vision-camera').fill('验收脚本');await page.locator('#vision-zone').fill('示例通道');await page.locator('#vision-start').fill('2026-10-19T09:00');
  await page.locator('#vision-context-confirmed').check();const ruled=await analyse();
  assert.ok(ruled.candidates.length>=1,'vehicle-in-zone rule should flag the bus');assert.ok(ruled.candidates.every(c=>c.category==='blocked_access'||c.category));
  step('rule_and_reuse',{reused_in_memory:again.model_loading.reused_in_memory,candidates:ruled.candidates.length,first:ruled.candidates[0]?.category});
  await page.screenshot({path:path.join(out,'detector-analyze-1440.png')});
  await page.goto(base+'/#results');await page.waitForFunction(()=>document.querySelector('#detector-evaluation-content table'));
  const text=await page.locator('#detector-evaluation-content').textContent();assert.ok(text.includes('D-FINE-N')&&text.includes('SSDLite'));
  await page.locator('#detector-evaluation').screenshot({path:path.join(out,'detector-results-1440.png')});
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true});phone.on('pageerror',e=>errors.push(e.message));
  await phone.goto(base+'/#analyze');await phone.waitForFunction(()=>!/评测记录加载后/.test(document.querySelector('#vision-detector-help').textContent));
  const w1=await phone.evaluate(()=>document.documentElement.scrollWidth);await phone.locator('#vision-detector').scrollIntoViewIfNeeded();await phone.screenshot({path:path.join(out,'detector-analyze-390.png')});
  await phone.goto(base+'/#results');await phone.waitForFunction(()=>document.querySelector('#detector-evaluation-content table'));
  const w2=await phone.evaluate(()=>document.documentElement.scrollWidth);await phone.locator('#detector-evaluation').screenshot({path:path.join(out,'detector-results-390.png')});
  assert.ok(w1<=390&&w2<=390,`phone overflow ${w1}/${w2}`);
  step('results_and_phone',{tables:await page.locator('#detector-evaluation-content table').count(),analyze_scroll_width:w1,results_scroll_width:w2});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);report.ok=true;
 }finally{await browser.close();fs.writeFileSync(path.join(out,'detector-validation.json'),JSON.stringify(report,null,2));}
 console.log('PASS detector-check');
})().catch(error=>{report.fatal_error=error.message;fs.writeFileSync(path.join(out,'detector-validation.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
