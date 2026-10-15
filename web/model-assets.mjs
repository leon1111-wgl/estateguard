/** Public, versioned model resources only. Never cache user media or reviews. */
export const MODEL_CACHE_NAME='estateguard-public-model-v1';
const aborted=signal=>{if(signal?.aborted)throw signal.reason||new DOMException('已取消加载','AbortError');};
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
export function createModelAssetLoader({baseURL,files,signal,onProgress=()=>{},fetchFn=globalThis.fetch,cacheStorage,timeoutMs=30000,cacheTimeoutMs=2000}){
 // Sandboxed/private browsing may reject the property getter itself.
 try{if(cacheStorage===undefined)cacheStorage=globalThis.caches;}catch{cacheStorage=null;}
 const entries=new Map(files.map(file=>[file.path,file])),pending=new Map(),urls=new Map(files.map(file=>[new URL(file.path,baseURL).href,file.path]));
 const state={loaded:0,total:files.reduce((sum,file)=>sum+file.bytes,0),networkBytes:0,cacheBytes:0,cacheAvailable:!!cacheStorage};
 let store=null,ready=null;
 function storageWait(task){
  aborted(signal);
  return new Promise((resolve,reject)=>{
   let settled=false;
   const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);callback(value);};
   const cancel=()=>finish(reject,signal.reason||new DOMException('已取消加载','AbortError'));
   const timer=setTimeout(()=>finish(reject,new Error('模型缓存响应超时')),cacheTimeoutMs);
   signal?.addEventListener('abort',cancel,{once:true});
   // Native storage cannot be aborted. Consume late completion without updating UI.
   Promise.resolve().then(task).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
 }
 function storage(){if(!ready)ready=storageWait(()=>cacheStorage?.open(MODEL_CACHE_NAME)).then(value=>store=value).catch(()=>{aborted(signal);state.cacheAvailable=false;});return ready;}
 const summary=()=>({...state}),emit=()=>{if(!signal?.aborted)onProgress(summary());};
 async function verify(buffer,file){if(buffer.byteLength!==file.bytes||await digest(buffer)!==file.sha256)throw new Error('模型资源校验失败，请重试加载。');aborted(signal);return buffer;}
 async function download(url,file){
  const controller=new AbortController();let timer;
  const cancel=()=>controller.abort(signal.reason);signal?.addEventListener('abort',cancel,{once:true});
  const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new Error('模型下载超时，请检查网络后重试。')),timeoutMs);};
  try{
   aborted(signal);reset();const response=await fetchFn(url,{signal:controller.signal,cache:'no-store'});
   if(!response.ok)throw new Error(`模型资源下载失败 (${response.status})，可重试。`);
   const chunks=[];let size=0;const reader=response.body?.getReader();
   if(reader){try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>file.bytes)throw new Error('模型资源大小不匹配，请重试。');chunks.push(value);state.loaded+=value.byteLength;state.networkBytes+=value.byteLength;emit();reset();}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
   else{const chunk=new Uint8Array(await response.arrayBuffer());size=chunk.length;if(size>file.bytes)throw new Error('模型资源大小不匹配，请重试。');chunks.push(chunk);state.loaded+=size;state.networkBytes+=size;emit();}
   const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
   return await verify(buffer.buffer,file);
  }catch(error){if(signal?.aborted)aborted(signal);if(controller.signal.aborted)throw controller.signal.reason;throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 }
 async function readOne(path){
  const file=entries.get(path);if(!file)throw new Error('请求了未登记的模型资源');
  aborted(signal);await storage();aborted(signal);const url=new URL(path,baseURL).href,key=`${url}?sha256=${file.sha256}`;
  if(store){try{const cached=await storageWait(()=>store.match(key));if(cached){const buffer=await verify(await storageWait(()=>cached.arrayBuffer()),file);state.loaded+=buffer.byteLength;state.cacheBytes+=buffer.byteLength;emit();return buffer;}}catch(error){aborted(signal);await storageWait(()=>store.delete(key)).catch(()=>{aborted(signal);state.cacheAvailable=false;});}}
  const buffer=await download(url,file);aborted(signal);
  if(store){try{await storageWait(()=>store.put(key,new Response(buffer)));}catch{aborted(signal);state.cacheAvailable=false;}}
  aborted(signal);emit();return buffer;
 }
 function read(path){if(!pending.has(path))pending.set(path,readOne(path));return pending.get(path);}
 return {read,summary,fetch:async input=>{const path=urls.get(new URL(typeof input==='string'?input:input.url,baseURL).href);if(!path)throw new Error('模型请求超出本站资源清单');return new Response(await read(path),{headers:{'Content-Type':path.endsWith('.json')?'application/json':'application/octet-stream'}});}};
}
// COCO-SSD accepts a URL; use TensorFlow's IO router to retain its own warm-up
// and inference code while providing cancellable, verified asset loading.
const routes=new WeakMap();let sequence=0;
export function registerModelRoute(tf,handler){
 if(!routes.has(tf)){const map=new Map();routes.set(tf,map);tf.io.registerLoadRouter(url=>map.get(url)||null);}
 const map=routes.get(tf),url=`estateguard-model://load-${++sequence}`;map.set(url,handler);
 return {url,release:()=>map.delete(url)};
}
