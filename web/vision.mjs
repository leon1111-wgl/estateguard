import {trackDetections,makeCandidates,VISION_RULE_SETTINGS} from './vision-rules.mjs';
import {createModelAssetLoader,registerModelRoute} from './model-assets.mjs';
import {loadDfineDetector} from './detector-dfine.mjs';
import {parseRecordingTime,confirmContext,isContextConfirmed,validateContext,reusableScene,restoreScene} from './media-context.mjs';
const $=id=>document.getElementById(id);
const inferenceSettings=Object.freeze({sample_interval_seconds:1,max_frames:20,...VISION_RULE_SETTINGS});
// Both detectors return COCO-SSD-shaped boxes, so tracking and rules are shared; settings are recorded per run.
const DETECTORS=Object.freeze({
 ssdlite:{name:'COCO-SSD 2.2.3 / SSDLite MobileNet V2',short:'COCO-SSD · SSDLite MobileNet V2',scoreHelp:'只保留达到下限的检测结果；重叠框按固定规则合并。',runtime:'TensorFlow.js 4.22.0',settings:Object.freeze({max_detections:50,nms_iou_threshold:.5,postprocess:'coco-ssd-2.2.3-fixed-nms-v1'})},
 dfine:{name:'D-FINE-N（本项目由官方权重导出的 ONNX）',short:'D-FINE-N · ONNX Runtime Web',scoreHelp:'只保留达到下限的检测结果；几乎重合（IoU ≥ 0.9）的重复框只留分数最高的一个，其余重叠框不合并。',runtime:'ONNX Runtime Web 1.30.0',settings:Object.freeze({max_detections:50,nms_iou_threshold:null,duplicate_iou_threshold:.9,postprocess:'dfine-topk-dedupe090-v1',input_size:640})}});
