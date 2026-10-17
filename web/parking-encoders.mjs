/** Frozen image encoders for parking patches. Resources come from the verified asset lock;
 * user images never leave the page. The offline feature extractor imports this same module. */
import {createModelAssetLoader,registerModelRoute} from './model-assets.mjs';
import {dinoInput,dinoPool,DINO_SIZE} from './parking-transfer.mjs';
const root=new URL('./',import.meta.url);
export const ENCODERS={
 mobilenet:{key:'mobilenet',feature_version:'ssdlite-mnv2-conv1-gap-v1',features:1280,label:'MobileNetV2 迁移头',detail:'复用检测器的 COCO 预训练骨干 · TensorFlow.js',head:'models/parking-transfer/model.json',assets:path=>path.startsWith('models/ssdlite_mobilenet_v2/')||path==='vendor/tf.min.js'},
 dinov2:{key:'dinov2',feature_version:'dinov2-small-int8-cls-mean-112-v1',features:768,label:'DINOv2-small 线性探针',detail:'自监督视觉基础模型 · ONNX Runtime Web',head:'models/parking-dinov2/model.json',assets:path=>DINO_FILES.includes(path)},
};
const MNV2_NODE='FeatureExtractor/MobilenetV2/Conv_1/Relu6';
const DINO_FILES=['vendor/onnxruntime-web/ort.wasm.min.mjs','vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs','vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm','models/dinov2-small/model_quantized.onnx'];
async function loadScript(buffer){const url=URL.createObjectURL(new Blob([buffer],{type:'text/javascript'}));try{await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=()=>{script.remove();resolve();};script.onerror=()=>{script.remove();reject(new Error('模型运行脚本初始化失败，请重试。'));};document.head.append(script);});}finally{URL.revokeObjectURL(url);}}
export async function decodeImage(url,{signal,timeoutMs=15000}={}){
 const controller=new AbortController(),cancel=()=>controller.abort(signal.reason);signal?.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(()=>controller.abort(new Error('图片读取超时，请重试')),timeoutMs);
 try{const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error(`图片读取失败 (${response.status})`);const bitmap=await createImageBitmap(await response.blob());if(bitmap.width*bitmap.height>40000000){bitmap.close();throw new Error('图片分辨率过大，请先裁剪单个车位');}return bitmap;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
function bitmapPixels(bitmap){const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);return ctx.getImageData(0,0,bitmap.width,bitmap.height).data;}
/** Loads one encoder. onProgress receives the shared loader summary (bytes, cache reuse). */
export async function loadEncoder(key,{signal,onProgress,numThreads}={}){
 const spec=ENCODERS[key];if(!spec)throw new Error('未知编码器');
 const started=performance.now(),response=await fetch(new URL('assets.lock.json',root),{signal,cache:'no-store'});if(!response.ok)throw new Error(`模型清单加载失败 (${response.status})`);
 const manifest=await response.json(),files=manifest.files.filter(file=>spec.assets(file.path)&&!(file.path==='vendor/tf.min.js'&&globalThis.tf));
 if(!files.length&&key==='dinov2')throw new Error('模型资源清单缺少 DINOv2 文件，请刷新页面后重试。');
 const loader=createModelAssetLoader({baseURL:root,files,signal,onProgress});
 if(key==='mobilenet'){
  if(!globalThis.tf)await loadScript(await loader.read('vendor/tf.min.js'));
  if(!tf.getBackend()){try{await tf.setBackend('webgl');await tf.ready();}catch{await tf.setBackend('cpu');await tf.ready();}}
  const handler=tf.io.http(new URL('models/ssdlite_mobilenet_v2/model.json',root).href,{fetchFunc:loader.fetch}),route=registerModelRoute(tf,{load:()=>handler.load()});
  let graph;try{graph=await tf.loadGraphModel(route.url);}finally{route.release();}
  return {...spec,backend:tf.getBackend(),stats:{...loader.summary(),load_ms:performance.now()-started},
   async embed(bitmap){const input=tf.tidy(()=>tf.browser.fromPixels(bitmap).expandDims(0));let output,pooled;try{output=await graph.executeAsync(input,MNV2_NODE);pooled=output.mean([1,2]);return await pooled.data();}finally{input.dispose();output?.dispose();pooled?.dispose();}},
   dispose(){graph.dispose();}};
 }
 // Runtime scripts are imported from verified bytes too, so a stale HTTP cache cannot pair old JS with new WASM.
 const [ortJs,glue,wasm,model]=await Promise.all(DINO_FILES.map(path=>loader.read(path)));
 const moduleURL=bytes=>URL.createObjectURL(new Blob([bytes],{type:'text/javascript'})),ortURL=moduleURL(ortJs),glueURL=moduleURL(glue);
 let session,ort;
 try{
  ort=await import(ortURL);
  // Threads need cross-origin isolation; GitHub Pages runs single-threaded and stays correct.
  ort.env.wasm.wasmPaths={mjs:glueURL};ort.env.wasm.wasmBinary=wasm;ort.env.wasm.numThreads=numThreads??(globalThis.crossOriginIsolated?Math.min(8,navigator.hardwareConcurrency||1):1);
  session=await ort.InferenceSession.create(new Uint8Array(model),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
 }finally{URL.revokeObjectURL(ortURL);URL.revokeObjectURL(glueURL);}
 return {...spec,backend:`WASM · ${ort.env.wasm.numThreads} 线程`,stats:{...loader.summary(),load_ms:performance.now()-started},
  async embed(bitmap){const pixels=bitmapPixels(bitmap),input=new ort.Tensor('float32',dinoInput(pixels,bitmap.width,bitmap.height),[1,3,DINO_SIZE,DINO_SIZE]);let out;try{out=await session.run({pixel_values:input});const hidden=out.last_hidden_state;return dinoPool(hidden.data,hidden.dims[1],hidden.dims[2]);}finally{input.dispose?.();for(const t of Object.values(out||{}))t.dispose?.();}},
  dispose(){session.release();}};
}
