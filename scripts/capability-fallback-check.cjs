/** Visitor-input failure paths in a real browser: a browser without WebAssembly SIMD (simulated by making
 * WebAssembly.validate reject the SIMD probe), files without a MIME type, HEIC photos, extreme aspect ratios and
 * whole-scene photos in the single-slot test. Runs SSDLite and MobileNetV2 for real; never downloads the ONNX models.
 * Writes artifacts/capability-fallback-validation.json and screenshots.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const bus=fs.readFileSync(path.join(root,'web/samples/bus.jpg')),slot=fs.readFileSync(path.join(root,'web/data/parking/images/B-20150708-0805-1.jpg'));
const heic=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypheic'),Buffer.alloc(32)]);
const report={checked_at:new Date().toISOString(),base,checks:[],page_errors:[],external_requests:[],onnx_requests:[]};
const test=async(name,fn)=>{const evidence={};try{await fn(evidence);report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}catch(e){report.checks.push({name,passed:false,error:e.message,evidence});console.error('FAIL: '+name+': '+e.message);}};
// Only the SIMD probe is rejected, so every other WebAssembly use behaves as in that browser.
const noSimd=()=>{const validate=WebAssembly.validate;WebAssembly.validate=function(bytes){const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes.buffer||bytes);if(b.length===31&&b[25]===253&&b[27]===253)return false;return validate.apply(this,arguments);};};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 const open=async(simd)=>{const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});p.setDefaultTimeout(120000);p.on('dialog',d=>d.accept());
  p.on('pageerror',e=>report.page_errors.push(e.message));p.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==origin)report.external_requests.push(u);if(!simd&&/onnxruntime-web|\.onnx/.test(u))report.onnx_requests.push(u);});
  if(!simd)await p.addInitScript(noSimd);return p;};
 const message=p=>p.locator('#vision-message').textContent();
 const opened=p=>p.waitForFunction(()=>{const m=document.querySelector('#vision-message');return m.textContent.startsWith('素材已就绪')||m.classList.contains('error');});
 const analysed=async p=>{await p.locator('#run-analysis').click();await p.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent));};
 const detections=async p=>{const [d]=await Promise.all([p.waitForEvent('download'),p.locator('#download-detections').click()]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));};
 try{
  const p=await open(false);
  await test('without SIMD the analysis page keeps SSDLite, disables D-FINE-N and says why',async ev=>{
   await p.goto(base+'/#analyze');await p.waitForFunction(()=>/WebAssembly SIMD/.test(document.querySelector('#vision-detector-help').textContent)&&/AP/.test(document.querySelector('#vision-detector-help').textContent));
   ev.detector=await p.locator('#vision-detector').inputValue();ev.dfine_disabled=await p.locator('#vision-detector option[value="dfine"]').evaluate(o=>o.disabled);ev.help=await p.locator('#vision-detector-help').textContent();
   assert.equal(ev.detector,'ssdlite');assert.equal(ev.dfine_disabled,true);
  });
  await test('without SIMD the visitor photo is still analysed for real with SSDLite',async ev=>{
   await p.locator('#analysis-file').setInputFiles({name:'my-photo.jpg',mimeType:'image/jpeg',buffer:bus});await opened(p);assert.match(await message(p),/^素材已就绪/);
   await analysed(p);ev.message=await message(p);assert.match(ev.message,/^分析完成/);
   const r=await detections(p);ev.model=r.model;ev.top=r.frames[0].detections[0];assert.match(r.model,/SSDLite/);assert.ok(r.frames[0].detections.some(d=>d.class==='bus'&&d.score>.5));
   await p.locator('#analysis-stage').screenshot({path:path.join(out,'capability-no-simd-analysis.png')});
  });
  await test('a ?detector=dfine link on such a browser falls back with a visible message',async ev=>{
   await p.goto(base+'/?detector=dfine#analyze');await p.waitForFunction(()=>document.querySelector('#vision-message').textContent.includes('链接指定了 D-FINE-N'));
   ev.message=await message(p);ev.detector=await p.locator('#vision-detector').inputValue();assert.equal(ev.detector,'ssdlite');
  });
  await test('without SIMD the parking page defaults to MobileNetV2 and still answers a visitor crop',async ev=>{
   await p.goto(base+'/#parking');await p.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53&&document.getElementById('parking-model-choice').value==='mobilenet');
   ev.dinov2_disabled=await p.locator('#parking-model-choice option[value="dinov2"]').evaluate(o=>o.disabled);assert.equal(ev.dinov2_disabled,true);
   ev.help=await p.locator('#parking-model-help').textContent();assert.match(ev.help,/WebAssembly SIMD/);
   await p.locator('#parking-upload').setInputFiles({name:'my-slot.jpg',mimeType:'image/jpeg',buffer:slot});
   await p.waitForFunction(()=>document.querySelector('#parking-upload-result img')?.naturalWidth>0&&document.getElementById('parking-upload-result').textContent.includes('my-slot.jpg'));
   ev.result=await p.locator('#parking-upload-result').textContent();assert.match(ev.result,/MobileNetV2/);assert.doesNotMatch(ev.result,/图片为 \d+×\d+ 像素/,'a 150 px crop gets no scene note');
   await p.locator('.parking-upload-panel').screenshot({path:path.join(out,'capability-no-simd-parking.png')});
  });
  await test('no ONNX Runtime or ONNX model file was requested without SIMD',async ev=>{ev.onnx_requests=report.onnx_requests;assert.deepEqual(report.onnx_requests,[]);});
  await p.close();

  const q=await open(true);
  await q.goto(base+'/?detector=ssdlite#analyze');
  await test('a JPEG whose picker gave no MIME type is recognised from its bytes',async ev=>{
   await q.locator('#analysis-file').setInputFiles({name:'photo',mimeType:'',buffer:bus});await opened(q);ev.message=await message(q);assert.match(ev.message,/^素材已就绪/);
   await analysed(q);const r=await detections(q);ev.media_type=r.media.type;assert.equal(r.media.type,'image/jpeg');
  });
  await test('a HEIC photo gets a specific reason on both upload paths',async ev=>{
   await q.locator('#analysis-file').setInputFiles({name:'IMG_0001.HEIC',mimeType:'',buffer:heic});await opened(q);ev.analysis=await message(q);assert.match(ev.analysis,/HEIC/);
   await q.goto(base+'/#parking');await q.waitForFunction(()=>document.querySelectorAll('.parking-tile').length===53);
   await q.locator('#parking-model-choice').selectOption('mlp32');
   await q.locator('#parking-upload').setInputFiles({name:'IMG_0002.heic',mimeType:'image/heic',buffer:heic});await q.waitForFunction(()=>/HEIC/.test(document.getElementById('parking-upload-status').textContent));
   ev.parking=await q.locator('#parking-upload-status').textContent();
  });
  const drawn=async(width,height)=>Buffer.from(await q.evaluate(async([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#556';x.fillRect(0,0,w,h);x.fillStyle='#ddd';for(let i=0;i<w;i+=120)x.fillRect(i,h*.3,60,h*.4);const b=await new Promise(r=>c.toBlob(r,'image/jpeg',.85));return [...new Uint8Array(await b.arrayBuffer())];},[width,height]));
  await test('a whole-scene photo in the single-slot test gets a note that the score does not apply',async ev=>{
   await q.locator('#parking-upload').setInputFiles({name:'whole-lot.jpg',mimeType:'image/jpeg',buffer:await drawn(1280,960)});
   await q.waitForFunction(()=>document.getElementById('parking-upload-result').textContent.includes('whole-lot.jpg'));
   ev.result=await q.locator('#parking-upload-result').textContent();assert.match(ev.result,/图片为 1280×960 像素/);assert.match(ev.result,/这个分数没有意义/);
  });
  await test('an extreme panorama is analysed with an aspect-ratio warning',async ev=>{
   await q.goto(base+'/?detector=ssdlite#analyze');
   await q.locator('#analysis-file').setInputFiles({name:'panorama.jpg',mimeType:'image/jpeg',buffer:await drawn(3600,600)});await opened(q);
   ev.message=await message(q);assert.match(ev.message,/长宽比约 6\.0:1/);
   await analysed(q);assert.match(await message(q),/^分析完成/);
  });
  await test('a very tall image is capped at 1920 px frame height',async ev=>{
   await q.locator('#analysis-file').setInputFiles({name:'tall.jpg',mimeType:'image/jpeg',buffer:await drawn(400,8000)});await opened(q);
   ev.canvas=await q.evaluate(()=>[document.getElementById('analysis-canvas').width,document.getElementById('analysis-canvas').height]);assert.deepEqual(ev.canvas,[96,1920]);
  });
  await q.close();
 }finally{
  await browser.close();
  report.ok=report.checks.length>0&&report.checks.every(c=>c.passed)&&!report.page_errors.length&&!report.external_requests.length;
  fs.writeFileSync(path.join(out,'capability-fallback-validation.json'),JSON.stringify(report,null,2));
 }
 if(!report.ok){console.error('FAILED',JSON.stringify({failed:report.checks.filter(c=>!c.passed).map(c=>c.name),page_errors:report.page_errors,external:report.external_requests}));process.exit(1);}
 console.log('PASS capability-fallback-check');
})().catch(e=>{console.error(e);process.exit(1);});