const defaultScores={ssdlite:.5,dfine:.5},backendLabels={};let detectorEvaluation=null,detectorTouched=false;
const detectorKey=()=>DETECTORS[$('vision-detector').value]?$('vision-detector').value:'ssdlite';
const names={person:'人员',bicycle:'自行车',car:'小汽车',motorcycle:'摩托车',bus:'公交 / 大巴',truck:'卡车',chair:'椅子',couch:'沙发',bed:'床',suitcase:'行李箱','dining table':'餐桌',refrigerator:'冰箱',backpack:'背包',handbag:'手提包',bottle:'瓶子',cat:'猫',dog:'狗',tv:'电视'};
const models={},modelPromises={},loadStats={};let modelController=null,modelLoadStats=null,source=null,sourceFile=null,sourceURL=null,isVideo=false,busy=false,loading=false,sourceGeneration=0,stopped=false,report=null,lastBoxes=[],frameSnapshot=null,snapshotTime=0;
let mediaRevision=0,geometry=null,contextConfirmation=null,savedScene=null,savedSceneRevision=0,contextHint='';
const canvas=$('analysis-canvas'),ctx=canvas.getContext('2d'),frame=document.createElement('canvas'),frameCtx=frame.getContext('2d');
const notice=(text,error=false)=>{$('vision-message').textContent=text;$('vision-message').classList.toggle('error',error);};
$('vision-start').value='';
async function loadScript(buffer){const url=URL.createObjectURL(new Blob([buffer],{type:'text/javascript'}));try{await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=()=>{script.remove();resolve();};script.onerror=()=>{script.remove();reject(new Error('模型运行脚本初始化失败，请重试。'));};document.head.append(script);});}finally{URL.revokeObjectURL(url);}}
const mib=value=>(value/1024/1024).toFixed(1);
async function getModel(key=detectorKey()){
 if(models[key]){modelLoadStats={...loadStats[key],network_bytes:0,cache_bytes:0,load_ms:0,initialization_ms:0,reused_in_memory:true};$('model-load-detail').textContent='复用本页已就绪模型，本次无需下载或重新初始化。';return models[key];}
 if(modelPromises[key])return modelPromises[key];
 const controller=new AbortController(),signal=controller.signal;modelController=controller;
 const check=()=>{if(signal.aborted)throw signal.reason;};
 modelPromises[key]=(async()=>{
  const started=performance.now();let route=null,detector=null,manifestTimer;
  $('model-loading').hidden=false;$('model-load-progress').value=0;$('model-status').textContent='正在准备模型资源…';$('stop-analysis').textContent='取消加载';
  $('model-load-detail').textContent='读取资源清单；公共模型可缓存在本机，素材不会上传。';
  notice('正在加载本站小模型。可以取消加载，原素材和设置会保留。');
  try{
   const onProgress=progress=>{
    $('model-status').textContent=`加载模型资源 ${Math.floor(progress.loaded/progress.total*100)}%`;
    $('model-load-progress').value=progress.loaded/progress.total;
    $('model-load-detail').textContent=`已读取 ${mib(progress.loaded)} / ${mib(progress.total)} MiB · 网络读取 ${mib(progress.networkBytes)} MiB · 复用缓存 ${mib(progress.cacheBytes)} MiB${progress.cacheAvailable?'':' · 缓存不可用，本次直接加载'}`;
    notice(`${$('model-load-detail').textContent}。可取消加载。`);
   };
   if(key==='dfine'){
    detector=await loadDfineDetector({signal,onProgress});check();
    const stats=detector.stats;models[key]=detector;loadStats[key]=modelLoadStats={network_bytes:stats.networkBytes,cache_bytes:stats.cacheBytes,cache_available:stats.cacheAvailable,resource_bytes:stats.total,load_ms:performance.now()-started,initialization_ms:stats.initialization_ms,reused_in_memory:false};
    $('model-status').textContent='模型已就绪';$('model-dot').classList.add('ready');$('model-load-progress').value=1;
    $('model-backend').textContent=backendLabels[key]=`${detector.backend} · 加载 ${Math.round(modelLoadStats.load_ms)} ms`;
    $('model-load-detail').textContent=`资源已校验 · 网络读取 ${mib(stats.networkBytes)} MiB · 复用缓存 ${mib(stats.cacheBytes)} MiB${stats.cacheAvailable?'':' · 缓存不可用'}`;
    return detector;
   }
   manifestTimer=setTimeout(()=>controller.abort(new Error('模型清单加载超时，请检查网络后重试。')),30000);
   const response=await fetch(new URL('./assets.lock.json',import.meta.url),{signal,cache:'no-store'});if(!response.ok)throw new Error(`模型清单加载失败 (${response.status})`);
   const manifest=await response.json();clearTimeout(manifestTimer);check();
   if(manifest.files?.find(file=>file.path==='vendor/coco-ssd.min.js')?.local_patch!==DETECTORS.ssdlite.settings.postprocess)throw new Error('模型资源清单与页面版本不一致，请刷新页面后重试。');
   const files=manifest.files.filter(file=>file.path.startsWith('models/ssdlite_mobilenet_v2/')||file.path==='vendor/tf.min.js'&&!globalThis.tf||file.path==='vendor/coco-ssd.min.js'&&!globalThis.cocoSsd);
   const loader=createModelAssetLoader({baseURL:new URL('./',import.meta.url),files,signal,onProgress});
   if(!globalThis.tf){await loadScript(await loader.read('vendor/tf.min.js'));check();}
   if(!globalThis.cocoSsd){await loadScript(await loader.read('vendor/coco-ssd.min.js'));check();}
   if(!tf.getBackend()){try{await tf.setBackend('webgl');await tf.ready();}catch{await tf.setBackend('cpu');await tf.ready();}}check();
   const url=new URL('./models/ssdlite_mobilenet_v2/model.json',import.meta.url).href;
   const handler=tf.io.http(url,{fetchFunc:loader.fetch});
   let initializedAt=0;
   route=registerModelRoute(tf,{load:async()=>{const artifacts=await handler.load();check();initializedAt=performance.now();$('model-status').textContent='正在初始化推理引擎…';$('model-load-detail').textContent+=' · 下载和校验完成';notice('模型资源已校验，正在初始化推理引擎。');return artifacts;}});
   detector=new cocoSsd.ObjectDetection('lite_mobilenet_v2',route.url);await detector.load();check();
   models[key]=detector;const stats=loader.summary();loadStats[key]=modelLoadStats={network_bytes:stats.networkBytes,cache_bytes:stats.cacheBytes,cache_available:stats.cacheAvailable,resource_bytes:stats.total,load_ms:performance.now()-started,initialization_ms:performance.now()-initializedAt,reused_in_memory:false};
   $('model-status').textContent='模型已就绪';$('model-dot').classList.add('ready');$('model-load-progress').value=1;
   $('model-backend').textContent=backendLabels[key]=`${tf.getBackend().toUpperCase()} · 加载 ${Math.round(modelLoadStats.load_ms)} ms`;
   $('model-load-detail').textContent=`资源已校验 · 网络读取 ${mib(stats.networkBytes)} MiB · 复用缓存 ${mib(stats.cacheBytes)} MiB${stats.cacheAvailable?'':' · 缓存不可用'}`;
   return detector;
  }catch(error){controller.abort(error);detector?.dispose();const cancelled=error.name==='AbortError';$('model-status').textContent=cancelled?'加载已取消，可重试':'加载失败，可重试';$('model-load-detail').textContent=cancelled?'下载已取消；点击开始分析即可重试，原素材与设置保留。':`${error.message} 原素材与设置保留。`;throw error;}
  finally{clearTimeout(manifestTimer);route?.release();modelController=null;$('stop-analysis').textContent='停止分析';}
 })().catch(error=>{modelPromises[key]=null;throw error;});return modelPromises[key];
}
function invalidate(){report=null;$('send-candidates').disabled=true;$('vision-results').hidden=true;}
const contextFields=new Set(['vision-rule','vision-camera','vision-zone','vision-start','vision-offset','vision-direction','roi-x','roi-y','roi-w','roi-h']);
function inputError(field,message){return Object.assign(new Error(message),{field});}
function numberField(id,min,max){const value=Number($(id).value);if(!$(id).value.trim()||!Number.isFinite(value)||value<min||value>max)throw inputError(id,`请检查数值范围：${min} 至 ${max===Infinity?'素材结束前':max}。`);return value;}
function roi(){const values=['roi-x','roi-y','roi-w','roi-h'].map((id,i)=>numberField(id,i<2?0:1,100)/100);if(values[0]+values[2]>1.00001||values[1]+values[3]>1.00001)throw inputError('roi-x','关注区域超出画面，请调整 X、Y、宽和高。');return values;}
function readParameters(){
 const rule=$('vision-rule').value;
 if(!['objects','access','lift','parking','direction'].includes(rule))throw inputError('vision-rule','请选择有效的场景规则。');
 if(!isVideo&&['parking','direction'].includes(rule))throw inputError('vision-rule','停留和方向规则需要视频。单张图片只能检测物体或区域候选。');
 const params={rule,roi:roi(),camera:$('vision-camera').value.trim(),zone:$('vision-zone').value.trim(),started_at:parseRecordingTime($('vision-start').value),media_name:sourceFile?.name,dwell_seconds:rule==='parking'?numberField('vision-dwell',2,19):null,is_video:isVideo,expected_direction:rule==='direction'?$('vision-direction').value:null,minimum_score:numberField('vision-score',.1,.95),offset_seconds:isVideo?numberField('vision-offset',0,Infinity):0,...inferenceSettings,detector:detectorKey(),...DETECTORS[detectorKey()].settings};
 if(rule==='direction'&&!['right','left','down','up'].includes(params.expected_direction))throw inputError('vision-direction','请选择预期行驶方向。');
 if(isVideo&&params.offset_seconds>=source.duration)throw inputError('vision-offset','分析起点必须小于视频时长。');
 return params;
}
function contextIsCurrent(){try{return isContextConfirmed(contextConfirmation,mediaRevision,readParameters());}catch{return false;}}
function renderContext(){
 const events=$('vision-rule').value!=='objects',confirmed=contextIsCurrent();
 for(const id of ['vision-camera','vision-zone','vision-start'])$(id).required=events;
 $('vision-context-confirmation').hidden=!events;$('vision-context-confirmed').required=events;$('vision-context-confirmed').checked=confirmed;
 $('reuse-scene').hidden=!savedScene||savedSceneRevision===mediaRevision;
 $('vision-context-status').classList.remove('error');
 $('vision-context-status').textContent=contextHint||(events?(confirmed?'已核对当前素材；更换素材或修改来源、区域、时间后需要重新核对。':'生成候选前，请填写本素材的来源和实际时间，并核对关注区域。'):'通用物体检测无需现场确认；未知时间可留空，不生成事件候选。');
 try{const region=roi();$('roi-summary').textContent=region.every((v,i)=>v===[0,0,1,1][i])?'整幅画面':`X ${$('roi-x').value}% · Y ${$('roi-y').value}% · 宽 ${$('roi-w').value}% · 高 ${$('roi-h').value}%`;}catch{$('roi-summary').textContent='区域待修正';}
}
function showInputError(error){notice(error.message,true);$('vision-context-status').textContent=error.message;$('vision-context-status').classList.add('error');if(error.field?.startsWith('roi-'))document.querySelector('.roi-details').open=true;$(error.field)?.focus();}
function syncControls(){
 for(const el of $('analysis-form').querySelectorAll('input,select,button'))el.disabled=busy||loading;
 for(const [id,applicable] of [['vision-dwell',$('vision-rule').value==='parking'],['vision-direction',$('vision-rule').value==='direction'],['vision-offset',isVideo]]){
  $(id).disabled=busy||loading||!applicable;$(id).required=applicable;
 }
 $('stop-analysis').disabled=false;$('stop-analysis').hidden=!busy;
 $('run-analysis').disabled=busy||loading||!source;$('reuse-scene').disabled=busy||loading||!source;
 $('vision-context-confirmed').disabled=busy||loading||!source;
 $('analysis-file').disabled=busy;$('sample-image').disabled=busy;
 $('send-candidates').disabled=busy||loading||!report?.candidates.length;
 $('download-detections').disabled=busy||loading||!report;
}
function setMediaLoading(value){loading=value;syncControls();}
function commitContext(nextGeometry){
 mediaRevision++;geometry=nextGeometry;contextConfirmation=null;origin=null;
 for(const id of ['vision-camera','vision-zone','vision-start'])$(id).value='';
 $('vision-offset').value='0';['roi-x','roi-y','roi-w','roi-h'].forEach((id,i)=>$(id).value=[0,0,100,100][i]);
 contextHint='新素材已清空来源和时间，片段起点归零、关注区域恢复整幅。可重新填写，或显式沿用已核对的现场设置。';renderContext();
}
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
async function openFile(file,ticket=++sourceGeneration){if(busy){notice('分析进行中，请先停止，再更换素材。',true);return false;}if(!file||ticket!==sourceGeneration)return false;let nextSource=null,nextURL=null;setMediaLoading(true);
 try{if(file.size>100*1024*1024)throw new Error('素材超过 100 MB，请先截取短片段。');if(!['image/jpeg','image/png','image/webp','video/mp4','video/webm'].includes(file.type))throw new Error('请选择 JPEG / PNG / WebP 图片或 MP4 / WebM 视频。');
 notice(`正在打开 ${file.name}…`);nextURL=URL.createObjectURL(file);const nextIsVideo=file.type.startsWith('video/');
 if(nextIsVideo){nextSource=document.createElement('video');nextSource.preload='auto';nextSource.muted=true;nextSource.playsInline=true;
  await new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);nextSource.removeEventListener('loadeddata',ok);nextSource.removeEventListener('error',bad);};const ok=()=>{cleanup();resolve();};const bad=()=>{cleanup();reject(new Error('浏览器无法读取此视频编码'));};const timer=setTimeout(()=>{cleanup();reject(new Error('视频读取超时，请使用可播放的 MP4 / WebM。'));},10000);nextSource.addEventListener('loadeddata',ok);nextSource.addEventListener('error',bad);nextSource.src=nextURL;nextSource.load();});
  if(!Number.isFinite(nextSource.duration)||nextSource.duration<=0)throw new Error('无法读取视频时长，请使用普通文件而非直播流。');nextSource.pause();
 }else{nextSource=new Image();nextSource.src=nextURL;try{await nextSource.decode();}catch{throw new Error('无法解码这张图片，请选择可打开的 JPEG、PNG 或 WebP 文件。');}}
 if(ticket!==sourceGeneration){releaseSource(nextSource,nextURL);return false;}
 // Decode and capture privately before replacing the current file and its evidence.
 const prepared=document.createElement('canvas'),preparedFrame=snapshot(nextSource,nextIsVideo,prepared,prepared.getContext('2d'));
 const nextGeometry={width:nextIsVideo?nextSource.videoWidth:nextSource.naturalWidth,height:nextIsVideo?nextSource.videoHeight:nextSource.naturalHeight};
 invalidate();
 releaseSource(source,sourceURL);source=nextSource;sourceFile=file;sourceURL=nextURL;isVideo=nextIsVideo;lastBoxes=[];frameSnapshot=preparedFrame;snapshotTime=0;
 commitContext(nextGeometry);
 frame.width=prepared.width;frame.height=prepared.height;frameCtx.putImageData(preparedFrame,0,0);canvas.width=prepared.width;canvas.height=prepared.height;
 const preview=$('source-video');preview.pause();preview.hidden=!isVideo;if(isVideo){preview.src=sourceURL;preview.load();}else{preview.removeAttribute('src');preview.load();}
 paint([]);describeFrame();$('analysis-empty').hidden=true;$('analysis-stage').hidden=false;setMediaLoading(false);notice('素材已就绪。通用物体检测可直接开始；生成候选前请填写时间并核对本素材现场设置。');return true;
 }catch(error){releaseSource(nextSource,nextURL);if(ticket===sourceGeneration){setMediaLoading(false);notice(`${error.message}${sourceFile?(report?' 当前仍保留此前素材、设置与已完成报告。':' 当前仍保留此前素材与设置。'):''}`,true);}return false;}}
