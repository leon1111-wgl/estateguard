/** Regression checks for independently reproduced user-workflow failures. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const page=await browser.newPage();page.on('dialog',d=>d.accept());const base=process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766';
 await page.goto(base+'/?detector=ssdlite#workspace');await page.waitForSelector('.event-button');await page.locator('#queue-filter').selectOption('all');await page.locator('[data-event="event:move-booked-1"]').click();
 await page.locator('#decision-status').selectOption('confirmed_concern');await page.locator('#decision-note').fill('现场复核发现预约已过期，需要跟进。');await page.getByRole('button',{name:'保存复核记录',exact:true}).click();await page.locator('#queue-filter').selectOption('review');assert.equal(await page.locator('.event-button').count(),10);assert.equal(await page.locator('.metric strong').nth(2).textContent(),'10');
 await page.locator('[data-event="event:move-booked-1"]').click();await page.locator('#decision-status').selectOption('resolved');await page.locator('#decision-note').fill('已确认完成处理。');await page.getByRole('button',{name:'保存复核记录',exact:true}).click();assert.equal(await page.locator('.event-button').count(),9);
 await page.locator('[data-nav="analyze"]').click();
 await page.evaluate(()=>{const decode=Image.prototype.decode;let calls=0;Image.prototype.decode=async function(){await decode.call(this);if(++calls===1)await new Promise(r=>setTimeout(r,500));};});
 const bytes=fs.readFileSync(path.join(__dirname,'../web/samples/bus.jpg'));
 await page.locator('#analysis-file').setInputFiles({name:'First-A.jpg',mimeType:'image/jpeg',buffer:bytes});await page.locator('#analysis-file').setInputFiles({name:'Second-B.jpg',mimeType:'image/jpeg',buffer:bytes});await page.waitForFunction(()=>document.querySelector('#analysis-file-info').textContent.startsWith('Second-B.jpg'));await page.waitForTimeout(650);assert.match(await page.locator('#analysis-file-info').textContent(),/^Second-B.jpg/);
 await page.locator('#analysis-file').setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')});await page.waitForFunction(()=>document.querySelector('#vision-message').textContent.includes('当前仍保留此前素材'));assert.match(await page.locator('#analysis-file-info').textContent(),/^Second-B.jpg/);assert.equal(await page.locator('#run-analysis').isEnabled(),true);
 await browser.close();console.log('PASS: manual priority overrides, resolved counts, asynchronous media replacement and failed replacement preservation.');
})().catch(e=>{console.error(e);process.exit(1);});
