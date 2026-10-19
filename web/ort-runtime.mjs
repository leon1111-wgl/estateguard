/** One ONNX Runtime Web instance per page, imported from hash-verified bytes and shared by every
 * ONNX model (parking encoders, detectors). Threads need cross-origin isolation, which GitHub Pages
 * cannot provide, so the default is one thread. */
import {createModelAssetLoader} from './model-assets.mjs';
export const ORT_FILES=['vendor/onnxruntime-web/ort.wasm.min.mjs','vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs','vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm'];
let runtime=null,shared=null;
export const ortLoaded=()=>!!runtime;
const moduleURL=bytes=>URL.createObjectURL(new Blob([bytes],{type:'text/javascript'}));
const cancelled=signal=>signal?.reason||new DOMException('已取消加载','AbortError');
/** Fetches the manifest with the caller's signal plus a 30 s ceiling. */
export async function fetchManifest(baseURL,signal,timeoutMs=30000){
 const controller=new AbortController(),forward=()=>controller.abort(cancelled(signal));signal?.addEventListener('abort',forward,{once:true});
 const timer=setTimeout(()=>controller.abort(new Error('模型清单加载超时，请检查网络后重试。')),timeoutMs);
 try{const response=await fetch(new URL('assets.lock.json',baseURL),{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error(`模型清单加载失败 (${response.status})`);return await response.json();}
 catch(error){if(signal?.aborted)throw cancelled(signal);if(controller.signal.aborted)throw controller.signal.reason;throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);}
}
/** The runtime download belongs to no single page: each caller waits with its own signal, and the
 * download is aborted only when every waiting caller has cancelled. */
export function loadOrt({manifest,baseURL,signal,onProgress,numThreads}){
 if(runtime)return Promise.resolve(runtime);
 if(signal?.aborted)return Promise.reject(cancelled(signal));
 if(!shared){
  const controller=new AbortController(),state={controller,waiters:new Set(),listeners:new Set()};shared=state;
  const loader=createModelAssetLoader({baseURL,files:manifest.files.filter(file=>ORT_FILES.includes(file.path)),signal:controller.signal,onProgress:p=>{for(const listener of state.listeners)listener(p);}});
  state.promise=(async()=>{
   // Runtime scripts are imported from verified bytes too, so a stale HTTP cache cannot pair old JS with new WASM.
   const [ortJs,glue,wasm]=await Promise.all(ORT_FILES.map(path=>loader.read(path)));
   const ortURL=moduleURL(ortJs);let ort;
   try{ort=await import(ortURL);}finally{URL.revokeObjectURL(ortURL);}
   // The glue module is fetched again when the WASM backend initialises, so its URL stays alive.
   ort.env.wasm.wasmPaths={mjs:moduleURL(glue)};ort.env.wasm.wasmBinary=wasm;
   ort.env.wasm.numThreads=numThreads??(globalThis.crossOriginIsolated?Math.min(8,navigator.hardwareConcurrency||1):1);
   return runtime={ort,threads:ort.env.wasm.numThreads,stats:loader.summary()};
  })().finally(()=>{if(shared===state)shared=null;});
 }
 const state=shared,token={};state.waiters.add(token);if(onProgress)state.listeners.add(onProgress);
 return new Promise((resolve,reject)=>{
  const leave=()=>{state.waiters.delete(token);state.listeners.delete(onProgress);signal?.removeEventListener('abort',abort);};
  const abort=()=>{leave();if(!state.waiters.size)state.controller.abort(cancelled(signal));reject(cancelled(signal));};
  signal?.addEventListener('abort',abort,{once:true});
  state.promise.then(value=>{leave();resolve(value);},error=>{leave();reject(error);});
 });
}
/** Adds the runtime's bytes to a caller's own progress so one bar covers both downloads. */
export function combinedProgress(onProgress){
 let own=null,ort=null;const emit=()=>{if(!onProgress)return;const parts=[own,ort].filter(Boolean);onProgress({loaded:parts.reduce((s,p)=>s+p.loaded,0),total:parts.reduce((s,p)=>s+p.total,0),networkBytes:parts.reduce((s,p)=>s+p.networkBytes,0),cacheBytes:parts.reduce((s,p)=>s+p.cacheBytes,0),cacheAvailable:parts.every(p=>p.cacheAvailable)});};
 return {own:p=>{own=p;emit();},ort:p=>{ort=p;emit();},summary:loader=>{const s=loader.summary(),r=ort||{loaded:0,total:0,networkBytes:0,cacheBytes:0};return {...s,loaded:s.loaded+r.loaded,total:s.total+r.total,networkBytes:s.networkBytes+r.networkBytes,cacheBytes:s.cacheBytes+r.cacheBytes};}};
}
/** Creates a session for one model: the caller's loader holds only the model file. */
export async function createSession({loader,modelPath,manifest,baseURL,signal,onProgress,numThreads}){
 const [{ort,threads},model]=await Promise.all([loadOrt({manifest,baseURL,signal,onProgress,numThreads}),loader.read(modelPath)]);
 if(signal?.aborted)throw cancelled(signal);
 const started=performance.now(),session=await ort.InferenceSession.create(new Uint8Array(model),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
 return {ort,session,backend:`WASM · ${threads} 线程`,initialization_ms:performance.now()-started};
}