$('analysis-file').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';openFile(file);});
$('sample-image').addEventListener('click',async()=>{const ticket=++sourceGeneration;setMediaLoading(true);try{const r=await fetch('samples/bus.jpg');if(!r.ok)throw new Error('示例图片加载失败');const file=new File([await r.blob()],'公开示例-校车.jpg',{type:'image/jpeg'});if(ticket!==sourceGeneration)return;if(await openFile(file,ticket))notice('公开示例：Raysonho，CC0，2011。具体拍摄时间未知，可直接做通用物体检测；规则演示需自行填写测试时间，不是小区违规证据。');}catch(e){if(ticket===sourceGeneration){setMediaLoading(false);notice(e.message,true);}}});
$('analysis-form').addEventListener('input',event=>{if(busy||loading||event.target.disabled)return;
 invalidate();contextHint='';
 if(contextFields.has(event.target.id))contextConfirmation=null;
 if(event.target.id==='vision-context-confirmed'){
  contextConfirmation=null;
  if(event.target.checked){try{const params=readParameters();contextConfirmation=confirmContext(mediaRevision,params);savedScene=reusableScene(params,geometry);savedSceneRevision=mediaRevision;}catch(error){event.target.checked=false;renderContext();showInputError(error);syncControls();return;}}
 }
 renderContext();paint();syncControls();notice($('vision-context-status').textContent);
});
$('reuse-scene').addEventListener('click',()=>{if(busy||loading||!source||!savedScene)return;
 const restored=restoreScene(savedScene,geometry),p=restored.settings;
 for(const [id,value] of Object.entries({'vision-camera':p.camera,'vision-zone':p.zone,'vision-rule':p.rule,'vision-direction':p.expected_direction,'vision-dwell':p.dwell_seconds,'vision-start':'','vision-offset':0}))if(value!==null&&value!==undefined)$(id).value=value;
 ['roi-x','roi-y','roi-w','roi-h'].forEach((id,i)=>$(id).value=Number((p.roi[i]*100).toFixed(6)));
 contextConfirmation=null;invalidate();contextHint=restored.roi_reset?'已沿用来源设置；画面尺寸变化，关注区域保持整幅。请重新框选并填写本素材时间，再核对。':'已沿用现场设置；同尺寸不代表同摄像头。请填写本素材时间并核对画面。';renderContext();paint();syncControls();notice(contextHint);
});
let origin=null;
canvas.addEventListener('pointerdown',event=>{if(busy||loading||!source)return;const rect=canvas.getBoundingClientRect();origin=[Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))];canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointerup',event=>{if(!origin||busy||loading){origin=null;return;}const rect=canvas.getBoundingClientRect();const end=[Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))];const values=[Math.min(origin[0],end[0]),Math.min(origin[1],end[1]),Math.abs(origin[0]-end[0]),Math.abs(origin[1]-end[1])];origin=null;if(values[2]<.02||values[3]<.02)return;['roi-x','roi-y','roi-w','roi-h'].forEach((id,i)=>$(id).value=Math.floor(values[i]*100));contextConfirmation=null;contextHint='';invalidate();renderContext();paint();syncControls();notice('关注区域已更新；生成候选前请重新核对。');});
$('stop-analysis').addEventListener('click',()=>{stopped=true;if(modelController){modelController.abort(new DOMException('已取消模型加载','AbortError'));notice('正在取消模型加载…');}else notice('正在停止：等待当前帧推理结束。');});
function setBusy(value){busy=value;syncControls();if(isVideo){$('source-video').controls=!value;if(value)$('source-video').pause();}}
$('analysis-form').addEventListener('submit',async event=>{event.preventDefault();if(!source||busy||loading)return;
 let params;try{params=readParameters();validateContext(params,mediaRevision,contextConfirmation);params.context_confirmed=params.rule!=='objects'&&isContextConfirmed(contextConfirmation,mediaRevision,params);}catch(error){showInputError(error);return;}
 const offset=params.offset_seconds,confirmation=params.context_confirmed?{media_revision:mediaRevision,confirmed_at:contextConfirmation.confirmed_at}:null;
 setBusy(true);stopped=false;invalidate();const frames=[];const durations=[];const totalStart=performance.now();
 try{const detector=await getModel(params.detector);const times=isVideo?Array.from({length:Math.min(params.max_frames,Math.ceil((source.duration-offset)/params.sample_interval_seconds))},(_,i)=>offset+i*params.sample_interval_seconds):[0];
 for(let i=0;i<times.length;i++){if(stopped)break;notice(`正在推理 ${i+1} / ${times.length} 帧 · ${times[i].toFixed(1)} 秒`);if(isVideo){source.pause();await seek(times[i]);}capture();const t=performance.now();const predictions=await detector.detect(frame,params.max_detections,params.minimum_score);durations.push(performance.now()-t);
 const detections=predictions.map(p=>({class:p.class,score:p.score,bbox:[Math.max(0,p.bbox[0]/frame.width),Math.max(0,p.bbox[1]/frame.height),p.bbox[2]/frame.width,p.bbox[3]/frame.height]}));frames.push({time:times[i],detections});lastBoxes=detections;paint();await new Promise(resolve=>requestAnimationFrame(resolve));}
 const tracks=trackDetections(frames),candidates=stopped?[]:makeCandidates(tracks,params);
 report={format:'estateguard-detections',version:1,model:DETECTORS[params.detector].name,runtime:DETECTORS[params.detector].runtime,backend:params.detector==='dfine'?detector.backend:tf.getBackend(),model_loading:{...modelLoadStats},media:{name:sourceFile.name,type:sourceFile.type,bytes:sourceFile.size,...geometry},params,context_confirmation:confirmation,complete:!stopped,frames,tracks,candidates,metrics:{frame_count:frames.length,mean_inference_ms:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,total_ms:performance.now()-totalStart},scope:'真实物体推理 + 示例规则。未进行领域微调；采样、关联和规则均可能漏检或误报。不是违规、身份或损坏判定。'};
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
$('download-detections').addEventListener('click',()=>{if(busy||loading||!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='estateguard-detections.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('send-candidates').addEventListener('click',()=>{if(busy||loading||!report?.candidates.length)return;const detail={batch:{schema_version:1,name:`本地模型分析 · ${sourceFile.name}`.slice(0,240),provenance:`真实浏览器推理：${report.model}。来源：${sourceFile.name.slice(0,100)}。规则：${report.params.rule}；采样 1 fps；区域 ${report.params.roi.join(',')}。质量 0.4 是保守工作流标记，不是图像质量模型输出。时间跨度来自稀疏采样，不代表连续停留。`,observations:report.candidates},file:sourceFile,accepted:false};window.dispatchEvent(new CustomEvent('estateguard:candidates',{detail}));if(detail.accepted)notice('候选已送入复核，原始素材可在事件详情中查看。');});
// Detector choice: label, help text and score default follow the published COCO comparison.
const pct=value=>value==null?'—':(value*100).toFixed(1);
const LIFT_CLASSES=['couch','chair','bed','dining table','refrigerator','suitcase'];
// D-FINE runs with duplicate suppression; its deployed operating point is what users get.
const deployedOp=(e,k)=>(k==='dfine'&&e.models.dfine.deployed_dedupe090?e.models.dfine.deployed_dedupe090.test.operating_point:e.models[k].test.operating_point);
function liftPrecision(op){let tp=0,fp=0,gt=0;for(const n of LIFT_CLASSES){const c=op.per_class[n];tp+=c.true_positive;fp+=c.false_positive;gt+=c.ground_truth;}return {precision:tp+fp?tp/(tp+fp):null,recall:gt?tp/gt:null,tp,fp,gt};}
$('vision-rule').addEventListener('change',()=>describeDetector());
function describeDetector(){
 const key=detectorKey(),spec=DETECTORS[key],e=detectorEvaluation?.models?.[key],ready=!!models[key];
 $('model-name').textContent=spec.short;$('model-status').textContent=ready?'模型已就绪':'模型尚未加载';$('model-dot').classList.toggle('ready',ready);$('model-backend').textContent=ready?backendLabels[key]:'浏览器端运行';$('vision-score-help').textContent=spec.scoreHelp;
 const otherKey=key==='dfine'?'ssdlite':'dfine',lift=e&&$('vision-rule').value==='lift'?liftPrecision(deployedOp(detectorEvaluation,key)):null,other=detectorEvaluation?.models?.[otherKey];
 $('vision-detector-help').textContent=lift&&other?`客梯大件 6 类在 COCO 上的精确率 ${pct(lift.precision)}%（${key==='dfine'?'SSDLite':'D-FINE-N'} ${pct(liftPrecision(deployedOp(detectorEvaluation,otherKey)).precision)}%），每 100 个检出约 ${Math.round((1-lift.precision)*100)} 个是误检；需逐条人工核对，可调高分数下限。`:e?`COCO 通用照片：AP\u00a0${pct(e.test.coco.AP)}（物业相关 12 类\u00a0${pct(e.test.coco.relevant_mean_ap)}）；参考机约 ${Math.round(e.latency.total_ms.p95)}\u00a0ms/张。建议下限 ${e.operating_threshold}${detectorEvaluation.default_decision?.default===key?'，当前默认':''}。不代表小区监控效果。`:'两种模型都识别 COCO 80 类物体；评测记录加载后显示公开数据上的对比。';
}
// ?detector=ssdlite|dfine pins a detector for shared links and regression checks.
const requestedDetector=new URLSearchParams(location.search).get('detector');let scoreEdited=false;
if(DETECTORS[requestedDetector]){$('vision-detector').value=requestedDetector;$('vision-detector').dataset.previous=requestedDetector;detectorTouched=true;describeDetector();}
$('vision-score').addEventListener('input',()=>{scoreEdited=true;});
$('vision-detector').addEventListener('change',()=>{
 detectorTouched=true;const previous=$('vision-detector').dataset.previous||'ssdlite',key=detectorKey();$('vision-detector').dataset.previous=key;$('model-loading').hidden=true;
 if(!scoreEdited&&Number($('vision-score').value)===defaultScores[previous])$('vision-score').value=String(defaultScores[key]);
 describeDetector();notice(`已切换到 ${DETECTORS[key].short}。${models[key]?'':'首次分析会从本站加载该模型。'}分数下限 ${$('vision-score').value}；需重新分析才会更新结果。`);
});
fetch(new URL('./data/detector/evaluation.json',import.meta.url),{cache:'no-store'}).then(r=>r.ok?r.json():null).then(e=>{
 if(!e)return;detectorEvaluation=e;defaultScores.dfine=e.models?.dfine?.operating_threshold??.5;
 // Apply the published default only before the user has chosen a detector or produced a report.
 if(!detectorTouched&&!busy&&!report&&e.default_decision?.default==='dfine'&&Number($('vision-score').value)===defaultScores.ssdlite){$('vision-detector').value='dfine';$('vision-detector').dataset.previous='dfine';$('vision-score').value=String(defaultScores.dfine);}
 else if(detectorKey()==='dfine'&&!scoreEdited&&!busy&&!report&&Number($('vision-score').value)===defaultScores.ssdlite)$('vision-score').value=String(defaultScores.dfine);
 describeDetector();renderDetectorEvaluation();
}).catch(()=>{}).finally(()=>{if(!detectorEvaluation){$('vision-detector-help').textContent='评测记录未能加载，暂按 SSDLite 运行；可刷新重试，或手动选择检测模型。';const box=$('detector-evaluation-content');if(box)box.innerHTML='<p class="subtle">检测器评测记录未能加载，可刷新重试。</p>';}});
function renderDetectorEvaluation(){
 const e=detectorEvaluation,box=$('detector-evaluation-content');if(!e||!box)return;
 const keys=['ssdlite','dfine'],m=k=>e.models[k],p1=v=>v==null?'—':`${(v*100).toFixed(1)}%`,ap=v=>v==null?'—':(v*100).toFixed(1);
 const tbl=(head,rows)=>`<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((c,i)=>i?`<td>${c}</td>`:`<th>${c}</th>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 const label={ssdlite:'SSDLite MobileNet V2',dfine:'D-FINE-N'},zh={person:'人员',bicycle:'自行车',car:'小汽车',motorcycle:'摩托车',bus:'公交 / 大巴',truck:'卡车',suitcase:'行李箱',chair:'椅子',couch:'沙发',bed:'床','dining table':'餐桌',refrigerator:'冰箱'};
 const ok=v=>v?'满足':'未满足',c=e.default_decision.criteria;
 let html=`<p><strong>测试半 ${e.dataset.test_images.toLocaleString()} 张</strong> · 按图片编号前 ${e.dataset.dev_images.toLocaleString()} 张只用于选 D-FINE 的分数下限（${e.threshold_selection.chosen}${e.threshold_selection.met_precision_constraint?'':'，未达到精度约束'}）。当前默认：${label[e.default_decision.default]}。</p>`;
 html+=tbl(['检测器','AP','12 类平均 AP','12 类召回 / 精确率','客梯大件 6 类召回 / 精确率','分数下限','小目标 AP','参考机每张 P50 / P95'],keys.map(k=>{const t=m(k).test,o=t.operating_point,l=m(k).latency,f=liftPrecision(o);return [label[k],ap(t.coco.AP),ap(t.coco.relevant_mean_ap),`${p1(o.recall)} / ${p1(o.precision)}`,`${p1(f.recall)} / ${p1(f.precision)}`,String(m(k).operating_threshold),ap(t.coco.AP_small),`${Math.round(l.total_ms.p50)} / ${Math.round(l.total_ms.p95)} ms`];}));
 {const a=liftPrecision(m('ssdlite').test.operating_point),b=liftPrecision(m('dfine').test.operating_point),dd=m('dfine').deployed_dedupe090,c=dd?liftPrecision(dd.test.operating_point):null;html+=`<p><strong>大件误检增加</strong>：客梯规则用到的沙发、椅子、床、餐桌、冰箱、行李箱 6 类合并后，D-FINE 召回 ${p1(b.recall)}（SSDLite ${p1(a.recall)}），但精确率 ${p1(b.precision)}（${p1(a.precision)}），误检 ${b.fp} 个（${a.fp} 个）。12 类合并精确率持平主要由人员类撑起。</p>`;
  if(dd)html+=`<p class="subtle">上表为协议预先固定的原始 top-k 结果。网页另外丢弃几乎重合（IoU ≥ 0.9）的重复框（评测后由找茬发现、事后加入）：测试半 AP ${ap(dd.test.coco.AP)}，12 类召回 / 精确率 ${p1(dd.test.operating_point.recall)} / ${p1(dd.test.operating_point.precision)}，客梯大件精确率 ${p1(c.precision)}；默认规则重核仍${Object.values(e.default_decision.deployed_recheck||{}).every(Boolean)?'全部满足':'有未满足项'}。</p>`;}
 html+=`<p class="subtle">AP 为 COCO 标准 AP@[.5:.95]（pycocotools，取每张前 100 个框）。召回与精确率按各自分数下限、IoU ≥ 0.5 一对一匹配计算。耗时含读图、缩放、推理与后处理；SSDLite 用 WebGL，D-FINE 用单线程 WASM，设备不同差异很大。</p>`;
 html+=`<details><summary>12 个物业相关类别逐类 AP、召回与精确率</summary>${tbl(['类别','真值数','AP（SSDLite / D-FINE）','召回（SSDLite / D-FINE）','精确率（SSDLite / D-FINE）'],e.relevant_classes.map(n=>{const s=m('ssdlite').test,d=m('dfine').test,a=s.operating_point.per_class[n],b=d.operating_point.per_class[n];return [zh[n]||n,a.ground_truth.toLocaleString(),`${ap(s.coco.per_class_ap[n])} / ${ap(d.coco.per_class_ap[n])}`,`${p1(a.recall)} / ${p1(b.recall)}`,`${p1(a.precision)} / ${p1(b.precision)}`];}))}</details>`;
 html+=`<p>默认规则（测试半）：全类 AP 更高：${ok(c.ap_higher)}；12 类召回不低于基线：${ok(c.recall_not_lower)}；精确率下降不超过 1 个百分点：${ok(c.precision_within_1pt)}；单线程 P95 ≤ 500 ms（参考机 M1 Max）：${ok(c.p95_latency_within_500ms)}。</p><p><a href="data/detector/evaluation.json">完整评测 JSON</a> · <a href="https://github.com/leon1111-wgl/estateguard/blob/main/docs/MODEL_CARD.md">模型卡 ↗</a></p><p class="subtle">COCO 标注按 CC BY 4.0 使用，图片只在本地评测、不随站点发布。没有小区监控、夜间或客梯数据上的检出率，不能把这里的提升当作违规识别效果。</p>`;
 box.innerHTML=html;
}
renderContext();syncControls();
