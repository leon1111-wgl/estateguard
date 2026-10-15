/** Exercises real published pixels, model inference, failure recovery and reviews. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(45000);
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const base=process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766',origin=new URL(base).origin;
 page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==origin)external.push(r.url());});
 const out=path.join(__dirname,'../artifacts');fs.mkdirSync(out,{recursive:true});
 await page.goto(base+'/#parking');await page.waitForSelector('.parking-tile');
 assert.equal(await page.locator('.parking-tile').count(),53);
 assert.match(await page.locator('#parking-model-status').textContent(),/已训练/);
 assert.equal(await page.locator('#parking-metrics .metric strong').nth(1).textContent(),'—');
 const run=async()=>{await page.locator('#parking-run').click();await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('当前快照分析完成'));};
 const exportData=async()=>{const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#parking-export').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
 await run();const measured=await exportData();assert.equal(measured.samples.length,53);assert.equal(measured.frame_summary.pending,0);
 const reference=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/data/parking/test-predictions.json'))),lookup=new Map(reference.map(r=>[r.id,r]));
 let maxError=0;for(const row of measured.samples){const ref=lookup.get(row.id);maxError=Math.max(maxError,Math.abs(row.predicted_occupied_score-ref.score));assert.equal(row.dataset_label,ref.label);}
 assert.ok(maxError<1e-10,`Python/Browser scores differ ${maxError}`);
 await page.locator('#parking-show-truth').check();assert.equal(await page.locator('.parking-truth').count(),53);
 await page.locator('#parking-filter').selectOption('errors');assert.equal(await page.locator('.parking-tile').count(),measured.samples.filter(r=>r.prediction!==r.dataset_label).length);
 await page.locator('#parking-filter').selectOption('all');await page.locator('.parking-tile').first().click();
 const selected=await page.locator('.parking-tile[aria-pressed="true"]').getAttribute('data-sample-id');
 await page.locator('#parking-decision').selectOption('busy');await page.locator('#parking-note').fill('人工核对阴影边缘，保留原始模型预测。');
 await page.locator('.parking-tile').nth(1).click();await page.locator('.parking-tile').first().click();assert.match(await page.locator('#parking-note').inputValue(),/阴影/);
 await page.locator('#parking-save').click();const saved=await exportData();assert.equal(saved.reviews[selected].decision,'busy');
 await page.locator('#parking-import').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...saved,model_sha256:'wrong'}))});
 await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('恢复失败'));assert.deepEqual((await exportData()).reviews,saved.reviews);
 await page.locator('#parking-import').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('已恢复'));assert.match(await page.locator('#parking-note').inputValue(),/阴影/);
 // A PNG model input with no label or filename hints produces the same score.
 const own=fs.readFileSync(path.join(__dirname,'../web/data/parking/inputs',selected+'.png'));
 await page.locator('#parking-upload').setInputFiles({name:'unknown-patch.png',mimeType:'image/png',buffer:own});await page.waitForSelector('#parking-upload-result img');
 assert.match(await page.locator('#parking-upload-result').textContent(),new RegExp((lookup.get(selected).score*100).toFixed(2).replace('.','\\.')));
 await page.screenshot({path:path.join(out,'parking-desktop.png'),fullPage:true});
 // Playback must compute the next frame, rather than replay supplied predictions.
 await page.locator('#parking-play').click();await page.waitForFunction(()=>Number(document.querySelector('#parking-frame').value)>0);await page.locator('#parking-play').click();
 await page.waitForFunction(()=>document.querySelector('#parking-stop').hidden);assert.match(await page.locator('#parking-time').textContent(),/距上一张 5 分钟/);
 const played=await exportData();assert.ok(played.samples.length>53);
 // An unavailable image remains unanalysed and retry recovers it.
 await page.locator('#parking-next').click();const failureId=await page.locator('.parking-tile').first().getAttribute('data-sample-id');
 const badPattern='**/inputs/'+failureId+'.png';await page.route(badPattern,route=>route.abort());await run();const failed=await exportData();assert.equal(failed.frame_summary.pending,1);assert.ok(failed.unanalysed_sample_ids.includes(failureId));
 await page.unroute(badPattern);await run();assert.equal((await exportData()).frame_summary.pending,0);
 await page.locator('[data-nav="results"]').click();await page.locator('#parking-load-errors').click();await page.waitForSelector('#parking-error-example');
 assert.equal(await page.locator('#parking-error-example option').count(),1486);const errorId=reference.find(r=>!r.correct).id;
 await page.locator('#parking-error-example').selectOption(errorId);await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('当前快照分析完成'));
 assert.equal(await page.locator('.parking-tile[aria-pressed="true"]').getAttribute('data-sample-id'),errorId);
 await page.locator('[data-nav="workspace"]').click();assert.equal(await page.locator('.event-button').count(),9,'occupancy must not create violation events');
 await page.locator('[data-nav="parking"]').click();await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(out,'parking-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const report={date:new Date().toISOString(),browser:await browser.version(),base,model_sha256:measured.model_sha256,first_frame_samples:53,max_python_js_score_error:maxError,test_errors_accessible:1485,external_requests:0,passed:['real image inference and Python parity','unanalysed counts','labels separate from predictions','all test errors browsable','drafts and review export/restore','invalid import atomicity','unlabelled local image inference','playback inference and original intervals','image failure remains pending and retry succeeds','no violation events generated','approved desktop and 390px layout']};
 fs.writeFileSync(path.join(out,'parking-validation.json'),JSON.stringify(report,null,2));console.log('PASS parking:',JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
