/** Event timeline (0.5.0) through the visitor path in a real browser, with the real detectors on a synthetic clip
 * (scripts/timeline-fixture.cjs): D-FINE-N and SSDLite each produce a "车辆停下" segment whose keyframe is where the bus
 * stops; clicking the segment and the list button draws that keyframe; the JSON export matches the page; a photo is
 * refused for the timeline; a stopped run produces no timeline; other rules are unchanged. Runs on GitHub Actions.
 * Writes artifacts/event-timeline/ (screenshots, exports, event-timeline-validation.json). */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {makeTimelineClip,runTimeline,openKeyframe}=require('./timeline-fixture.cjs');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts','event-timeline');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const report={checked_at:new Date().toISOString(),base,scope:'Real detectors on a synthetic clip of the CC0 bus photo. Checks the timeline flow, not accuracy.',checks:[],console_errors:[],page_errors:[],external_requests:[]};
const check=async(name,body)=>{const evidence={};try{await body(evidence);report.checks.push({name,passed:true,evidence});console.log('PASS',name);}catch(e){report.checks.push({name,passed:false,error:e.message,evidence});console.error('FAIL',name,e.message);}};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 const open=async query=>{const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});p.setDefaultTimeout(60000);
  p.on('console',m=>{if(m.type()==='error')report.console_errors.push(m.text());});p.on('pageerror',e=>report.page_errors.push(e.message));
  p.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==origin)report.external_requests.push(u);});
  await p.goto(`${base}/${query}#analyze`);await p.waitForFunction(()=>!document.getElementById('analyze').hidden);return p;};
 const download=async(p,id,file)=>{const [d]=await Promise.all([p.waitForEvent('download'),p.locator('#'+id).click()]);const text=fs.readFileSync(await d.path(),'utf8');fs.writeFileSync(path.join(out,file),text);return JSON.parse(text);};
 try{
  const page=await open('?detector=dfine');
  const clip=await makeTimelineClip(page);fs.writeFileSync(path.join(out,'timeline-fixture.webm'),clip.buffer);report.fixture={...clip.spec,bytes:clip.buffer.length,sha256:clip.sha256};
  await check('choosing the timeline sets its own score floor and dwell and needs no camera or time',async ev=>{
   await page.locator('#analysis-file').setInputFiles({name:clip.name,mimeType:clip.type,buffer:clip.buffer});
   await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪'));
   await page.locator('#vision-rule').selectOption('timeline');
   Object.assign(ev,await page.evaluate(()=>({score:document.getElementById('vision-score').value,dwell:document.getElementById('vision-dwell').value,dwellEnabled:!document.getElementById('vision-dwell').disabled,confirmationHidden:document.getElementById('vision-context-confirmation').hidden,status:document.getElementById('vision-context-status').textContent})));
   const settings=await page.evaluate(async()=>(await import('./event-timeline.mjs')).TIMELINE_SETTINGS);
   assert.equal(Number(ev.score),settings.minimum_score);assert.equal(Number(ev.dwell),settings.dwell_seconds);assert.equal(ev.dwellEnabled,true);assert.equal(ev.confirmationHidden,true);assert.match(ev.status,/无需填写来源和时间/);
  });
  for(const [detector,p] of [['dfine',page],['ssdlite',await open('?detector=ssdlite')]]){
   await check(`${detector}: the bus that drives in and stops is one 车辆停下 segment with its keyframe at the stop`,async ev=>{
    const run=await runTimeline(p,clip);ev.message=run.message;assert.match(run.message,/^分析完成：.*时间线 \d+ 个待核实事件/);
    const data=await download(p,'download-timeline',`timeline-${detector}.json`);ev.events=data.events;
    const stops=data.events.filter(e=>e.rule==='vehicle_stop');assert.equal(stops.length,1,'one vehicle stop');
    const e=stops[0];assert.equal(e.class,'bus');assert.ok(e.keyframe_time>=2&&e.keyframe_time<=4,`keyframe ${e.keyframe_time}`);assert.ok(e.start<e.keyframe_time&&e.end>e.keyframe_time);
    assert.equal(data.format,'estateguard-timeline');assert.ok(data.limits.some(x=>/不等于安全/.test(x)));assert.ok(data.analysed.frames>=11,`frames ${data.analysed.frames}`);
    const segments=await p.locator('.tl-seg').count();assert.equal(segments,data.events.length);
    await openKeyframe(p,e.id,{via:'segment'});
    ev.detail=await p.locator('#timeline-detail').textContent();assert.match(ev.detail,/车辆停下/);assert.match(ev.detail,/关键帧/);
    ev.frame_label=await p.locator('#analysis-file-info').textContent();assert.match(ev.frame_label,new RegExp(`检测画面：${e.keyframe_time.toFixed(1)} 秒`));
    await p.locator('#analysis-stage').screenshot({path:path.join(out,`${detector}-keyframe.png`)});
    await openKeyframe(p,e.id,{via:'row'});assert.equal(await p.locator(`.tl-open[data-event="${e.id}"]`).getAttribute('aria-pressed'),'true');
    await p.locator('#vision-results').screenshot({path:path.join(out,`${detector}-timeline.png`)});
    const detections=await download(p,'download-detections',`detections-${detector}.json`);assert.equal(detections.timeline.events.length,data.events.length);assert.equal(detections.candidates.length,0);
    assert.equal(await p.locator('#send-candidates').isDisabled(),true);
   });
  }
  await check('a photo is refused for the timeline with a reason',async ev=>{
   await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);
   await page.locator('#vision-rule').selectOption('timeline');await page.locator('#run-analysis').click();
   ev.message=await page.locator('#vision-message').textContent();assert.match(ev.message,/事件时间线需要视频/);assert.equal(await page.locator('#timeline-panel').isHidden(),true);
  });
  await check('a run stopped part way produces no timeline',async ev=>{
   await page.locator('#analysis-file').setInputFiles({name:clip.name,mimeType:clip.type,buffer:clip.buffer});
   await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪')&&!document.querySelector('#run-analysis').disabled);
   await page.locator('#vision-rule').selectOption('timeline');await page.locator('#run-analysis').click();
   await page.waitForFunction(()=>/^正在推理 [3-9]/.test(document.querySelector('#vision-message').textContent));await page.locator('#stop-analysis').click();
   await page.waitForFunction(()=>/^分析已停止/.test(document.querySelector('#vision-message').textContent));
   ev.message=await page.locator('#vision-message').textContent();assert.match(ev.message,/不生成时间线/);assert.equal(await page.locator('#timeline-panel').isHidden(),true);
  });
  await check('the parking dwell rule is unchanged: 20-frame cap and its own dwell default',async ev=>{
   await page.locator('#vision-rule').selectOption('parking');Object.assign(ev,await page.evaluate(()=>({dwell:document.getElementById('vision-dwell').value,confirmation:!document.getElementById('vision-context-confirmation').hidden})));
   assert.equal(ev.dwell,'5');assert.equal(ev.confirmation,true);
  });
  assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.console_errors,[]);assert.deepEqual(report.external_requests,[]);
  assert.ok(report.checks.every(c=>c.passed),'every check passes');report.ok=true;
 }finally{await browser.close();fs.writeFileSync(path.join(out,'event-timeline-validation.json'),JSON.stringify(report,null,2));}
 console.log('PASS event-timeline-check',report.checks.length);
})().catch(e=>{report.fatal_error=e.message;fs.writeFileSync(path.join(out,'event-timeline-validation.json'),JSON.stringify(report,null,2));console.error(e);process.exit(1);});
