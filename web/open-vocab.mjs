/** Open-vocabulary "slow lane": a text-prompted detector for hazards that are not COCO classes (carts, boxes, crates…).
 * The visitor starts it per image; weights come from Hugging Face at a pinned commit, never on page load.
 * Protocol: docs/validation/open-vocab-protocol.md. The page and the LVIS evaluation call this same module. */
// transformers.js and its ONNX Runtime Web build come from jsDelivr at pinned versions and are checked against these
// SHA-256 digests before use (a mismatch stops the lane). Weights come from Hugging Face at pinned commits. Nothing is
// fetched until the visitor starts the lane.
export const OPEN_VOCAB_RUNTIME=Object.freeze({
 library:Object.freeze({url:'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js',bytes:587917,sha256:'8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb'}),
 glue:Object.freeze({url:'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.mjs',bytes:53057,sha256:'0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611'}),
 wasm:Object.freeze({url:'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm',bytes:26861777,sha256:'49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082'}),
});
export const OPEN_VOCAB_RUNTIME_BYTES=Object.values(OPEN_VOCAB_RUNTIME).reduce((a,f)=>a+f.bytes,0);
const hex=buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
async function verifiedBytes(file,{signal,onBytes}){
 const response=await fetch(file.url,{signal,credentials:'omit'});if(!response.ok)throw new Error(`运行库下载失败（HTTP ${response.status}）`);
 const reader=response.body.getReader(),parts=[];let loaded=0;
 for(;;){const {done,value}=await reader.read();if(done)break;parts.push(value);loaded+=value.length;onBytes(loaded);}
 const buffer=await new Blob(parts).arrayBuffer();
 if(hex(await crypto.subtle.digest('SHA-256',buffer))!==file.sha256)throw new Error('运行库完整性校验失败，已停止。');
 return buffer;
}

// Fixed prompts, pre-registered: LVIS v1 names with '_' → ' ', except cone → "traffic cone".
export const OPEN_VOCAB_CLASSES=Object.freeze(['cart','handcart','shopping_cart','box','carton','crate','trash_can','barrel','ladder','fire_extinguisher','cone']);
export const OPEN_VOCAB_PROMPTS=Object.freeze(OPEN_VOCAB_CLASSES.map(name=>name==='cone'?'traffic cone':name.replace(/_/g,' ')));
export const OPEN_VOCAB_NAMES_ZH=Object.freeze({cart:'推车',handcart:'手推车',shopping_cart:'购物车',box:'箱子',carton:'纸箱',crate:'周转箱 / 板条箱',trash_can:'垃圾桶',barrel:'桶',ladder:'梯子',fire_extinguisher:'灭火器',cone:'锥桶'});
export const OPEN_VOCAB_LABEL='开放词汇检测 · 未核实';

// Candidates from the protocol (stage 1). Revisions are full commit ids; bytes are the ONNX file sizes from the HF API.
export const OPEN_VOCAB_CANDIDATES=Object.freeze({
 'A-q8':{family:'owl',model:'OWLv2 B/16 ensemble',repo:'Xenova/owlv2-base-patch16-ensemble',revision:'3e255bc9bf304b3358a8c1945c0a9514eefe7f10',dtype:'q8',file:'onnx/model_quantized.onnx',bytes:155312754},
 'A-q4':{family:'owl',model:'OWLv2 B/16 ensemble',repo:'Xenova/owlv2-base-patch16-ensemble',revision:'3e255bc9bf304b3358a8c1945c0a9514eefe7f10',dtype:'q4',file:'onnx/model_q4.onnx',bytes:193982426},
 'B-q8':{family:'gdino',model:'Grounding DINO tiny',repo:'onnx-community/grounding-dino-tiny-ONNX',revision:'ff690b0a8050566c290287545bd059350f3e9096',dtype:'q8',file:'onnx/model_quantized.onnx',bytes:203824675},
 'C-q8':{family:'owl',model:'OWL-ViT B/32',repo:'Xenova/owlvit-base-patch32',revision:'b75f4e52949639c3bb0b96546ea4149482f6e7ef',dtype:'q8',file:'onnx/model_quantized.onnx',bytes:155431700},
 'C-q4':{family:'owl',model:'OWL-ViT B/32',repo:'Xenova/owlvit-base-patch32',revision:'b75f4e52949639c3bb0b96546ea4149482f6e7ef',dtype:'q4',file:'onnx/model_q4.onnx',bytes:191730057},
});
export const OPEN_VOCAB_POSTPROCESS=Object.freeze({id:'ovd-nms050-dedupe090-v1',class_nms_iou:.5,cross_class_dedupe_iou:.9});

