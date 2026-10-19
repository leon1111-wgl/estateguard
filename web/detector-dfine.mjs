/** D-FINE-N real-time detection transformer (arXiv:2410.13842), fp32 ONNX in single-thread WASM.
 * Returns detections shaped like COCO-SSD's detect() so tracking and scene rules stay unchanged.
 * The COCO evaluation harness imports this module, so offline and in-page results share one code path. */
import {createModelAssetLoader} from './model-assets.mjs';
import {fetchManifest,combinedProgress,createSession} from './ort-runtime.mjs';
// COCO's 80 detection classes in official id order; names match COCO-SSD so rules and labels are shared.
export const COCO_CLASSES=['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'];
export const COCO_IDS=[1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20,21,22,23,24,25,27,28,31,32,33,34,35,36,37,38,39,40,41,42,43,44,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,67,70,72,73,74,75,76,77,78,79,80,81,82,84,85,86,87,88,89,90];
export const DFINE={key:'dfine',name:'D-FINE-N',model:'models/dfine-n/model.onnx',input:640,queries:300,classes:80,postprocess:'dfine-topk-dedupe090-v1',dedupeIoU:.9};
/** Pixels /255 into NCHW; resizing to 640×640 happens on a canvas before this call. */
export function dfineInput(rgba,size=DFINE.input){
 if(rgba.length!==size*size*4)throw new Error('检测输入尺寸不匹配');
 const out=new Float32Array(3*size*size),plane=size*size;
 for(let i=0;i<plane;i++){out[i]=rgba[i*4]/255;out[plane+i]=rgba[i*4+1]/255;out[2*plane+i]=rgba[i*4+2]/255;}
 return out;
}
const sigmoid=z=>1/(1+Math.exp(-z));
export function boxIoU(a,b){const ix=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),iy=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1])),inter=ix*iy,union=a[2]*a[3]+b[2]*b[3]-inter;return union>0?inter/union:0;}
/** Top-k over all query×class sigmoid scores; boxes are normalised centre/size mapped back to the
 * source frame in pixels. DETR-style models need no NMS, but one object can still come back as two
 * near-identical boxes (e.g. car and truck); with dedupeIoU those are dropped class-agnostically,
 * keeping the higher score. dedupeIoU=null gives the raw top-k evaluated in the protocol. */
export function dfinePostprocess(logits,boxes,width,height,{maxDetections=100,minScore=.01,queries=DFINE.queries,classes=DFINE.classes,dedupeIoU=null}={}){
 if(logits.length!==queries*classes||boxes.length!==queries*4)throw new Error('检测输出尺寸不匹配');
 const logit=Math.log(minScore/(1-minScore)),hits=[];
 for(let i=0;i<logits.length;i++)if(logits[i]>=logit)hits.push(i);
 hits.sort((a,b)=>logits[b]-logits[a]||a-b);
 const kept=[];
 for(const i of hits){
  if(kept.length>=maxDetections)break;
  const q=Math.floor(i/classes),c=i%classes,[cx,cy,w,h]=boxes.subarray?boxes.subarray(q*4,q*4+4):boxes.slice(q*4,q*4+4);
  const x0=Math.max(0,(cx-w/2)*width),y0=Math.max(0,(cy-h/2)*height),x1=Math.min(width,(cx+w/2)*width),y1=Math.min(height,(cy+h/2)*height);
  const d={bbox:[x0,y0,Math.max(0,x1-x0),Math.max(0,y1-y0)],class:COCO_CLASSES[c],classIndex:c,score:sigmoid(logits[i])};
  if(dedupeIoU!=null&&kept.some(k=>boxIoU(k.bbox,d.bbox)>=dedupeIoU))continue;
  kept.push(d);
 }
 return kept;
}
/** Loads the verified model and returns {detect(source,maxDetections,minScore), backend, stats, dispose}. */
export async function loadDfineDetector({signal,onProgress,numThreads,baseURL=new URL('./',import.meta.url)}={}){
 const started=performance.now(),manifest=await fetchManifest(baseURL,signal),progress=combinedProgress(onProgress);
 const files=manifest.files.filter(file=>file.path===DFINE.model);
 if(!files.length)throw new Error('模型资源清单缺少 D-FINE 文件，请刷新页面后重试。');
 const loader=createModelAssetLoader({baseURL,files,signal,onProgress:progress.own});
 const {ort,session,backend,initialization_ms}=await createSession({loader,modelPath:DFINE.model,manifest,baseURL,signal,onProgress:progress.ort,numThreads});
 const stats={...progress.summary(loader),load_ms:performance.now()-started,initialization_ms};
 const canvas=document.createElement('canvas');canvas.width=canvas.height=DFINE.input;const ctx=canvas.getContext('2d',{willReadFrequently:true});
 return {...DFINE,backend,stats,
  async detect(source,maxDetections=50,minScore=.5){
   const width=source.naturalWidth||source.videoWidth||source.width,height=source.naturalHeight||source.videoHeight||source.height;
   if(!width||!height)throw new Error('无法读取画面尺寸');
   ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,DFINE.input,DFINE.input);
   const input=new ort.Tensor('float32',dfineInput(ctx.getImageData(0,0,DFINE.input,DFINE.input).data),[1,3,DFINE.input,DFINE.input]);let out;
   try{out=await session.run({pixel_values:input});return dfinePostprocess(out.logits.data,out.pred_boxes.data,width,height,{maxDetections,minScore,dedupeIoU:DFINE.dedupeIoU});}
   finally{input.dispose?.();for(const t of Object.values(out||{}))t.dispose?.();}
  },
  dispose(){session.release();}};
}
