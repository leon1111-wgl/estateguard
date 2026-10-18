/** Real-browser acceptance for frozen-encoder occupancy models: feature/score parity with the offline
 * pipeline, default model, risk routing, on-site adaptation, spot checks and revocation, CNR-EXT snapshots and layout.
 * Run with ESTATEGUARD_URL, PLAYWRIGHT_MODULE and CHROME_PATH when needed. Writes artifacts/parking-transfer-validation.json.
 * Dataset labels stand in for a reviewer's decisions here only to drive the UI; the page never reads them for adaptation.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/parking-transfer-parity.json')));
const bRef=Object.fromEntries(['mobilenet','dinov2'].map(k=>[k,new Map(JSON.parse(fs.readFileSync(path.join(root,`web/data/parking-transfer/b-predictions-${k}.json`))).map(r=>[r.id,r]))]));
const extCsv=path.join(root,'docs/validation/parking-ext-predictions.csv.gz'),extRef=new Map();
if(fs.existsSync(extCsv)){const [head,...lines]=zlib.gunzipSync(fs.readFileSync(extCsv)).toString().trim().split('\n'),keys=head.split(',');for(const line of lines){const v=line.split(',');extRef.set(v[0],Object.fromEntries(keys.map((k,i)=>[k,v[i]])));}}
const report={checked_at:new Date().toISOString(),base,steps:{},ok:false};
const step=(name,value)=>{report.steps[name]=value;console.log(name,JSON.stringify(value).slice(0,240));};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(180000);
  const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
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
  for(const [k,v] of Object.entries(parity)){assert.ok(v.max_feature_diff<=1e-4,`${k} feature diff ${v.max_feature_diff}`);assert.ok(v.max_calibrated_diff<=1e-6,`${k} score diff ${v.max_calibrated_diff}`);}
  step('encoder_parity',parity);

  // 2. Default model and an unverified camera: everything is routed to a person.
  await page.goto(base+'/#parking');await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53);
  assert.equal(await page.locator('#parking-model-choice').inputValue(),'dinov2');
  const run=async()=>{await page.locator('#parking-run').click();await page.waitForFunction(()=>/^当前快照分析完成/.test(document.querySelector('#parking-message').textContent));};
  const exportData=async()=>{const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#parking-export').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
  const compare=(data,key,ref,field)=>{let m=0;for(const r of data.samples){const x=ref(r.id);assert.ok(x,`missing reference ${r.id}`);m=Math.max(m,Math.abs((field==='mlp32'?r.predicted_occupied_score:r.calibrated_occupied_score)-Number(field?x[field]:x.calibrated)));}return m;};
  await run();const firstMessage=await page.locator('#parking-message').textContent();let data=await exportData();
  assert.equal(data.prediction_model.key,'dinov2');assert.equal(data.samples.length,53);
  const bDiff=compare(data,'dinov2',id=>bRef.dinov2.get(id));assert.ok(bDiff<=1e-6,`B page/offline diff ${bDiff}`);
  assert.ok(data.samples.every(r=>r.review_state==='uncertain'),'unverified camera must route every slot to review');
  assert.equal(await page.locator('#parking-metrics .metric strong').nth(1).textContent(),'0');
  assert.match(await page.locator('#parking-onsite-status').textContent(),/尚未校准.*637 个无错的车位·日/);
  step('default_unverified_b',{default:'dinov2',max_page_vs_offline_calibrated:bDiff,message:firstMessage});
  await page.screenshot({path:path.join(out,'parking-transfer-unverified-1440.png')});

  // 3. Save reviewer decisions, adapt on this camera, then restore the source head.
  const labelOf=new Map(data.samples.map(r=>[r.id,r.dataset_label]));
  const saveN=async n=>{const ids=await page.locator('.parking-tile').evaluateAll(t=>t.map(x=>x.dataset.sampleId));for(const id of ids.slice(0,n)){await page.locator(`.parking-tile[data-sample-id="${id}"]`).click();await page.waitForFunction(id=>{const i=document.querySelector('#parking-evidence-image');return i&&i.dataset.evidenceSampleId===id&&i.complete&&i.naturalWidth>0;},id);await page.locator('#parking-decision').selectOption(labelOf.get(id)?'busy':'free');await page.locator('#parking-note').fill('验收脚本：按原图核对');await page.locator('#parking-save').click();}return ids.slice(0,n);};
  const used=await saveN(12);
  assert.equal(await page.locator('#parking-calibrate').isDisabled(),false);
  await page.locator('#parking-adapt').click();assert.match(await page.locator('#parking-model-message').textContent(),/已用摄像头 B 的 12 条人工结论/);
  assert.equal(await page.locator('#parking-calibrate').isDisabled(),true,'labels used for adaptation cannot calibrate the adapted head');
  const adapted=await exportData();assert.equal(adapted.onsite.dinov2.B.adaptation.labels,12);assert.deepEqual([...adapted.onsite.dinov2.B.adaptation.sample_ids].sort(),[...used].sort());assert.equal(adapted.predictions_by_model.dinov2.length,53);
  const moved=adapted.samples.filter(r=>Math.abs(r.calibrated_occupied_score-bRef.dinov2.get(r.id).calibrated)>1e-6).length;assert.ok(moved>0,'adaptation should change scores');
  const acc=d=>d.samples.filter(r=>(r.calibrated_occupied_score>=.5)===(r.dataset_label===1)).length;
  step('adaptation',{labels:12,scores_changed:moved,correct_before:acc(data),correct_after:acc(adapted),note:'same snapshot includes the 12 adaptation slots; not an accuracy claim'});
  await page.locator('#parking-adapt-reset').click();const restored=await exportData();
  assert.ok(compare(restored,'dinov2',id=>bRef.dinov2.get(id))<=1e-6,'reset must restore source scores');assert.deepEqual(restored.onsite,{mobilenet:{},dinov2:{}});
  // B has one date: calibration is refused whatever the scores, and nothing is auto-decided.
  await page.locator('#parking-calibrate').click();assert.match(await page.locator('#parking-model-message').textContent(),/单日数据不能代表其他时段/);assert.match(await page.locator('#parking-detail').textContent(),/证据不足 · 全部送人工/);
  const checked=await exportData();assert.ok(checked.samples.every(r=>r.review_state==='uncertain'));assert.equal(checked.onsite.dinov2.B.routing.t_free,null);assert.equal(checked.onsite.dinov2.B.routing.calibration_units,12);
  // Changing a decision that the check used voids it; so does restoring a review file.
  const flip=used[0];await page.locator('#parking-filter').selectOption('all');await page.locator(`.parking-tile[data-sample-id="${flip}"]`).click();await page.waitForFunction(id=>{const i=document.querySelector('#parking-evidence-image');return i&&i.dataset.evidenceSampleId===id&&i.complete&&i.naturalWidth>0;},flip);
  await page.locator('#parking-decision').selectOption(labelOf.get(flip)?'free':'busy');await page.locator('#parking-note').fill('验收脚本：改判');await page.locator('#parking-save').click();
  assert.match(await page.locator('#parking-model-message').textContent(),/相关现场设置已作废/);assert.deepEqual((await exportData()).onsite.dinov2,{});
  await page.locator('#parking-calibrate').click();const beforeImport=await exportData();assert.ok(beforeImport.onsite.dinov2.B);
  const file=path.join(out,'parking-transfer-import.json');fs.writeFileSync(file,JSON.stringify(beforeImport));await page.locator('#parking-import').setInputFiles(file);
  await page.waitForFunction(()=>/人工复核已恢复/.test(document.querySelector('#parking-review-message').textContent));assert.match(await page.locator('#parking-review-message').textContent(),/现场自适应与阈值已清除/);assert.deepEqual((await exportData()).onsite.dinov2,{});
  step('evidence_rules',{one_date_refused:true,calibration_units:checked.onsite.dinov2.B.routing.calibration_units,edit_voids:true,import_clears:true});
  await page.screenshot({path:path.join(out,'parking-transfer-onsite-1440.png')});

  // 4. CNR-EXT held-out snapshot with all three models against the published per-sample scores.
  const extSession=await page.locator('#parking-session option').evaluateAll(o=>o.map(x=>x.value).find(v=>v==='C8-ext'));assert.ok(extSession,'EXT session missing');
  await page.locator('#parking-session').selectOption('C8-ext');await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===54);
  const ext={};
  for(const key of ['dinov2','mobilenet','mlp32']){
   await page.locator('#parking-model-choice').selectOption(key);await run();const d=await exportData();d.samples=d.samples.filter(r=>r.dataset==='cnr_ext');assert.equal(d.samples.length,54,'export keeps every analysed sample; this snapshot has 54');
   ext[key]=extRef.size?compare(d,key,id=>extRef.get(id),key==='mlp32'?'mlp32':`${key}_calibrated`):null;
   if(ext[key]!==null)assert.ok(ext[key]<=5e-5,`${key} EXT page/offline diff ${ext[key]}`);
  }
  const c8frame=await page.locator('#parking-time').textContent();
  await page.locator('#parking-session').selectOption('C2-ext');await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===9);await page.locator('#parking-model-choice').selectOption('dinov2');
  const c2labels=new Map();for(let f=0;f<3;f++){await page.locator('#parking-frame').fill(String(f));await page.locator('#parking-frame').dispatchEvent('input');await run();const d=await exportData();for(const r of d.samples)c2labels.set(r.id,r.dataset_label);
   const ids=await page.locator('.parking-tile').evaluateAll(t=>t.map(x=>x.dataset.sampleId));for(const id of ids){await page.locator(`.parking-tile[data-sample-id="${id}"]`).click();await page.waitForFunction(id=>{const i=document.querySelector('#parking-evidence-image');return i&&i.dataset.evidenceSampleId===id&&i.complete&&i.naturalWidth>0;},id);await page.locator('#parking-decision').selectOption(c2labels.get(id)?'busy':'free');await page.locator('#parking-note').fill('验收脚本：按原图核对');await page.locator('#parking-save').click();}}
  await page.locator('#parking-risk-target').selectOption('0.05');await page.locator('#parking-calibrate').click();const c2=(await exportData()).onsite.dinov2.C2.routing;
  assert.equal(c2.calibration_units,27);assert.equal(c2.t_free,null,'27 slot-days cannot pass a 5% target');assert.match(await page.locator('#parking-model-message').textContent(),/27 个车位·日的证据不足/);
  step('ext_three_dates',{camera:'C2',units:c2.calibration_units,dates:3,t_free:c2.t_free,t_busy:c2.t_busy});
  step('ext_snapshot_three_models',{session:'C8-ext',frame:c8frame,max_diff_vs_published_6_significant_digits:ext});
  await page.locator('#parking-model-choice').selectOption('dinov2');await page.screenshot({path:path.join(out,'parking-transfer-ext-1440.png')});

  // 5. Spot checks and revocation (protocol appendix 5) on C6. Dataset labels fill in the non-checked conclusions
  // so that a threshold can pass; six spot checks are then saved as errors to simulate drift.
  await page.locator('#parking-session').selectOption('C6-ext');await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===44);
  const gotoFrame=async f=>{await page.locator('#parking-frame').fill(String(f));await page.locator('#parking-frame').dispatchEvent('input');};
  const waitEvidence=id=>page.waitForFunction(id=>{const i=document.querySelector('#parking-evidence-image');return i&&i.dataset.evidenceSampleId===id&&i.complete&&i.naturalWidth>0;},id);
  const c6=new Map();for(let f=0;f<3;f++){await gotoFrame(f);await run();for(const r of (await exportData()).samples)if(r.camera==='C6')c6.set(r.id,r);}
  assert.equal(c6.size,132);const c6dates=[...new Set([...c6.values()].map(r=>r.source_time.slice(0,8)))].sort();
  const audited=new Set(await page.evaluate(async({base,rows})=>{const t=await import(base+'/parking-transfer.mjs');return rows.filter(r=>t.isAudited(t.auditUnit(r.camera,r.slot,r.source_time.slice(0,8)))).map(r=>r.id);},{base,rows:[...c6.values()]}));
  const doc=await exportData(),at=new Date().toISOString();doc.reviews={};
  for(const [id,r] of c6)if(!audited.has(id))doc.reviews[id]={decision:r.dataset_label?'busy':'free',note:'验收脚本：数据集标签代填人工结论',at};
  const file6=path.join(out,'parking-transfer-audit-import.json');fs.writeFileSync(file6,JSON.stringify(doc));await page.locator('#parking-import').setInputFiles(file6);
  await page.waitForFunction(()=>/人工复核已恢复/.test(document.querySelector('#parking-review-message').textContent));
  await page.locator('#parking-risk-target').selectOption('0.05');await page.locator('#parking-calibrate').click();assert.match(await page.locator('#parking-model-message').textContent(),/通过检验.*抽检/);
  let d6=await exportData(),r6=d6.onsite.dinov2.C6.routing;assert.notEqual(r6.t_busy,null,'C6 busy side should pass on the reviewed slot-days');
  const sideOf=r=>r6.t_free!=null&&r.calibrated_occupied_score<=r6.t_free?'free':r6.t_busy!=null&&r.calibrated_occupied_score>=r6.t_busy?'busy':null,cmp=(a,b)=>a<b?-1:a>b?1:0;
  const events=[...c6.values()].filter(r=>audited.has(r.id)&&sideOf(r)).sort((a,b)=>cmp(a.source_time,b.source_time)||cmp(a.slot,b.slot)),busyChecks=events.filter(r=>sideOf(r)==='busy');
  assert.ok(busyChecks.length>=6,`need six busy-side spot checks, got ${busyChecks.length}`);
  assert.deepEqual(r6.audit.sample_ids,events.map(r=>r.id));assert.equal(r6.audit.busy.units,busyChecks.length);assert.equal(r6.audit.busy.pending,busyChecks.length);assert.equal(r6.audit.busy.revoked,null);
  const c6rows=d=>d.samples.filter(r=>r.camera==='C6');assert.deepEqual(c6rows(d6).filter(r=>r.audit).map(r=>r.id).sort(),events.map(r=>r.id).sort());assert.ok(c6rows(d6).filter(r=>r.audit).every(r=>r.review_state==='uncertain'));
  assert.ok(c6rows(d6).some(r=>r.review_state==='busy'),'certified busy side auto-decides the other slots');
  await gotoFrame(c6dates.indexOf(busyChecks[0].source_time.slice(0,8)));await page.locator('#parking-filter').selectOption('audit');
  const tilesInFrame=await page.locator('.parking-tile').evaluateAll(t=>t.map(x=>[x.dataset.sampleId,x.querySelector('.badge').textContent]));
  assert.deepEqual(tilesInFrame.map(x=>x[0]).sort(),events.filter(r=>r.source_time.slice(0,8)===busyChecks[0].source_time.slice(0,8)).map(r=>r.id).sort());assert.ok(tilesInFrame.every(x=>x[1]==='抽检'));
  assert.match(await page.locator('#parking-metrics').textContent(),/含抽检 \d+/);
  const before=await page.locator('#parking-onsite-status').textContent();assert.match(before,/占用侧抽中 \d+ 个车位·日（已核对 0），出错 0，待核对 \d+ 张；证据值 [\d.<]+，每个出错车位·日 ×2/);
  // Spot checks are blind until a person saves a conclusion.
  assert.ok((await page.locator('.parking-tile').allTextContents()).every(t=>t.includes('概率暂不显示')&&!t.includes('% 占用')),'spot-check tiles hide the model probability');
  await page.locator('#parking-show-truth').check();assert.ok((await page.locator('.parking-tile').allTextContents()).every(t=>t.includes('标注：')&&!/一致|错判/.test(t)),'dataset labels do not reveal model agreement on blind checks');await page.locator('#parking-show-truth').uncheck();
  await page.screenshot({path:path.join(out,'parking-transfer-audit-1440.png')});
  const openCheck=async(r,filter='audit')=>{await gotoFrame(c6dates.indexOf(r.source_time.slice(0,8)));await page.locator('#parking-filter').selectOption(filter);await page.locator(`.parking-tile[data-sample-id="${r.id}"]`).click();await waitEvidence(r.id);};
  const saveAudit=async(r,decision,note,filter='audit',button='#parking-save')=>{await openCheck(r,filter);await page.locator('#parking-decision').selectOption(decision);await page.locator('#parking-note').fill(note);await page.locator(button).click();await page.waitForFunction(()=>/^已保存/.test(document.querySelector('#parking-review-message').textContent));};
  await openCheck(busyChecks[0]);const detail0=await page.locator('#parking-detail').textContent();assert.match(detail0,/抽检 · 本车位·日被随机抽中/);assert.match(detail0,/抽检中暂不显示/);
  const sameDay=(a,b)=>a.source_time.slice(0,8)===b.source_time.slice(0,8);let frameDone=false;
  for(let i=0;i<6;i++){
   const lastInFrame=i>0&&events.filter(r=>sameDay(r,busyChecks[i])).every(r=>busyChecks.slice(0,i+1).includes(r));
   await saveAudit(busyChecks[i],'free','验收脚本：模拟抽检发现自动判占用出错','audit',i===0||lastInFrame?'#parking-save-next':'#parking-save');
   if(lastInFrame&&!frameDone){
    // The last open spot check of a snapshot: stay on it and say the spot checks are done, not wrap to a finished one.
    frameDone=true;assert.match(await page.locator('#parking-review-message').textContent(),/当前快照的抽检车位已全部确认/);assert.equal(await page.locator('.parking-tile[aria-pressed="true"]').getAttribute('data-sample-id'),busyChecks[i].id);
   }
   if(i===0){
    // Save and continue stays inside the spot-check list, and the saved check now shows its probability.
    assert.equal(await page.locator('#parking-filter').inputValue(),'audit');const pressed=page.locator('.parking-tile[aria-pressed="true"]');
    assert.equal(await pressed.locator('.badge').textContent(),'抽检');assert.notEqual(await pressed.getAttribute('data-sample-id'),busyChecks[0].id);
    assert.match(await page.locator(`.parking-tile[data-sample-id="${busyChecks[0].id}"]`).textContent(),/% 占用/);
   }
   const message=await page.locator('#parking-review-message').textContent();
   if(i<5)assert.doesNotMatch(message,/撤销/,`no revocation after ${i+1} errors`);else assert.match(message,/占用侧阈值已被抽检撤销：抽中 6 个车位·日中 6 个出错（未核对的按无错计），证据值 64\.00 ≥ 40/);
  }
  d6=await exportData();r6=d6.onsite.dinov2.C6.routing;const rev=r6.audit.revoked.busy;
  assert.equal(rev.error_units,6);assert.equal(rev.units,6);assert.equal(r6.audit.busy.units,6);assert.equal(r6.audit.busy.checked,busyChecks.length);assert.equal(r6.audit.busy.revoked_at,rev.source_time);assert.equal(rev.sample_id,busyChecks[5].id);assert.deepEqual(rev.checked.map(c=>c.id),busyChecks.map(r=>r.id));assert.equal(rev.checked.filter(c=>c.wrong===true).length,6);
  const drift=d6.drift.C6;assert.equal(drift.evidence_from,busyChecks[5].source_time.slice(0,8));assert.equal(drift.history.length,1);assert.equal(drift.history[0].model,'dinov2');assert.equal(drift.history[0].side,'busy');assert.equal(drift.history[0].threshold,r6.t_busy);
  assert.ok(c6rows(d6).every(r=>r.review_state!=='busy'),'a revoked side no longer auto-decides');
  const revokedStatus=await page.locator('#parking-onsite-status').textContent();assert.match(revokedStatus,/≥ 0\.85 自动判占用（已被抽检撤销，改送人工）/);assert.match(revokedStatus,/占用侧由 .* 的抽检触发撤销：抽中 6 个车位·日中 6 个出错/);
  // After revocation those slots are ordinary review items, not spot checks; the detail panel says why for every slot.
  await gotoFrame(c6dates.indexOf(busyChecks[0].source_time.slice(0,8)));await page.locator('#parking-filter').selectOption('audit');assert.equal(await page.locator('.parking-tile').count(),0,'revoked side has no spot checks left');
  await openCheck(busyChecks[0],'all');assert.match(await page.locator('#parking-detail').textContent(),/占用侧阈值已被抽检撤销 · 送人工/);
  const low=[...c6.values()].find(r=>r.source_time.slice(0,8)===busyChecks[0].source_time.slice(0,8)&&r.calibrated_occupied_score<r6.t_busy);
  if(low){await openCheck(low,'all');assert.match(await page.locator('#parking-detail').textContent(),/阈值已被抽检撤销 · 全部送人工/);}
  // A second reviewer corrects all six conclusions: the revocation is sticky and stale evidence cannot bring it back.
  for(let i=0;i<6;i++)await saveAudit(busyChecks[i],'busy','验收脚本：更正抽检结论','all');
  assert.ok((await exportData()).onsite.dinov2.C6.routing.audit.revoked.busy,'correcting checks does not restore the threshold');
  await page.locator('#parking-risk-target').selectOption('0.02');await page.locator('#parking-risk-target').selectOption('0.05');
  await page.locator('#parking-calibrate').click();const after=await exportData(),recal=after.onsite.dinov2.C6.routing;
  assert.equal(recal.t_busy,null);assert.equal(after.drift.C6.evidence_from,rev.source_time.slice(0,8));assert.equal(after.drift.C6.history.length,1);
  const staleStatus=await page.locator('#parking-onsite-status').textContent();assert.match(staleStatus,/曾有阈值被抽检撤销（最近：DINOv2-small 线性探针的占用侧 ≥ 0\.85，.*抽中 6 个车位·日中 6 个出错），任一模型的校准都只用 .* 及之后的人工结论/);
  // The restriction is about the camera, not one model.
  await page.locator('#parking-model-choice').selectOption('mobilenet');assert.match(await page.locator('#parking-onsite-status').textContent(),/任一模型的校准都只用/);
  // The spot-check filter is reset when a model without spot checks is chosen.
  await page.locator('#parking-model-choice').selectOption('dinov2');await page.locator('#parking-filter').selectOption('audit');await page.locator('#parking-model-choice').selectOption('mlp32');
  assert.equal(await page.locator('#parking-filter').inputValue(),'all');assert.equal(await page.locator('#parking-filter option[value="audit"]').evaluate(o=>o.hidden),true);await page.locator('#parking-model-choice').selectOption('dinov2');
  await page.locator('#parking-filter').selectOption('all');await page.screenshot({path:path.join(out,'parking-transfer-revoked-1440.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('.parking-model-panel').scrollIntoViewIfNeeded();
  const auditWidth=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(auditWidth<=390,`audit status overflows ${auditWidth}`);
  await page.locator('.parking-model-panel').screenshot({path:path.join(out,'parking-transfer-audit-panel-390.png')});await page.setViewportSize({width:1440,height:1000});
  // Export, then restore into a fresh page (the next shift): the drift record comes back and stale evidence stays excluded.
  const handover=path.join(out,'parking-transfer-audit-handover.json');fs.writeFileSync(handover,JSON.stringify(await exportData()));
  const next=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});next.setDefaultTimeout(180000);next.on('pageerror',e=>errors.push(e.message));next.on('dialog',d=>d.accept());
  await next.goto(base+'/#parking');await next.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53);await next.locator('#parking-session').selectOption('C6-ext');await next.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===44);
  for(let f=0;f<3;f++){await next.locator('#parking-frame').fill(String(f));await next.locator('#parking-frame').dispatchEvent('input');await next.locator('#parking-run').click();await next.waitForFunction(()=>/^当前快照分析完成/.test(document.querySelector('#parking-message').textContent));}
  await next.locator('#parking-import').setInputFiles(handover);await next.waitForFunction(()=>/人工复核已恢复/.test(document.querySelector('#parking-review-message').textContent));
  assert.match(await next.locator('#parking-review-message').textContent(),/已读入 1 个摄像头的抽检撤销记录/);
  await next.locator('#parking-risk-target').selectOption('0.05');await next.locator('#parking-calibrate').click();
  const [nd]=await Promise.all([next.waitForEvent('download'),next.locator('#parking-export').click()]);const nextDoc=JSON.parse(fs.readFileSync(await nd.path(),'utf8'));
  assert.equal(nextDoc.onsite.dinov2.C6.routing.t_busy,null,'restored stale evidence must not re-certify the revoked threshold');assert.equal(nextDoc.drift.C6.evidence_from,rev.source_time.slice(0,8));assert.equal(nextDoc.drift.C6.history[0].sample_id,rev.sample_id);
  assert.match(await next.locator('#parking-onsite-status').textContent(),/曾有阈值被抽检撤销/);await next.close();
  step('audit_revocation',{camera:'C6',reviewed_for_calibration:Object.keys(doc.reviews).length,t_busy:r6.t_busy,spot_checks:events.length,busy_checks:busyChecks.length,frame_done_message:frameDone,revoked_after:{...rev,checked:rev.checked.length},recalibrated_t_busy:recal.t_busy,restored_page_t_busy:nextDoc.onsite.dinov2.C6.routing.t_busy,drift_evidence_from:after.drift.C6.evidence_from,status_before:before.slice(0,200),phone_scroll_width:auditWidth});

  // 6. Single-patch upload uses the selected encoder and says a new camera is unverified.
  await page.locator('#parking-upload').setInputFiles(path.join(root,'web/data/parking-ext/images',fs.readdirSync(path.join(root,'web/data/parking-ext/images'))[0]));
  await page.waitForFunction(()=>/校准后占用概率/.test(document.querySelector('#parking-upload-result').textContent));
  step('upload',{text:(await page.locator('#parking-upload-result').textContent()).trim()});

  // 7. Evaluation tables render from the published JSON.
  await page.goto(base+'/#results');await page.waitForFunction(()=>document.querySelector('#parking-transfer-content table'));
  const tables=await page.locator('#parking-transfer-content table').count(),evalText=await page.locator('#parking-transfer-content').textContent();
  assert.ok(tables>=(extRef.size?6:3),`tables ${tables}`);for(const s of ['MLP32 基线','MobileNetV2 迁移头','DINOv2-small 线性探针'])assert.ok(evalText.includes(s),s);
  await page.locator('#parking-transfer-evaluation').screenshot({path:path.join(out,'parking-transfer-results-1440.png')});
  assert.ok(evalText.includes('抽检与自动撤销：EXT 按日期回放')&&/主规则在 10% 抽检下只撤销了 DINOv2 的 C7/.test(evalText),'spot-check replay section missing');
  step('results_page',{tables,has_ext:evalText.includes('CNR-EXT 保留测试'),has_audit_replay:true});

  // 8. Phone width: no horizontal page scroll, controls reachable.
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true});phone.on('pageerror',e=>errors.push(e.message));
  await phone.goto(base+'/#parking');await phone.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53);
  const widths=await phone.evaluate(()=>({doc:document.documentElement.scrollWidth,panel:document.querySelector('.parking-model-panel').getBoundingClientRect().width}));
  assert.ok(widths.doc<=390,`page overflows: ${widths.doc}`);
  await phone.locator('.parking-model-panel').scrollIntoViewIfNeeded();await phone.screenshot({path:path.join(out,'parking-transfer-model-panel-390.png')});
  await phone.goto(base+'/#results');await phone.waitForFunction(()=>document.querySelector('#parking-transfer-content table'));
  const resultsWidth=await phone.evaluate(()=>document.documentElement.scrollWidth);assert.ok(resultsWidth<=390,`results overflow ${resultsWidth}`);
  await phone.locator('#parking-transfer-evaluation').screenshot({path:path.join(out,'parking-transfer-results-390.png')});
  step('phone',{parking_scroll_width:widths.doc,results_scroll_width:resultsWidth});

  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  report.page_errors=errors;report.external_requests=external;report.ok=true;
 }finally{await browser.close();fs.writeFileSync(path.join(out,'parking-transfer-validation.json'),JSON.stringify(report,null,2));}
 console.log('PASS parking-transfer-check');
})().catch(error=>{report.fatal_error=error.message;fs.writeFileSync(path.join(out,'parking-transfer-validation.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
