// Real-browser regressions from the independent property-user review.
// Run against the served web/ directory. PLAYWRIGHT_MODULE and CHROME_PATH are optional.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766';
const root=path.join(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'web/data/parking/manifest.json')));
const allPredictions=JSON.parse(fs.readFileSync(path.join(root,'web/data/parking/test-predictions.json')));
const hash=manifest.model_sha256,first=manifest.samples[0].id;
const envelope=reviews=>({format:'estateguard-parking-review',version:1,model_sha256:hash,reviews});
const review=note=>Buffer.from(JSON.stringify(envelope({[first]:{decision:'busy',note,at:'2026-10-15T16:00:00Z'}})));
const errors=[];

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const newPage=async options=>{const page=await browser.newPage(options);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());return page;};
 const open=async page=>{await page.goto(`${base}/#parking`);await page.waitForFunction(()=>document.querySelectorAll('.parking-tile').length>0);await page.locator('#parking-model-choice').selectOption('mlp32');};
 const delayInputs=async(page,ms)=>page.route('**/data/parking/inputs/**',async route=>{await new Promise(r=>setTimeout(r,ms));await route.continue();});
 try{
  // A previously accepted near-8-MiB review grew beyond its own import limit.
  const page=await newPage({acceptDownloads:true});await open(page);
  const reviews={};for(const sample of manifest.samples.slice(0,4100))reviews[sample.id]={decision:'busy',note:'x',at:'2026-10-15T16:00:00Z'};
  const data=envelope(reviews);let remaining=8*1024*1024-100-Buffer.byteLength(JSON.stringify(data));
  for(const entry of Object.values(reviews)){const n=Math.min(1999,remaining);entry.note+='x'.repeat(n);remaining-=n;if(!remaining)break;}
  assert.equal(remaining,0);const original=Buffer.from(JSON.stringify(data));
  await page.locator('#parking-import').setInputFiles({name:'near-limit.json',mimeType:'application/json',buffer:original});
  await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('已恢复人工复核'));
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#parking-export').click()]);
  const exported=fs.readFileSync(await download.path()),parsed=JSON.parse(exported);
  assert.ok(exported.length>8*1024*1024);assert.ok(exported.length<=32*1024*1024);
  assert.equal(exported.toString(),JSON.stringify(parsed));
  await page.locator('#parking-import').setInputFiles({name:'own-export.json',mimeType:'application/json',buffer:exported});
  await page.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('已恢复人工复核'));
  assert.equal(await page.locator('#parking-note').inputValue(),reviews[first].note);
  console.log(`PASS: compact parking export restores ${Object.keys(parsed.reviews).length} reviews (${exported.length} bytes).`);
  await page.close();

  // Human notes need a separate budget so future inference cannot strand saved work.
  const capacity=await newPage({acceptDownloads:true});await open(capacity);
  const bounded=Object.fromEntries(manifest.samples.map(sample=>[sample.id,{decision:'busy',note:'x',at:'2026-10-15T16:00:00.000Z'}]));
  let spare=24*1024*1024-Buffer.byteLength(JSON.stringify(bounded));
  for(const entry of Object.values(bounded).slice(1)){
   const chars=Math.min(1999,Math.floor(spare/3));entry.note+='中'.repeat(chars);spare-=chars*3;
   const ascii=Math.min(2000-entry.note.length,spare);entry.note+='x'.repeat(ascii);spare-=ascii;if(!spare)break;
  }
  assert.equal(spare,0);assert.equal(Buffer.byteLength(JSON.stringify(bounded)),24*1024*1024);
  await capacity.locator('#parking-import').setInputFiles({name:'notes-at-budget.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(envelope(bounded)))});
  await capacity.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('已恢复人工复核'));
  bounded[first].note+='y';
  await capacity.locator('#parking-import').setInputFiles({name:'notes-over-budget.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(envelope(bounded)))});
  await capacity.waitForFunction(()=>document.querySelector('#parking-message').textContent.includes('人工复核记录超过 24 MiB'));
  assert.equal(await capacity.locator('#parking-note').inputValue(),'x');
  await capacity.locator('#parking-note').fill('xy');await capacity.locator('#parking-save').click();
  assert.ok((await capacity.locator('#parking-message').textContent()).includes('人工复核记录超过 24 MiB'));
  await capacity.locator('#parking-export').click();assert.ok((await capacity.locator('#parking-message').textContent()).includes('未保存'));
  await capacity.locator('#parking-note').fill('x');await capacity.locator('#parking-save').click();
  await capacity.waitForFunction(()=>document.querySelector('#parking-review-message').textContent.startsWith('已保存 '));
  await capacity.locator('#parking-run').click();await capacity.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('当前快照分析完成'));
  const [capacityDownload]=await Promise.all([capacity.waitForEvent('download'),capacity.locator('#parking-export').click()]);
  const capacityExport=fs.readFileSync(await capacityDownload.path()),capacityParsed=JSON.parse(capacityExport);
  assert.equal(Object.keys(capacityParsed.reviews).length,6413);assert.equal(capacityParsed.reviews[first].note,'x');assert.equal(capacityParsed.samples.length,53);
  assert.ok(capacityExport.length<32*1024*1024);
  await capacity.locator('#parking-import').setInputFiles({name:'notes-with-predictions.json',mimeType:'application/json',buffer:capacityExport});
  await capacity.waitForFunction(()=>document.querySelector('#parking-message').textContent.startsWith('已恢复人工复核'));
  console.log(`PASS: 24-MiB notes remain exportable after inference (${capacityExport.length} bytes); over-budget save/import preserve existing work and drafts.`);await capacity.close();

  // File read completion order must not override the user's latest selection.
  const race=await newPage();await race.addInitScript(()=>{const original=File.prototype.text;File.prototype.text=async function(){const result=await original.call(this);if(this.name==='A.json')await new Promise(r=>setTimeout(r,600));return result;};});await open(race);
  await race.locator('#parking-import').setInputFiles({name:'A.json',mimeType:'application/json',buffer:review('OLD A')});await race.waitForTimeout(50);
  await race.locator('#parking-import').setInputFiles({name:'B.json',mimeType:'application/json',buffer:review('LATEST B')});
  await race.waitForFunction(()=>document.querySelector('#parking-note').value==='LATEST B');await race.waitForTimeout(700);
  assert.equal(await race.locator('#parking-note').inputValue(),'LATEST B');console.log('PASS: late completion of the older review import is ignored.');await race.close();

  // Slow but valid image requests expose manual-run/playback interleavings.
  const slow=await newPage();await delayInputs(slow,300);await open(slow);
  await slow.locator('#parking-run').click();await slow.waitForSelector('#parking-stop:visible');await slow.locator('#parking-play').click();
  await slow.waitForTimeout(2100);assert.equal(await slow.locator('#parking-frame').inputValue(),'0');assert.equal(await slow.locator('#parking-stop').isVisible(),true);
  await slow.waitForFunction(()=>Number(document.querySelector('#parking-frame').value)===1,null,{timeout:20000});
  await slow.waitForSelector('#parking-stop:visible');await slow.locator('#parking-stop').click();await slow.waitForSelector('#parking-stop',{state:'hidden'});await slow.waitForTimeout(2100);
  assert.equal(await slow.locator('#parking-frame').inputValue(),'1');assert.equal(await slow.locator('#parking-play').getAttribute('aria-pressed'),'false');
  console.log('PASS: playback waits for manual analysis; stopping prevents further frame advances.');await slow.close();

  // Jumping from the error picker must analyse the requested frame after any old run.
  const jump=await newPage();await delayInputs(jump,250);await open(jump);
  await jump.locator('#parking-run').click();await jump.waitForSelector('#parking-stop:visible');await jump.evaluate(()=>location.hash='results');
  await jump.locator('#parking-load-errors').click();await jump.waitForSelector('#parking-error-example');
  const target=allPredictions.find(r=>!r.correct&&!r.id.includes('-0805-')).id;
  await jump.locator('#parking-error-example').selectOption(target);
  await jump.waitForFunction(id=>{
   const selected=document.querySelector('.parking-tile[aria-pressed="true"]');
   return selected?.dataset.sampleId===id&&document.querySelector('#parking-stop').hidden&&!document.querySelector('#parking-detail').textContent.includes('未运行模型');
  },target,{timeout:20000});
  assert.equal(await jump.locator('.parking-tile[aria-pressed="true"]').getAttribute('data-sample-id'),target);
  const targetTime=manifest.samples.find(r=>r.id===target).time;
  assert.ok((await jump.locator('#parking-message').textContent()).includes(`${targetTime.slice(0,2)}:${targetTime.slice(2)}`));
  console.log(`PASS: error-picker jump analyses target ${target}, rather than treating the old frame as complete.`);await jump.close();

  const mobile=await newPage({viewport:{width:390,height:844}});await open(mobile);await mobile.locator('.parking-tile').first().click();
  await mobile.waitForFunction(()=>{const y=document.querySelector('.parking-review').getBoundingClientRect().y;return y>=0&&y<150;});
  const detail=await mobile.locator('.parking-review').boundingBox();assert.ok(detail.y>=0&&detail.y<150,`mobile review top: ${detail.y}`);
  console.log('PASS: selecting a parking tile brings the review panel into view on mobile.');await mobile.close();
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