export function boxIoU(a,b){const w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1])),i=w*h;return i/(a[2]*a[3]+b[2]*b[3]-i||1);}
/** Per-class NMS, then drop any box overlapping an already kept one (any class) by IoU ≥ 0.9; highest score first. */
export function suppress(detections,maxDetections){
 const kept=[];
 for(const d of [...detections].sort((a,b)=>b.score-a.score)){
  if(kept.some(k=>(k.class===d.class&&boxIoU(k.bbox,d.bbox)>OPEN_VOCAB_POSTPROCESS.class_nms_iou)||boxIoU(k.bbox,d.bbox)>=OPEN_VOCAB_POSTPROCESS.cross_class_dedupe_iou))continue;
  kept.push(d);if(kept.length>=maxDetections)break;
 }
 return kept;
}
const sigmoid=x=>1/(1+Math.exp(-x));
/** Normalised centre boxes (relative to the whole, stretched input) → pixel [x, y, w, h] in the source frame, clipped. */
function toPixels([cx,cy,w,h],W,H){const x0=Math.max(0,(cx-w/2)*W),y0=Math.max(0,(cy-h/2)*H),x1=Math.min(W,(cx+w/2)*W),y1=Math.min(H,(cy+h/2)*H);return [x0,y0,Math.max(0,x1-x0),Math.max(0,y1-y0)];}
/** OWL family: one box per image patch; score = best of the 11 query sigmoids. logits [1,P,Q], boxes [1,P,4]. */
export function decodeOwl(logits,boxes,W,H,floor){
 const [,P,Q]=logits.dims,l=logits.data,b=boxes.data,out=[];
 for(let p=0;p<P;p++){let best=-Infinity,k=-1;for(let q=0;q<Q;q++){const v=l[p*Q+q];if(v>best){best=v;k=q;}}const score=sigmoid(best);if(score<floor)continue;out.push({class:OPEN_VOCAB_CLASSES[k],score,bbox:toPixels(Array.from(b.subarray(p*4,p*4+4)),W,H)});}
 return out;
}
/** Token spans of each class in the Grounding DINO prompt: runs of tokens between [CLS]/[SEP]/'.'. */
export function classSpans(inputIds,{cls=101,sep=102,dot=1012}={}){
 const spans=[];let current=[];
 inputIds.forEach((id,i)=>{if(id===cls||id===sep||id===dot){if(current.length)spans.push(current);current=[];}else current.push(i);});
 if(current.length)spans.push(current);
 if(spans.length!==OPEN_VOCAB_CLASSES.length)throw new Error(`提示词切分得到 ${spans.length} 段，应为 ${OPEN_VOCAB_CLASSES.length}`);
 return spans;
}
/** Grounding DINO: per query, class score = max sigmoid over that class's tokens. logits [1,N,T], boxes [1,N,4]. */
export function decodeGroundingDino(logits,boxes,spans,W,H,floor){
 const [,N,T]=logits.dims,l=logits.data,b=boxes.data,out=[];
 for(let n=0;n<N;n++){let best=-Infinity,k=-1;spans.forEach((span,c)=>{for(const t of span){const v=l[n*T+t];if(v>best){best=v;k=c;}}});const score=sigmoid(best);if(score<floor)continue;out.push({class:OPEN_VOCAB_CLASSES[k],score,bbox:toPixels(Array.from(b.subarray(n*4,n*4+4)),W,H)});}
 return out;
}
export const GDINO_TEXT=OPEN_VOCAB_PROMPTS.map(p=>p.toLowerCase()+'.').join(' ');

