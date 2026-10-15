import {trackDetections,makeCandidates} from './vision-rules.mjs';
import {createModelAssetLoader,registerModelRoute} from './model-assets.mjs';
const $=id=>document.getElementById(id);
const inferenceSettings=Object.freeze({sample_interval_seconds:1,max_frames:20,max_detections:50,nms_iou_threshold:.5,postprocess:'coco-ssd-2.2.3-fixed-nms-v1'});
const names={person:'人员',bicycle:'自行车',car:'小汽车',motorcycle:'摩托车',bus:'公交 / 大巴',truck:'卡车',chair:'椅子',couch:'沙发',bed:'床',suitcase:'行李箱','dining table':'餐桌',refrigerator:'冰箱',backpack:'背包',handbag:'手提包',bottle:'瓶子',cat:'猫',dog:'狗',tv:'电视'};
let model=null,modelPromise=null,modelController=null,modelLoadStats=null,source=null,sourceFile=null,sourceURL=null,isVideo=false,busy=false,loading=false,sourceGeneration=0,stopped=false,report=null,lastBoxes=[],frameSnapshot=null,snapshotTime=0;
const canvas=$('analysis-canvas'),ctx=canvas.getContext('2d'),frame=document.createElement('canvas'),frameCtx=frame.getContext('2d');
const notice=(text,error=false)=>{$('vision-message').textContent=text;$('vision-message').classList.toggle('error',error);};
$('vision-start').value=new Date(Date.now()+8*3600000).toISOString().slice(0,16);
async function loadScript(buffer){const url=URL.createObjectURL(new Blob([buffer],{type:'text/javascript'}));try{await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=()=>{script.remove();resolve();};script.onerror=()=>{script.remove();reject(new Error('模型运行脚本初始化失败，请重试。'));};document.head.append(script);});}finally{URL.revokeObjectURL(url);}}
const mib=value=>(value/1024/1024).toFixed(1);
async function getModel(){
 if(model){modelLoadStats={...modelLoadStats,network_bytes:0,cache_bytes:0,load_ms:0,initialization_ms:0,reused_in_memory:true};$('model-load-detail').textContent='复用本页已就绪模型，本次无需下载或重新初始化。';return model;}
 if(modelPromise)return modelPromise;
 const controller=new AbortController(),signal=controller.signal;modelController=controller;
 const check=()=>{if(signal.aborted)throw signal.reason;};
 modelPromise=(async()=>{
  const started=performance.now();let route=null,detector=null,manifestTimer;
  $('model-loading').hidden=false;$('model-load-progress').value=0;$('model-status').textContent='正在准备模型资源…';$('stop-analysis').textContent='取消加载';
  $('model-load-detail').textContent='读取资源清单；公共模型可缓存在本机，素材不会上传。';
  notice('正在加载本站小模型。可以取消加载，原素材和设置会保留。');
  try{
   manifestTimer=setTimeout(()=>controller.abort(new Error('模型清单加载超时，请检查网络后重试。')),30000);
   const response=await fetch(new URL('./assets.lock.json',import.meta.url),{signal,cache:'no-store'});if(!response.ok)throw new Error(`模型清单加载失败 (${response.status})`);
   const manifest=await response.json();clearTimeout(manifestTimer);check();
   if(manifest.files?.find(file=>file.path==='vendor/coco-ssd.min.js')?.local_patch!==inferenceSettings.postprocess)throw new Error('模型资源清单与页面版本不一致，请刷新页面后重试。');
   const files=manifest.files.filter(file=>file.path.startsWith('models/ssdlite_mobilenet_v2/')||file.path==='vendor/tf.min.js'&&!globalThis.tf||file.path==='vendor/coco-ssd.min.js'&&!globalThis.cocoSsd);
   const loader=createModelAssetLoader({baseURL:new URL('./',import.meta.url),files,signal,onProgress:progress=>{
    $('model-status').textContent=`加载模型资源 ${Math.floor(progress.loaded/progress.total*100)}%`;
    $('model-load-progress').value=progress.loaded/progress.total;
    $('model-load-detail').textContent=`已读取 ${mib(progress.loaded)} / ${mib(progress.total)} MiB · 网络读取 ${mib(progress.networkBytes)} MiB · 复用缓存 ${mib(progress.cacheBytes)} MiB${progress.cacheAvailable?'':' · 缓存不可用，本次直接加载'}`;
    notice(`${$('model-load-detail').textContent}。可取消加载。`);
   }});
   if(!globalThis.tf){await loadScript(await loader.read('vendor/tf.min.js'));check();}
   if(!globalThis.cocoSsd){await loadScript(await loader.read('vendor/coco-ssd.min.js'));check();}
   if(!tf.getBackend()){try{await tf.setBackend('webgl');await tf.ready();}catch{await tf.setBackend('cpu');await tf.ready();}}check();
   const url=new URL('./models/ssdlite_mobilenet_v2/model.json',import.meta.url).href;
   const handler=tf.io.http(url,{fetchFunc:loader.fetch});
   let initializedAt=0;
   route=registerModelRoute(tf,{load:async()=>{const artifacts=await handler.load();check();initializedAt=performance.now();$('model-status').textContent='正在初始化推理引擎…';$('model-load-detail').textContent+=' · 下载和校验完成';notice('模型资源已校验，正在初始化推理引擎。');return artifacts;}});
   detector=new cocoSsd.ObjectDetection('lite_mobilenet_v2',route.url);await detector.load();check();
   model=detector;const stats=loader.summary();modelLoadStats={network_bytes:stats.networkBytes,cache_bytes:stats.cacheBytes,cache_available:stats.cacheAvailable,resource_bytes:stats.total,load_ms:performance.now()-started,initialization_ms:performance.now()-initializedAt,reused_in_memory:false};
   $('model-status').textContent='模型已就绪';$('model-dot').classList.add('ready');$('model-load-progress').value=1;
   $('model-backend').textContent=`${tf.getBackend().toUpperCase()} · 加载 ${Math.round(modelLoadStats.load_ms)} ms`;
   $('model-load-detail').textContent=`资源已校验 · 网络读取 ${mib(stats.networkBytes)} MiB · 复用缓存 ${mib(stats.cacheBytes)} MiB${stats.cacheAvailable?'':' · 缓存不可用'}`;
   return model;
  }catch(error){controller.abort(error);detector?.dispose();const cancelled=error.name==='AbortError';$('model-status').textContent=cancelled?'加载已取消，可重试':'加载失败，可重试';$('model-load-detail').textContent=cancelled?'下载已取消；点击开始分析即可重试，原素材与设置保留。':`${error.message} 原素材与设置保留。`;throw error;}
  finally{clearTimeout(manifestTimer);route?.release();modelController=null;$('stop-analysis').textContent='停止分析';}
 })().catch(error=>{modelPromise=null;throw error;});return modelPromise;
}
function invalidate(){report=null;$('send-candidates').disabled=true;$('vision-results').hidden=true;}
function roi(){const values=['roi-x','roi-y','roi-w','roi-h'].map(id=>Number($(id).value)/100);if(values.some(x=>!Number.isFinite(x))||values[0]<0||values[1]<0||values[2]<=0||values[3]<=0||values[0]+values[2]>1.00001||values[1]+values[3]>1.00001)throw new Error('关注区域超出画面，请调整 X、Y、宽和高。');return values;}
function paint(boxes=lastBoxes){if(!frameSnapshot)return;ctx.putImageData(frameSnapshot,0,0);let region;try{region=roi();}catch{return;}
 ctx.lineWidth=2;ctx.strokeStyle='#4d8cff';ctx.setLineDash([7,4]);ctx.strokeRect(region[0]*canvas.width,region[1]*canvas.height,region[2]*canvas.width,region[3]*canvas.height);ctx.setLineDash([]);
 ctx.font=`${Math.max(12,Math.round(canvas.width/60))}px sans-serif`;
 for(const d of boxes){const [x,y,w,h]=d.bbox.map((v,i)=>v*(i%2===0?canvas.width:canvas.height));ctx.strokeStyle='#28ca9c';ctx.strokeRect(x,y,w,h);const label=`${names[d.class]||d.class} ${Math.round(d.score*100)}%`;const width=ctx.measureText(label).width+10;ctx.fillStyle='#136b53';ctx.fillRect(x,Math.max(0,y-23),width,23);ctx.fillStyle='#fff';ctx.fillText(label,x+5,Math.max(16,y-7));}
}
function snapshot(media,video,target,targetCtx){const width=video?media.videoWidth:media.naturalWidth,height=video?media.videoHeight:media.naturalHeight;if(!width||!height)throw new Error('无法读取素材尺寸');const scale=Math.min(1,960/width);target.width=Math.round(width*scale);target.height=Math.round(height*scale);targetCtx.drawImage(media,0,0,target.width,target.height);return targetCtx.getImageData(0,0,target.width,target.height);}
function describeFrame(){if(!sourceFile)return;const timing=isVideo?` · ${source.duration.toFixed(1)} 秒 · 检测画面：${snapshotTime.toFixed(1)} 秒（下方播放器可独立播放）`:'';$('analysis-file-info').textContent=`${sourceFile.name} · ${(sourceFile.size/1024/1024).toFixed(2)} MB${timing}`;canvas.setAttribute('aria-label',isVideo?`模型检测框与关注区域，固定采样画面位于视频 ${snapshotTime.toFixed(1)} 秒`:'模型检测框与关注区域');}
function capture(){frameSnapshot=snapshot(source,isVideo,frame,frameCtx);canvas.width=frame.width;canvas.height=frame.height;snapshotTime=isVideo?source.currentTime:0;paint([]);describeFrame();}
function seek(time){return new Promise((resolve,reject)=>{if(Math.abs(source.currentTime-time)<.001&&source.readyState>=2){resolve();return;}const timer=setTimeout(()=>{cleanup();reject(new Error('视频解码超时，请使用可播放的 MP4 / WebM。'));},10000);const cleanup=()=>{clearTimeout(timer);source.removeEventListener('seeked',ok);source.removeEventListener('error',bad);};const ok=()=>{cleanup();resolve();};const bad=()=>{cleanup();reject(new Error('浏览器无法解码此视频'));};source.addEventListener('seeked',ok,{once:true});source.addEventListener('error',bad,{once:true});source.currentTime=time;});}
function releaseSource(media,url){if(media?.tagName==='VIDEO'){media.pause();media.removeAttribute('src');media.load();}if(url)URL.revokeObjectURL(url);}
async function openFile(file,ticket=++sourceGeneration){if(busy){notice('分析进行中，请先停止，再更换素材。',true);return false;}if(!file||ticket!==sourceGeneration)return false;let nextSource=null,nextURL=null;loading=true;$('run-analysis').disabled=true;
 try{if(file.size>100*1024*1024)throw new Error('素材超过 100 MB，请先截取短片段。');if(!['image/jpeg','image/png','image/webp','video/mp4','video/webm'].includes(file.type))throw new Error('请选择 JPEG / PNG / WebP 图片或 MP4 / WebM 视频。');
 invalidate();notice(`正在打开 ${file.name}…`);nextURL=URL.createObjectURL(file);const nextIsVideo=file.type.startsWith('video/');
 if(nextIsVideo){nextSource=document.createElement('video');nextSource.preload='auto';nextSource.muted=true;nextSource.playsInline=true;
  await new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);nextSource.removeEventListener('loadeddata',ok);nextSource.removeEventListener('error',bad);};const ok=()=>{cleanup();resolve();};const bad=()=>{cleanup();reject(new Error('浏览器无法读取此视频编码'));};const timer=setTimeout(()=>{cleanup();reject(new Error('视频读取超时，请使用可播放的 MP4 / WebM。'));},10000);nextSource.addEventListener('loadeddata',ok);nextSource.addEventListener('error',bad);nextSource.src=nextURL;nextSource.load();});
  if(!Number.isFinite(nextSource.duration)||nextSource.duration<=0)throw new Error('无法读取视频时长，请使用普通文件而非直播流。');nextSource.pause();
 }else{nextSource=new Image();nextSource.src=nextURL;await nextSource.decode();}
 if(ticket!==sourceGeneration){releaseSource(nextSource,nextURL);return false;}
 // Decode and capture privately before replacing the current file and its evidence.
 const prepared=document.createElement('canvas'),preparedFrame=snapshot(nextSource,nextIsVideo,prepared,prepared.getContext('2d'));
 releaseSource(source,sourceURL);source=nextSource;sourceFile=file;sourceURL=nextURL;isVideo=nextIsVideo;lastBoxes=[];frameSnapshot=preparedFrame;snapshotTime=0;
 frame.width=prepared.width;frame.height=prepared.height;frameCtx.putImageData(preparedFrame,0,0);canvas.width=prepared.width;canvas.height=prepared.height;
 const preview=$('source-video');preview.pause();preview.hidden=!isVideo;if(isVideo){preview.src=sourceURL;preview.load();}else{preview.removeAttribute('src');preview.load();}
 paint([]);describeFrame();$('analysis-empty').hidden=true;$('analysis-stage').hidden=false;loading=false;$('run-analysis').disabled=false;notice('素材已就绪。选择场景规则和关注区域，然后开始分析。');return true;
 }catch(error){releaseSource(nextSource,nextURL);if(ticket===sourceGeneration){loading=false;$('run-analysis').disabled=!source;notice(`${error.message}${sourceFile?' 当前仍保留此前素材。':''}`,true);}return false;}}
