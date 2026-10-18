/** Real Chrome evidence replacement checks. Public-photo fixtures are not field evidence. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const original=fs.readFileSync(path.join(root,'web/samples/bus.jpg'));
const report={started_at:new Date().toISOString(),base,scope:'Actual Chrome image/video decoding and actual COCO inference on a public CC0 photograph. Synthetic video verifies workflow only, not temporal violation accuracy.',checks:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 report.browser=await browser.version();const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 // Delay only the completion of a real browser decode. Pixel data and model output are never mocked.
 await context.addInitScript(()=>{
   const create=URL.createObjectURL.bind(URL),decode=HTMLImageElement.prototype.decode,names=new Map();
   window.__mediaDecodeCounts={};window.__mediaDecodeGates={};window.__holdMediaName=null;
   URL.createObjectURL=function(value){const url=create(value);if(value instanceof File)names.set(url,value.name);return url;};
   HTMLImageElement.prototype.decode=async function(){
     const name=names.get(this.src);if(name)window.__mediaDecodeCounts[name]=(window.__mediaDecodeCounts[name]||0)+1;
     let value,error;try{value=await decode.call(this);}catch(reason){error=reason;}
     if(name&&name===window.__holdMediaName){
       const gate={native_success:!error,released:false,completed:false};window.__mediaDecodeGates[name]=gate;
       await new Promise(resolve=>gate.release=resolve);gate.released=true;
       try{if(error)throw error;return value;}finally{gate.completed=true;}
     }
     if(error)throw error;return value;
   };
 });
 const state=page=>page.evaluate(()=>{const img=document.querySelector('#media-preview img'),video=document.querySelector('#media-preview video');return {event:document.querySelector('.event-index')?.textContent,file:document.querySelector('#media-preview p')?.textContent||null,image:img?{src:img.src,complete:img.complete,width:img.naturalWidth,height:img.naturalHeight}:null,video:video?{src:video.src,ready_state:video.readyState,width:video.videoWidth,height:video.videoHeight,duration:video.duration,error:video.error?.code||null}:null,status:document.querySelector('#media-status')?.textContent||null,status_role:document.querySelector('#media-status')?.getAttribute('role')||null,message:document.querySelector('#message')?.textContent,status_value:document.querySelector('#decision-status')?.value,note:document.querySelector('#decision-note')?.value,save_disabled:document.querySelector('#decision-form button[type="submit"]')?.disabled,file_input_value:document.querySelector('#media-file')?.value};});
 const ready=async(page,name)=>{await page.waitForFunction(name=>{const img=document.querySelector('#media-preview img'),video=document.querySelector('#media-preview video');return document.querySelector('#media-preview p')?.textContent===name&&((img?.naturalWidth>0)||(video?.videoWidth>0&&video.readyState>=2))&&!document.querySelector('#decision-form button[type="submit"]').disabled;},name,{timeout:15000});};
 const upload=async(page,name,buffer=original,mimeType='image/jpeg')=>{await page.locator('#media-file').setInputFiles({name,mimeType,buffer});await ready(page,name);};
 const retained=(before,after)=>{assert.equal(after.file,before.file,'failed replacement lost the original filename');assert.deepEqual(after.image,before.image,'failed replacement changed the original image');assert.deepEqual(after.video,before.video,'failed replacement changed the original video');assert.equal(after.note,before.note,'replacement lost the review draft');assert.equal(after.status_value,before.status_value);};
 const failed=page=>page.waitForFunction(()=>/失败|无法|不能|不支持/.test(document.querySelector('#media-status')?.textContent||'')&&!document.querySelector('#decision-form button[type="submit"]').disabled);
 const beginHeld=async(page,name,bytes=original)=>{await page.evaluate(name=>window.__holdMediaName=name,name);await page.locator('#media-file').setInputFiles({name,mimeType:'image/jpeg',buffer:bytes});await page.waitForFunction(name=>typeof window.__mediaDecodeGates[name]?.release==='function',name);};
 const releaseHeld=async(page,name)=>{await page.evaluate(name=>window.__mediaDecodeGates[name].release(),name);await page.waitForFunction(name=>window.__mediaDecodeGates[name]?.completed,name);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
 const saveButton=page=>page.locator('#decision-form button[type="submit"]');
 const downloadJSON=async(page,id)=>{const[download]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);const text=fs.readFileSync(await download.path(),'utf8');return {text,data:JSON.parse(text)};};
 const test=async(name,body)=>{const page=await context.newPage();page.setDefaultTimeout(8000);page.on('dialog',d=>d.accept());page.on('pageerror',e=>report.page_errors.push({test:name,message:e.message}));page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==new URL(base).origin)report.external_requests.push(r.url());});const evidence={};try{await page.goto(base+'/#workspace');await page.waitForSelector('.event-button');await body(page,evidence);report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}catch(error){evidence.state=await state(page).catch(()=>null);report.checks.push({name,passed:false,error:error.message,evidence});await page.screenshot({path:path.join(out,`event-media-failure-${report.checks.length}.png`),fullPage:true}).catch(()=>{});console.error('FAIL: '+name+': '+error.message);}finally{await page.close();}};
 try{
   for(const [suffix,mime]of [['jpg','image/jpeg'],['mp4','video/mp4']])await test(`broken ${suffix.toUpperCase()} preserves the previous evidence and review draft`,async(page,evidence)=>{
     await upload(page,'原证据.jpg');await page.locator('#decision-note').fill('已查看原图，等待补充证据。');await page.locator('#decision-status').selectOption('needs_evidence');evidence.before=await state(page);
     await page.locator('#media-file').setInputFiles({name:'损坏替换.'+suffix,mimeType:mime,buffer:Buffer.from('This is not valid media.')});
     await page.waitForFunction(()=>{const status=document.querySelector('#media-status');if(status)return /失败|无法|不能|不支持/.test(status.textContent)&&!document.querySelector('#decision-form button[type="submit"]').disabled;const img=document.querySelector('#media-preview img'),video=document.querySelector('#media-preview video');return Boolean(img?.complete&&img.naturalWidth===0||video?.error);});
     evidence.after=await state(page);retained(evidence.before,evidence.after);assert.equal(evidence.after.status_role,'status');assert.match(evidence.after.status,/无法|失败|不支持/);assert.match(evidence.after.status,/保留/);assert.doesNotMatch(evidence.after.status,/FFmpeg|EncodingError|cannot be decoded/i);assert.equal(await page.evaluate(async url=>{try{return(await fetch(url)).ok;}catch{return false;}},evidence.before.image.src),true);
   });
   await test('first failure leaves no pretend evidence and the same file can be selected again',async(page,evidence)=>{
     const file={name:'首次损坏.jpg',mimeType:'image/jpeg',buffer:Buffer.from('Not a JPEG')};
     for(let attempt=1;attempt<=2;attempt++){
       await page.locator('#media-file').setInputFiles(file);await failed(page);
       await page.waitForFunction(({name,count})=>window.__mediaDecodeCounts[name]===count,{name:file.name,count:attempt});
       const current=await state(page);assert.equal(current.image,null);assert.equal(current.video,null);assert.equal(current.file,null);assert.equal(current.file_input_value,'','file input must reset so a native same-file selection emits change');assert.equal(current.save_disabled,false);assert.match(current.status,/无法|失败/);
     }
     evidence.failed=await state(page);evidence.actual_decode_attempts=await page.evaluate(name=>window.__mediaDecodeCounts[name],file.name);
     await upload(page,'首次可用证据.jpg');evidence.recovered=await state(page);assert.equal(evidence.recovered.image.width,960);assert.match(evidence.recovered.status,/可查看|就绪|成功|已打开|已解码/);
   });
   await test('pending replacement keeps the original preview and permits drafting but blocks saving',async(page,evidence)=>{
     await upload(page,'核查中的原图.jpg');await page.locator('#decision-note').fill('原草稿');evidence.before=await state(page);
     await beginHeld(page,'等待解码.jpg');evidence.pending=await state(page);retained(evidence.before,evidence.pending);assert.equal(evidence.pending.save_disabled,true);assert.match(evidence.pending.status,/正在.*(?:检查|读取|解码|加载)/);
     assert.equal(await page.locator('#media-file').isEnabled(),true);assert.equal(await page.locator('#decision-note').isEnabled(),true);assert.equal(await page.locator('#decision-status').isEnabled(),true);
     await page.locator('#decision-note').fill('读取期间继续填写的草稿');await page.locator('#decision-status').selectOption('needs_evidence');
     await page.locator('#decision-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
     assert.match(await page.locator('.history').textContent(),/复核历史\s*·\s*0\s*条/);assert.doesNotMatch(await page.locator('.history').textContent(),/读取期间继续填写的草稿/);assert.equal(await saveButton(page).isDisabled(),true);assert.equal(await page.locator('#decision-note').inputValue(),'读取期间继续填写的草稿');
     await releaseHeld(page,'等待解码.jpg');await ready(page,'等待解码.jpg');evidence.after=await state(page);
     assert.equal(evidence.after.note,'读取期间继续填写的草稿');assert.equal(evidence.after.status_value,'needs_evidence');assert.equal(evidence.after.save_disabled,false);assert.notEqual(evidence.after.image.src,evidence.before.image.src);
     await saveButton(page).click();assert.match(await page.locator('.history').textContent(),/读取期间继续填写的草稿/);
   });
   for(const oldFails of [false,true])await test(`newer evidence survives an older delayed ${oldFails?'failure':'success'}`,async(page,evidence)=>{
     await upload(page,'已验证原图.jpg');await page.locator('#decision-note').fill('最新草稿必须保留');
     const oldName=oldFails?'旧失败读取.jpg':'旧成功读取.jpg';await beginHeld(page,oldName,oldFails?Buffer.from('broken JPEG'):original);
     await upload(page,'最新选择.jpg');evidence.latest=await state(page);await releaseHeld(page,oldName);evidence.after=await state(page);assert.deepEqual(evidence.after,evidence.latest);
     evidence.delayed_native_result=await page.evaluate(name=>window.__mediaDecodeGates[name].native_success,oldName);assert.equal(evidence.delayed_native_result,!oldFails);
   });
   await test('delayed evidence stays with its original event while another event remains editable',async(page,evidence)=>{
     const events=await page.locator('.event-button').evaluateAll(nodes=>nodes.slice(0,2).map(node=>node.dataset.event));
     const select=async id=>{await page.locator(`.event-button[data-event="${id}"]`).click();assert.equal((await state(page)).event,id);};
     await select(events[0]);await upload(page,'事件A原图.jpg');await page.locator('#decision-note').fill('事件A草稿');await beginHeld(page,'事件A新图.jpg');
     await select(events[1]);assert.equal(await saveButton(page).isEnabled(),true);assert.equal((await state(page)).image,null);await upload(page,'事件B原图.jpg');await page.locator('#decision-note').fill('事件B草稿');evidence.event_b_before=await state(page);
     await releaseHeld(page,'事件A新图.jpg');evidence.event_b_after=await state(page);assert.deepEqual(evidence.event_b_after,evidence.event_b_before);
     await select(events[0]);await ready(page,'事件A新图.jpg');evidence.event_a=await state(page);assert.equal(evidence.event_a.note,'事件A草稿');
     await beginHeld(page,'事件A损坏图.jpg',Buffer.from('broken JPEG'));await select(events[1]);const beforeFailure=await state(page);await releaseHeld(page,'事件A损坏图.jpg');assert.deepEqual(await state(page),beforeFailure);
     await select(events[0]);await failed(page);evidence.event_a_failed=await state(page);retained(evidence.event_a,evidence.event_a_failed);
   });
   await test('replacing the workspace invalidates pending attachments even when event IDs repeat',async(page,evidence)=>{
     await upload(page,'旧工作区原图.jpg');evidence.original=await state(page);await beginHeld(page,'旧工作区晚到图.jpg');
     await page.locator('#reset-demo').click();await page.waitForFunction(()=>!document.querySelector('#media-preview img')&&!document.querySelector('#decision-form button[type="submit"]').disabled);assert.equal((await state(page)).event,evidence.original.event);
     await upload(page,'新工作区证据.jpg');await page.locator('#decision-note').fill('新工作区草稿');evidence.replacement=await state(page);await releaseHeld(page,'旧工作区晚到图.jpg');evidence.after=await state(page);assert.deepEqual(evidence.after,evidence.replacement);
     evidence.old_url_readable=await page.evaluate(async url=>{try{return(await fetch(url)).ok;}catch{return false;}},evidence.original.image.src);assert.equal(evidence.old_url_readable,false);
   });
   await test('a real short video can be viewed and a bad replacement preserves it',async(page,evidence)=>{
     // Generate a short decodable fixture from the public photo. Repetition is disclosed, never motion evidence.
     const fixture=await page.evaluate(async()=>{
       const image=new Image();image.src='samples/bus.jpg';await image.decode();const canvas=document.createElement('canvas');canvas.width=640;canvas.height=426;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,640,426);
       const type=MediaRecorder.isTypeSupported('video/mp4')?'video/mp4':'video/webm',stream=canvas.captureStream(10),chunks=[],recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:400000});recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();const timer=setInterval(()=>ctx.drawImage(image,0,0,640,426),100);await new Promise(resolve=>setTimeout(resolve,1600));clearInterval(timer);recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());const bytes=new Uint8Array(await new Blob(chunks,{type}).arrayBuffer());let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return {type,base64:btoa(text)};
     });
     const ext=fixture.type.includes('mp4')?'mp4':'webm';await upload(page,'公开图片合成短片.'+ext,Buffer.from(fixture.base64,'base64'),fixture.type);evidence.before=await state(page);assert.equal(evidence.before.video.width,640);assert.ok(evidence.before.video.duration>1);
     await page.locator('#media-preview video').evaluate(async video=>{video.muted=true;await video.play();});await page.waitForFunction(()=>document.querySelector('#media-preview video').currentTime>.1);await page.locator('#media-preview video').evaluate(video=>{video.pause();window.__originalPreviewVideo=video;window.__originalPreviewTime=video.currentTime;});
     await page.locator('#decision-note').fill('合成静态短片，仅核查媒体播放。');const before=await state(page);await page.locator('#media-file').setInputFiles({name:'损坏短片.mp4',mimeType:'video/mp4',buffer:Buffer.from('invalid MP4')});await failed(page);evidence.after=await state(page);retained(before,evidence.after);assert.equal(await page.evaluate(()=>document.querySelector('#media-preview video')===window.__originalPreviewVideo&&window.__originalPreviewVideo.currentTime===window.__originalPreviewTime),true,'failed replacement must preserve video position and the existing preview element');
   });
   await test('actual COCO candidates keep readable evidence and handover restores records without media',async(page,evidence)=>{
     await page.locator('[data-nav="analyze"]').click();await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);
     await page.locator('#vision-rule').selectOption('access');await page.locator('#vision-camera').fill('公开图回归镜头');await page.locator('#vision-zone').fill('原子证据验证');await page.locator('#vision-start').fill('2026-10-18T08:00');await page.locator('#vision-context-confirmed').check();await page.locator('#run-analysis').click();
     await page.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent),null,{timeout:120000});assert.match(await page.locator('#vision-message').textContent(),/^分析完成/);
     const detection=await downloadJSON(page,'download-detections');evidence.real_inference={bus_score:detection.data.frames[0].detections.find(item=>item.class==='bus')?.score,candidates:detection.data.candidates.length};assert.ok(evidence.real_inference.bus_score>.8);assert.ok(evidence.real_inference.candidates>0);
     await page.locator('#send-candidates').click();await page.waitForSelector('#workspace:not([hidden])');await ready(page,'公开示例-校车.jpg');evidence.handoff=await state(page);assert.equal(evidence.handoff.image.width,960);assert.match(evidence.handoff.status,/可查看|就绪|成功|已打开|已解码/);
     await upload(page,'本地替换仅供查看不应导出.jpg');await page.locator('#decision-status').selectOption('needs_evidence');await page.locator('#decision-note').fill('已核查公开图，需现场资料补证。');await saveButton(page).click();
     const exported=await downloadJSON(page,'export-json');assert.doesNotMatch(exported.text,/blob:|data:image|data:video|本地替换仅供查看不应导出/);assert.equal(exported.data.decisions[evidence.handoff.event].note,'已核查公开图，需现场资料补证。');assert.equal(exported.data.media,undefined);evidence.exported_keys=Object.keys(exported.data);evidence.exported_bytes=Buffer.byteLength(exported.text);
     await page.locator('#import-file').setInputFiles({name:'事件交班恢复.json',mimeType:'application/json',buffer:Buffer.from(exported.text)});await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('JSON 已导入'));evidence.restored=await state(page);
     assert.equal(evidence.restored.event,evidence.handoff.event);assert.equal(evidence.restored.image,null);assert.equal(evidence.restored.video,null);assert.equal(evidence.restored.note,'已核查公开图，需现场资料补证。');assert.equal(evidence.restored.status_value,'needs_evidence');assert.match(evidence.restored.status,/未载入|请选择/);assert.match(evidence.restored.message,/媒体文件需另行打开/);
     await page.screenshot({path:path.join(out,'event-media-handover-restored.png'),fullPage:true});
   });
 }catch(error){report.fatal_error=error.stack;}
 finally{await browser.close();report.finished_at=new Date().toISOString();report.passed=report.checks.filter(x=>x.passed).length;report.failed=report.checks.filter(x=>!x.passed).length;report.ok=!report.fatal_error&&report.failed===0&&report.page_errors.length===0&&report.external_requests.length===0;const filename=process.env.EVENT_MEDIA_REPORT||'event-media-validation.json';fs.writeFileSync(path.join(out,filename),JSON.stringify(report,null,2));console.log(JSON.stringify({report:'artifacts/'+filename,passed:report.passed,failed:report.failed,ok:report.ok}));if(!report.ok)process.exitCode=1;}
})().catch(error=>{console.error(error);process.exitCode=1;});
