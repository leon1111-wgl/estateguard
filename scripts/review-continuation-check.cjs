/** Continuous review: real D-FINE handover plus separately labelled synthetic workflow boundaries. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const reportName=process.env.REVIEW_CONTINUATION_REPORT||'review-continuation-validation.json';
const report={started_at:new Date().toISOString(),base,scope:'Real default D-FINE on the existing public CC0 bus image; access region and capture time are synthetic test context. Other cases explicitly label synthetic workflow fixtures. No model accuracy or field violation claim.',instrumentation:'Native focus/scrollIntoView calls are observed without changing their behavior. Delayed evidence cases postpone completion of actual image decode only.',checks:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});
const shot=name=>path.join(out,reportName.replace(/\.json$/,'')+'-'+name+'.png');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 report.browser=await browser.version();
 const context=await browser.newContext({acceptDownloads:true});
 await context.addInitScript(()=>{
  window.__navigationCalls=[];
  for(const [prototype,method] of [[Element.prototype,'scrollIntoView'],[HTMLElement.prototype,'focus']]){
   const native=prototype[method];prototype[method]=function(...args){window.__navigationCalls.push({method,id:this.id,tag:this.tagName});return native.apply(this,args);};
  }
  const decode=Image.prototype.decode;Image.prototype.decode=async function(){await decode.call(this);if(window.__holdEvidenceDecode)await new Promise(resolve=>window.__releaseEvidenceDecode=resolve);};
 });
 const settle=p=>p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const inspect=p=>p.evaluate(()=>{
  const rect=selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return{text:el.textContent?.trim(),top:r.top,bottom:r.bottom,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight};};
  return {event:document.querySelector('.event-index')?.textContent,heading:rect('#incident-detail .detail-header h3'),source:rect('#incident-detail .detail-header p'),badge:rect('#incident-detail .detail-header .badge'),empty:rect('#incident-detail .empty h3'),note_rect:rect('#decision-note'),note:document.getElementById('decision-note')?.value,status:document.getElementById('decision-status')?.value,media:document.querySelector('#media-preview img')?.src||null,media_status:document.getElementById('media-status')?.textContent,history:document.querySelector('.history')?.textContent,queue_count:document.getElementById('queue-count').textContent,filter:document.getElementById('queue-filter').value,area:document.getElementById('area-filter').value,focus:{id:document.activeElement.id,tag:document.activeElement.tagName,text:document.activeElement.textContent?.trim().slice(0,100)},calls:[...window.__navigationCalls],scroll_y:scrollY,hash:location.hash,message:document.getElementById('message').textContent};
 });
 const download=async(p,id='export-json')=>{const[d]=await Promise.all([p.waitForEvent('download'),p.locator('#'+id).click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
 const save=async(p,status,note)=>{await p.locator('#decision-status').selectOption(status);await p.locator('#decision-note').fill(note);await p.locator('#decision-form [type="submit"]').click();await settle(p);};
 const fixture=(count=2)=>({schema_version:1,analysis_id:'synthetic-continuation-'+count,name:'连续复核合成边界',provenance:'原创合成事件，仅验证工作流；不是模型检出或真实违规。',observations:Array.from({length:count},(_,i)=>({id:'review-'+(i+1),camera:'测试镜头',zone:'测试通道',track:'object-'+(i+1),category:'blocked_access',start:'2026-10-24T08:00:00+08:00',end:'2026-10-24T08:00:05+08:00',score:.9,quality:.9,summary:'合成目标 '+(i+1),evidence:['synthetic-object-'+(i+1)]}))});
 const deliver=(p,batch)=>p.evaluate(batch=>{const detail={batch,accepted:false};window.dispatchEvent(new CustomEvent('estateguard:candidates',{detail}));return detail.accepted;},batch);
 const select=(p,id)=>p.locator('[data-event="'+id+'"]').click();
 const attach=async(p,name)=>{await p.locator('#media-file').setInputFiles({name,mimeType:'image/jpeg',buffer:fs.readFileSync(path.join(root,'web/samples/bus.jpg'))});await p.waitForFunction(()=>document.querySelector('#media-preview img')?.naturalWidth>0&&!document.querySelector('#decision-form [type="submit"]').disabled);};
 const assertNext=async(p,state)=>{
  assert.equal(state.heading?.visible,true,'new event title must be visible after closing the previous event');
  assert.equal(state.source?.visible,true,'new camera/zone/track identity must be visible');
  assert.equal(state.badge?.visible,true,'new event risk/status must be visible');
  assert.equal(await p.evaluate(()=>document.activeElement===document.querySelector('#incident-detail .detail-header h3')),true,'focus must identify the newly selected event');
  await p.keyboard.press('Tab');const id=await p.evaluate(()=>document.activeElement.id);
  assert.ok(['media-file','decision-status','decision-note'].includes(id),'Tab should continue into evidence or review: '+id);
 };
 const infer=async(p,evidence)=>{
  await p.waitForFunction(()=>document.querySelector('#detector-evaluation-content table')&&document.getElementById('vision-detector').value==='dfine',null,{timeout:30000});
  await p.locator('#sample-image').click();await p.waitForFunction(()=>!document.getElementById('run-analysis').disabled);
  await p.locator('#vision-rule').selectOption('access');await p.locator('#vision-camera').fill('公开图片测试镜头');await p.locator('#vision-zone').fill('合成通道区域');await p.locator('#vision-start').fill('2026-10-24T08:00');await p.locator('#vision-context-confirmed').check();await p.locator('#run-analysis').click();
  await p.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.getElementById('vision-message').textContent)&&!document.getElementById('run-analysis').disabled,null,{timeout:180000});
  assert.match(await p.locator('#vision-message').textContent(),/^分析完成/);
  const data=await download(p,'download-detections');assert.equal(data.params.detector,'dfine');assert.ok(data.candidates.length>=2,'public photo must produce multiple actual candidates for this workflow');
  evidence.real_model={detector:data.params.detector,analysis_id:data.analysis_id,bus_score:data.frames[0].detections.find(d=>d.class==='bus')?.score,candidates:data.candidates.length};
  await p.locator('#send-candidates').click();await p.waitForSelector('#workspace:not([hidden])');await p.waitForFunction(()=>document.querySelector('#media-preview img')?.naturalWidth>0&&!document.querySelector('#decision-form [type="submit"]').disabled);await settle(p);
 };
 const test=async(name,viewport,body)=>{
  if(process.env.REVIEW_CONTINUATION_ONLY&&!name.includes(process.env.REVIEW_CONTINUATION_ONLY))return;
  const p=await context.newPage();await p.setViewportSize(viewport);p.setDefaultTimeout(15000);const evidence={viewport};
  p.on('dialog',d=>d.accept());p.on('pageerror',e=>report.page_errors.push({test:name,message:e.message}));p.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==new URL(base).origin)report.external_requests.push(r.url());});
  try{await p.goto(base+'/#analyze');await p.waitForSelector('.event-button',{state:'attached'});await body(p,evidence);report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}
  catch(error){evidence.final=await inspect(p).catch(()=>null);report.checks.push({name,passed:false,error:error.message,evidence});console.error('FAIL: '+name+': '+error.message);await p.screenshot({path:shot('failure-'+report.checks.length)}).catch(()=>{});}
  finally{await p.evaluate(()=>window.__releaseEvidenceDecode?.()).catch(()=>{});await p.close();fs.writeFileSync(path.join(out,reportName),JSON.stringify(report,null,2));}
 };
 try{
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}])await test('real D-FINE closing first candidate reveals next object at '+viewport.width,viewport,async(p,evidence)=>{
   await infer(p,evidence);evidence.initial=await inspect(p);assert.equal(evidence.initial.filter,'review');
   await p.locator('#decision-status').selectOption('dismissed');await p.locator('#decision-note').fill('公开照片流程测试：已核对第一对象，不作实际违规认定。');await p.locator('#decision-form [type="submit"]').scrollIntoViewIfNeeded();await settle(p);evidence.before=await inspect(p);
   await p.locator('#decision-form [type="submit"]').click();await settle(p);evidence.after=await inspect(p);await p.screenshot({path:shot('after-'+viewport.width)});
   assert.notEqual(evidence.after.event,evidence.before.event);assert.equal(evidence.after.queue_count,String(Number(evidence.before.queue_count)-1));assert.equal(evidence.after.status,'open');assert.equal(evidence.after.note,'');assert.equal(evidence.after.media,evidence.before.media,'same source photo must remain attached to the correct second candidate');
   await assertNext(p,evidence.after);
   await save(p,'needs_evidence','第二对象仍需现场核查，不能沿用上一对象的排除结论。');const ws=await download(p);evidence.decisions=ws.decisions;assert.equal(ws.decisions[evidence.before.event].status,'dismissed');assert.equal(ws.decisions[evidence.after.event].status,'needs_evidence');assert.equal(ws.audit.length,2);
  });
  await test('synthetic ordinary save and all-filter closure do not reposition unchanged selection',{width:390,height:844},async(p,evidence)=>{
   evidence.synthetic=true;assert.equal(await deliver(p,fixture()),true);await attach(p,'ordinary-public-photo.jpg');
   evidence.transitions=[];
   for(const [filter,status] of [['review','needs_evidence'],['all','dismissed']]){
    await p.locator('#queue-filter').selectOption(filter);await p.locator('#decision-status').selectOption(status);await p.locator('#decision-note').fill('同一对象的明确保存 '+status);await p.locator('#decision-form [type="submit"]').scrollIntoViewIfNeeded();await settle(p);const before=await inspect(p);
    await p.locator('#decision-form [type="submit"]').click();await settle(p);const after=await inspect(p);evidence.transitions.push({before,after});
    assert.equal(after.event,before.event);assert.equal(after.filter,filter);assert.equal(after.media,before.media);assert.equal(after.status,status);assert.equal(after.note,before.note);assert.deepEqual(after.calls,before.calls,'saving the same selected event must not add application positioning');
   }
   const ws=await download(p);assert.equal(ws.audit.length,2);assert.equal(Object.keys(ws.decisions).length,1);evidence.audit=ws.audit;
  });
  await test('synthetic next event restores its own draft and separately attached evidence',{width:390,height:844},async(p,evidence)=>{
   evidence.synthetic=true;assert.equal(await deliver(p,fixture()),true);
   await select(p,'event:review-2');await attach(p,'second-object-public-photo.jpg');await p.locator('#decision-status').selectOption('confirmed_concern');await p.locator('#decision-note').fill('第二对象尚未保存的独立草稿');const second=await inspect(p);
   await select(p,'event:review-1');await attach(p,'first-object-public-photo.jpg');const first=await inspect(p);assert.notEqual(first.media,second.media);
   await save(p,'dismissed','第一对象已排除，仅关闭第一项。');evidence.after=await inspect(p);assert.equal(evidence.after.event,second.event);assert.equal(evidence.after.note,second.note);assert.equal(evidence.after.status,second.status);assert.equal(evidence.after.media,second.media);assert.notEqual(evidence.after.media,first.media);assert.match(evidence.after.history,/0 条/);await assertNext(p,evidence.after);
   assert.match(await p.locator('.event-button.active').textContent(),/未保存草稿/);
   await p.locator('#decision-form [type="submit"]').click();await settle(p);const ws=await download(p);evidence.decisions=ws.decisions;assert.equal(ws.decisions[second.event].note,second.note);assert.equal(ws.decisions[first.event].status,'dismissed');assert.equal(ws.audit.length,2);
  });
  await test('synthetic rejected blank reason preserves selection draft evidence and current form',{width:1440,height:1000},async(p,evidence)=>{
   evidence.synthetic=true;assert.equal(await deliver(p,fixture()),true);await attach(p,'failure-public-photo.jpg');await p.locator('#decision-status').selectOption('dismissed');await p.locator('#decision-note').fill('   ');await p.locator('#decision-form [type="submit"]').scrollIntoViewIfNeeded();await p.evaluate(()=>{window.__keptForm=document.getElementById('decision-form');window.__keptImage=document.querySelector('#media-preview img');});await settle(p);evidence.before=await inspect(p);
   await p.locator('#decision-form [type="submit"]').click();await p.waitForSelector('#message.error');await settle(p);evidence.after=await inspect(p);
   for(const key of ['event','note','status','media','history','queue_count','filter','area'])assert.equal(evidence.after[key],evidence.before[key]);assert.deepEqual(evidence.after.calls,evidence.before.calls);assert.equal(await p.evaluate(()=>window.__keptForm===document.getElementById('decision-form')&&window.__keptImage===document.querySelector('#media-preview img')),true);assert.match(evidence.after.history,/0 条/);
  });
  await test('synthetic pending next evidence blocks save and late completion does not steal editing focus',{width:390,height:844},async(p,evidence)=>{
   evidence.synthetic=true;assert.equal(await deliver(p,fixture()),true);await select(p,'event:review-2');await p.evaluate(()=>window.__holdEvidenceDecode=true);
   await p.locator('#media-file').setInputFiles({name:'delayed-second-public-photo.jpg',mimeType:'image/jpeg',buffer:fs.readFileSync(path.join(root,'web/samples/bus.jpg'))});await p.waitForFunction(()=>typeof window.__releaseEvidenceDecode==='function');await p.locator('#decision-note').fill('第二对象附件待加载时的草稿');await select(p,'event:review-1');await save(p,'dismissed','第一对象完成，继续第二对象。');evidence.selected=await inspect(p);assert.equal(evidence.selected.event,'event:review-2');await assertNext(p,evidence.selected);assert.equal(await p.locator('#decision-form [type="submit"]').isDisabled(),true);
   await p.locator('#decision-note').fill('继续编辑第二对象，不能被迟到附件移走焦点');await settle(p);evidence.before=await inspect(p);
   await p.evaluate(()=>document.getElementById('decision-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle(p);const blocked=await inspect(p);assert.equal(blocked.event,evidence.before.event);assert.equal(blocked.note,evidence.before.note);assert.match(blocked.history,/0 条/);assert.deepEqual(blocked.calls,evidence.before.calls);
   await p.evaluate(()=>{window.__holdEvidenceDecode=false;window.__releaseEvidenceDecode();});await p.waitForFunction(()=>document.querySelector('#media-preview img')?.naturalWidth>0&&!document.querySelector('#decision-form [type="submit"]').disabled);await settle(p);evidence.after=await inspect(p);assert.equal(evidence.after.focus.id,'decision-note');assert.equal(evidence.after.note,evidence.before.note);assert.equal(evidence.after.note_rect.visible,true);assert.deepEqual(evidence.after.calls,evidence.before.calls,'late evidence must not reposition an operator who is already editing');
   await save(p,'needs_evidence',evidence.after.note);const ws=await download(p);assert.equal(ws.audit.length,2);assert.equal(ws.decisions['event:review-1'].status,'dismissed');assert.equal(ws.decisions['event:review-2'].note,evidence.after.note);
  });
  await test('synthetic final closure focuses empty state and keyboard reaches handover without changing filter',{width:390,height:844},async(p,evidence)=>{
   evidence.synthetic=true;assert.equal(await deliver(p,fixture(1)),true);await attach(p,'last-public-photo.jpg');await save(p,'resolved','最后一项已经人工完成，准备交班。');evidence.after=await inspect(p);
   assert.equal(evidence.after.queue_count,'0');assert.equal(evidence.after.filter,'review');assert.equal(evidence.after.empty?.visible,true);assert.equal(await p.locator('#decision-form').count(),0);assert.equal(await p.evaluate(()=>document.activeElement===document.querySelector('#incident-detail .empty h3')),true);
   await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'export-brief');const[d]=await Promise.all([p.waitForEvent('download'),p.keyboard.press('Enter')]);const markdown=fs.readFileSync(await d.path(),'utf8');assert.match(markdown,/最后一项已经人工完成/);const ws=await download(p);assert.equal(ws.audit.length,1);assert.equal(ws.decisions['event:review-1'].status,'resolved');evidence.audit=ws.audit;
  });
  await test('synthetic reopening within resolved filter reveals the next closed object and preserves filters',{width:1440,height:1000},async(p,evidence)=>{
   evidence.synthetic=true;assert.equal(await deliver(p,fixture()),true);await p.locator('#queue-filter').selectOption('all');await save(p,'resolved','第一对象原来已处理。');await select(p,'event:review-2');await save(p,'dismissed','第二对象原来已排除。');await p.locator('#queue-filter').selectOption('resolved');await p.locator('#area-filter').selectOption('Shared space');await select(p,'event:review-1');await save(p,'open','第一对象重开，需下一班再次核查。');evidence.after=await inspect(p);
   assert.equal(evidence.after.event,'event:review-2');assert.equal(evidence.after.filter,'resolved');assert.equal(evidence.after.area,'Shared space');assert.equal(evidence.after.queue_count,'1');assert.equal(evidence.after.status,'dismissed');assert.equal(evidence.after.note,'第二对象原来已排除。');await assertNext(p,evidence.after);const ws=await download(p);assert.equal(ws.audit.length,3);assert.equal(ws.decisions['event:review-1'].status,'open');assert.equal(ws.decisions['event:review-2'].status,'dismissed');evidence.decisions=ws.decisions;
  });
 }finally{
  await browser.close();report.finished_at=new Date().toISOString();report.passed=report.checks.filter(x=>x.passed).length;report.failed=report.checks.filter(x=>!x.passed).length;report.ok=report.checks.length>0&&report.failed===0&&report.page_errors.length===0&&report.external_requests.length===0;fs.writeFileSync(path.join(out,reportName),JSON.stringify(report,null,2));console.log(JSON.stringify({report:'artifacts/'+reportName,passed:report.passed,failed:report.failed,ok:report.ok}));if(!report.ok)process.exitCode=1;
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
