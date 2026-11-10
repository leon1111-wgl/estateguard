/** 开放词汇慢车道 in a real browser (Actions only: it downloads the real model from Hugging Face and runs it).
 * - Hidden lane (config.shipped false): the panel never appears and nothing is fetched from Hugging Face or jsDelivr.
 * - Shipped lane: no-SIMD browsers see the reason and no button; nothing loads before the click; the confirmation
 *   names the download size; a tampered runtime is refused; cancel keeps the analysis; the real run labels every box
 *   开放词汇检测 · 未核实, feeds the corridor rule and the export; screenshots at 1440 and 375 px, light and dark.
 * Fixture: tests/fixtures/open-vocab/shopping-carts-pd.jpg (Wikimedia Commons, public domain, Jim.henderson 2008).
 * Writes artifacts/open-vocab-check.json and screenshots. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts','open-vocab-check');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const config=JSON.parse(fs.readFileSync(path.join(root,'web/data/open-vocab/config.json'),'utf8'));
const carts={name:'shopping-carts-pd.jpg',mimeType:'image/jpeg',buffer:fs.readFileSync(path.join(root,'tests/fixtures/open-vocab/shopping-carts-pd.jpg'))};
const report={checked_at:new Date().toISOString(),base,shipped:!!config.shipped,checks:[],page_errors:[],console_errors:[],lane_requests:[],other_external:[]};
const test=async(name,fn)=>{const evidence={};try{await fn(evidence);report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}catch(e){report.checks.push({name,passed:false,error:e.message,evidence});console.error('FAIL: '+name+': '+e.message);}};
const noSimd=()=>{const probe=[0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11],validate=WebAssembly.validate;WebAssembly.validate=function(bytes){const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes.buffer||bytes);if(b.length===probe.length&&probe.every((x,i)=>b[i]===x))return false;return validate.apply(this,arguments);};};
const LANE=/huggingface\.co|hf\.co|xethub|cdn\.jsdelivr\.net/;
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 const open=async({simd=true,width=1440,height=1000,scheme='light'}={})=>{const context=await browser.newContext({viewport:{width,height},colorScheme:scheme,acceptDownloads:true});const p=await context.newPage();p.setDefaultTimeout(180000);p.on('dialog',d=>d.accept());
  p.on('pageerror',e=>report.page_errors.push(e.message));p.on('console',m=>{if(m.type()==='error')report.console_errors.push(m.text());});
  p.requests=[];p.on('request',r=>{const u=r.url();if(!u.startsWith('http')||new URL(u).origin===origin)return;p.requests.push(u);(LANE.test(u)?report.lane_requests:report.other_external).push(u);});
  if(!simd)await p.addInitScript(noSimd);await p.goto(base+'/#analyze');return p;};
 // Open the cart photo, pick the corridor rule with placeholder context (whole frame), analyse with SSDLite.
 const analyse=async(p,rule='access')=>{
  await p.locator('#analysis-file').setInputFiles(carts);
  await p.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪'));
  await p.locator('#vision-detector').selectOption('ssdlite');await p.locator('#vision-rule').selectOption(rule);
  if(rule!=='objects'){await p.locator('#vision-camera').fill('检查');await p.locator('#vision-zone').fill('一号通道');await p.locator('#vision-start').fill('2026-11-10T08:00');await p.locator('#vision-context-confirmed').check();}
  await p.locator('#run-analysis').click();await p.waitForFunction(()=>/^分析完成/.test(document.querySelector('#vision-message').textContent));};
 const exportJSON=async p=>{const [d]=await Promise.all([p.waitForEvent('download'),p.locator('#download-detections').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
 const laneDone=p=>p.waitForFunction(()=>/^(找到|慢车道没有找到|慢车道未能运行|已取消下载)/.test(document.querySelector('#ovd-message').textContent),null,{timeout:900000});
 try{
  if(!config.shipped){
   await test('hidden lane: no panel after a still-image analysis and nothing fetched for it',async ev=>{
    const p=await open();await analyse(p,'objects');await p.waitForTimeout(500);
    ev.panel_hidden=await p.locator('#ovd-panel').isHidden();assert.ok(ev.panel_hidden);assert.deepEqual(p.requests.filter(u=>LANE.test(u)),[]);await p.context().close();});
  }else{
   await test('no SIMD: the panel says why and offers no button; nothing is fetched',async ev=>{
    const p=await open({simd:false});await analyse(p);
    ev.reason=await p.locator('#ovd-unavailable').textContent();assert.match(ev.reason,/WebAssembly SIMD/);
    assert.ok(await p.locator('#ovd-start').isHidden());assert.deepEqual(p.requests.filter(u=>LANE.test(u)),[]);
    await p.screenshot({path:path.join(out,'no-simd-1440-light.png'),fullPage:true});await p.context().close();});
   await test('the panel is hidden before any analysis',async ev=>{
    const p=await open();ev.offered_before_any_analysis=!(await p.locator('#ovd-panel').isHidden());assert.equal(ev.offered_before_any_analysis,false);await p.context().close();});
   await test('nothing loads before the click; the confirmation names the size; dismiss keeps the analysis',async ev=>{
    const p=await open();await analyse(p);assert.ok(await p.locator('#ovd-panel').isVisible());
    await p.locator('#ovd-start').click();ev.confirm=await p.locator('#ovd-confirm-text').textContent();assert.match(ev.confirm,/约 \d+ MB/);assert.match(ev.confirm,/Hugging Face/);
    assert.deepEqual(p.requests.filter(u=>LANE.test(u)),[]);await p.locator('#ovd-dismiss').click();assert.ok(await p.locator('#ovd-confirm').isHidden());assert.ok(await p.locator('#vision-results').isVisible());await p.context().close();});
   await test('a tampered runtime is refused before use',async ev=>{
    const p=await open();await p.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:'export const tampered=true;'}));
    await analyse(p);await p.locator('#ovd-start').click();await p.locator('#ovd-load').click();await laneDone(p);
    ev.message=await p.locator('#ovd-message').textContent();assert.match(ev.message,/完整性校验失败/);assert.ok(await p.locator('#vision-results').isVisible());await p.context().close();});
   await test('cancel during the download keeps the analysis and says so',async ev=>{
    const p=await open();await p.route(/\.onnx($|\?)/,async r=>{await new Promise(s=>setTimeout(s,15000));await r.continue().catch(()=>{});});
    await analyse(p);await p.locator('#ovd-start').click();await p.locator('#ovd-load').click();
    await p.waitForFunction(()=>/正在下载/.test(document.querySelector('#ovd-message').textContent));await p.locator('#ovd-cancel').click();await laneDone(p);
    ev.message=await p.locator('#ovd-message').textContent();assert.match(ev.message,/^已取消下载/);assert.ok(await p.locator('#vision-results').isVisible());await p.context().close();});
   await test('real run: every box labelled 未核实, corridor rule candidates, export; 1440 and 375, light and dark',async ev=>{
    const p=await open();await analyse(p);const before=(await exportJSON(p)).candidates.length;
    await p.locator('#ovd-start').click();await p.locator('#ovd-load').click();const t0=Date.now();await laneDone(p);ev.first_run_s=(Date.now()-t0)/1000;
    ev.message=await p.locator('#ovd-message').textContent();assert.match(ev.message,/^(找到|慢车道没有找到)/,ev.message);
    const rows=await p.locator('#ovd-rows tr').allTextContents();ev.rows=rows;for(const r of rows)assert.match(r,/开放词汇检测 · 未核实/);
    const exported=await exportJSON(p);ev.open_vocab=exported.open_vocab&&{model:exported.open_vocab.model,revision:exported.open_vocab.revision,threshold:exported.open_vocab.threshold,detections:exported.open_vocab.detections.length,label:exported.open_vocab.label};
    assert.equal(exported.open_vocab.label,'开放词汇检测 · 未核实');assert.equal(exported.open_vocab.detections.length,rows.length);
    const lane=exported.candidates.filter(c=>c.source==='open_vocab');ev.lane_candidates=lane.length;ev.coco_candidates=before;
    assert.equal(exported.candidates.length-before,lane.length);for(const c of lane){assert.equal(c.quality,.3);assert.match(c.summary,/^开放词汇检测 · 未核实/);}
    if(!rows.length)assert.match(ev.message,/没有结果不等于安全/);
    await p.screenshot({path:path.join(out,'lane-1440-light.png'),fullPage:true});
    for(const [width,height,scheme] of [[1440,1000,'dark'],[375,812,'light'],[375,812,'dark']]){await p.setViewportSize({width,height});await p.emulateMedia({colorScheme:scheme});await p.locator('#ovd-panel').scrollIntoViewIfNeeded();
     const overflow=await p.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);ev[`overflow_${width}_${scheme}`]=overflow;assert.ok(overflow<=1,`horizontal overflow ${overflow}px at ${width} ${scheme}`);
     await p.screenshot({path:path.join(out,`lane-${width}-${scheme}.png`),fullPage:true});}
    // Second analysis in the same tab at 375 px: the model is in memory, so the lane runs without a new download.
    await analyse(p,'lift');const t1=Date.now();await p.locator('#ovd-start').click();await laneDone(p);ev.second_run_s=(Date.now()-t1)/1000;
    ev.second_message=await p.locator('#ovd-message').textContent();assert.match(ev.second_message,/^(找到|慢车道没有找到)/);
    await p.screenshot({path:path.join(out,'lane-375-dark-lift.png'),fullPage:true});await p.context().close();});
  }
  await test('no page errors; lane requests only to Hugging Face and jsDelivr; nothing else external',async ev=>{
   ev.page_errors=report.page_errors;ev.console_errors=report.console_errors;ev.other_external=report.other_external;ev.lane_hosts=[...new Set(report.lane_requests.map(u=>new URL(u).host))];
   assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.other_external,[]);
   // Expected console errors: the tampered-runtime and cancelled-download checks make fetches fail on purpose.
   assert.ok(report.console_errors.every(m=>/Failed to load resource|ERR_ABORTED|AbortError/.test(m)),report.console_errors.join(' | '));});
 }finally{await browser.close();}
 fs.writeFileSync(path.join(root,'artifacts','open-vocab-check.json'),JSON.stringify(report,null,1));
 const failed=report.checks.filter(c=>!c.passed);console.log(`${report.checks.length-failed.length}/${report.checks.length} passed`);if(failed.length)process.exit(1);
})().catch(e=>{console.error(e);process.exit(1);});