let library=null;
async function transformers({signal,onBytes}){
 if(!library){
  const done={};const report=key=>n=>{done[key]=n;onBytes(Object.values(done).reduce((x,y)=>x+y,0));};
  const [lib,glue,wasm]=await Promise.all(['library','glue','wasm'].map(key=>verifiedBytes(OPEN_VOCAB_RUNTIME[key],{signal,onBytes:report(key)})));
  const moduleURL=buffer=>URL.createObjectURL(new Blob([buffer],{type:'text/javascript'}));
  const loaded=await import(moduleURL(lib));
  const {env}=loaded;
  env.allowLocalModels=false;env.allowRemoteModels=true;env.useBrowserCache=true;
  env.remotePathTemplate='{model}/resolve/{revision}/';
  env.backends.onnx.wasm.wasmPaths={mjs:moduleURL(glue)};env.backends.onnx.wasm.wasmBinary=wasm;
  env.backends.onnx.wasm.numThreads=1;env.backends.onnx.wasm.proxy=false;
  library=loaded;
 }
 return library;
}
/** `remoteHost` is for the Actions evaluation only (a local mirror of the same pinned files); the page never sets it. */
export async function loadOpenVocab(id,{onProgress=()=>{},signal=null,remoteHost='https://huggingface.co/'}={}){
 const candidate=OPEN_VOCAB_CANDIDATES[id];if(!candidate)throw new Error(`未知的开放词汇模型：${id}`);
 const files={};let runtimeBytes=0;
 const report=()=>{const all=Object.values(files);onProgress({loaded:runtimeBytes+all.reduce((x,f)=>x+f.loaded,0),total:OPEN_VOCAB_RUNTIME_BYTES+candidate.bytes});};
 const lib=await transformers({signal,onBytes:n=>{runtimeBytes=n;report();}}),{env,AutoProcessor,AutoModelForZeroShotObjectDetection,RawImage}=lib;
 env.remoteHost=remoteHost;const plainFetch=globalThis.fetch.bind(globalThis);env.fetch=(url,options={})=>plainFetch(url,{...options,credentials:'omit',...(signal?{signal}:{})});
 const progress_callback=event=>{if(event.status==='progress'&&event.file){files[event.file]={loaded:event.loaded||0,total:event.total||0};report();}};
 const started=performance.now();
 const processor=await AutoProcessor.from_pretrained(candidate.repo,{revision:candidate.revision,progress_callback});
 const model=await AutoModelForZeroShotObjectDetection.from_pretrained(candidate.repo,{revision:candidate.revision,dtype:candidate.dtype,device:'wasm',progress_callback});
 signal?.throwIfAborted?.();
 const loadMs=performance.now()-started;
 let textInputs=null,spans=null;
 if(candidate.family==='owl')textInputs=processor.tokenizer([...OPEN_VOCAB_PROMPTS],{padding:true,truncation:true});
 else spans=classSpans(Array.from(processor.tokenizer(GDINO_TEXT).input_ids.data,Number));
 /** Detect on a canvas (the page's analysed frame). Returns COCO-SSD-shaped boxes in canvas pixels, highest score first. */
 async function detect(canvas,{floor=.05,maxDetections=100,raw=false}={}){
  const W=canvas.width,H=canvas.height,pixels=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,W,H).data;
  const image=new RawImage(new Uint8ClampedArray(pixels),W,H,4).rgb();
  let outputs,detections,inputs;
  if(candidate.family==='owl'){inputs=await processor.image_processor(image);outputs=await model({...textInputs,pixel_values:inputs.pixel_values});detections=decodeOwl(outputs.logits,outputs.pred_boxes,W,H,floor);}
  else{inputs=await processor(image,GDINO_TEXT);outputs=await model(inputs);detections=decodeGroundingDino(outputs.logits,outputs.pred_boxes,spans,W,H,floor);}
  const result=suppress(detections,maxDetections).map(d=>({...d,source:'open_vocab'}));
  if(raw)return {detections:result,outputs,inputs,processor};
  return result;
 }
 return {id,candidate,detect,loadMs,backend:'wasm',threads:1,postprocess:OPEN_VOCAB_POSTPROCESS.id};
}
