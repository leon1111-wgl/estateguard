/** Runs actual model inference. The video fixture repeats a public CC0 photograph. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const base=process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766';const origin=new URL(base).origin;
 page.on('request',r=>{if(r.url().startsWith('http')&&new URL(r.url()).origin!==origin)external.push(r.url());});
 const out=path.join(__dirname,'../artifacts');fs.mkdirSync(out,{recursive:true});
 const confirmContext=async()=>{await page.locator('#vision-camera').fill('模型运行回归');await page.locator('#vision-zone').fill('测试区域');await page.locator('#vision-start').fill('2026-10-16T08:00');await page.locator('#vision-context-confirmed').check();};
 await page.goto(base);await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);await page.locator('#vision-rule').selectOption('access');
 await confirmContext();
 const run=async()=>{await page.locator('#run-analysis').click();await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('分析完成')||document.querySelector('#vision-message').textContent.startsWith('分析失败'),{},{timeout:120000});assert.match(await page.locator('#vision-message').textContent(),/^分析完成/);};
 const report=async name=>{const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);const text=fs.readFileSync(await d.path(),'utf8');fs.writeFileSync(path.join(out,name),text);return JSON.parse(text);};
 await run();const image=await report('model-image.json');assert.ok(image.frames[0].detections.some(d=>d.class==='bus'&&d.score>.8));assert.equal(image.candidates[0].category,'blocked_access');assert.equal(image.complete,true);
 await page.screenshot({path:path.join(out,'model-desktop.png'),fullPage:true});
 await page.locator('#send-candidates').click();await page.waitForSelector('#workspace:not([hidden])');assert.equal(await page.locator('.event-button').count(),1);assert.match(await page.locator('#incident-detail').textContent(),/证据不足/);await page.waitForFunction(()=>document.querySelector('#media-preview img')?.naturalWidth>0&&!document.querySelector('#decision-form [type=submit]').disabled);assert.equal(await page.locator('#media-preview img').count(),1);
 await page.locator('#decision-status').selectOption('dismissed');await page.locator('#decision-note').fill('公开检测示例，不是小区通道违规证据。');await page.getByRole('button',{name:'保存复核记录',exact:true}).click();assert.equal(await page.locator('.event-button').count(),0);
 await page.locator('[data-nav="analyze"]').click();
 // A real decodable file, but deliberately synthetic temporal content.
 const fixture=await page.evaluate(async()=>{
   const img=new Image();img.src='samples/bus.jpg';await img.decode();const c=document.createElement('canvas');c.width=640;c.height=426;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height);
   const type=MediaRecorder.isTypeSupported('video/mp4')?'video/mp4':'video/webm';const stream=c.captureStream(10),chunks=[],rec=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:400000});
   rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise(resolve=>rec.onstop=resolve);rec.start();const timer=setInterval(()=>ctx.drawImage(img,0,0,c.width,c.height),100);await new Promise(resolve=>setTimeout(resolve,6200));clearInterval(timer);rec.stop();await stopped;stream.getTracks().forEach(t=>t.stop());const bytes=new Uint8Array(await new Blob(chunks,{type}).arrayBuffer());let text='';for(const b of bytes)text+=String.fromCharCode(b);return {base64:btoa(text),type};
 });
 const ext=fixture.type.includes('mp4')?'mp4':'webm',videoBytes=Buffer.from(fixture.base64,'base64');fs.writeFileSync(path.join(out,'synthetic-still.'+ext),videoBytes);
 await page.locator('#analysis-file').setInputFiles({name:'synthetic-still.'+ext,mimeType:fixture.type,buffer:videoBytes});await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪')||document.querySelector('#vision-message').classList.contains('error'));
 assert.match(await page.locator('#vision-message').textContent(),/^素材已就绪/);
 await page.locator('#vision-rule').selectOption('parking');await page.locator('#vision-dwell').fill('2');await confirmContext();await run();const video=await report('model-video.json');assert.ok(video.metrics.frame_count>=5);assert.ok(video.candidates.some(c=>c.category==='illegal_parking'));
 const tensorBefore=await page.evaluate(()=>tf.memory().numTensors);await run();const tensorAfter=await page.evaluate(()=>tf.memory().numTensors);assert.ok(tensorAfter<=tensorBefore+2,`tensor growth ${tensorBefore} -> ${tensorAfter}`);
 await page.locator('#vision-offset').fill('2');await page.locator('#vision-context-confirmed').check();await run();const offsetVideo=await report('model-video-offset.json');assert.equal(offsetVideo.params.offset_seconds,2);assert.equal(offsetVideo.frames[0].time,2);assert.equal(offsetVideo.params.sample_interval_seconds,1);assert.equal(offsetVideo.params.max_frames,20);assert.equal(offsetVideo.params.max_detections,50);assert.equal(offsetVideo.params.minimum_score,.5);assert.equal(offsetVideo.params.nms_iou_threshold,.5);assert.equal(offsetVideo.params.postprocess,'coco-ssd-2.2.3-fixed-nms-v1');assert.ok(offsetVideo.candidates.length>0);assert.equal(Date.parse(offsetVideo.candidates[0].start)-Date.parse(offsetVideo.params.started_at),2000);
 await page.locator('#vision-offset').fill('999');await page.locator('#run-analysis').click();assert.match(await page.locator('#vision-message').textContent(),/起点必须小于/);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(out,'model-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 fs.writeFileSync(path.join(out,'model-validation.json'),JSON.stringify({date:new Date().toISOString(),browser:await browser.version(),scope:'Local execution smoke tests; not detection accuracy or real-world parking validation.',image_score:image.frames[0].detections.find(d=>d.class==='bus').score,image_mean_ms:image.metrics.mean_inference_ms,video_frames:video.metrics.frame_count,video_mean_ms:video.metrics.mean_inference_ms,tensors_before:tensorBefore,tensors_after:tensorAfter,external_requests:external.length,passed:['real image inference','same-origin assets','candidate handoff','review dismissal','real video decoding and sampling','synthetic dwell candidate','repeat inference tensor stability','nonzero offset export and candidate timestamp','out-of-range offset rejection','mobile layout']},null,2));
 console.log('PASS actual model:',JSON.stringify({image_score:image.frames[0].detections.find(d=>d.class==='bus').score,image_ms:image.metrics.mean_inference_ms,video_frames:video.metrics.frame_count,video_ms:video.metrics.mean_inference_ms,tensorBefore,tensorAfter,external:external.length}));await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
