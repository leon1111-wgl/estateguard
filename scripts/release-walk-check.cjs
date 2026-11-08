/** Release walk: the whole visitor flow on the site as deployed (web/ served as-is): overview, enter, every console
 * tab, the main analysis with the default D-FINE-N on the public CC0 photo, and a parking snapshot with the default
 * DINOv2, at 1440 px and 375 px in light and dark. Fails on any console error, page error, cross-origin request or
 * horizontal page scroll at 375 px. Screenshots and artifacts/release-walk-validation.json are the evidence.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),out=path.join(root,'artifacts','release-walk');fs.mkdirSync(out,{recursive:true});
const base=(process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766').replace(/\/$/,''),origin=new URL(base).origin;
const views=['home','analyze','workspace','parking','policy','results','story'];
const report={checked_at:new Date().toISOString(),base,steps:{},screens:[],console_errors:[],page_errors:[],external_requests:[]};
const step=(name,value)=>{report.steps[name]=value;console.log(name,JSON.stringify(value).slice(0,300));};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});report.browser=await browser.version();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light',acceptDownloads:true});page.setDefaultTimeout(180000);page.on('dialog',d=>d.accept());
  page.on('console',m=>{if(m.type()==='error')report.console_errors.push(m.text());});page.on('pageerror',e=>report.page_errors.push(e.message));
  page.on('request',r=>{const u=r.url();if(u.startsWith('http')&&new URL(u).origin!==origin)report.external_requests.push(u);});
  const show=async view=>{await page.evaluate(v=>{location.hash=v==='home'?'':v;},view);await page.waitForFunction(v=>v==='home'?!document.getElementById('home').hidden:!document.getElementById(v).hidden,view);await page.evaluate(()=>scrollTo(0,0));};
  const shoot=async(name,{full=true}={})=>{const file=`${name}.png`;await page.screenshot({path:path.join(out,file),fullPage:full});report.screens.push(file);};

  // 1. Overview: name headline + stack line, then enter the console.
  await page.goto(base+'/');
  const intro=await page.evaluate(()=>({h1:document.querySelector('#home h1').textContent,stack:document.querySelector('.intro-stack')?.textContent,visible:!document.getElementById('home').hidden}));
  assert.equal(intro.h1,'EstateGuard');assert.equal(intro.stack,'D-FINE-N · DINOv2 · ONNX Runtime Web');assert.equal(intro.visible,true);step('overview',intro);
  await page.waitForFunction(()=>!/正在读取/.test(document.querySelector('[data-zone-count="Lift"]').textContent));
  await shoot('1440-light-home');
  await page.locator('.intro-actions [data-enter]').click();await page.waitForFunction(()=>!document.getElementById('analyze').hidden);

  // 2. Main task: the default detector (D-FINE-N once the published evaluation loads) on the CC0 photo.
  await page.waitForFunction(()=>document.getElementById('vision-detector').value==='dfine');
  await page.locator('#sample-image').click();await page.waitForFunction(()=>!document.querySelector('#run-analysis').disabled);
  await page.locator('#run-analysis').click();await page.waitForFunction(()=>/^(分析完成|分析失败)/.test(document.querySelector('#vision-message').textContent));
  const analysis=await page.evaluate(()=>({message:document.querySelector('#vision-message').textContent,model:document.getElementById('model-name').textContent,backend:document.getElementById('model-backend').textContent,rows:[...document.querySelectorAll('#detection-rows tr')].slice(0,5).map(r=>r.textContent)}));
  assert.match(analysis.message,/^分析完成/);assert.match(analysis.model,/D-FINE-N/);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#download-detections').click()]);const detections=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  fs.writeFileSync(path.join(out,'main-task-detections.json'),JSON.stringify(detections,null,2));
  assert.ok(detections.frames[0].detections.some(d=>d.class==='bus'&&d.score>=.6),'D-FINE-N should find the bus');
  step('main_task',{...analysis,detections:detections.frames[0].detections.map(d=>`${d.class} ${d.score.toFixed(3)}`),mean_inference_ms:detections.metrics.mean_inference_ms,backend_report:detections.backend});
  await page.locator('#analysis-stage').screenshot({path:path.join(out,'main-task-annotated.png')});report.screens.push('main-task-annotated.png');
  await shoot('1440-light-analyze');

  // 3. Parking: one public snapshot with the default DINOv2; every slot goes to a person on an unverified camera.
  await show('parking');await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length>0&&!document.getElementById('parking-run').disabled&&document.getElementById('parking-model-choice').value==='dinov2');
  await page.locator('#parking-run').click();await page.waitForFunction(()=>!document.querySelector('#parking-run').disabled&&/^当前快照分析完成/.test(document.querySelector('#parking-message').textContent));
  const parking=await page.evaluate(()=>({message:document.querySelector('#parking-message').textContent,model:document.getElementById('parking-model-choice').value,metrics:[...document.querySelectorAll('#parking-metrics .metric')].map(m=>m.textContent)}));
  step('parking_snapshot',parking);
  for(const view of ['workspace','parking','policy','results','story']){await show(view);if(view==='results')await page.waitForFunction(()=>document.querySelector('#parking-transfer-content table')&&document.querySelector('#detector-evaluation-content table'));await shoot(`1440-light-${view}`);}
  await show('analyze');await shoot('1440-light-analyze-after');

  // 4. Same state in dark, then 375 px in both themes.
  const widths={};
  for(const [width,height,scheme] of [[1440,1000,'dark'],[375,812,'light'],[375,812,'dark']]){
   await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});
   for(const view of views){
    await show(view);
    const w=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:innerWidth,background:getComputedStyle(document.body).backgroundColor}));
    widths[`${width}-${scheme}-${view}`]=w;if(width===375)assert.ok(w.scroll<=w.inner,`${view} at 375 px ${scheme}: page scroll width ${w.scroll}`);
    await shoot(`${width}-${scheme}-${view}`);
   }
  }
  const bg=v=>widths[v].background;assert.notEqual(bg('375-light-analyze'),bg('375-dark-analyze'),'dark theme must change the page background');
  step('layout',widths);

  assert.deepEqual(report.page_errors,[]);assert.deepEqual(report.console_errors,[]);assert.deepEqual(report.external_requests,[]);
  report.ok=true;
 }finally{await browser.close();fs.writeFileSync(path.join(out,'release-walk-validation.json'),JSON.stringify(report,null,2));}
 console.log('PASS release-walk-check',report.screens.length,'screens');
})().catch(e=>{report.fatal_error=e.message;fs.writeFileSync(path.join(out,'release-walk-validation.json'),JSON.stringify(report,null,2));console.error(e);process.exit(1);});
