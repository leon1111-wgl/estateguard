/** Real UI replacement races. Network/File.text gates delay completion, never fabricate inference. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts'),base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const filename=process.env.WORKSPACE_REPLACEMENT_REPORT||'workspace-replacement-validation.json';
const report={at:new Date().toISOString(),base,scope:'Actual public/demo workflow and real D-FINE-N handover. Controlled fetch and File.text completion delays represent slow reads; no private media or simulated model predictions.',checks:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});
const demo=JSON.parse(fs.readFileSync(path.join(root,'web/demo.json'),'utf8'));
const input=(name,title)=>({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...demo,name:title}))});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 await context.addInitScript(()=>{
  const read=File.prototype.text;window.__heldImportName=null;
  File.prototype.text=async function(){const result=await read.call(this);if(this.name===window.__heldImportName)await new Promise(resolve=>window.__releaseImport=resolve);return result;};
  // Mark after the app's promise continuation, including a failed HTTP response.
  const fetchOriginal=window.fetch;window.__demoIssued=0;window.__demoCompleted=[];
  window.fetch=async function(...args){
   const url=new URL(args[0] instanceof Request?args[0].url:String(args[0]),location.href);
   if(url.origin!==location.origin||!url.pathname.endsWith('/demo.json'))return fetchOriginal.apply(this,args);
   const ticket=++window.__demoIssued,done=()=>setTimeout(()=>window.__demoCompleted.push(ticket),0);
   try{const response=await fetchOriginal.apply(this,args);if(!response.ok)done();else{const json=response.json;response.json=async function(){try{return await json.call(this);}finally{done();}};}return response;}catch(error){done();throw error;}
  };
 });
 const state=page=>page.evaluate(()=>({batch:document.getElementById('batch-name').textContent,event:document.querySelector('.event-index')?.textContent,note:document.getElementById('decision-note')?.value,status:document.getElementById('decision-status')?.value,history:document.querySelector('.history')?.textContent,message:document.getElementById('message').textContent,message_error:document.getElementById('message').classList.contains('error'),merge_gap:document.getElementById('merge-gap').value,parking_grace:document.getElementById('parking-grace').value,media_image:document.querySelector('#media-preview img')?{src:document.querySelector('#media-preview img').src,width:document.querySelector('#media-preview img').naturalWidth,height:document.querySelector('#media-preview img').naturalHeight}:null}));
 const flush=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const save=async(page,note)=>{await page.locator('#decision-status').selectOption('needs_evidence');await page.locator('#decision-note').fill(note);await page.locator('#decision-form [type=submit]').click();await page.waitForFunction(()=>document.getElementById('message').textContent.startsWith('复核记录已保存'));};
 const exported=async page=>{await page.locator('[data-nav="workspace"]').click();const[d]=await Promise.all([page.waitForEvent('download'),page.locator('#export-json').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
 const policy=async page=>{await page.locator('[data-nav="policy"]').click();await page.locator('#parking-grace').fill('61');await page.locator('#policy-form [type=submit]').click();await page.waitForFunction(()=>document.getElementById('message').textContent.startsWith('规则已应用'));};
 const test=async(name,body)=>{
  const page=await context.newPage();page.setDefaultTimeout(10000);const evidence={dialogs:[]},control={accept:false,releases:[]};
  page.on('dialog',async dialog=>{evidence.dialogs.push({message:dialog.message(),accepted:control.accept});await(control.accept?dialog.accept():dialog.dismiss());});
  page.on('pageerror',e=>report.page_errors.push({test:name,message:e.message}));page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==new URL(base).origin)report.external_requests.push(r.url());});
  const gate=async(status=200)=>{
   const requestNumber=await page.evaluate(()=>window.__demoIssued+1);
   let release,enter,finish;const released=new Promise(r=>release=r),entered=new Promise(r=>enter=r),finished=new Promise(r=>finish=r);control.releases.push(release);
   await page.route(base+'/demo.json',async route=>{try{const response=status===200?await route.fetch():null;enter();await released;await route.fulfill(response?{response}:{status,contentType:'text/plain',body:'controlled read failure'});}finally{finish();}},{times:1});
   return{entered,release:async()=>{release();await finished;await page.waitForFunction(ticket=>window.__demoCompleted.includes(ticket),requestNumber);}};
  };
  const holdImport=async(name,title)=>{await page.evaluate(name=>window.__heldImportName=name,name);await page.locator('#import-file').setInputFiles(input(name,title));await page.waitForFunction(()=>typeof window.__releaseImport==='function');return async()=>{await page.evaluate(()=>window.__releaseImport());await flush(page);};};
  try{await page.goto(base+'/#workspace');await page.waitForSelector('.event-button');await body({page,evidence,control,gate,holdImport});report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}
  catch(error){evidence.state=await state(page).catch(()=>null);report.checks.push({name,passed:false,error:error.message,evidence});console.error('FAIL: '+name+': '+error.message);await page.screenshot({path:path.join(out,'workspace-replacement-failure-'+report.checks.length+'.png'),fullPage:true}).catch(()=>{});}
  finally{for(const release of control.releases)release();await page.close();fs.writeFileSync(path.join(out,filename),JSON.stringify(report,null,2));}
 };
 try{
  await test('late demo asks before discarding a draft written while it was loading',async({page,evidence,gate})=>{
   await page.locator('#media-file').setInputFiles(path.join(root,'web/samples/bus.jpg'));await page.waitForFunction(()=>document.querySelector('#media-preview img')?.naturalWidth>0);const request=await gate();await page.locator('#reset-demo').click();await request.entered;await page.locator('#decision-note').fill('读取示例期间新写的交班草稿');evidence.before=await state(page);await request.release();evidence.after=await state(page);
   assert.equal(evidence.after.note,evidence.before.note,'late demo silently discarded the new draft');assert.equal(evidence.after.event,evidence.before.event);assert.deepEqual(evidence.after.media_image,evidence.before.media_image);assert.equal(evidence.dialogs.length,1);assert.equal(evidence.dialogs[0].accepted,false);
  });
  await test('late demo preserves a newly saved review when replacement is declined',async({page,evidence,gate})=>{
   const request=await gate();await page.locator('#reset-demo').click();await request.entered;await save(page,'在等待期间核实后保存，不能被旧请求清除');evidence.before=await state(page);await request.release();evidence.after=await state(page);const data=await exported(page);
   assert.equal(evidence.after.history,evidence.before.history);assert.equal(data.audit.length,1);assert.equal(data.audit[0].note,'在等待期间核实后保存，不能被旧请求清除');assert.equal(evidence.dialogs.length,1);
  });
  await test('existing dirty work is confirmed only after a valid replacement is ready',async({page,evidence,control,gate})=>{
   await page.locator('#decision-note').fill('原有草稿');control.accept=true;const request=await gate();await page.locator('#reset-demo').click();await request.entered;evidence.dialogs_before_read=evidence.dialogs.length;await request.release();evidence.after=await state(page);
   assert.equal(evidence.dialogs_before_read,0,'confirmation was consumed before the read completed');assert.equal(evidence.dialogs.length,1);assert.equal(evidence.after.note,'');assert.match(evidence.after.message,/合成班次/);
  });
  await test('failed demo read preserves the workspace without asking to discard it',async({page,evidence,control,gate})=>{
   await page.locator('#decision-note').fill('失败读取后仍需保留');control.accept=true;const request=await gate(500);await page.locator('#reset-demo').click();await request.entered;await request.release();evidence.after=await state(page);
   assert.equal(evidence.after.note,'失败读取后仍需保留');assert.equal(evidence.dialogs.length,0);assert.match(evidence.after.message,/无法读取|失败/);
  });
  await test('late demo failure cannot replace a newer successful import message',async({page,evidence,gate})=>{
   const request=await gate(500);await page.locator('#reset-demo').click();await request.entered;await page.locator('#import-file').setInputFiles(input('新工作区.json','新导入工作区'));await page.waitForFunction(()=>document.getElementById('message').textContent.startsWith('JSON 已导入'));evidence.before=await state(page);await request.release();evidence.after=await state(page);assert.deepEqual(evidence.after,evidence.before);
  });
  await test('applying a policy invalidates an earlier pending demo success',async({page,evidence,gate})=>{
   const request=await gate();await page.locator('#reset-demo').click();await request.entered;await policy(page);evidence.before=await state(page);await request.release();evidence.after=await state(page);assert.deepEqual(evidence.after,evidence.before);assert.equal((await exported(page)).policy.parking_grace_seconds,61);
  });
  await test('applying a policy invalidates an earlier pending JSON read without another discard prompt',async({page,evidence,holdImport})=>{
   const release=await holdImport('旧读取.json','不应晚到的旧文件');await policy(page);evidence.before=await state(page);await release();evidence.after=await state(page);assert.deepEqual(evidence.after,evidence.before);assert.equal(evidence.dialogs.length,0,'the older intent should already be stale');
  });
  await test('latest import intent wins, including when the newer file is invalid',async({page,evidence,holdImport,gate})=>{
   const release=await holdImport('先选文件.json','先选工作区');await page.locator('#import-file').setInputFiles(input('后选文件.json','后选工作区'));await page.waitForFunction(()=>document.getElementById('batch-name').textContent==='后选工作区');evidence.latest=await state(page);await release();assert.deepEqual(await state(page),evidence.latest);
   const request=await gate();await page.locator('#reset-demo').click();await request.entered;await page.locator('#import-file').setInputFiles({name:'后选损坏.json',mimeType:'application/json',buffer:Buffer.from('{')});await page.waitForFunction(()=>document.getElementById('message').textContent.startsWith('导入被拒绝'));evidence.failed_latest=await state(page);await request.release();assert.deepEqual(await state(page),evidence.failed_latest);
  });
  await test('actual D-FINE-N handover survives an earlier demo failure',async({page,evidence,gate})=>{
   const request=await gate(500);await page.locator('#reset-demo').click();await request.entered;await page.locator('[data-nav="analyze"]').click();await page.waitForFunction(()=>document.getElementById('vision-detector').value==='dfine');await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.getElementById('run-analysis').disabled);await page.locator('#vision-rule').selectOption('access');await page.locator('#vision-camera').fill('公开校车测试镜头');await page.locator('#vision-zone').fill('规则测试区域');await page.locator('#vision-start').fill('2026-10-20T08:00');await page.locator('#vision-context-confirmed').check();await page.locator('#run-analysis').click();await page.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.getElementById('vision-message').textContent)&&!document.getElementById('run-analysis').disabled,null,{timeout:180000});assert.match(await page.locator('#vision-message').textContent(),/^分析完成/);const[detectionDownload]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);const detection=JSON.parse(fs.readFileSync(await detectionDownload.path(),'utf8'));assert.equal(detection.params.detector,'dfine');assert.ok(detection.candidates.length>0);evidence.real_inference={model:detection.model,bus_score:detection.frames[0].detections.find(d=>d.class==='bus')?.score,candidates:detection.candidates.length};await page.locator('#send-candidates').click();await page.waitForSelector('#workspace:not([hidden])');await page.waitForFunction(()=>document.querySelector('#media-preview img')?.naturalWidth>0);evidence.before=await state(page);await request.release();evidence.after=await state(page);assert.deepEqual(evidence.after,evidence.before);assert.match(evidence.after.message,/真实模型/);await save(page,'公开样例仅验证交接流程，现场授权与区域需补充证据');const data=await exported(page);assert.ok(data.batch.observations.some(o=>o.score>.8));assert.equal(data.audit.length,1);assert.equal(data.audit[0].status,'needs_evidence');evidence.candidates=data.batch.observations;evidence.saved_review=data.audit[0];
   await page.locator('#reset-demo').click();await page.waitForFunction(()=>document.getElementById('message').textContent.startsWith('当前为合成班次'));
   await page.locator('#import-file').setInputFiles({name:'真实模型复核交班.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await page.waitForFunction(()=>document.getElementById('message').textContent.startsWith('JSON 已导入'));const restored=await exported(page);assert.deepEqual(restored.batch,data.batch);assert.deepEqual(restored.decisions,data.decisions);assert.deepEqual(restored.audit,data.audit);assert.equal(await page.locator('#decision-status').inputValue(),'needs_evidence');assert.equal(await page.locator('#decision-note').inputValue(),data.audit[0].note);assert.equal(await page.locator('#media-preview img').count(),0,'JSON restoration must not pretend to restore a local media attachment');evidence.restored={status:await page.locator('#decision-status').inputValue(),note:await page.locator('#decision-note').inputValue(),audit:restored.audit,media_status:await page.locator('#media-status').textContent()};
  });
 }catch(error){report.fatal_error=error.stack;}
 finally{await browser.close();report.finished_at=new Date().toISOString();report.passed=report.checks.filter(c=>c.passed).length;report.failed=report.checks.filter(c=>!c.passed).length;report.ok=!report.fatal_error&&report.failed===0&&report.page_errors.length===0&&report.external_requests.length===0;fs.writeFileSync(path.join(out,filename),JSON.stringify(report,null,2));console.log(JSON.stringify({report:'artifacts/'+filename,passed:report.passed,failed:report.failed,ok:report.ok}));if(!report.ok)process.exitCode=1;}
})().catch(error=>{console.error(error);process.exitCode=1;});
