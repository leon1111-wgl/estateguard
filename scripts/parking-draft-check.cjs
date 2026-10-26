/** Parking handover acceptance with actual Chrome UI and real MLP32 inference.
 * Product modules, model results and image bytes are never replaced or mocked. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts'),base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const reportName=process.env.PARKING_DRAFT_REPORT||'parking-draft-validation.json';
const first='B-20150708-0805-1',second='B-20150708-0805-2';
const report={started_at:new Date().toISOString(),base,previous_baseline_commit:'585074b',baseline_report:'parking-draft-baseline.json',scope:'Actual Chrome, real MLP32 on 53 public CNRPark patches. Only UI inputs and user-supplied handover files are changed; no product-source interception or mocked inference. beforeunload is inspected with a cancelable event without closing the page.',checks:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 const pages=[];let dialogChoice='accept';const dialogs=[];
 const open=async()=>{const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});pages.push(p);p.setDefaultTimeout(30000);p.on('pageerror',e=>report.page_errors.push(e.message));p.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==new URL(base).origin)report.external_requests.push(r.url());});p.on('dialog',async d=>{dialogs.push({type:d.type(),message:d.message(),choice:dialogChoice});await d[dialogChoice]();});await p.goto(base+'/#parking');await p.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53);await p.locator('#parking-model-choice').selectOption('mlp32');return p;};
 const exportData=async p=>{const[d]=await Promise.all([p.waitForEvent('download'),p.locator('#parking-export').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
 const restore=async(p,data)=>{await p.locator('#parking-import').setInputFiles({name:'handover.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await p.waitForFunction(()=>document.getElementById('parking-message').textContent.startsWith('已恢复人工复核'));};
 const protectedOnLeave=p=>p.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;});
 const choose=async(p,id)=>{await p.locator('#parking-filter').selectOption('all');await p.locator(`.parking-tile[data-sample-id="${id}"]`).click();};
 const form=async(p,decision,note)=>{await p.locator('#parking-decision').selectOption(decision);await p.locator('#parking-note').fill(note);};
 const formValue=async p=>({decision:await p.locator('#parking-decision').inputValue(),note:await p.locator('#parking-note').inputValue()});
 const blockedExport=async p=>{let downloaded=false;const listener=()=>downloaded=true;p.on('download',listener);await p.locator('#parking-export').click();const message=await p.locator('#parking-message').textContent();assert.match(message,/未保存.*草稿/);assert.equal(downloaded,false);p.off('download',listener);return message;};
 const save=async(p,decision,note)=>{await form(p,decision,note);await p.locator('#parking-save').click();await p.waitForFunction(()=>document.getElementById('parking-review-message').textContent.startsWith('已保存'));};
 const test=async(name,fn)=>{const evidence={};try{await fn(evidence);report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}catch(error){report.checks.push({name,passed:false,error:error.message,evidence});console.error('FAIL: '+name+': '+error.message);throw error;}};
 try{
  const p=await open();await p.locator('#parking-run').click();await p.waitForFunction(()=>document.getElementById('parking-message').textContent.startsWith('当前快照分析完成'));const initial=await exportData(p);assert.equal(initial.samples.length,53);assert.deepEqual(initial.reviews,{});let saved;
  await test('new review values reverted to empty create no record and allow handover',async e=>{
   await choose(p,first);e.variants=[];
   for(const note of ['', ' \t\n  ']){await form(p,'free','误输入的判断');await form(p,'pending',note);assert.equal(await protectedOnLeave(p),false);const data=await exportData(p);assert.deepEqual(data.reviews,{});e.variants.push({note,review_count:Object.keys(data.reviews).length});}
   assert.equal((await exportData(p)).samples.length,53);
  });
  await test('reverting saved values preserves the original note and timestamp',async e=>{
   await restore(p,initial);await choose(p,first);await save(p,'uncertain','原图阴影遮挡，请接班员核查。');saved=await exportData(p);const original=saved.reviews[first];
   await form(p,'pending','临时误改');await form(p,original.decision,original.note);assert.equal(await protectedOnLeave(p),false);const data=await exportData(p);assert.deepEqual(data.reviews,saved.reviews);e.original=original;e.after=data.reviews[first];
  });
  await test('reverting one slot keeps genuine drafts on another slot protected',async e=>{
   await restore(p,saved);await choose(p,first);await p.locator('#parking-note').fill('第一车位真正修改');await choose(p,second);await form(p,'uncertain','第二车位真正修改');await choose(p,first);assert.equal(await p.locator('#parking-note').inputValue(),'第一车位真正修改');await form(p,saved.reviews[first].decision,saved.reviews[first].note);
   e.blocked=await blockedExport(p);assert.equal(await protectedOnLeave(p),true);await choose(p,second);assert.deepEqual(await formValue(p),{decision:'uncertain',note:'第二车位真正修改'});await form(p,'pending','');assert.equal(await protectedOnLeave(p),false);assert.deepEqual((await exportData(p)).reviews,saved.reviews);e.other_draft_preserved=true;
  });
  await test('reverting a draft cannot clear saved but unexported review protection',async e=>{
   await restore(p,initial);await choose(p,first);const note='本班实际保存，还没有交接导出。';await save(p,'uncertain',note);await p.locator('#parking-note').fill('临时编辑');await p.locator('#parking-note').fill(note);assert.equal(await protectedOnLeave(p),true);
   const before=dialogs.length;dialogChoice='dismiss';await p.locator('#parking-import').setInputFiles({name:'replace.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(initial))});await p.waitForFunction(()=>document.getElementById('parking-message').textContent.startsWith('已取消恢复'));dialogChoice='accept';assert.equal(dialogs.length-before,1);assert.deepEqual(await formValue(p),{decision:'uncertain',note});e.confirmation=dialogs.at(-1);const data=await exportData(p);assert.equal(data.reviews[first].note,note);e.record=data.reviews[first];assert.equal(await protectedOnLeave(p),false);
  });
  await test('exported work reverted to saved values needs no replacement confirmation',async e=>{
   await restore(p,saved);await choose(p,first);await form(p,'pending','误改');await form(p,saved.reviews[first].decision,saved.reviews[first].note);assert.equal(await protectedOnLeave(p),false);const before=dialogs.length;await restore(p,initial);e.confirmations=dialogs.length-before;assert.equal(e.confirmations,0);assert.deepEqual((await exportData(p)).reviews,{});
  });
  await test('legacy whitespace and CRLF or CR compare like the editor without rewriting history',async e=>{
   e.records=[];
   for(const note of ['  第一行\r\n第二行  ','\t第一行\r第二行\t']){
    const legacy=structuredClone(saved);legacy.reviews[first].note=note;legacy.reviews[first].at='2026-10-01T01:02:03.000Z';await restore(p,legacy);await choose(p,first);const editor=await p.locator('#parking-note').inputValue();assert.equal(editor,note.replace(/\r\n?/g,'\n'));await p.locator('#parking-decision').selectOption('pending');await p.locator('#parking-decision').selectOption('uncertain');assert.equal(await protectedOnLeave(p),false);assert.deepEqual((await exportData(p)).reviews,legacy.reviews);
    await p.locator('#parking-note').fill(editor.trim());assert.equal(await protectedOnLeave(p),false);assert.deepEqual((await exportData(p)).reviews,legacy.reviews);
    for(const changed of [editor.replace('第一行','第一 行'),editor.replace('\n','\n\n')]){await p.locator('#parking-note').fill(changed);await blockedExport(p);await p.locator('#parking-note').fill(editor);assert.equal(await protectedOnLeave(p),false);}
    const data=await exportData(p);assert.deepEqual(data.reviews,legacy.reviews);e.records.push(data.reviews[first]);
   }
  });
  await test('bad imports and rejected saves preserve real drafts and other saved work',async e=>{
   await restore(p,saved);await choose(p,second);await form(p,'uncertain','应保留的真实草稿');const before=dialogs.length;await p.locator('#parking-import').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{broken')});await p.waitForFunction(()=>document.getElementById('parking-message').textContent.startsWith('恢复失败'));assert.equal(dialogs.length-before,0);assert.deepEqual(await formValue(p),{decision:'uncertain',note:'应保留的真实草稿'});e.import_error=await p.locator('#parking-message').textContent();await blockedExport(p);
   await form(p,'free','  ');await p.locator('#parking-save').click();await p.waitForFunction(()=>document.getElementById('parking-review-message').textContent.startsWith('保存失败'));e.save_error=await p.locator('#parking-review-message').textContent();assert.deepEqual(await formValue(p),{decision:'free',note:'  '});assert.equal(await protectedOnLeave(p),true);await choose(p,first);assert.deepEqual(await formValue(p),{decision:saved.reviews[first].decision,note:saved.reviews[first].note});await choose(p,second);assert.deepEqual(await formValue(p),{decision:'free',note:'  '});await form(p,'pending','');assert.deepEqual((await exportData(p)).reviews,saved.reviews);
  });
  await test('real MLP outputs stay identical and a fresh handover restores only human work',async e=>{
   await restore(p,saved);await choose(p,first);const data=await exportData(p),refs=new Map(JSON.parse(fs.readFileSync(path.join(root,'web/data/parking/test-predictions.json'))).map(r=>[r.id,r]));assert.equal(data.samples.length,53);assert.deepEqual(data.predictions_by_model.mlp32,initial.predictions_by_model.mlp32);e.max_score_difference=Math.max(...data.samples.map(r=>Math.abs(r.predicted_occupied_score-refs.get(r.id).score)));assert.ok(e.max_score_difference<1e-12);e.sample_count=data.samples.length;e.first_score=data.samples.find(r=>r.id===first).predicted_occupied_score;
   const fresh=await open();await restore(fresh,data);const restored=await exportData(fresh);assert.deepEqual(restored.reviews,data.reviews);assert.deepEqual(restored.view,data.view);assert.equal(restored.samples.length,0);assert.equal(restored.unanalysed_sample_ids.length,53);e.restored_reviews=restored.reviews;e.restored_prediction_count=restored.samples.length;assert.equal(await protectedOnLeave(fresh),false);await fresh.close();
  });
  await p.locator('.parking-review').scrollIntoViewIfNeeded();await p.screenshot({path:path.join(out,reportName.replace(/\.json$/,'')+'-desktop.png')});
 }catch(error){report.fatal_error=error.message;console.error(error.message);}
 finally{dialogChoice='accept';for(const p of pages)if(!p.isClosed())await p.close();await browser.close();report.finished_at=new Date().toISOString();report.passed=report.checks.filter(x=>x.passed).length;report.failed=report.checks.filter(x=>!x.passed).length;report.ok=report.checks.length===8&&!report.failed&&!report.fatal_error&&!report.page_errors.length&&!report.external_requests.length;fs.writeFileSync(path.join(out,reportName),JSON.stringify(report,null,2));console.log(JSON.stringify({report:'artifacts/'+reportName,passed:report.passed,failed:report.failed,ok:report.ok}));if(!report.ok)process.exitCode=1;}
})();
