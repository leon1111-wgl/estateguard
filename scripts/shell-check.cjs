// Console shell: header stays in view on hash navigation, navigation reachable at 390 px, appearance preference persists.
// The site overview at / fits both widths and its entry, zone and shift links open the matching console view.
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
   // Site overview: shown without a hash, fits the viewport, and its links open the matching console view.
   const home=async()=>{await page.goto(`${base}/`);await page.waitForFunction(()=>document.querySelectorAll('#shift-list .shift-item').length>0);};
   const opened=async view=>{await page.waitForFunction(v=>location.hash===`#${v}`&&!document.getElementById(v).hidden,view);return page.evaluate(v=>({scrollY,focus:document.activeElement===document.querySelector(`#${v} h1`),intro:!document.getElementById('home').hidden}),view);};
   await home();
   const overview=await page.evaluate(()=>({intro:!document.getElementById('home').hidden,console:!document.querySelector('.app-frame').hidden,title:document.getElementById('view-title').textContent,zones:document.querySelectorAll('.zone-card').length,shift:document.querySelectorAll('#shift-list .shift-item').length,events:document.querySelectorAll('.event-button').length,overflow:document.documentElement.scrollWidth,plan:document.getElementById('site-plan').getBoundingClientRect().width}));
   assert.equal(overview.intro,true,`${width}px overview hidden at /`);assert.equal(overview.console,false);assert.equal(overview.title,'站点总览');assert.equal(overview.zones,4);
   assert.ok(overview.shift>=overview.events&&overview.shift>0,`${width}px shift strip does not list the workspace events`);
   assert.ok(overview.overflow<=width,`${width}px overview overflows: ${overview.overflow}`);assert.ok(overview.plan>0&&overview.plan<=width);
   await page.getByRole('link',{name:'进入巡检台',exact:true}).click();
   assert.deepEqual(await opened('analyze'),{scrollY:0,focus:true,intro:false},`${width}px enter did not land on analysis`);
   await page.locator('.wordmark').click();await page.waitForFunction(()=>!document.getElementById('home').hidden);
   await page.goto(`${base}/#home`);await page.waitForFunction(()=>!document.getElementById('home').hidden);assert.equal(await page.evaluate(()=>scrollY),0,`${width}px #home deep link scrolled past the header`);
   await page.locator('.zone-card[data-area="Refuse"]').click();
   assert.deepEqual(await opened('workspace'),{scrollY:0,focus:true,intro:false});
   const refuse=await page.evaluate(()=>({area:document.getElementById('area-filter').value,chips:[...document.querySelectorAll('.event-button .zone-chip')].map(c=>c.textContent)}));
   assert.equal(refuse.area,'Refuse');assert.ok(refuse.chips.length>0&&refuse.chips.every(t=>t==='垃圾收集点'),`${width}px zone card did not filter the queue: ${refuse.chips}`);
   await home();await page.locator('.zone-card[data-zone="parking"]').click();
   assert.deepEqual(await opened('parking'),{scrollY:0,focus:true,intro:false});
   await home();const item=page.locator('#shift-list .shift-item').nth(2),eventId=await item.getAttribute('data-event-link');await item.click();
   await page.waitForFunction(id=>location.hash==='#workspace'&&document.querySelector('.event-button.active')?.dataset.event===id&&document.activeElement===document.querySelector('#incident-detail .detail-header h3'),eventId);
   if(!isMobile)assert.equal(await page.evaluate(()=>scrollY),0,`${width}px shift link left the page header out of view`);
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
  console.log(JSON.stringify({shell:'ok',views:views.length,overview:'enter/zone/shift links',viewports:[1440,390],theme:'system/light/dark persisted'}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
