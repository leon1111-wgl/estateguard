/** Probe: run your own images or short videos through the page's real visitor path in headless Chrome.
 * Each URL is downloaded by this script (as a visitor would save a file), handed to the page's file input, and analysed
 * with the page's own buttons: 视频与图片分析 (D-FINE-N or SSDLite) and, optionally, 测试自己的车位图片 (default
 * occupancy model). Nothing is mocked; the page's own messages are recorded, including refusals and failures.
 * Inputs (environment): PROBE_URLS (whitespace/comma separated, at most 20), PROBE_DETECTOR dfine|ssdlite,
 * PROBE_RULE objects|access|lift, PROBE_PARKING true|false, PROBE_VIEWPORT desktop|mobile.
 * PROBE_CLIPS (at most 10 video URLs): each goes through 事件时间线 (whole frame, the page's default score floor and
 * dwell): CNN-timeline.json (the page's own export), CNN-timeline.png, CNN-detections.json and one keyframe PNG per
 * event (CNN-event-eXXX.png, at most 12 per clip), opened by clicking the event like a visitor.
 * Writes artifacts/probe/: summary.json, summary.md, NN-detections.json, NN-analysis.png (annotated frame),
 * NN-page.png, NN-parking.png.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const out=path.join(__dirname,'..','artifacts','probe');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const urls=(process.env.PROBE_URLS||'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
const clips=(process.env.PROBE_CLIPS||'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
const {runTimeline,openKeyframe,inputFile}=require('./timeline-fixture.cjs');
const MAX_CLIPS=10,MAX_KEYFRAMES=12,CLIP_TIMEOUT=900000;
const detector=['dfine','ssdlite'].includes(process.env.PROBE_DETECTOR)?process.env.PROBE_DETECTOR:'dfine';
const rule=['objects','access','lift'].includes(process.env.PROBE_RULE)?process.env.PROBE_RULE:'objects';
const parking=!/^(false|0|no)$/i.test(process.env.PROBE_PARKING||'true');
const mobile=process.env.PROBE_VIEWPORT==='mobile';
// 开放词汇慢车道 (0.6.0): after each completed still-image analysis, click the lane like a visitor (first item confirms the download).
const openVocab=/^(true|1|yes)$/i.test(process.env.PROBE_OPEN_VOCAB||'false');
// The lane is hidden on the site (appendix 4); the probe then serves the evaluation configuration in place of the site's
// config so the maintainer can see the model's output on their own images. The summary says so.
const laneConfig=JSON.parse(fs.readFileSync(path.join(__dirname,'..','web/data/open-vocab/config.json'),'utf8'));
const forcedLane=openVocab&&!laneConfig.shipped?fs.readFileSync(path.join(__dirname,'open-vocab-probe-config.json'),'utf8'):null;
const MAX_BYTES=100*1024*1024,MAX_URLS=20,ITEM_TIMEOUT=240000;
const summary={started_at:new Date().toISOString(),scope:'Probe of the deployed page code on the URLs given. Each result is what a visitor would see for that file; it is not an accuracy measurement.',settings:{detector,rule,parking,open_vocab:openVocab?(forcedLane?'forced: lane not shipped; evaluation configuration from scripts/open-vocab-probe-config.json (Grounding DINO tiny q8, t=0.15, 11 classes), which failed the dev precision bar':'shipped configuration'):false,viewport:mobile?'375x812':'1440x1000'},items:[],clips:[],page_errors:[],console_errors:[],external_requests:[]};
const pad=i=>String(i+1).padStart(2,'0');
const mimeFor=(header,name)=>{const t=(header||'').split(';')[0].trim().toLowerCase();if(/^(image|video)\//.test(t))return t;const ext=(name.match(/\.([a-z0-9]+)$/i)||[])[1]?.toLowerCase();return {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',mp4:'video/mp4',webm:'video/webm',heic:'image/heic',gif:'image/gif',avif:'image/avif'}[ext]||'';};
async function download(url){
 const started=Date.now(),response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(60000),headers:{'user-agent':'EstateGuard-probe/1.0 (+https://github.com/leon1111-wgl/estateguard)'}});
 if(!response.ok)throw new Error(`HTTP ${response.status}`);
 const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_BYTES)throw new Error(`${declared} bytes is over the probe's 100 MB limit`);
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES)throw new Error('over the probe\'s 100 MB limit');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks.map(c=>Buffer.from(c)));
 let name=decodeURIComponent(new URL(response.url||url).pathname.split('/').pop()||'download')||'download';name=name.replace(/[^\w.\-()一-鿿]/g,'_').slice(-80)||'download';
 return {bytes,name,content_type:response.headers.get('content-type')||'',final_url:response.url,ms:Date.now()-started};
}
// Written after every item, so a job that hits its time limit still leaves what was probed so far.
function writeSummary(){
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
 const cell=s=>String(s??'').replace(/\|/g,'\\|').replace(/\n/g,' ').slice(0,220);
 const rows=summary.items.map(x=>{const top=x.analysis?.detections?.[0]?.detections.slice(0,5).map(d=>`${d.class} ${d.score.toFixed(2)}`).join(', ');return `| ${x.index} | ${cell(x.url)} | ${cell(x.download_error||`${x.download.bytes} B · ${x.file.mime_given_to_page}`)} | ${cell(x.probe_error?`probe error: ${x.probe_error}`:x.analysis?.outcome?`${x.analysis.outcome}: ${x.analysis.message||x.analysis.open_message}`:'')} | ${cell(top||'')} | ${cell(x.open_vocab?(x.open_vocab.status||`${x.open_vocab.message} ${x.open_vocab.detections.map(d=>`${d.class} ${d.score.toFixed(2)}`).join(', ')}`):'')} | ${cell(x.parking?(x.parking.result||x.parking.status):'')} |`;});
 const clipRows=summary.clips.map(x=>`| C${x.index} | ${cell(x.url)} | ${cell(x.download_error||`${x.download.bytes} B · ${x.file.mime_given_to_page}`)} | ${cell(x.probe_error?`probe error: ${x.probe_error}`:x.message||x.open_message||'')} | ${cell((x.events||[]).map(e=>`${e.id} ${e.rule} ${e.class} ${e.start}–${e.end}s`).join('; ')||'—')} |`);
 fs.writeFileSync(path.join(out,'summary.md'),[`# EstateGuard probe · ${summary.started_at}`,'',summary.scope,'',`Detector ${detector} · rule ${rule} · parking ${parking} · viewport ${summary.settings.viewport} · ${summary.browser}`,'','| # | URL | File | 视频与图片分析 | Top detections | 开放词汇慢车道 | 车位图片测试 |','| --- | --- | --- | --- | --- | --- | --- |',...rows,'',...(clipRows.length?['## 事件时间线 (clip_urls)','','| # | URL | File | Page message | Events (clip seconds) |','| --- | --- | --- | --- | --- |',...clipRows,'']:[]),`Page errors: ${summary.page_errors.length} · console errors: ${summary.console_errors.length} · cross-origin requests: ${summary.external_requests.length}`,''].join('\n'));
}
(async()=>{
 if(!urls.length&&!clips.length){console.error('PROBE_URLS and PROBE_CLIPS are empty');process.exit(2);}
 if(clips.length>MAX_CLIPS)summary.clip_note=`Only the first ${MAX_CLIPS} of ${clips.length} clip URLs were probed.`;
 if(urls.length>MAX_URLS)summary.note=`Only the first ${MAX_URLS} of ${urls.length} URLs were probed.`;
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});summary.browser=await browser.version();
 const viewport=mobile?{width:375,height:812}:{width:1440,height:1000};
 const newPage=async hash=>{const p=await browser.newPage({viewport,...(mobile?{isMobile:true,hasTouch:true}:{}),acceptDownloads:true});p.setDefaultTimeout(180000);p.on('dialog',d=>d.accept());if(forcedLane)await p.route('**/data/open-vocab/config.json',r=>r.fulfill({status:200,contentType:'application/json',body:forcedLane}));
  p.on('pageerror',e=>summary.page_errors.push(e.message));p.on('console',m=>{if(m.type()==='error')summary.console_errors.push(m.text());});
  p.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==origin)summary.external_requests.push(u);});
  await p.goto(`${base}/?detector=${detector}${hash}`);return p;};
 const page=await newPage('#analyze');
 let parkingPage=null;
 try{
  // 事件时间线 for each clip URL: the visitor path, the page's own export, and every event's keyframe as a PNG.
  for(const [i,url] of clips.slice(0,MAX_CLIPS).entries()){
   const item={index:i+1,url},tag=`C${pad(i)}`;summary.clips.push(item);console.log(`[${tag}] ${url}`);
   try{
    let file;
    try{file=await download(url);}catch(e){item.download_error=String(e.message||e);console.log('  download failed:',item.download_error);continue;}
    item.download={final_url:file.final_url,bytes:file.bytes.length,sha256:crypto.createHash('sha256').update(file.bytes).digest('hex'),content_type:file.content_type,ms:file.ms};
    const mimeType=mimeFor(file.content_type,file.name);item.file={name:file.name,mime_given_to_page:mimeType||'(none)'};
    const run=await runTimeline(page,{name:file.name,type:mimeType,buffer:file.bytes},{timeout:CLIP_TIMEOUT});
    item.open_message=run.opened;item.message=run.message;item.outcome=!run.message?'refused':run.message.startsWith('分析完成')?'completed':/^分析/.test(run.message)?'failed':'refused';
    item.model=await page.locator('#model-name').textContent();item.backend=await page.locator('#model-backend').textContent();
    if(await page.locator('#download-detections').isEnabled()){const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);fs.copyFileSync(await d.path(),path.join(out,`${tag}-detections.json`));}
    if(item.outcome==='completed'){
     const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download-timeline').click()]);const tl=JSON.parse(fs.readFileSync(await d.path(),'utf8'));
     fs.writeFileSync(path.join(out,`${tag}-timeline.json`),JSON.stringify(tl,null,2));
     item.analysed=tl.analysed;item.settings=tl.settings;item.events=tl.events.map(e=>({id:e.id,rule:e.rule,class:e.class,start:e.start,end:e.end,keyframe_time:e.keyframe_time,score:e.score,condition_seconds:e.condition_seconds}));
     item.summary_line=await page.locator('#timeline-summary').textContent();
     await page.locator('#timeline-panel').screenshot({path:path.join(out,`${tag}-timeline.png`)});
     item.keyframes=[];
     for(const e of tl.events.slice(0,MAX_KEYFRAMES)){await openKeyframe(page,e.id,{via:'row'});const png=`${tag}-event-${e.id}.png`;await page.locator('#analysis-stage').screenshot({path:path.join(out,png)});item.keyframes.push(png);}
    }else await page.screenshot({path:path.join(out,`${tag}-page.png`),fullPage:!mobile});
    console.log(`  ${item.outcome}: ${item.message||item.open_message}`);
   }catch(e){item.probe_error=String(e.message||e);console.log('  probe error:',item.probe_error);await page.goto(`${base}/?detector=${detector}#analyze`).catch(()=>{});}
   finally{writeSummary();}
  }
  for(const [i,url] of urls.slice(0,MAX_URLS).entries()){
   const item={index:i+1,url};summary.items.push(item);console.log(`[${pad(i)}] ${url}`);
   try{
   let file;
   try{file=await download(url);}catch(e){item.download_error=String(e.message||e);console.log('  download failed:',item.download_error);continue;}
   item.download={final_url:file.final_url,bytes:file.bytes.length,sha256:crypto.createHash('sha256').update(file.bytes).digest('hex'),content_type:file.content_type,ms:file.ms};
   const mimeType=mimeFor(file.content_type,file.name);item.file={name:file.name,mime_given_to_page:mimeType||'(none)'};
   // 视频与图片分析
   const a=item.analysis={};
   // Clear the previous item's message so its refusal or completion cannot be read as this file's answer.
   const clearMessage=()=>page.evaluate(()=>{const m=document.querySelector('#vision-message');m.textContent='';m.classList.remove('error');});
   await clearMessage();
   await page.locator('#analysis-file').setInputFiles(inputFile({name:file.name,type:mimeType,buffer:file.bytes}));
   await page.waitForFunction(()=>{const m=document.querySelector('#vision-message');return m.textContent.startsWith('素材已就绪')||m.classList.contains('error');});
   a.open_message=await page.locator('#vision-message').textContent();
   if(!a.open_message.startsWith('素材已就绪')){a.outcome='refused';await page.screenshot({path:path.join(out,`${pad(i)}-page.png`),fullPage:!mobile});console.log('  refused:',a.open_message);}
   else{
    await page.locator('#vision-rule').selectOption(rule);
    if(rule!=='objects'){await page.locator('#vision-camera').fill('探针');await page.locator('#vision-zone').fill('探针区域');await page.locator('#vision-start').fill('2026-11-08T08:00');await page.locator('#vision-context-confirmed').check();a.context='probe placeholders: camera 探针, zone 探针区域, 2026-11-08 08:00, whole frame';}
    await clearMessage();await page.locator('#run-analysis').click();
    await page.waitForFunction(()=>/^(分析完成|分析失败|分析已停止|模型加载已取消)/.test(document.querySelector('#vision-message').textContent),{},{timeout:ITEM_TIMEOUT});
    a.message=await page.locator('#vision-message').textContent();a.outcome=a.message.startsWith('分析完成')?'completed':'failed';
    a.model=await page.locator('#model-name').textContent();a.backend=await page.locator('#model-backend').textContent();
    a.detector_help=await page.locator('#vision-detector-help').textContent();
    if(await page.locator('#download-detections').isEnabled()){
     const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);const report=JSON.parse(fs.readFileSync(await d.path(),'utf8'));
     fs.writeFileSync(path.join(out,`${pad(i)}-detections.json`),JSON.stringify(report,null,2));
     a.frames=report.metrics.frame_count;a.mean_inference_ms=report.metrics.mean_inference_ms;a.media=report.media;a.candidates=report.candidates.length;
     a.detections=report.frames.map(f=>({time:f.time,detections:f.detections.map(x=>({class:x.class,score:+x.score.toFixed(4),bbox:x.bbox.map(v=>+v.toFixed(4))}))}));
    }
    a.candidate_explanation=await page.locator('#candidate-explanation').textContent();
    if(openVocab&&a.outcome==='completed'){
     const ov=item.open_vocab={};
     if(await page.locator('#ovd-panel').isHidden())ov.status='panel not offered (lane hidden, video, or analysis incomplete)';
     else if(await page.locator('#ovd-start').isHidden())ov.status=`unavailable: ${await page.locator('#ovd-unavailable').textContent()}`;
     else{
      await page.evaluate(()=>{document.querySelector('#ovd-message').textContent='';});const t=Date.now();
      await page.locator('#ovd-start').click();if(await page.locator('#ovd-confirm').isVisible()){ov.confirmation=await page.locator('#ovd-confirm-text').textContent();await page.locator('#ovd-load').click();}
      await page.waitForFunction(()=>/^(找到|慢车道没有找到|慢车道未能运行|已取消下载)/.test(document.querySelector('#ovd-message').textContent),{},{timeout:900000});
      ov.seconds=(Date.now()-t)/1000;ov.message=await page.locator('#ovd-message').textContent();ov.rows=await page.locator('#ovd-rows tr').allTextContents();
      const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);const r=JSON.parse(fs.readFileSync(await d.path(),'utf8'));
      fs.writeFileSync(path.join(out,`${pad(i)}-detections.json`),JSON.stringify(r,null,2));
      ov.detections=(r.open_vocab?.detections||[]).map(x=>({class:x.class,score:+x.score.toFixed(4),bbox:x.bbox.map(v=>+v.toFixed(4))}));ov.lane_candidates=r.candidates.filter(c=>c.source==='open_vocab').length;
      ov.model=r.open_vocab&&`${r.open_vocab.model} ${r.open_vocab.repo}@${r.open_vocab.revision.slice(0,8)} t=${r.open_vocab.threshold}`;
      await page.locator('#analysis-stage').screenshot({path:path.join(out,`${pad(i)}-open-vocab.png`)});
     }
     console.log(`  open-vocab: ${ov.status||ov.message}`);
    }
    await page.locator('#analysis-stage').screenshot({path:path.join(out,`${pad(i)}-analysis.png`)});
    await page.screenshot({path:path.join(out,`${pad(i)}-page.png`),fullPage:!mobile});
    console.log(`  ${a.outcome}: ${a.message}`);
   }
   // 测试自己的车位图片
   if(parking&&mimeType!=='video/mp4'&&mimeType!=='video/webm'){
    const pk=item.parking={};
    if(!parkingPage){parkingPage=await newPage('#parking');await parkingPage.waitForFunction(()=>document.querySelectorAll('.parking-tile').length>0&&!document.getElementById('parking-upload').disabled);}
    pk.model=await parkingPage.locator('#parking-model-choice').inputValue();
    // Clear the status first so two identical messages in a row are still seen as a new answer.
    await parkingPage.evaluate(()=>{document.getElementById('parking-upload-status').textContent='';});
    await parkingPage.locator('#parking-upload').setInputFiles(inputFile({name:file.name,type:mimeType,buffer:file.bytes}));
    await parkingPage.waitForFunction(()=>{const s=document.getElementById('parking-upload-status').textContent;return s!==''&&!s.startsWith('正在')&&!document.getElementById('parking-upload').disabled;},{},{timeout:ITEM_TIMEOUT});
    pk.status=await parkingPage.locator('#parking-upload-status').textContent();
    pk.result=(await parkingPage.locator('#parking-upload-result').textContent()).includes(file.name)?await parkingPage.locator('#parking-upload-result').textContent():null;
    await parkingPage.locator('.parking-upload-panel').screenshot({path:path.join(out,`${pad(i)}-parking.png`)});
    console.log(`  parking: ${pk.status}`);
   }
   }catch(e){item.probe_error=String(e.message||e);console.log('  probe error:',item.probe_error);await page.goto(`${base}/?detector=${detector}#analyze`).catch(()=>{});}
   finally{writeSummary();}
  }
 }finally{
  await browser.close();summary.finished_at=new Date().toISOString();
  writeSummary();
 }
 console.log(`probe finished: ${summary.items.length} item(s); page errors ${summary.page_errors.length}; external requests ${summary.external_requests.length}`);
})().catch(e=>{console.error(e);process.exit(1);});
