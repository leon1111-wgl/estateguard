// Console shell: header stays in view on hash navigation, navigation reachable at 390 px, appearance preference persists.
// Only opens pages and switches views; no analysis is started, so no model inference runs.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const base=process.env.ESTATEGUARD_URL||'http://127.0.0.1:8766';
const views=['analyze','workspace','parking','policy','results','story'];
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const errors=[];
 try{
  for(const [width,height,isMobile] of [[1440,900,false],[390,844,true]]){
   const context=await browser.newContext({viewport:{width,height},isMobile,colorScheme:'light'}),page=await context.newPage();
   page.on('pageerror',e=>errors.push(e.message));
   for(const view of views){
    await page.goto(`${base}/?detector=ssdlite#${view}`);
    await page.waitForFunction(v=>!document.getElementById(v).hidden&&document.querySelector('[data-nav].active')?.dataset.nav===v,view);
    const state=await page.evaluate(v=>({scrollY,header:document.querySelector('.global-header').getBoundingClientRect().top,active:document.querySelector('[data-nav].active')?.dataset.nav,overflow:document.documentElement.scrollWidth}),view);
    assert.equal(state.scrollY,0,`${width}px #${view} opened scrolled past the header`);
    assert.equal(state.header,0,`${width}px #${view} header not at top`);
    assert.equal(state.active,view);
    assert.ok(state.overflow<=width,`${width}px #${view} overflows: ${state.overflow}`);
   }
   for(const view of views){
    // Start from the bottom of the previous view so a jump that leaves the page scrolled is caught.
    await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
    await page.locator(`[data-nav="${view}"]`).click();
    await page.waitForFunction(v=>!document.getElementById(v).hidden&&document.querySelector('[data-nav].active')?.dataset.nav===v,view);
    const after=await page.evaluate(()=>{const a=document.querySelector('[data-nav].active'),strip=a.closest('nav'),n=strip.getBoundingClientRect(),r=a.getBoundingClientRect(),fade=strip.scrollWidth>strip.clientWidth?27:-1;return {scrollY,current:a.getAttribute('aria-current'),inside:r.left>=n.left-1&&r.right<=n.right-fade};});
    assert.equal(after.scrollY,0,`${width}px nav to ${view} left the page scrolled`);
    assert.equal(after.current,'page');
    assert.ok(after.inside,`${width}px active tab ${view} is outside the navigation strip`);
   }
   // Deep links on a phone also bring the current tab into the strip.
   await page.goto(`${base}/#story`);await page.waitForFunction(()=>document.querySelector('[data-nav].active')?.dataset.nav==='story');
   assert.ok(await page.evaluate(()=>{const a=document.querySelector('[data-nav].active'),strip=a.closest('nav'),n=strip.getBoundingClientRect(),r=a.getBoundingClientRect(),fade=strip.scrollWidth>strip.clientWidth?27:-1;return r.left>=n.left-1&&r.right<=n.right-fade;}),`${width}px deep link hides the active tab`);
   await context.close();
  }
  // Appearance: system by default, explicit choice wins over the OS setting and survives reload.
  const context=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'dark'}),page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  const bg=()=>page.evaluate(()=>getComputedStyle(document.body).backgroundColor);
  await page.goto(`${base}/#policy`);
  assert.equal(await page.locator('#theme-select').inputValue(),'system');
  const systemDark=await bg();
  await page.locator('#theme-select').selectOption('light');
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
  const light=await bg();assert.notEqual(light,systemDark,'light choice did not override the dark OS setting');
  await page.reload();
  assert.equal(await page.locator('#theme-select').inputValue(),'light');
  assert.equal(await bg(),light);
  await page.locator('#theme-select').selectOption('system');
  assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-theme')),false);
  assert.equal(await bg(),systemDark);
  await context.close();
  // Blocked storage must not break the page.
  const blocked=await browser.newContext({viewport:{width:1440,height:900}}),bp=await blocked.newPage();
  bp.on('pageerror',e=>errors.push(e.message));
  await bp.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError');}});});
  await bp.goto(`${base}/#workspace`);await bp.waitForFunction(()=>document.querySelectorAll('.event-button').length>0);
  await bp.locator('#theme-select').selectOption('dark');
  assert.equal(await bp.evaluate(()=>document.documentElement.dataset.theme),'dark');
  await blocked.close();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({shell:'ok',views:views.length,viewports:[1440,390],theme:'system/light/dark persisted'}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
