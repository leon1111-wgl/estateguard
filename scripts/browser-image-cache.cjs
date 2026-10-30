/** Chromium test setup: a late HTTP fault must not reuse an already decoded image. */
async function clearBrowserImageCache(page){
 const session=await page.context().newCDPSession(page);
 try{
  // Routing disables HTTP caching, but a warm Image can bypass routing entirely.
  // Clear the browser cache before the next request; keep the page, loaded models,
  // application state and CacheStorage intact. Do not alter the requested URL.
  await session.send('Network.clearBrowserCache');
 }finally{await session.detach();}
}
module.exports={clearBrowserImageCache};
