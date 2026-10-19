/**
 * Actual COCO inference and event handover using the existing public CC0 bus photo.
 * The videos translate a photo on a fixed canvas. They are synthetic rule fixtures,
 * not surveillance footage, parking labels, or a measure of field accuracy.
 * Generated media stays in ignored artifacts/. No extra media download is required.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts');
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,'');
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const names=['stationary','arrive-stop','moving'];
const report={started_at:new Date().toISOString(),base,scope:'Real browser decoding and original COCO-SSD weights on synthetic movement of an existing CC0 photograph. Validates rule segmentation and human-review handover, not real-world parking accuracy.',checks:[],page_errors:[],external_requests:[]};
fs.mkdirSync(out,{recursive:true});

// Each clip has the same fixed canvas, scale, source photo, and nominal duration.
// Translation stops at 3 s only in arrive-stop. Exact encoded bytes may differ
// between Chrome versions; hashes and real sampled boxes are saved for audit.
async function createFixtures(page){
  return page.evaluate(async()=>{
    const image=new Image();image.src='samples/bus.jpg';await image.decode();
    const duration=10.4,motionEnd=3,startX=40,endX=220;
    const type=MediaRecorder.isTypeSupported('video/mp4')?'video/mp4':'video/webm';
    const movies=['stationary','arrive-stop','moving'].map(name=>{
      const canvas=document.createElement('canvas');canvas.width=960;canvas.height=640;
      const context=canvas.getContext('2d');
      const draw=t=>{
        context.fillStyle='#75818a';context.fillRect(0,0,960,640);
        const progress=name==='stationary'?1:name==='arrive-stop'?Math.min(1,t/motionEnd):Math.min(1,t/duration);
        context.drawImage(image,startX+(endX-startX)*progress,120,576,384);
      };
      draw(0);const stream=canvas.captureStream(10),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:900000});
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      const stopped=new Promise(resolve=>recorder.onstop=resolve);
      return {name,draw,stream,chunks,recorder,stopped};
    });
    const start=performance.now();for(const movie of movies)movie.recorder.start();
    const timer=setInterval(()=>{const t=(performance.now()-start)/1000;for(const movie of movies)movie.draw(t);},100);
    await new Promise(resolve=>setTimeout(resolve,duration*1000));clearInterval(timer);
    for(const movie of movies)movie.recorder.stop();await Promise.all(movies.map(movie=>movie.stopped));
    const result={};
    for(const movie of movies){
      movie.stream.getTracks().forEach(track=>track.stop());
      const bytes=new Uint8Array(await new Blob(movie.chunks,{type}).arrayBuffer());
      let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
      result[movie.name]={type,base64:btoa(binary)};
    }
    return result;
  });
}

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  report.browser=await browser.version();
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
  page.setDefaultTimeout(15000);page.on('dialog',dialog=>dialog.accept());
  page.on('pageerror',error=>report.page_errors.push(error.message));
  page.on('request',request=>{if(request.url().startsWith('http')&&new URL(request.url()).origin!==new URL(base).origin)report.external_requests.push(request.url());});
  const download=async(id,filename)=>{
    const[item]=await Promise.all([page.waitForEvent('download'),page.locator('#'+id).click()]);
    const text=fs.readFileSync(await item.path(),'utf8');
    if(filename)fs.writeFileSync(path.join(out,filename),text);
    return {text,data:JSON.parse(text)};
  };
  const test=async(name,body)=>{
    const evidence={};
    try{await body(evidence);report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}
    catch(error){report.checks.push({name,passed:false,error:error.message,evidence});console.error('FAIL: '+name+': '+error.message);}
  };
  const center=b=>[b[0]+b[2]/2,b[1]+b[3]/2];
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const actual={};
  try{
    await page.goto(base+'/?detector=ssdlite#analyze');
    const fixtureIndex=path.join(out,'vision-dwell-fixtures.json');let fixtures;
    if(process.env.VISION_DWELL_REUSE_FIXTURES==='1'){
      report.fixtures=JSON.parse(fs.readFileSync(fixtureIndex,'utf8'));
      fixtures=Object.fromEntries(names.map(name=>{
        const entry=report.fixtures.videos[name],buffer=fs.readFileSync(path.join(out,entry.file));
        assert.equal(sha256(buffer),entry.sha256,'saved fixture bytes differ');
        return [name,{type:entry.type,buffer,name:entry.file}];
      }));
    }else{
      const generated=await createFixtures(page);
      report.fixtures={source:'web/samples/bus.jpg',source_sha256:sha256(fs.readFileSync(path.join(root,'web/samples/bus.jpg'))),canvas:[960,640],photo_size:[576,384],photo_y:120,start_x:40,end_x:220,arrival_stops_at:3,nominal_duration_seconds:10.4,videos:{}};
      fixtures={};
      for(const name of names){
        const {type,base64}=generated[name],buffer=Buffer.from(base64,'base64'),file=`vision-dwell-${name}.${type.includes('mp4')?'mp4':'webm'}`;
        fs.writeFileSync(path.join(out,file),buffer);fixtures[name]={type,buffer,name:file};
        report.fixtures.videos[name]={file,type,bytes:buffer.length,sha256:sha256(buffer)};
      }
      fs.writeFileSync(fixtureIndex,JSON.stringify(report.fixtures,null,2));
    }
    // Capture all three actual reports before assertions so red runs retain controls.
    for(const name of names){
      const fixture=fixtures[name];
      await page.locator('#analysis-file').setInputFiles({name:fixture.name,mimeType:fixture.type,buffer:fixture.buffer});
      await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪')&&!document.querySelector('#run-analysis').disabled);
      await page.locator('#vision-rule').selectOption('parking');await page.locator('#vision-dwell').fill('5');
      await page.locator('#vision-camera').fill('合成规则验收镜头');await page.locator('#vision-zone').fill('完整画面测试区域');
      await page.locator('#vision-start').fill('2026-10-19T08:00');await page.locator('#vision-context-confirmed').check();
      await page.locator('#run-analysis').click();
      await page.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent)&&!document.querySelector('#run-analysis').disabled,null,{timeout:180000});
      assert.match(await page.locator('#vision-message').textContent(),/^分析完成/);
      actual[name]=(await download('download-detections',`vision-dwell-${name}-report.json`)).data;
      await page.screenshot({path:path.join(out,`vision-dwell-${name}.png`),fullPage:true});
    }
    await test('stationary control produces one sampled-dwell candidate',async evidence=>{
      const data=actual.stationary;evidence.candidates=data.candidates;evidence.frame_count=data.frames.length;
      assert.equal(data.complete,true);assert.equal(data.frames.length,11);assert.equal(data.candidates.length,1);
      assert.equal(data.candidates[0].category,'illegal_parking');
      assert.equal(Date.parse(data.candidates[0].start)-Date.parse(data.params.started_at),0);
      assert.equal(Date.parse(data.candidates[0].end)-Date.parse(data.params.started_at),10000);
    });
    await test('continuous movement remains outside the dwell review queue',async evidence=>{
      const data=actual.moving,track=data.tracks.find(track=>track.class==='bus');
      evidence.frame_count=data.frames.length;evidence.bus_samples=track?.samples;evidence.candidates=data.candidates;
      assert.equal(track.samples.length,11);assert.equal(data.candidates.length,0);
      assert.ok(distance(center(track.samples[0].bbox),center(track.samples.at(-1).bbox))>.12);
    });
    await test('arrival followed by a stable stop includes only the stopped interval',async evidence=>{
      const data=actual['arrive-stop'],track=data.tracks.find(track=>track.class==='bus');
      evidence.candidates=data.candidates;evidence.bus_samples=track?.samples;evidence.params=data.params;
      assert.equal(track.samples.length,11);assert.equal(data.candidates.length,1,'a vehicle that enters and then stops must reach human review');
      const candidate=data.candidates[0],start=(Date.parse(candidate.start)-Date.parse(data.params.started_at))/1000,end=(Date.parse(candidate.end)-Date.parse(data.params.started_at))/1000;
      assert.ok([3,4].includes(start),`dwell starts after arrival, got ${start}`);assert.equal(end,10);
      const stable=track.samples.filter(sample=>sample.time>=start&&sample.time<=end);
      evidence.stable_interval=[start,end];evidence.stable_max_displacement=Math.max(...stable.map(sample=>distance(center(sample.bbox),center(stable[0].bbox))));
      assert.ok(end-start>=5);assert.ok(evidence.stable_max_displacement<=.06);
      assert.deepEqual(candidate.evidence,stable.map(sample=>`${data.media.name} @ ${sample.time.toFixed(2)}s`));
      assert.equal(candidate.score,Math.max(...stable.map(sample=>sample.score)),'score must not include the moving frames');
      assert.equal(candidate.quality,.4);assert.equal(candidate.category,'illegal_parking');
      assert.equal(candidate.track,track.id);assert.equal(typeof candidate.stable_segment_id,'string');assert.ok(candidate.stable_segment_id.length>0);
      assert.equal(data.params.rules_version,'vision-rules-v2-stable-dwell');
      assert.equal(data.params.tracking_max_gap_seconds,1.6);
      assert.equal(data.params.parking_max_center_distance,.06);
      assert.equal(data.params.parking_min_samples,3);
    });
    await test('video candidate explanations do not contain a single-image placeholder',async evidence=>{
      evidence.summaries=[...actual.stationary.candidates,...actual['arrive-stop'].candidates].map(candidate=>candidate.summary);
      for(const summary of evidence.summaries){assert.doesNotMatch(summary,/单图|时间窗仅为格式占位/);assert.match(summary,/采样|连续/);}
    });
    await test('stable-interval candidates survive human review and JSON handover without media',async evidence=>{
      // The last displayed report is moving. Re-import the same arrival file and run
      // the genuine model again; do not inject detections or candidate events.
      const fixture=fixtures['arrive-stop'];
      await page.locator('#analysis-file').setInputFiles({name:fixture.name,mimeType:fixture.type,buffer:fixture.buffer});
      await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.startsWith('素材已就绪')&&!document.querySelector('#run-analysis').disabled);
      await page.locator('#vision-camera').fill('合成规则验收镜头');await page.locator('#vision-zone').fill('完整画面测试区域');await page.locator('#vision-start').fill('2026-10-19T08:00');await page.locator('#vision-context-confirmed').check();
      await page.locator('#run-analysis').click();await page.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent)&&!document.querySelector('#run-analysis').disabled,null,{timeout:180000});
      const rerun=(await download('download-detections')).data;
      assert.equal(rerun.candidates.length,1);assert.equal(await page.locator('#send-candidates').isEnabled(),true);
      await page.locator('#send-candidates').click();await page.waitForSelector('#workspace:not([hidden])');
      await page.waitForFunction(()=>document.querySelector('#media-preview video')?.readyState>=2&&!document.querySelector('#decision-form [type=submit]').disabled);
      assert.equal(await page.locator('.event-button').count(),1);assert.match(await page.locator('#incident-detail').textContent(),/证据不足/);
      const event=await page.locator('.event-index').textContent();
      await page.locator('#decision-status').selectOption('needs_evidence');await page.locator('#decision-note').fill('合成短片仅验证停稳片段，实际停车处置仍需现场证据。');
      await page.locator('#decision-form [type=submit]').click();
      const exported=await download('export-json','vision-dwell-handover.json');
      assert.deepEqual(exported.data.batch.observations,rerun.candidates);
      assert.equal(exported.data.decisions[event].status,'needs_evidence');
      assert.doesNotMatch(exported.text,/blob:|data:video|base64/);
      assert.equal(exported.data.media,undefined);
      await page.locator('#import-file').setInputFiles({name:'停稳事件交班.json',mimeType:'application/json',buffer:Buffer.from(exported.text)});
      await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('JSON 已导入'));
      evidence.restore_message=await page.locator('#message').textContent();
      const restored=await download('export-json');
      for(const key of ['batch','policy','decisions','audit'])assert.deepEqual(restored.data[key],exported.data[key],key+' changed on restore');
      assert.equal(await page.locator('#media-preview video').count(),0);assert.match(await page.locator('#media-status').textContent(),/未载入|请选择/);
      evidence.observation=restored.data.batch.observations[0];evidence.decision=restored.data.decisions[event];evidence.exported_bytes=Buffer.byteLength(exported.text);
      await page.screenshot({path:path.join(out,'vision-dwell-handover.png'),fullPage:true});
    });
  }catch(error){report.fatal_error=error.stack;}
  finally{
    await browser.close();report.finished_at=new Date().toISOString();report.passed=report.checks.filter(check=>check.passed).length;report.failed=report.checks.filter(check=>!check.passed).length;
    report.ok=!report.fatal_error&&report.failed===0&&report.page_errors.length===0&&report.external_requests.length===0;
    const filename=process.env.VISION_DWELL_REPORT||'vision-dwell-validation.json';fs.writeFileSync(path.join(out,filename),JSON.stringify(report,null,2));
    console.log(JSON.stringify({report:'artifacts/'+filename,passed:report.passed,failed:report.failed,ok:report.ok}));if(!report.ok)process.exitCode=1;
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
