/** The "开放词汇慢车道" panel under a still-image analysis. The lane runs only after the visitor clicks and confirms the
 * download; it is offered only when the pre-registered evaluation passed (web/data/open-vocab/config.json "shipped")
 * and the browser can run it. Boxes are labelled 开放词汇检测 · 未核实 everywhere they appear. */
import {loadOpenVocab,OPEN_VOCAB_CANDIDATES,OPEN_VOCAB_NAMES_ZH,OPEN_VOCAB_LABEL,OPEN_VOCAB_RUNTIME_BYTES} from './open-vocab.mjs';
import {wasmSimdSupported} from './capabilities.mjs';
const $=id=>document.getElementById(id);
const mb=bytes=>(bytes/1e6).toFixed(0);
/** Why this browser cannot run the lane, or '' when it can. Checked before anything is downloaded. */
export function laneUnsupportedReason({simd=wasmSimdSupported(),deviceMemory=globalThis.navigator?.deviceMemory,subtle=!!globalThis.crypto?.subtle}={}){
 if(!simd)return '此浏览器不支持 WebAssembly SIMD（或已关闭 WebAssembly，例如 iOS 锁定模式），无法运行开放词汇慢车道；上面的 COCO 检测结果不受影响。';
 if(!subtle)return '此页面不在安全连接（HTTPS）下打开，无法校验运行库，开放词汇慢车道不可用。';
 if(Number.isFinite(deviceMemory)&&deviceMemory<4)return `此设备报告的内存约 ${deviceMemory} GB，低于慢车道需要的 4 GB，已隐藏以免页面崩溃。`;
 return '';
}
/** Lane detections kept for display and rules: the shipped classes at the frozen threshold, boxes normalised. */
export function shippedDetections(detections,config,width,height){
 return detections.filter(d=>config.classes.includes(d.class)&&d.score>=config.threshold).map(d=>({class:d.class,score:d.score,source:'open_vocab',bbox:[d.bbox[0]/width,d.bbox[1]/height,d.bbox[2]/width,d.bbox[3]/height]}));
}
export function createOpenVocabView({getContext,onResult}){
 let config=null,configPromise=null,lane=null,controller=null,running=false;
 const panel=$('ovd-panel');
 const loadConfig=()=>configPromise||(configPromise=fetch(new URL('./data/open-vocab/config.json',import.meta.url)).then(r=>r.ok?r.json():null).catch(()=>null).then(c=>(config=c)));
 const message=(text,error=false)=>{$('ovd-message').textContent=text;$('ovd-message').classList.toggle('error',error);};
 const busyUI=value=>{running=value;$('ovd-start').disabled=value;$('ovd-load').disabled=value;$('ovd-cancel').textContent=value?'取消下载':'取消';};
 function introText(){const c=OPEN_VOCAB_CANDIDATES[config.candidate];return `在 COCO 80 类之外查找通道与客梯里常见的物品：${config.classes.map(k=>OPEN_VOCAB_NAMES_ZH[k]).join('、')}。用 ${c.model}（固定提示词）在本浏览器单线程运行，图片不上传；结果都标为“${OPEN_VOCAB_LABEL}”。`;}
 function rows(list){
  const body=$('ovd-rows');body.replaceChildren();
  for(const d of list){const tr=document.createElement('tr');for(const value of [OPEN_VOCAB_NAMES_ZH[d.class]||d.class,`${(d.score*100).toFixed(1)}%`,d.bbox.map(x=>x.toFixed(3)).join(', '),OPEN_VOCAB_LABEL]){const td=document.createElement('td');td.textContent=value;tr.append(td);}body.append(tr);}
  $('ovd-table').hidden=!list.length;
 }
 async function run(){
  const {report,frame}=getContext();if(!report||running)return;
  const ticket=report.analysis_id;busyUI(true);$('ovd-confirm').hidden=true;
  try{
   if(!lane){
    controller=new AbortController();$('ovd-progress').hidden=false;$('ovd-progress').value=0;$('ovd-cancel-row').hidden=false;
    message('正在下载慢车道模型与运行库…');
    lane=await loadOpenVocab(config.candidate,{signal:controller.signal,onProgress:({loaded,total})=>{$('ovd-progress').max=total;$('ovd-progress').value=loaded;message(`正在下载慢车道模型与运行库：${mb(loaded)} / ${mb(total)} MB`);}});
    controller=null;$('ovd-progress').hidden=true;$('ovd-cancel-row').hidden=true;
   }
   message(`正在查找（单线程，Actions 上测得每张约 ${(config.latency.p50_ms/1000).toFixed(0)} 秒）…`);
   const started=performance.now(),raw=await lane.detect(frame,{floor:config.threshold,maxDetections:50}),ms=performance.now()-started;
   if(getContext().report?.analysis_id!==ticket)return;// the visitor started a new analysis meanwhile
   const detections=shippedDetections(raw,config,frame.width,frame.height);
   const result={label:OPEN_VOCAB_LABEL,model:lane.candidate.model,repo:lane.candidate.repo,revision:lane.candidate.revision,dtype:lane.candidate.dtype,runtime:'transformers.js 4.3.2 · ONNX Runtime Web WASM 单线程',threshold:config.threshold,classes:config.classes,postprocess:lane.postprocess,inference_ms:ms,detections};
   rows(detections);
   const added=onResult(result);
   message(detections.length?`找到 ${detections.length} 个开放词汇检测（未核实）${added?`，其中 ${added} 个按当前规则生成候选`:''}。框在画面上以虚线标出。`:'慢车道没有找到这些物品。没有结果不等于安全：模型会漏检，尤其是远处、遮挡或光线差的物品。');
  }catch(error){
   $('ovd-progress').hidden=true;$('ovd-cancel-row').hidden=true;
   if(error?.name==='AbortError'){lane=null;message('已取消下载。已下载的部分可能留在浏览器缓存中；分析结果不受影响。');}
   else{lane=null;message(`慢车道未能运行：${error.message||error}。上面的 COCO 检测结果不受影响。`,true);}
  }finally{controller=null;busyUI(false);}
 }
 $('ovd-start').addEventListener('click',()=>{if(running)return;if(lane){run();return;}const c=OPEN_VOCAB_CANDIDATES[config.candidate];
  $('ovd-confirm-text').textContent=`首次使用需要下载约 ${mb(c.bytes+OPEN_VOCAB_RUNTIME_BYTES)} MB：模型 ${mb(c.bytes)} MB（${c.repo}，Hugging Face，固定版本），运行库 ${mb(OPEN_VOCAB_RUNTIME_BYTES)} MB（jsDelivr，使用前核对 SHA-256）。之后保存在浏览器缓存中。移动网络下请谨慎。`;
  $('ovd-confirm').hidden=false;$('ovd-load').focus();});
 $('ovd-load').addEventListener('click',run);
 $('ovd-dismiss').addEventListener('click',()=>{$('ovd-confirm').hidden=true;$('ovd-start').focus();});
 $('ovd-cancel').addEventListener('click',()=>controller?.abort(new DOMException('已取消','AbortError')));
 return {
  /** Show or hide the panel for the current report. Still images only, completed analyses only. */
  async render(report,{isVideo}){
   await loadConfig();
   const offer=!!(config?.shipped&&report?.complete&&!isVideo);
   panel.hidden=!offer;if(!offer)return;
   const reason=laneUnsupportedReason();
   $('ovd-intro').textContent=introText();$('ovd-start').textContent=`查找${config.classes.slice(0,3).map(k=>OPEN_VOCAB_NAMES_ZH[k]).join('、')}…`;
   $('ovd-unavailable').textContent=reason;$('ovd-unavailable').hidden=!reason;$('ovd-start').hidden=!!reason;
   $('ovd-evidence').textContent=config.evidence_line||'';
   if(!report.open_vocab){rows([]);if(!running)message('');}
  },
  reset(){if(!running){$('ovd-confirm').hidden=true;rows([]);message('');}},
  setDisabled(value){if(!running)$('ovd-start').disabled=value;},
 };
}
