/** Human-review workflow acceptance against real browser UI and public parking pixels.
 * No inference is mocked and no held-out score is used to choose model parameters.
 * Run with ESTATEGUARD_URL, PLAYWRIGHT_MODULE and CHROME_PATH when needed.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const root=path.join(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'web/data/parking/manifest.json')));
const firstIds=manifest.frames[0].sample_ids;
const first='B-20150708-0805-1',ambiguous='B-20150708-0805-35';
const out=path.join(root,'artifacts');
const report={started_at:new Date().toISOString(),base,model_sha256:manifest.model_sha256,cases:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});
const envelope=reviews=>({format:'estateguard-parking-review',version:1,model_sha256:manifest.model_sha256,reviews});
const record=(decision,note)=>({decision,note,at:'2026-10-16T00:00:00.000Z'});

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 report.browser=await browser.version();
 const pages=[];
 const open=async(viewport={width:1440,height:1000})=>{
  const page=await browser.newPage({viewport,acceptDownloads:true});pages.push(page);page.setDefaultTimeout(15000);
  page.on('pageerror',error=>report.page_errors.push(error.message));
  page.on('request',request=>{if(request.url().startsWith('http')&&new URL(request.url()).origin!==new URL(base).origin)report.external_requests.push(request.url());});
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(`${base}/#parking`);await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53);await page.locator('#parking-model-choice').selectOption('mlp32');
  return page;
 };
 const run=async page=>{await page.locator('#parking-run').click();await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('当前快照分析完成'));};
 const ids=async page=>page.locator('.parking-tile').evaluateAll(nodes=>nodes.map(node=>node.dataset.sampleId));
 const selected=async page=>page.locator('.parking-tile[aria-pressed="true"]').getAttribute('data-sample-id');
 const filter=async(page,value)=>{
  assert.equal(await page.locator(`#parking-filter option[value="${value}"]`).count(),1,`missing ${value} filter`);
  await page.locator('#parking-filter').selectOption(value);return ids(page);
 };
 const choose=async(page,id)=>{await filter(page,'all');await page.locator(`[data-sample-id="${id}"]`).click();};
 const form=async(page,decision,note)=>{await page.locator('#parking-decision').selectOption(decision);await page.locator('#parking-note').fill(note);};
 const save=async(page,decision,note)=>{await form(page,decision,note);await page.locator('#parking-save').click();};
 const progress=async(page,completed)=>{
  assert.equal(await page.locator('#parking-review-progress').count(),1,'missing human-review progress');
  const value=await page.locator('#parking-review-progress').innerText();
  assert.match(value,new RegExp(`(?:已完成|已复核|已确认|完成)\\s*[：:]?\\s*${completed}\\s*(?:/|／|个?\\s*[,，·]\\s*(?:共|总计))\\s*53`),`unexpected progress: ${value}`);
  return value;
 };
 const exportData=async page=>{
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#parking-export').click()]);
  const buffer=fs.readFileSync(await download.path());return {buffer,data:JSON.parse(buffer)};
 };
 const restore=async(page,data,name='review.json')=>{
  const buffer=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data));
  await page.locator('#parking-import').setInputFiles({name,mimeType:'application/json',buffer});
  await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('已恢复人工复核'));
 };
 const nextButton=async page=>assert.equal(await page.locator('#parking-save-next').count(),1,'missing save-and-next action');
 const test=async(name,body)=>{
  const start=Date.now(),entry={name,status:'running'};report.cases.push(entry);
  try{entry.evidence=await body();entry.status='passed';console.log(`PASS: ${name}`);}
  catch(error){entry.status='failed';entry.error=error.message;console.error(`FAIL: ${name}: ${error.message}`);}
  finally{entry.duration_ms=Date.now()-start;for(const page of pages.splice(0))await page.close();}
 };
 try{
  // Catches model confidence silently completing untouched human-review work.
  await test('all untouched samples need human review regardless of model confidence',async()=>{
   const page=await open();await run(page);
   const pending=await filter(page,'review');assert.equal(pending.length,53);assert.ok(pending.includes(first));assert.ok(pending.includes(ambiguous));
   const humanProgress=await progress(page,0);const modelOnly=await filter(page,'model_uncertain');assert.deepEqual(modelOnly,[ambiguous]);
   const measured=(await exportData(page)).data;assert.equal(measured.samples.length,53);
   const score=measured.samples.find(row=>row.id===first).predicted_occupied_score;assert.ok(score<.035);
   return {human_pending:pending.length,human_progress:humanProgress,model_uncertain:modelOnly,low_score:score};
  });

  // Catches premature completion from drafts and failure to reopen saved work.
  await test('only saved conclusions close work and a saved pending decision reopens it',async()=>{
   const page=await open();await run(page);await choose(page,ambiguous);await form(page,'busy','已查看原图，确认车辆占用。');
   assert.ok((await filter(page,'review')).includes(ambiguous));await progress(page,0);
   await page.locator(`[data-sample-id="${ambiguous}"]`).click();assert.equal(await page.locator('#parking-note').inputValue(),'已查看原图，确认车辆占用。');
   await page.locator('#parking-save').click();const after=await ids(page);assert.equal(after.length,52);assert.ok(!after.includes(ambiguous));await progress(page,1);
   assert.deepEqual(await filter(page,'confirmed'),[ambiguous]);await page.locator(`[data-sample-id="${ambiguous}"]`).click();
   await form(page,'pending','重新检查遮挡部分。');await progress(page,1);await page.locator('#parking-save').click();
   const reopened=await filter(page,'review');assert.equal(reopened.length,53);assert.ok(reopened.includes(ambiguous));await progress(page,0);
   return {closed_pending:52,reopened_pending:53,sample:ambiguous};
  });

  // Catches a human request for evidence disappearing behind a low model score.
  await test('uncertain human conclusions remain actionable on confident model predictions',async()=>{
   const page=await open();await run(page);await choose(page,first);await save(page,'uncertain','阴影遮挡，交给下一班现场核查。');
   assert.ok((await filter(page,'review')).includes(first));assert.deepEqual(await filter(page,'evidence'),[first]);
   assert.deepEqual(await filter(page,'confirmed'),[]);await progress(page,0);
   const saved=(await exportData(page)).data;assert.equal(saved.reviews[first].decision,'uncertain');assert.ok(saved.samples.find(row=>row.id===first).predicted_occupied_score<.035);
   return {needs_evidence:first,model_score_unchanged:true};
  });

  // Catches loss of the human work queue across an actual download and restoration.
  await test('export and restore preserve completed and unfinished review sets',async()=>{
   const page=await open();await run(page);const baseline=(await exportData(page)).data;
   const entries=[[firstIds[0],'busy'],[firstIds[1],'free'],[firstIds[2],'uncertain'],[firstIds[3],'pending']];
   for(const [id,decision] of entries){await choose(page,id);await save(page,decision,`交班记录：${decision}`);}
   const before={review:await filter(page,'review'),confirmed:await filter(page,'confirmed'),evidence:await filter(page,'evidence')};
   assert.equal(before.review.length,51);assert.deepEqual(before.confirmed,firstIds.slice(0,2));assert.deepEqual(before.evidence,[firstIds[2]]);await progress(page,2);
   const exported=await exportData(page),expectedSummary={total:53,confirmed:2,pending:50,needs_evidence:1};
   assert.deepEqual(exported.data.review_summary,expectedSummary);assert.deepEqual(exported.data.samples,baseline.samples);assert.deepEqual(exported.data.frame_summary,baseline.frame_summary);
   const restored=await open();await restore(restored,exported.buffer);
   const after={review:await filter(restored,'review'),confirmed:await filter(restored,'confirmed'),evidence:await filter(restored,'evidence')};
   assert.deepEqual(after,before);await progress(restored,2);
   const recovered=(await exportData(restored)).data;assert.deepEqual(recovered.reviews,exported.data.reviews);assert.equal(recovered.samples.length,0,'restoration must not turn old scores into new inference');assert.deepEqual(recovered.review_summary,expectedSummary);
   const misleading={...exported.data,review_summary:{total:53,confirmed:53,pending:0,needs_evidence:0},frame_summary:{total:53,free:53,busy:0,uncertain:0,pending:0}};
   await restore(restored,misleading,'misleading-summary.json');await progress(restored,2);
   const regenerated=(await exportData(restored)).data;assert.deepEqual(regenerated.review_summary,expectedSummary);assert.equal(regenerated.frame_summary.pending,53);assert.deepEqual(await filter(restored,'review'),before.review);
   return {completed:2,pending:51,needs_evidence:1,restored_review_records:Object.keys(recovered.reviews).length,review_summary:expectedSummary,untrusted_summary_recomputed:true,model_results_unchanged:true};
  });

  // Catches same-slot joins incorrectly carrying a decision into a different time.
  await test('the same slot in the next snapshot starts a separate review',async()=>{
   const page=await open();await choose(page,first);await save(page,'busy','仅确认当前 08:05 快照。');await progress(page,1);
   await page.locator('#parking-next').click();assert.equal(await page.locator('#parking-frame').inputValue(),'1');
   assert.equal(await selected(page),'B-20150708-0810-1');assert.equal(await page.locator('#parking-decision').inputValue(),'pending');assert.equal(await page.locator('#parking-note').inputValue(),'');
   assert.equal((await filter(page,'review')).length,53);await progress(page,0);
   await page.locator('#parking-prev').click();await choose(page,first);assert.equal(await page.locator('#parking-decision').inputValue(),'busy');assert.equal(await page.locator('#parking-note').inputValue(),'仅确认当前 08:05 快照。');
   return {previous:first,next:'B-20150708-0810-1',next_pending:53};
  });

  // Catches save-and-next advancing after a rejected save or losing an invalid draft.
  await test('failed save-and-next preserves the draft and successful save advances once',async()=>{
   const page=await open();await nextButton(page);await choose(page,first);await form(page,'busy','');await page.locator('#parking-save-next').click();
   assert.equal(await selected(page),first);assert.equal(await page.locator('#parking-decision').inputValue(),'busy');assert.equal(await page.locator('#parking-note').inputValue(),'');await progress(page,0);
   const error=await page.locator('#parking-review-message').innerText();assert.match(error,/理由|说明|无效|填写/);
   await choose(page,firstIds[1]);await choose(page,first);assert.equal(await page.locator('#parking-decision').inputValue(),'busy');
   await page.locator('#parking-note').fill('补齐理由后确认占用。');await page.locator('#parking-save-next').click();
   assert.equal(await selected(page),firstIds[1]);assert.equal(await page.locator('#parking-frame').inputValue(),'0');await progress(page,1);
   assert.equal(await page.locator('#parking-decision').inputValue(),'pending');assert.equal(await page.locator('#parking-note').inputValue(),'');
   const saved=(await exportData(page)).data;assert.equal(saved.reviews[first].note,'补齐理由后确认占用。');assert.equal(saved.reviews[first].decision,'busy');
   return {rejected_sample:first,error,next_sample:firstIds[1],completed:1};
  });

  // Catches falsely marking pending/uncertain as complete or advancing the time axis.
  await test('save-and-next keeps unresolved work and completes the frame without crossing time',async()=>{
   const page=await open();await nextButton(page);
   const reviews=Object.fromEntries(firstIds.filter(id=>id!==first).map(id=>[id,record('free','已核对当前快照。')]));await restore(page,envelope(reviews));await choose(page,first);
   await form(page,'uncertain','仅剩此项，仍需补证据。');await page.locator('#parking-save-next').click();
   assert.equal(await selected(page),first);await progress(page,52);assert.equal(await page.locator('#parking-frame').inputValue(),'0');
   assert.deepEqual(await filter(page,'review'),[first]);await page.locator(`[data-sample-id="${first}"]`).click();
   await form(page,'busy','已经补查，确认占用。');await page.locator('#parking-save-next').click();
   await progress(page,53);assert.equal(await page.locator('#parking-frame').inputValue(),'0');assert.deepEqual(await filter(page,'review'),[]);
   const message=await page.locator('#parking-review-message').innerText();assert.match(message,/完成|全部.*复核/);
   return {unresolved_remaining:1,completed:53,frame_index:0,message};
  });

  // Catches the phone workflow jumping from the review card back to the tile list.
  await test('mobile save-and-next continues in the same review card',async()=>{
   const page=await open({width:390,height:844});await nextButton(page);await choose(page,first);await form(page,'free','手机端核对完成。');await page.locator('#parking-save-next').click();
   assert.equal(await selected(page),firstIds[1]);await progress(page,1);assert.equal(await page.locator('#parking-frame').inputValue(),'0');
   const box=await page.locator('.parking-review').boundingBox();assert.ok(box.y>=-20&&box.y<422,`review card moved out of mobile context: ${box.y}`);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(out,'parking-review-mobile.png'),fullPage:true});
   return {viewport:390,next_sample:firstIds[1],review_top:box.y};
  });

  // Catches the playback timer moving away from an invalid manual-review draft.
  await test('failed manual save pauses playback and retains the current snapshot and draft',async()=>{
   const page=await open();await nextButton(page);await page.locator('#parking-play').click();
   await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('当前快照分析完成')&&!document.querySelector('#parking-save-next').disabled);
   await choose(page,first);await form(page,'busy','');await page.locator('#parking-save-next').click();
   const error=await page.locator('#parking-review-message').innerText();assert.match(error,/理由|说明|无效|填写/);
   const snapshot=async()=>({frame:await page.locator('#parking-frame').inputValue(),sample:await selected(page),decision:await page.locator('#parking-decision').inputValue(),note:await page.locator('#parking-note').inputValue(),playing:await page.locator('#parking-play').getAttribute('aria-pressed')});
   const before=await snapshot();assert.equal(before.frame,'0');assert.equal(before.sample,first);
   // The real automatic advance interval is 1.8 s; observe its effect rather than mocking timers.
   await page.waitForTimeout(2300);const after=await snapshot(),evidence=JSON.stringify({before,after,error});
   assert.equal(after.frame,'0',evidence);assert.equal(after.sample,first,evidence);assert.equal(after.decision,'busy',evidence);assert.equal(after.note,'',evidence);assert.equal(after.playing,'false',evidence);await progress(page,0);
   return {before,after,error,observed_interval_ms:2300};
  });
 }finally{
  await browser.close();report.finished_at=new Date().toISOString();report.passed=report.cases.filter(row=>row.status==='passed').length;report.failed=report.cases.filter(row=>row.status==='failed').length;
  report.ok=report.failed===0&&report.page_errors.length===0&&report.external_requests.length===0;
  fs.writeFileSync(path.join(out,'parking-review-validation.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:'artifacts/parking-review-validation.json',passed:report.passed,failed:report.failed,page_errors:report.page_errors,external_requests:report.external_requests,ok:report.ok}));
  if(!report.ok)process.exitCode=1;
 }
})().catch(error=>{report.fatal_error=error.message;report.ok=false;fs.writeFileSync(path.join(out,'parking-review-validation.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