$('analysis-file').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';openFile(file);});
$('sample-image').addEventListener('click',async()=>{const ticket=++sourceGeneration;loading=true;$('run-analysis').disabled=true;try{const r=await fetch('samples/bus.jpg');if(!r.ok)throw new Error('示例图片加载失败');const file=new File([await r.blob()],'公开示例-校车.jpg',{type:'image/jpeg'});if(ticket!==sourceGeneration)return;if(await openFile(file,ticket))notice('公开示例：Raysonho，CC0，2011。用于测试物体检测；不是小区违规证据。请选择规则后分析。');}catch(e){if(ticket===sourceGeneration){loading=false;$('run-analysis').disabled=!source;notice(e.message,true);}}});
$('analysis-form').addEventListener('input',()=>{if(!busy){invalidate();paint();}});
let origin=null;
canvas.addEventListener('pointerdown',event=>{if(busy||!source)return;const rect=canvas.getBoundingClientRect();origin=[Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))];canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointerup',event=>{if(!origin)return;const rect=canvas.getBoundingClientRect();const end=[Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))];const values=[Math.min(origin[0],end[0]),Math.min(origin[1],end[1]),Math.abs(origin[0]-end[0]),Math.abs(origin[1]-end[1])];origin=null;if(values[2]<.02||values[3]<.02)return;['roi-x','roi-y','roi-w','roi-h'].forEach((id,i)=>$(id).value=Math.floor(values[i]*100));invalidate();paint();notice('关注区域已更新，请重新分析。');});
$('stop-analysis').addEventListener('click',()=>{stopped=true;if(modelController){modelController.abort(new DOMException('已取消模型加载','AbortError'));notice('正在取消模型加载…');}else notice('正在停止：等待当前帧推理结束。');});
function setBusy(value){busy=value;for(const el of $('analysis-form').querySelectorAll('input,select,button'))el.disabled=value;$('stop-analysis').disabled=false;$('stop-analysis').hidden=!value;$('run-analysis').disabled=value||loading||!source;$('analysis-file').disabled=value;$('sample-image').disabled=value;if(isVideo){$('source-video').controls=!value;if(value)$('source-video').pause();}}
$('analysis-form').addEventListener('submit',async event=>{event.preventDefault();if(!source||busy||loading)return;
 let region;try{region=roi();}catch(error){notice(error.message,true);return;}
 const minimumScore=Number($('vision-score').value),offset=isVideo?Number($('vision-offset').value):0;
 const params={rule:$('vision-rule').value,roi:region,camera:$('vision-camera').value.trim(),zone:$('vision-zone').value.trim(),started_at:$('vision-start').value+':00+08:00',media_name:sourceFile.name,dwell_seconds:Number($('vision-dwell').value),is_video:isVideo,expected_direction:$('vision-direction').value,minimum_score:minimumScore,offset_seconds:offset,...inferenceSettings};
 if(!params.camera||!params.zone){notice('请填写摄像头和区域名称。',true);return;}if(isVideo&&offset>=source.duration){notice('分析起点必须小于视频时长。',true);return;}if(!isVideo&&['parking','direction'].includes(params.rule)){notice('停留和方向规则需要视频。单张图片只能检测物体或区域候选。',true);return;}
 setBusy(true);stopped=false;invalidate();const frames=[];const durations=[];const totalStart=performance.now();
 try{const detector=await getModel();const times=isVideo?Array.from({length:Math.min(params.max_frames,Math.ceil((source.duration-offset)/params.sample_interval_seconds))},(_,i)=>offset+i*params.sample_interval_seconds):[0];
 for(let i=0;i<times.length;i++){if(stopped)break;notice(`正在推理 ${i+1} / ${times.length} 帧 · ${times[i].toFixed(1)} 秒`);if(isVideo){source.pause();await seek(times[i]);}capture();const t=performance.now();const predictions=await detector.detect(frame,params.max_detections,params.minimum_score);durations.push(performance.now()-t);
 const detections=predictions.map(p=>({class:p.class,score:p.score,bbox:[Math.max(0,p.bbox[0]/frame.width),Math.max(0,p.bbox[1]/frame.height),p.bbox[2]/frame.width,p.bbox[3]/frame.height]}));frames.push({time:times[i],detections});lastBoxes=detections;paint();await new Promise(resolve=>requestAnimationFrame(resolve));}
 const tracks=trackDetections(frames),candidates=stopped?[]:makeCandidates(tracks,params);
 report={format:'estateguard-detections',version:1,model:'COCO-SSD 2.2.3 / SSDLite MobileNet V2',runtime:'TensorFlow.js 4.22.0',backend:tf.getBackend(),model_loading:{...modelLoadStats},media:{name:sourceFile.name,type:sourceFile.type,bytes:sourceFile.size},params,complete:!stopped,frames,tracks,candidates,metrics:{frame_count:frames.length,mean_inference_ms:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,total_ms:performance.now()-totalStart},scope:'真实物体推理 + 示例规则。未进行领域微调；采样、关联和规则均可能漏检或误报。不是违规、身份或损坏判定。'};
 renderResults();notice(stopped?'分析已停止。可导出已完成帧，未完成任务不生成候选。':`分析完成：${frames.length} 帧、${tracks.length} 条匿名轨迹、${candidates.length} 个待核实候选。`);
 }catch(error){if(stopped&&error.name==='AbortError')notice('模型加载已取消。素材与设置已保留，可重新开始分析。');else notice(`分析失败：${error.message}`,true);}finally{setBusy(false);}
});
function renderResults(){
 $('vision-results').hidden=false;$('send-candidates').disabled=!report.candidates.length;
 const metrics=[['采样帧',report.metrics.frame_count],['匿名轨迹',report.tracks.length],['规则候选',report.candidates.length],['平均推理',report.metrics.mean_inference_ms===null?'—':`${Math.round(report.metrics.mean_inference_ms)} ms`]];
 $('vision-summary').replaceChildren(...metrics.map(([label,value])=>{const div=document.createElement('div'),strong=document.createElement('strong');strong.textContent=value;div.append(strong,document.createTextNode(label));return div;}));
 $('candidate-explanation').textContent=report.candidates.length?'候选来自物体检测和示例规则，证据质量保守设为 0.4，送入队列后必须人工核实。检测报告保留完整框与参数。':'没有生成候选不等于安全。通用检测模式只输出物体；其他规则可能因区域、类别、时长或漏检而没有结果。';
 const rows=[];for(const track of report.tracks)for(const sample of track.samples){const tr=document.createElement('tr');for(const value of [`${sample.time.toFixed(1)} s`,track.id,names[track.class]||track.class,`${(sample.score*100).toFixed(1)}%`,sample.bbox.map(x=>x.toFixed(3)).join(', ')]){const td=document.createElement('td');td.textContent=value;tr.append(td);}rows.push(tr);}if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='当前阈值下未检测到支持的物体。可检查画面清晰度、距离和模型类别范围。';tr.append(td);rows.push(tr);}$('detection-rows').replaceChildren(...rows.slice(0,300));
}
$('download-detections').addEventListener('click',()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='estateguard-detections.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('send-candidates').addEventListener('click',()=>{if(!report?.candidates.length)return;const detail={batch:{schema_version:1,name:`本地模型分析 · ${sourceFile.name}`.slice(0,240),provenance:`真实浏览器推理：${report.model}。来源：${sourceFile.name.slice(0,100)}。规则：${report.params.rule}；采样 1 fps；区域 ${report.params.roi.join(',')}。质量 0.4 是保守工作流标记，不是图像质量模型输出。时间跨度来自稀疏采样，不代表连续停留。`,observations:report.candidates},file:sourceFile,accepted:false};window.dispatchEvent(new CustomEvent('estateguard:candidates',{detail}));if(detail.accepted)notice('候选已送入复核，原始素材可在事件详情中查看。');});
