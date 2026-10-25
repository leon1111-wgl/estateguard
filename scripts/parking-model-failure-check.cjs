/** Actual parking model failure isolation. Public pixels and original models; controlled HTTP faults only. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const reportName=process.env.PARKING_FAILURE_REPORT||'parking-model-failure-validation.json';
fs.mkdirSync(out,{recursive:true});
const report={at:new Date().toISOString(),base,previous_baseline_commit:'3ba5132',baseline_report:'parking-model-failure-validation.red.json',scope:'Actual MLP32 and DINOv2 inference on public CNRPark images. Controlled HTTP500 faults do not replace pixels, model weights or successful model outputs. Workflow checks are not accuracy claims.',checks:[],page_errors:[],external_requests:[]};
const check=(name,evidence,fn)=>{try{fn();report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}catch(e){report.checks.push({name,passed:false,error:e.message,evidence});console.error('FAIL: '+name+': '+e.message);}};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 report.browser=await browser.version();
 try{
  const newPage=async()=>{const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});p.setDefaultTimeout(180000);p.on('dialog',d=>d.accept());p.on('pageerror',e=>report.page_errors.push(e.message));p.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==new URL(base).origin)report.external_requests.push(r.url());});await p.goto(base+'/#parking');await p.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53&&document.getElementById('parking-model-choice').value==='dinov2');return p;};
  const p=await newPage();
  const ids=await p.locator('.parking-tile').evaluateAll(ts=>ts.map(t=>t.dataset.sampleId)),[id,otherId]=ids;report.sample_ids={dino_fault:id,mlp_fault:otherId};
  const exportData=async(target=p)=>{const[d]=await Promise.all([target.waitForEvent('download'),target.locator('#parking-export').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
  const inspect=async(sample=id,target=p)=>({model:await target.locator('#parking-model-choice').inputValue(),tile:await target.locator('.parking-tile[data-sample-id="'+sample+'"]').textContent(),detail:await target.locator('#parking-detail').textContent(),message:await target.locator('#parking-message').textContent()});
  const run=async()=>{await p.locator('#parking-run').click();await p.waitForFunction(()=>document.getElementById('parking-message').textContent.startsWith('当前快照分析完成')&&document.getElementById('parking-stop').hidden);};
  const summarize=d=>({model:d.prediction_model,samples:d.samples.filter(r=>r.id===id||r.id===otherId),sample_count:d.samples.length,failures:d.failures,failures_by_model:d.failures_by_model,evidence_failures:d.evidence_failures,frame_summary:d.frame_summary,unanalysed_sample_ids:d.unanalysed_sample_ids});
  const choose=async(sample,target=p)=>{await target.locator('.parking-tile[data-sample-id="'+sample+'"]').click();await target.waitForFunction(id=>{const image=document.getElementById('parking-evidence-image');return image?.dataset.evidenceSampleId===id&&image.complete&&image.naturalWidth>0;},sample);};
  const save=async(decision,note)=>{await p.locator('#parking-decision').selectOption(decision);await p.locator('#parking-note').fill(note);await p.locator('#parking-save').click();await p.waitForFunction(()=>document.getElementById('parking-review-message').textContent.startsWith('已保存'));};
  const shot=async(name)=>p.screenshot({path:path.join(out,reportName.replace(/\.json$/,'')+'-'+name+'.png'),fullPage:true});

  await p.locator('#parking-model-choice').selectOption('mlp32');await run();const initial=await exportData();
  const refs=new Map(JSON.parse(fs.readFileSync(path.join(root,'web/data/parking/test-predictions.json'))).map(r=>[r.id,r]));
  const maxDiff=Math.max(...initial.samples.map(r=>Math.abs(r.predicted_occupied_score-refs.get(r.id).score)));
  check('actual MLP32 public snapshot succeeds and matches published scores',{export:summarize(initial),max_difference:maxDiff},()=>{assert.equal(initial.samples.length,53);assert.equal(initial.failures.length,0);assert.equal(initial.frame_summary.pending,0);assert.ok(maxDiff<1e-10);});

  await choose(id);await save('uncertain','人工记录：需要现场核查；模型更换不能删除该说明。');const saved=await exportData();
  await p.locator('#parking-model-choice').selectOption('dinov2');let dinoFaults=0;
  const dinoPattern='**/data/parking/images/'+id+'.jpg';
  await p.route(dinoPattern,route=>{if(route.request().resourceType()==='fetch'){dinoFaults++;return route.fulfill({status:500,body:'Controlled DINOv2 input fetch fault'});}return route.continue();});
  await run();await choose(id);const failed=await exportData();const failedUI=await inspect();
  check('DINOv2 failure is recorded while original evidence and manual review remain available',{export:summarize(failed),ui:failedUI,injected_requests:dinoFaults},()=>{assert.equal(dinoFaults,1);assert.equal(failed.samples.length,52);assert.ok(failed.failures.some(r=>r.id===id));assert.ok(failed.unanalysed_sample_ids.includes(id));assert.equal(failed.evidence_failures.length,0);assert.deepEqual(failed.reviews,saved.reviews);assert.match(failedUI.tile,/读取失败/);});

  await p.locator('#parking-model-choice').selectOption('mlp32');const clean=await exportData(),cleanUI=await inspect();await shot('mlp-after-dino-failure');
  await p.locator('#parking-model-choice').selectOption('mobilenet');const unused=await exportData(),unusedUI=await inspect();
  check('switching to successful or unused models does not inherit another model error',{mlp:{export:summarize(clean),ui:cleanUI},unused_mobilenet:{export:summarize(unused),ui:unusedUI}},()=>{assert.deepEqual(clean.failures,[]);assert.doesNotMatch(cleanUI.tile,/读取失败/);assert.equal(clean.samples.find(r=>r.id===id).predicted_occupied_score,initial.samples.find(r=>r.id===id).predicted_occupied_score);assert.deepEqual(unused.failures,[]);assert.equal(unused.samples.length,0);assert.doesNotMatch(unusedUI.tile,/读取失败/);assert.ok(unused.failures_by_model.dinov2.some(r=>r.id===id));assert.deepEqual(unused.failures_by_model.mobilenet,[]);});

  await p.locator('#parking-model-choice').selectOption('mlp32');await run();await p.locator('#parking-model-choice').selectOption('dinov2');const persisted=await exportData(),persistedUI=await inspect();await shot('dino-after-mlp-success');
  check('successful MLP32 retry cannot erase the unresolved DINOv2 error',{export:summarize(persisted),ui:persistedUI},()=>{assert.equal(persisted.samples.length,52);assert.ok(persisted.unanalysed_sample_ids.includes(id));assert.ok(persisted.failures.some(r=>r.id===id));assert.match(persistedUI.tile,/读取失败/);assert.deepEqual(persisted.failures,persisted.failures_by_model.dinov2);});

  // Independent second model failure; MLP reads a published PNG, DINO reads the original JPEG.
  await p.locator('#parking-model-choice').selectOption('mlp32');let mlpFaults=0;const mlpPattern='**/data/parking/inputs/'+otherId+'.png';
  await p.route(mlpPattern,route=>{mlpFaults++;return route.fulfill({status:500,body:'Controlled MLP32 input decode fault'});});
  await run();const twoErrors=await exportData();
  check('simultaneous failures retain separate model and sample identities',{export:summarize(twoErrors),injected_mlp_requests:mlpFaults},()=>{assert.equal(mlpFaults,1);assert.equal(twoErrors.samples.length,52);assert.deepEqual(twoErrors.failures.map(r=>r.id),[otherId]);assert.deepEqual(twoErrors.failures_by_model.mlp32.map(r=>r.id),[otherId]);assert.deepEqual(twoErrors.failures_by_model.dinov2.map(r=>r.id),[id]);assert.deepEqual(twoErrors.reviews,saved.reviews);assert.equal(twoErrors.evidence_failures.length,0);});

  await p.unroute(dinoPattern);await p.locator('#parking-model-choice').selectOption('dinov2');await run();const recovered=await exportData();await p.locator('#parking-model-choice').selectOption('mlp32');const stillFailed=await exportData(),stillFailedUI=await inspect(otherId);
  check('actual DINOv2 recovery clears only its own error while MLP32 remains failed',{dino:summarize(recovered),mlp:{export:summarize(stillFailed),ui:stillFailedUI}},()=>{assert.equal(recovered.samples.length,53);assert.deepEqual(recovered.failures,[]);assert.deepEqual(recovered.failures_by_model.dinov2,[]);assert.ok(recovered.failures_by_model.mlp32.some(r=>r.id===otherId));assert.equal(stillFailed.samples.length,52);assert.ok(stillFailed.failures.some(r=>r.id===otherId));assert.match(stillFailedUI.tile,/读取失败/);});
  await p.unroute(mlpPattern);

  await choose(otherId);await p.locator('#parking-decision').selectOption('uncertain');await p.locator('#parking-note').fill('尚未保存的第二车位说明，切换模型时应保留。');const draft={decision:await p.locator('#parking-decision').inputValue(),note:await p.locator('#parking-note').inputValue()};
  const observed=[];
  for(const model of ['mobilenet','dinov2','mlp32']){await p.locator('#parking-model-choice').selectOption(model);observed.push({model,selected:await p.locator('.parking-tile[aria-pressed="true"]').getAttribute('data-sample-id'),decision:await p.locator('#parking-decision').inputValue(),note:await p.locator('#parking-note').inputValue()});}
  await p.locator('#parking-save').click();await p.waitForFunction(()=>document.getElementById('parking-review-message').textContent.startsWith('已保存'));const handover=await exportData();
  check('model switching preserves saved reviews and the selected sample draft',{draft,observed,reviews:handover.reviews},()=>{for(const row of observed){assert.equal(row.selected,otherId);assert.equal(row.decision,draft.decision);assert.equal(row.note,draft.note);}assert.deepEqual(handover.reviews[id],saved.reviews[id]);assert.equal(handover.reviews[otherId].note,draft.note);assert.equal(Object.keys(handover.reviews).length,2);});

  const restored=await newPage();await restored.locator('#parking-import').setInputFiles({name:'parking-handover.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(handover))});await restored.waitForFunction(()=>document.getElementById('parking-message').textContent.startsWith('已恢复人工复核'));const fresh=await exportData(restored);const freshUI=await inspect(otherId,restored);
  check('fresh handover restores human decisions but never adopts exported predictions or failure state',{source:summarize(handover),restored:summarize(fresh),ui:freshUI,reviews:fresh.reviews},()=>{assert.deepEqual(fresh.reviews,handover.reviews);assert.equal(fresh.view.frame_id,handover.view.frame_id);assert.equal(fresh.view.sample_id,handover.view.sample_id);assert.equal(fresh.view.model_key,handover.view.model_key);assert.equal(fresh.samples.length,0);assert.deepEqual(fresh.failures,[]);assert.deepEqual(fresh.failures_by_model,{mlp32:[],mobilenet:[],dinov2:[]});assert.doesNotMatch(freshUI.tile,/读取失败/);});
  await restored.close();
 }catch(e){report.fatal_error=e.stack;console.error(e);process.exitCode=1;}
 finally{await browser.close();report.finished_at=new Date().toISOString();report.passed=report.checks.filter(c=>c.passed).length;report.failed=report.checks.filter(c=>!c.passed).length;report.ok=report.checks.length===8&&report.failed===0&&!report.fatal_error&&report.page_errors.length===0&&report.external_requests.length===0;fs.writeFileSync(path.join(out,reportName),JSON.stringify(report,null,2));console.log(JSON.stringify({report:'artifacts/'+reportName,passed:report.passed,failed:report.failed,ok:report.ok}));if(!report.ok)process.exitCode=1;}
})();
