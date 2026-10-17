import {predictPatch,classifyScore,frameSummary,parkingReviewSummary,filterParkingRows,nextParkingReviewId,exportParkingReview,importParkingReview,serializeParkingReview,MAX_PARKING_REVIEW_BYTES} from './parking-model.mjs';
import {buildParkingAudit,filterParkingAudit,exportParkingAudit} from './parking-audit.mjs';
import {validateHead,predictHead,routeScore,selectRouting,adaptHead,standardize,minimumEvidence} from './parking-transfer.mjs';
import {ENCODERS,loadEncoder,decodeImage} from './parking-encoders.mjs';
const $=id=>document.getElementById(id);
const text=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={free:'空闲',busy:'占用',uncertain:'模型不确定',pending:'未分析'};
const humanLabels={free:'已确认空闲',busy:'已确认占用',uncertain:'需补证据',pending:'待人工复核'};
const routedLabels={free:'自动判空闲',busy:'自动判占用',uncertain:'需人工复核',pending:'未分析'};
const base=new URL('./data/parking/',import.meta.url),extBase=new URL('./data/parking-ext/',import.meta.url),transferBase=new URL('./data/parking-transfer/',import.meta.url);
const src=(r,field='image')=>new URL(r[field],r.base||base);
const mib=bytes=>(bytes/1048576).toFixed(1);
let model=null,evaluation=null,manifest=null,corePromise=null,dataPromise=null,samples=new Map(),frames=[],frameIndex=0,selected=null,running=false,playTimer=null,playSequence=0,cancelled=false,uploadSequence=0,importSequence=0,uploadURL=null,changed=false,analysisPromise=null,analysisFrameId=null,analysisSequence=0;
const failures=new Map(),reviews={},drafts=new Map();
// One prediction map per model; transfer models also keep calibrated scores and embeddings for on-site adaptation.
const sets={mlp32:new Map(),mobilenet:new Map(),dinov2:new Map()},calibratedSets={mobilenet:new Map(),dinov2:new Map()},embeddings={mobilenet:new Map(),dinov2:new Map()};
const heads={},encoders={},encoderPromises={},adaptations={mobilenet:{},dinov2:{}},onsiteRouting={mobilenet:{},dinov2:{}};
let current='mlp32',predictions=sets.mlp32,transferEvaluation=null,encoderController=null,modelChosenByUser=false;
const transfer=()=>current!=='mlp32';
const labelOf=state=>(transfer()?routedLabels:labels)[state];
function routingFor(camera){return onsiteRouting[current]?.[camera]?.routing||null;}
const certified=routing=>!!routing&&(routing.t_free!=null||routing.t_busy!=null);
const routingNote=camera=>certified(routingFor(camera))?'按本相机通过检验的阈值自动分流，其余送人工；阈值可能随画面变化失效，需抽检。':routingFor(camera)?'本相机校准证据不足，所有车位仍送人工复核；模型倾向与概率可作参考。':'本相机尚未完成风险校准，所有车位送人工复核；模型倾向与概率可作参考。';
// Transfer models auto-decide only with thresholds certified on this camera; otherwise every slot goes to a person.
function stateOf(id,p){if(!transfer())return classifyScore(p);return {review:'uncertain',free:'free',busy:'busy'}[routeScore(calibratedSets[current].get(id),routingFor(samples.get(id)?.camera))];}
function scoreSample(id,key=current){const r=samples.get(id),z=embeddings[key].get(id);if(!z)return;const {score,calibrated}=predictHead(z,heads[key],adaptations[key][r.camera]);sets[key].set(id,score);calibratedSets[key].set(id,calibrated);}
const evidenceFailures=new Map(),evidenceAttempts=new Map();
let errorAudit=null,errorPredictionsHash=null,errorJumpSequence=0,uploadPending=false;
const notice=(s,error=false)=>{$('parking-message').textContent=s;$('parking-message').classList.toggle('error',error);};
const reviewNotice=(s,error=false)=>{$('parking-review-message').textContent=s;$('parking-review-message').classList.toggle('error',error);};
const download=(name,value)=>{const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
async function json(url){const r=await fetch(url);if(!r.ok)throw new Error(`资源加载失败 (${r.status})`);return r.json();}
const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
const weatherLabels={sunny:'晴',overcast:'阴',rainy:'雨'};
let extManifest=null,allFrames=[];
// Heads are small JSON files checked against the published evaluation; encoders load only when analysis starts.
async function loadTransfer(){
 try{
  const report=await json(new URL('evaluation.json',transferBase));
  for(const key of ['mobilenet','dinov2']){const entry=report.models?.[key];if(!entry)continue;const response=await fetch(new URL(entry.model_path,new URL('./',import.meta.url)));if(!response.ok)throw new Error('迁移分类头加载失败');const bytes=await response.arrayBuffer();if(await sha256(bytes)!==entry.model_sha256)throw new Error('迁移分类头与评测版本不一致');heads[key]=validateHead(JSON.parse(new TextDecoder().decode(bytes)),ENCODERS[key]);}
  transferEvaluation=report;
  try{const lock=await (await fetch(new URL('./assets.lock.json',import.meta.url),{cache:'no-store'})).json();for(const key of ['mobilenet','dinov2'])encoderBytes[key]=lock.files.filter(f=>ENCODERS[key].assets(f.path)||key==='dinov2'&&f.path.startsWith('vendor/onnxruntime-web/ort')&&f.path.endsWith('.mjs')).reduce((s,f)=>s+f.bytes,0);}catch{}
  if(!modelChosenByUser&&heads[report.default_model?.encoder]){current=report.default_model.encoder;$('parking-model-choice').value=current;predictions=sets[current];}
 }catch(e){for(const key of ['mobilenet','dinov2'])delete heads[key];current='mlp32';predictions=sets.mlp32;$('parking-model-choice').value='mlp32';notice(`迁移模型记录加载失败，已保留 MLP32 基线：${e.message}`,true);}
 for(const option of $('parking-model-choice').options)option.disabled=option.value!=='mlp32'&&!heads[option.value];
}
function updateModelBar(){
 if(!model)return;const spec=ENCODERS[current];
 $('parking-model-status').textContent=transfer()?`${spec.label} · ${encoders[current]?`已加载 · ${encoders[current].backend}`:'分析时加载编码器'}`:`已训练 · ${model.hidden?'32 隐藏单元神经网络':'线性分类器'} · MLP32 基线`;
 $('parking-model-source').textContent=transfer()?spec.detail:'本项目使用公开标签训练';
 $('parking-model-data').textContent=transfer()?'CNRPark A 训练 · 冻结编码器 + 线性头':'CNRPark 基础子集';
}
async function loadCore(){
 if(model)return;if(corePromise)return corePromise;
 corePromise=(async()=>{
  $('parking-model-status').textContent='正在加载已训练的占用分类器…';
  const response=await fetch(new URL('./models/parking-occupancy/model.json',import.meta.url));if(!response.ok)throw new Error('分类器加载失败');
  const bytes=await response.arrayBuffer();const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const next=JSON.parse(new TextDecoder().decode(bytes));const report=await json(new URL('evaluation.json',base));
  if(next.format!=='estateguard-parking-mlp'||next.features!==240||report.model_sha256!==sha)throw new Error('模型与评测版本不一致，请刷新后重试');
  model=next;evaluation=report;await loadTransfer();updateModelBar();
  $('parking-model-status').previousElementSibling.classList.add('ready');renderEvaluation();renderTransferEvaluation();updateModelPanel();
 })().catch(e=>{corePromise=null;throw e;});return corePromise;
}
async function loadData(){
 if(manifest)return;if(dataPromise)return dataPromise;
 dataPromise=(async()=>{
  await loadCore();const next=await json(new URL('manifest.json',base));if(next.model_sha256!==evaluation.model_sha256)throw new Error('样本与模型版本不一致');
  manifest=next;for(const r of next.samples)r.base=base;samples=new Map(next.samples.map(r=>[r.id,r]));allFrames=[...next.frames];
  // The CNR-EXT subset is optional: the B test set stays usable if it fails to load.
  try{const ext=await json(new URL('manifest.json',extBase));for(const r of ext.samples){r.base=extBase;samples.set(r.id,r);}extManifest=ext;allFrames.push(...ext.frames);}catch(e){extManifest=null;}
  const sessions=[...new Set(allFrames.map(f=>f.session))];$('parking-session').replaceChildren(...sessions.map(s=>{const option=document.createElement('option');option.value=s;const fs=allFrames.filter(f=>f.session===s),f=fs[0];option.textContent=f.weather?`摄像头 ${f.camera} · CNR-EXT 保留测试 · ${fs.map(x=>weatherLabels[x.weather]).join('/')} ${fs.length} 个快照`:`摄像头 ${f.camera} · ${formatDate(f.date)} · 测试集`;return option;}));
  setSession();$('parking-run').disabled=false;
  notice(`已加载完整测试集：${next.samples.length} 张真实车位图片，${next.frames.length} 个历史快照${extManifest?`；另有 CNR-EXT 保留测试 ${extManifest.samples.length} 张、${extManifest.frames.length} 个快照（9 个新视角，未参与训练与选模）`:'；CNR-EXT 保留测试子集加载失败，可刷新重试'}。点击“分析当前快照”运行模型。`,!extManifest);
 })().catch(e=>{dataPromise=null;manifest=null;$('parking-run').disabled=false;throw e;});return dataPromise;
}
function formatDate(d){return `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}`;}
function walltime(f){return `${formatDate(f.date)} ${f.time.slice(0,2)}:${f.time.slice(2)}`;}
function clockMinutes(f){return Date.UTC(+f.date.slice(0,4),+f.date.slice(4,6)-1,+f.date.slice(6,8),+f.time.slice(0,2),+f.time.slice(2))/60000;}
function currentRows(){return frames[frameIndex]?.sample_ids.map(id=>samples.get(id))||[];}
function stopPlayback(){playSequence++;clearTimeout(playTimer);playTimer=null;$('parking-play').textContent='播放快照';$('parking-play').setAttribute('aria-pressed','false');}
function setSession(){stopPlayback();reviewNotice('');frames=allFrames.filter(f=>f.session===$('parking-session').value);frameIndex=0;selected=null;$('parking-frame').max=String(Math.max(0,frames.length-1));render();}
function chooseFrame(index){reviewNotice('');const slot=samples.get(selected)?.slot;frameIndex=Math.max(0,Math.min(frames.length-1,index));selected=currentRows().find(r=>r.slot===slot)?.id||null;render();}
function render(){
 if(!manifest||!frames.length)return;const f=frames[frameIndex],rows=currentRows(),summary=frameSummary(rows,predictions,stateOf),hasAny=rows.some(r=>predictions.has(r.id));
 $('parking-frame').value=String(frameIndex);$('parking-prev').disabled=running||frameIndex===0;$('parking-next').disabled=running||frameIndex===frames.length-1;
 const delta=frameIndex?clockMinutes(f)-clockMinutes(frames[frameIndex-1]):null;
 $('parking-time').textContent=`${walltime(f)}${f.weather?` · ${weatherLabels[f.weather]}天`:''} · 第 ${frameIndex+1} / ${frames.length} 张 · ${delta===null?'首个快照':delta>=1440?`距上一张约 ${Math.round(delta/1440)} 天`:`距上一张 ${delta} 分钟`} · 数据源当地钟面时间，未声明时区；间隔不证明连续停留。`;
 const items=transfer()?[['当前快照车位',summary.total],['自动判空闲',hasAny?summary.free:'—'],['自动判占用',hasAny?summary.busy:'—'],['需人工复核 / 未分析',hasAny?`${summary.uncertain} / ${summary.pending}`:'—']]:[['当前快照车位',summary.total],['模型预测空闲',hasAny?summary.free:'—'],['模型预测占用',hasAny?summary.busy:'—'],['模型不确定 / 未分析',hasAny?`${summary.uncertain} / ${summary.pending}`:'—']];
 $('parking-metrics').innerHTML=items.map(([label,value])=>`<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
 const human=parkingReviewSummary(rows,reviews);
 $('parking-review-progress').textContent=`当前快照：已确认 ${human.confirmed} / ${human.total} · 待人工复核 ${human.pending+human.needs_evidence}（其中需补证据 ${human.needs_evidence}）`;
 const filter=$('parking-filter').value,visible=filterParkingRows(rows,predictions,reviews,filter,stateOf);
 if(!selected||!visible.some(r=>r.id===selected))selected=visible[0]?.id||null;
 const truth=$('parking-show-truth').checked;
 $('parking-grid').replaceChildren(...visible.map(r=>{
  const p=predictions.get(r.id),state=p===undefined?'pending':stateOf(r.id,p),shown=transfer()?calibratedSets[current].get(r.id):p;const button=document.createElement('button');button.type='button';button.className='parking-tile';button.dataset.sampleId=r.id;button.setAttribute('aria-pressed',String(selected===r.id));
  button.innerHTML=`<img loading="lazy" src="${src(r)}" alt="摄像头 ${text(r.camera)} 车位 ${text(r.slot)} 的历史裁剪图"><strong>${text(r.camera)}:${text(r.slot)}</strong><span class="parking-tile-line"><span class="badge${transfer()&&state==='uncertain'&&!failures.has(r.id)?' uncertain':''}">${failures.has(r.id)?'读取失败':labelOf(state)}</span><span>${p===undefined?'—':`${(shown*100).toFixed(1)}% 占用`}</span></span>${truth?`<small class="parking-truth">标注：${r.label?'占用':'空闲'}${p===undefined?'':Number(p>=.5)===r.label?' · 一致':' · 错判'}</small>`:''}<small>${humanLabels[reviews[r.id]?.decision]||'未人工复核'}</small>`;
  button.addEventListener('click',()=>{selected=r.id;reviewNotice('');render();if(matchMedia('(max-width:650px)').matches)document.querySelector('.parking-review')?.scrollIntoView({block:'start'});});return button;
 }));
 if(!visible.length){const p=document.createElement('p');p.className='empty';p.textContent=({review:'当前快照人工复核已完成。',confirmed:'当前快照还没有已人工确认的车位。',evidence:'当前快照没有标记为需补证据的车位。'})[filter]||(hasAny?'当前快照没有符合筛选的车位。':'请先分析当前快照，再筛选模型结果。');$('parking-grid').append(p);}
 renderDetail();updateModelPanel();
}
function renderDetail(){
 const r=samples.get(selected);$('parking-save').disabled=!r||running;$('parking-save-next').disabled=!r||running;
 if(!r){$('parking-detail').innerHTML='<p class="empty">选择一个车位查看详情。</p>';$('parking-decision').value='pending';$('parking-note').value='';return;}
 const p=predictions.get(r.id),state=p===undefined?'pending':stateOf(r.id,p),truth=$('parking-show-truth').checked,cal=calibratedSets[current]?.get(r.id),adapted=transfer()&&adaptations[current][r.camera];
 const imageURL=src(r);if(evidenceAttempts.has(r.id))imageURL.searchParams.set('retry',evidenceAttempts.get(r.id));
 $('parking-detail').innerHTML=`<img id="parking-evidence-image" data-evidence-sample-id="${text(r.id)}" src="${imageURL}" alt="选中车位的原始图片"><p id="parking-image-status" class="subtle" role="status" aria-live="polite">正在读取复核原图…</p><button id="parking-image-retry" class="button" type="button" hidden>重试原图</button><h3>摄像头 ${text(r.camera)} · 车位 ${text(r.slot)}</h3><span class="badge${transfer()&&state==='uncertain'?' uncertain':''}">${labelOf(state)}</span><dl><dt>原始采样时间</dt><dd>${walltime(r)}${r.weather?` · ${weatherLabels[r.weather]}天`:''}</dd>${transfer()?`<dt>模型</dt><dd>${text(ENCODERS[current].label)}${adapted?` · 已用本相机 ${adapted.n} 条人工结论自适应`:''}</dd><dt>校准后占用概率</dt><dd>${cal===undefined?'未运行模型':`${(cal*100).toFixed(2)}%（未校准分数 ${(p*100).toFixed(2)}%）`}</dd><dt>自动判定</dt><dd>${certified(routingFor(r.camera))?'已通过检验 · 自动分流':routingFor(r.camera)?'证据不足 · 全部送人工':'未校准 · 全部送人工'}</dd>`:`<dt>占用分数</dt><dd>${p===undefined?'未运行模型':`${(p*100).toFixed(2)}%`}</dd>`}<dt>数据分区</dt><dd>${r.base===extBase?'CNR-EXT 保留测试':'B 视角 · 开发比较'}</dd>${truth?`<dt>原始数据标签</dt><dd>${r.label?'占用':'空闲'}</dd>`:''}</dl><p class="subtle">${transfer()?'温度校准只在训练视角验证；换视角后概率会偏，需现场校准才能自动判定。':'分数未做概率校准，低分空闲也可能漏掉占用车辆。'}模型输出、数据标注与人工结论分别保留。</p>${failures.has(r.id)?'<p class="message error">模型输入读取失败，仍计入未分析；可重新分析重试。</p>':''}`;
 const image=$('parking-evidence-image'),imageStatus=$('parking-image-status'),retry=$('parking-image-retry');
 const ready=ok=>{if(selected!==r.id||$('parking-evidence-image')!==image)return;retry.disabled=false;retry.hidden=ok;imageStatus.classList.toggle('error',!ok);imageStatus.textContent=ok?'复核原图已载入，请结合画面填写人工结论。':'原图读取失败。请重试；无法查看时可记录“无法判断”，不能保存明确空闲或占用。';if(ok)evidenceFailures.delete(r.id);else evidenceFailures.set(r.id,'复核原图读取失败');};
 image.addEventListener('load',()=>ready(true));image.addEventListener('error',()=>ready(false));if(image.complete)ready(image.naturalWidth>0);
 retry.addEventListener('click',()=>{if(selected!==r.id)return;evidenceAttempts.set(r.id,String(Date.now()));imageURL.searchParams.set('retry',evidenceAttempts.get(r.id));retry.disabled=true;imageStatus.classList.remove('error');imageStatus.textContent='正在重新读取复核原图…';image.src=imageURL.href;});
 const d=drafts.get(r.id)||reviews[r.id]||{decision:'pending',note:''};$('parking-decision').value=d.decision;$('parking-note').value=d.note;
}
async function pixels(url){const image=new Image();image.src=url;let timer;try{await Promise.race([image.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('图片读取超时，请重试')),15000);})]);}catch(error){image.src='';throw error;}finally{clearTimeout(timer);}if(image.naturalWidth*image.naturalHeight>40000000)throw new Error('图片分辨率过大，请先裁剪单个车位');const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;if(c.width*c.height>40000000)throw new Error('图片分辨率过大，请先裁剪单个车位');const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const source=ctx.getImageData(0,0,c.width,c.height).data;const out=new Uint8ClampedArray(4096);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const sx=Math.floor((x+.5)*c.width/32),sy=Math.floor((y+.5)*c.height/32),i=(sy*c.width+sx)*4;out.set(source.subarray(i,i+4),(y*32+x)*4);}return out;}
function busy(value){running=value;$('parking-stop').hidden=!value;for(const id of ['parking-run','parking-session','parking-frame','parking-upload','parking-save','parking-save-next','parking-model-choice'])$(id).disabled=value;render();}
// Encoders are cached per page; loading reports verified bytes and can be cancelled from the stop button.
function ensureEncoder(key){
 if(encoders[key])return Promise.resolve(encoders[key]);
 if(!encoderPromises[key]){
  const controller=new AbortController();encoderController=controller;
  encoderPromises[key]=loadEncoder(key,{signal:controller.signal,onProgress:p=>{if(controller.signal.aborted)return;const line=`正在加载 ${ENCODERS[key].label}：${mib(p.loaded)} / ${mib(p.total)} MiB · 网络读取 ${mib(p.networkBytes)} MiB · 复用缓存 ${mib(p.cacheBytes)} MiB`;notice(`${line}。${running?'可停止。':''}`);if(uploadPending)$('parking-upload-result').textContent=`${line}…`;}})
   .then(e=>{encoders[key]=e;updateModelBar();updateModelPanel();if(!running)notice(`${ENCODERS[key].label} 已加载（${e.backend}），之后分析复用本页模型。`);return e;}).finally(()=>{encoderPromises[key]=null;if(encoderController===controller)encoderController=null;});
 }
 return encoderPromises[key];
}
function runCurrent(){
 // Playback must await an existing manual run instead of treating it as finished.
 if(analysisPromise){
  const wanted=frames[frameIndex]?.id,ticket=analysisSequence;
  if(!wanted||wanted===analysisFrameId)return analysisPromise;
  return analysisPromise.then(()=>{if(ticket===analysisSequence&&frames[frameIndex]?.id===wanted&&location.hash==='#parking')return runCurrent();});
 }
 analysisPromise=(async()=>{try{await loadData();analysisFrameId=frames[frameIndex]?.id;const frameTime=walltime(frames[frameIndex]);busy(true);cancelled=false;const rows=currentRows(),key=current,target=sets[key];let done=0,loadMs=0;
  let encoder=null;if(key!=='mlp32'){const loadStart=performance.now();encoder=await ensureEncoder(key);loadMs=performance.now()-loadStart;}
  const start=performance.now();
  // Small concurrency bound avoids loading the entire public corpus at once; encoders run one patch at a time.
  let next=0;await Promise.all(Array.from({length:encoder?1:4},async()=>{while(next<rows.length&&!cancelled){const r=rows[next++];try{
   if(encoder){const bitmap=await decodeImage(src(r).href);try{embeddings[key].set(r.id,await encoder.embed(bitmap));}finally{bitmap.close();}scoreSample(r.id,key);}
   else{const data=await pixels(src(r,'input').href);target.set(r.id,predictPatch(data,model));}
   failures.delete(r.id);}catch(e){failures.set(r.id,e.message);target.delete(r.id);calibratedSets[key]?.delete(r.id);}done++;notice(`正在分析快照 ${frameTime}：${done} / ${rows.length} 个车位。`);}}));
  const failed=rows.filter(r=>failures.has(r.id)).length,elapsed=performance.now()-start,count=rows.filter(r=>target.has(r.id)).length;
  notice(`${cancelled?'分析已停止':'当前快照分析完成'}（${frameTime} · ${key==='mlp32'?'MLP32':ENCODERS[key].label}）：${count} / ${rows.length} 个车位，${Math.round(elapsed)} ms（含图片读取${count?`，约 ${Math.round(elapsed/Math.max(1,done))} ms/个`:''}）${loadMs>50?`；编码器加载 ${Math.round(loadMs)} ms`:''}。${failed?'读取失败项保留为未分析，可重试。':key==='mlp32'?'预测来自图片像素；原始标注只用于对照。':routingNote(frames[frameIndex].camera)}`,!!failed);
 }catch(e){if(e?.name==='AbortError')notice('已停止加载编码器。已下载并校验的资源会缓存，可重新分析。');else notice(e.message,true);}finally{busy(false);}})().finally(()=>{analysisPromise=null;analysisFrameId=null;});
 return analysisPromise;
}
async function playback(){
 if(playTimer){stopPlayback();return;}if(!manifest)return;
 const ticket=++playSequence;playTimer=-1;$('parking-play').textContent='停止回放';$('parking-play').setAttribute('aria-pressed','true');
 const tick=async()=>{if(ticket!==playSequence||location.hash!=='#parking')return;await runCurrent();if(ticket!==playSequence)return;if(frameIndex>=frames.length-1){stopPlayback();return;}playTimer=setTimeout(()=>{if(ticket!==playSequence)return;chooseFrame(frameIndex+1);tick();},1800);};tick();
}
const stopButton=document.createElement('button');stopButton.id='parking-stop';stopButton.className='button';stopButton.type='button';stopButton.textContent='停止分析';stopButton.hidden=true;$('parking-run').after(stopButton);stopButton.addEventListener('click',()=>{analysisSequence++;cancelled=true;encoderController?.abort(new DOMException('已取消加载','AbortError'));stopPlayback();notice('正在停止，已完成的预测会保留。');});
$('parking-run').addEventListener('click',runCurrent);
$('parking-session').addEventListener('change',setSession);
$('parking-frame').addEventListener('input',()=>{stopPlayback();chooseFrame(Number($('parking-frame').value));});
$('parking-prev').addEventListener('click',()=>{stopPlayback();chooseFrame(frameIndex-1);});$('parking-next').addEventListener('click',()=>{stopPlayback();chooseFrame(frameIndex+1);});$('parking-play').addEventListener('click',playback);
for(const id of ['parking-filter','parking-show-truth'])$(id).addEventListener('change',render);
for(const id of ['parking-note','parking-decision'])$(id).addEventListener('input',()=>{if(selected){stopPlayback();drafts.set(selected,{decision:$('parking-decision').value,note:$('parking-note').value});changed=true;}});
const context=()=>({model_sha256:evaluation.model_sha256,sample_ids:[...samples.keys()]});
function reviewDocument(nextReviews=reviews){const out=exportParkingReview(context(),nextReviews);out.dataset=manifest.dataset;out.source_frame=frames[frameIndex]?.id;out.frame_summary=frameSummary(currentRows(),predictions,stateOf);out.datasets={cnrpark:manifest.dataset,cnr_ext:extManifest?.dataset||null};out.prediction_model={key:current,name:current==='mlp32'?'MLP32':ENCODERS[current].label,model_sha256:current==='mlp32'?evaluation.model_sha256:transferEvaluation.models[current].model_sha256};out.onsite=Object.fromEntries(['mobilenet','dinov2'].map(key=>[key,Object.fromEntries([...new Set([...Object.keys(adaptations[key]),...Object.keys(onsiteRouting[key])])].map(camera=>{const a=adaptations[key][camera],o=onsiteRouting[key][camera];return [camera,{adaptation:a?{labels:a.n,occupied:a.busy,lam:a.lam,lr:a.lr,steps:a.steps,sample_ids:[...a.used],at:a.at}:null,routing:o?{...o.routing,tests:undefined,sample_ids:o.ids,at:o.at}:null}];}))]));out.predictions_by_model={mlp32:[...sets.mlp32].map(([id,score])=>({id,score})),...Object.fromEntries(['mobilenet','dinov2'].map(key=>[key,[...sets[key]].map(([id,score])=>({id,score,calibrated:calibratedSets[key].get(id),adapted:!!adaptations[key][samples.get(id).camera]}))]))};out.review_summary=parkingReviewSummary(currentRows(),nextReviews);out.unanalysed_sample_ids=currentRows().filter(r=>!predictions.has(r.id)).map(r=>r.id);out.samples=[...predictions].map(([id,score])=>{const r=samples.get(id);return {id,dataset:r.base===extBase?'cnr_ext':'cnrpark',camera:r.camera,slot:r.slot,source_time:`${r.date} ${r.time}`,source_timezone:manifest.dataset.timezone,split:r.split,image:r.image,source_sha256:r.source_sha256,predicted_occupied_score:score,...(transfer()?{calibrated_occupied_score:calibratedSets[current].get(id)}:{}),prediction:Number(score>=.5),review_state:stateOf(id,score),dataset_label:r.label};});out.failures=[...failures].map(([id,error])=>({id,error}));out.evidence_failures=[...evidenceFailures].map(([id,error])=>({id,image:samples.get(id).image,error}));out.scope='停车位占用分类；真实历史快照；非连续视频，不判断违停或停留时长。';return out;}
function saveReview(advance){
 if(!selected||running)return;
 // A rejected save must also hold the current snapshot for corrections.
 stopPlayback();
 const savedId=selected,sample=samples.get(savedId);
 try{
  const record={decision:$('parking-decision').value,note:$('parking-note').value.trim(),at:new Date().toISOString()};
  const evidence=$('parking-evidence-image');
  if(record.decision!=='pending'&&!record.note)throw new Error('请填写复核说明（判断依据）后再保存。');
  if(['free','busy'].includes(record.decision)&&(!evidence||evidence.dataset.evidenceSampleId!==savedId||!evidence.complete||!evidence.naturalWidth))throw new Error('复核原图尚未成功载入，不能保存明确空闲或占用。请重试原图，或记录“无法判断”及原因。');
  // Validate the whole export before applying the decision or advancing the queue.
  serializeParkingReview(reviewDocument({...reviews,[savedId]:record}),context());
  const previous=reviews[savedId];reviews[savedId]=record;drafts.delete(savedId);changed=true;
  if(previous&&(previous.decision!==record.decision))invalidateOnsite(sample.camera,savedId);
  if(advance){selected=nextParkingReviewId(currentRows(),reviews,savedId);$('parking-filter').value='review';}
  render();
  const summary=parkingReviewSummary(currentRows(),reviews),remaining=summary.pending+summary.needs_evidence;
  const next=samples.get(selected);
  let message=`已保存 ${walltime(sample)} · ${sample.camera}:${sample.slot}：${humanLabels[record.decision]}。`;
  if(!remaining)message+='当前快照人工复核已全部完成。';
  else if(advance&&selected===savedId)message+=record.decision==='uncertain'?'其余车位已确认，此车位仍需补证据。':'其余车位已确认，此车位仍待人工复核。';
  else message+=`当前快照还剩 ${remaining} 个待人工复核。${next&&selected!==savedId?`现查看 ${next.camera}:${next.slot}。`:''}`;
  reviewNotice(message);notice(`${message}离开前请导出。`);
  if(advance&&matchMedia('(max-width:650px)').matches)document.querySelector('.parking-review')?.scrollIntoView({block:'start'});
 }catch(e){reviewNotice(`保存失败：${e.message}`,true);notice(e.message,true);}
}
$('parking-save').addEventListener('click',()=>saveReview(false));
$('parking-save-next').addEventListener('click',()=>saveReview(true));
$('parking-export').addEventListener('click',()=>{if(!manifest)return;try{if(drafts.size)throw new Error('还有未保存的车位草稿，请先保存复核记录。');const payload=serializeParkingReview(reviewDocument(),context());download('estateguard-parking-review.json',payload);changed=false;notice('已导出模型版本、样本来源、预测、原始标签和人工结论。');}catch(e){notice(e.message,true);}});
// Import only validated human decisions; never trust imported model predictions as new inference.
const importLabel=document.createElement('label');importLabel.className='button file-button';importLabel.textContent='恢复车位复核';const importer=document.createElement('input');importer.type='file';importer.accept='.json,application/json';importer.id='parking-import';importLabel.append(importer);$('parking-export').before(importLabel);
importer.addEventListener('change',async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;const ticket=++importSequence;try{if(file.size>MAX_PARKING_REVIEW_BYTES)throw new Error('复核文件超过 32 MiB');await loadData();if(ticket!==importSequence)return;const data=JSON.parse(await file.text());if(ticket!==importSequence)return;const next=importParkingReview(data,context());if((changed||drafts.size)&&!confirm('恢复将替换本页人工记录。请先导出已有记录。继续恢复？'))return;for(const key of Object.keys(reviews))delete reviews[key];Object.assign(reviews,next);drafts.clear();changed=false;const cleared=clearOnsite();reviewNotice(`人工复核已恢复，待办和进度已按保存的结论重新计算。${cleared?'原有现场自适应与阈值已清除，需按恢复后的结论重新设置。':''}`);render();notice('已恢复人工复核。模型预测将通过当前模型重新分析，不采用导入文件中的分数。');}catch(e){if(ticket===importSequence)notice(`恢复失败：${e.message}`,true);}});
$('parking-upload').addEventListener('change',async e=>{const file=e.target.files[0],ticket=++uploadSequence;e.target.value='';if(!file)return;let url;try{if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw new Error('请选择不超过 10 MB 的 JPEG、PNG 或 WebP 单车位裁剪图');$('parking-upload-result').textContent='正在分析本地车位图片…';uploadPending=true;await loadCore();url=URL.createObjectURL(file);const key=current;let html;
 if(key==='mlp32'){const data=await pixels(url);if(ticket!==uploadSequence){URL.revokeObjectURL(url);return;}const score=predictPatch(data,model);html=`<p>${labels[classifyScore(score)]} · 占用分数 ${(score*100).toFixed(2)}% · MLP32</p>`;}
 else{const encoder=await ensureEncoder(key),bitmap=await decodeImage(url);let z;try{z=await encoder.embed(bitmap);}finally{bitmap.close();}if(ticket!==uploadSequence){URL.revokeObjectURL(url);return;}const {score,calibrated}=predictHead(z,heads[key]);html=`<p>${calibrated>=.5?'倾向占用':'倾向空闲'} · 校准后占用概率 ${(calibrated*100).toFixed(2)}%（未校准 ${(score*100).toFixed(2)}%）· ${text(ENCODERS[key].label)}</p><p class="subtle">新画面没有现场风险校准，按规则应送人工复核。</p>`;}
 if(uploadURL)URL.revokeObjectURL(uploadURL);uploadURL=url;$('parking-upload-result').innerHTML=`<img src="${url}" alt="本地单车位裁剪图"><strong>${text(file.name)}</strong>${html}<p class="subtle">新场景结果未经验证，没有数据集标签可对照。不是违规判断。</p>`;}catch(e){if(url)URL.revokeObjectURL(url);if(ticket===uploadSequence)$('parking-upload-result').textContent=e.name==='AbortError'?'模型加载已停止，可重新选择图片。':e.message;}finally{if(ticket===uploadSequence)uploadPending=false;}});
window.addEventListener('beforeunload',e=>{if(changed||drafts.size){e.preventDefault();e.returnValue='';}});
const errorFilters=()=>({type:$('parking-error-type').value,slot:$('parking-error-slot').value});
function updateErrorFilters(){
 const matches=filterParkingAudit(errorAudit,errorFilters()),select=$('parking-error-example');
 select.replaceChildren(new Option(matches.length?`选择错例并重新推理（${matches.length} 张）`:'当前组合没有错例',''));
 for(const r of matches)select.add(new Option(`${r.camera}:${r.slot} · ${formatDate(r.date)} ${r.time.slice(0,2)}:${r.time.slice(2)} · 标注${r.label?'占用':'空闲'} / 预测${r.prediction?'占用':'空闲'} · 分数 ${(r.score*100).toPrecision(3)}%`,r.id));
 select.disabled=!matches.length;
 $('parking-error-count').textContent=`当前筛选 ${matches.length} / 全部 ${errorAudit.summary.errors} 张错例。${matches.length?'选择样本将前往原图，并用当前模型重新分析所在快照。':'当前组合没有匹配，不代表其他车位没有错误。'}`;
 $('parking-error-status').classList.remove('error');
 $('parking-error-status').textContent='当前清单来自冻结模型的离线评测；导出含模型、预测文件和原图校验值。人工复核请在巡检页单独导出。';
}
async function openAuditSample(id){
 if(!id)return;const r=samples.get(id),ticket=++errorJumpSequence;
 // The audit lists MLP32's frozen errors, so re-inference uses MLP32; other models stay one switch away.
 if(current!=='mlp32'&&running){const message='车位巡检正在用其他模型分析，请先停止或等待完成，再打开 MLP32 错例。';notice(message,true);$('parking-error-status').classList.add('error');$('parking-error-status').textContent=message;$('parking-error-example').value='';return;}
 if(current!=='mlp32'){modelChosenByUser=true;current='mlp32';predictions=sets.mlp32;$('parking-model-choice').value='mlp32';updateModelBar();modelNotice('错例清单来自 MLP32 基线，已切换到 MLP32 用真实像素重新推理；可切换其他模型对比同一车位。');reviewNotice('已切换到 MLP32 重新推理此错例；可在“占用模型”中切换对比。');}
 $('parking-session').value=`${r.camera}-${r.date}`;setSession();
 frameIndex=frames.findIndex(f=>f.sample_ids.includes(id));$('parking-filter').value='all';$('parking-show-truth').checked=true;selected=id;
 location.hash='parking';render();await runCurrent();
 if(ticket!==errorJumpSequence||selected!==id||location.hash!=='#parking')return;
 const grid=$('parking-grid'),tile=[...grid.querySelectorAll('.parking-tile')].find(el=>el.dataset.sampleId===id);
 if(tile){const g=grid.getBoundingClientRect(),t=tile.getBoundingClientRect();if(t.top<g.top)grid.scrollTop-=g.top-t.top+2;else if(t.bottom>g.bottom)grid.scrollTop+=t.bottom-g.bottom+2;}
 if(matchMedia('(max-width:650px)').matches)document.querySelector('.parking-review')?.scrollIntoView({block:'start'});
}
function renderErrorAudit(){
 const a=errorAudit;
 $('parking-error-picker').innerHTML=`<div class="parking-error-controls"><label class="field">错误类型<select id="parking-error-type"><option value="all">全部错误</option><option value="false_free">有车却报空闲</option><option value="false_occupied">空位却报占用</option><option value="low_score_false_free">有车却报空闲 · 分数 ≤ 0.35</option></select></label><label class="field">摄像头 / 车位<select id="parking-error-slot"><option value="all">全部车位</option></select></label></div><p id="parking-error-count" class="subtle" role="status" aria-live="polite"></p><label class="field">错误样本<select id="parking-error-example" aria-label="选择完整测试集中的错误样本"></select></label><div class="toolbar"><button id="parking-error-export" class="button" type="button">导出当前错例清单</button></div><p id="parking-error-status" class="subtle" role="status" aria-live="polite">以下是冻结模型的离线评测，不会写入人工结论。清单含模型、预测文件与原图校验值；人工复核请在巡检页单独导出。</p><p class="subtle">0.35–0.65 的不确定区间仅包含 ${a.summary.band_errors} / ${a.summary.errors} 张错例；区间外仍有 ${a.summary.outside_band_errors} 张错误，其中 ${a.summary.low_score_false_free} 张有车却被低分报空闲。仅复核“不确定”会漏掉这些问题。</p><details><summary>按车位排查 · 错报空闲最多的前 10 个车位</summary><p class="subtle">漏判比例以该车位原始占用标签数为分母。仅用于定位此公开测试集的失败点，不代表其他小区表现。</p><div class="table-wrap"><table><thead><tr><th>摄像头 / 车位</th><th>有车报空闲</th><th>空位报占用</th><th>占用漏判比例</th></tr></thead><tbody>${a.groups.slice(0,10).map(g=>`<tr><td><button type="button" class="button parking-error-group" data-slot="${text(g.key)}">${text(g.camera)}:${text(g.slot)}</button></td><td>${g.false_free}</td><td>${g.false_occupied}</td><td>${g.false_free} / ${g.occupied}${g.false_free_rate===null?'':`（${(g.false_free_rate*100).toFixed(1)}%）`}</td></tr>`).join('')}</tbody></table></div></details>`;
 for(const g of a.groups)$('parking-error-slot').add(new Option(`${g.camera}:${g.slot}`,g.key));
 for(const id of ['parking-error-type','parking-error-slot'])$(id).addEventListener('change',updateErrorFilters);
 $('parking-error-example').addEventListener('change',event=>openAuditSample(event.target.value).catch(error=>notice(error.message,true)));
 for(const button of document.querySelectorAll('.parking-error-group'))button.addEventListener('click',()=>{$('parking-error-type').value='false_free';$('parking-error-slot').value=button.dataset.slot;updateErrorFilters();$('parking-error-example').focus();});
 $('parking-error-export').addEventListener('click',()=>{try{download('estateguard-parking-error-audit.json',exportParkingAudit(a,errorFilters(),errorPredictionsHash));$('parking-error-status').classList.remove('error');$('parking-error-status').textContent='已导出当前筛选的离线错例及来源校验值，不包含本次推理与人工结论。';}catch(error){$('parking-error-status').classList.add('error');$('parking-error-status').textContent=error.message;}});
 updateErrorFilters();
}
async function loadErrorAudit(){
 const button=$('parking-load-errors'),status=$('parking-error-status');button.disabled=true;status.classList.remove('error');status.textContent='正在核对完整预测记录、样本与模型版本…';
 try{
  await loadData();const response=await fetch(new URL('test-predictions.json',base));if(!response.ok)throw new Error(`错例资源加载失败 (${response.status})`);
  const bytes=await response.arrayBuffer(),next=buildParkingAudit(manifest,JSON.parse(new TextDecoder().decode(bytes)));
  if(next.summary.total!==evaluation.test.n||next.summary.false_free!==evaluation.test.false_free||next.summary.false_occupied!==evaluation.test.false_occupied)throw new Error('错例汇总与完整评测不一致，请重试。');
  errorPredictionsHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');errorAudit=next;renderErrorAudit();
 }catch(error){button.disabled=false;button.textContent='重试加载完整错例';status.classList.add('error');status.textContent=`加载失败：${error.message}`;}
}
async function renderEvaluation(){
 const e=evaluation;if(!e)return;const pct=v=>`${(v*100).toFixed(1)}%`;const s=e.splits,m=e.test.confusion_matrix;
 $('parking-evaluation-content').innerHTML=`<p><strong>本项目实际训练：${text(e.model_name)}</strong> · ${e.parameter_count.toLocaleString()} 个参数 · 种子 ${e.seed}</p><p class="training-history">固定比较线性分类器与 32 隐藏单元神经网络，各训练 ${e.epochs_per_candidate} 轮，按验证损失选模；最终第 ${e.selected_epoch} 轮。未微调原 COCO 检测器。</p><div class="table-wrap"><table><thead><tr><th>分区</th><th>样本 / 原始帧</th><th>摄像头</th><th>日期与时间范围</th></tr></thead><tbody>${[['训练','train'],['间隔排除','gap'],['验证','validation'],['测试','test']].map(([label,k])=>`<tr><td>${label}</td><td>${s[k].count} / ${s[k].frames}</td><td>${s[k].cameras.join(', ')}</td><td>${s[k].first} → ${s[k].last}</td></tr>`).join('')}</tbody></table></div><p class="subtle">${s.duplicate_excluded.count} 张跨分区完全重复图片被排除。只有一个停车场、两个摄像头；不代表新小区或新天气表现。</p><div class="metrics">${[['完整测试样本',e.test.n],['分类正确率',pct(e.test.accuracy)],['平衡正确率',pct(e.test.balanced_accuracy)],['占用召回率',pct(e.test.occupied_recall)]].map(([k,v])=>`<div class="metric"><strong>${v}</strong><span>${k}</span></div>`).join('')}</div><p>多数类基线正确率 ${pct(e.majority_baseline.accuracy)}。预测空闲但实际占用 <strong>${e.test.false_free}</strong> 张；预测占用但实际空闲 <strong>${e.test.false_occupied}</strong> 张。${e.review_samples} 张分数落在待复核区间，明确预测中仍有 ${e.confident_false_free} 张错误空闲判断。</p><div class="table-wrap"><table><thead><tr><th>原始标签 / 预测</th><th>空闲</th><th>占用</th></tr></thead><tbody><tr><th>空闲</th><td>${m[0][0]}</td><td>${m[0][1]}</td></tr><tr><th>占用</th><td>${m[1][0]}</td><td>${m[1][1]}</td></tr></tbody></table></div><p class="subtle">混淆矩阵采用 0.5 分类阈值；巡检页另将 0.35–0.65 标为待复核。所有测试样本均计入，未删除错例。</p><div id="parking-error-picker"><button id="parking-load-errors" class="button" type="button">浏览完整测试集错例</button></div><p><a href="data/parking/evaluation.json">完整评测 JSON</a> · <a href="data/parking/test-predictions.json">逐样本预测与全部错例</a> · <a href="https://github.com/leon1111-wgl/estateguard/blob/main/docs/PARKING_DATA.md">数据、训练与复现说明 ↗</a></p><p class="subtle">数据来自 <a href="http://cnrpark.it/">CNRPark / Amato 等</a>，按 <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a> 提供。历史图片不构成连续停车或违停证据。</p>`;
 const status=document.createElement('p');status.id='parking-error-status';status.className='subtle';status.setAttribute('role','status');status.setAttribute('aria-live','polite');$('parking-error-picker').append(status);
 $('parking-load-errors').addEventListener('click',loadErrorAudit);
}
// Comparison tables come straight from the published evaluation JSON; nothing is recomputed or rounded upstream.
function renderTransferEvaluation(){
 const e=transferEvaluation,box=$('parking-transfer-content');if(!box)return;
 if(!e){box.innerHTML='<p class="subtle">迁移模型评测记录未加载；MLP32 基线不受影响。</p>';return;}
 const p1=v=>v==null?'—':`${(v*100).toFixed(1)}%`,p2=v=>v==null?'—':`${(v*100).toFixed(2)}%`,keys=['mobilenet','dinov2'].filter(k=>e.models[k]),ext=!!e.cnr_ext;
 const name=k=>k==='mlp32'?'MLP32 基线':e.models[k].name,tbl=(head,rows)=>`<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((c,i)=>i?`<td>${c}</td>`:`<th>${c}</th>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 const extOf=k=>k==='mlp32'?e.cnr_ext?.mlp32:e.models[k].cnr_ext?.transfer,bOf=k=>k==='mlp32'?e.cnrpark_b_baseline.mlp32:e.models[k].cnrpark_b.transfer;
 const overview=[['多数类（全部报占用）','0','—',p1(e.cnrpark_b_baseline.majority_busy.balanced_accuracy),...(ext?[p1(e.cnr_ext.majority_busy.accuracy),p1(e.cnr_ext.majority_busy.balanced_accuracy),p1(e.cnr_ext.majority_busy.false_free_rate),p1(e.cnr_ext.majority_busy.false_occupied_rate)]:[]),'—'],
  ['MLP32 基线','7,745','—',p1(bOf('mlp32').balanced_accuracy),...(ext?[p1(extOf('mlp32').accuracy),p1(extOf('mlp32').balanced_accuracy),p1(extOf('mlp32').false_free_rate),p1(extOf('mlp32').false_occupied_rate)]:[]),'约 1 ms'],
  ...keys.map(k=>{const m=e.models[k],x=extOf(k);return [`${text(m.name)}${e.default_model.encoder===k?'（默认）':''}`,m.parameter_count.toLocaleString(),p1(m.validation.balanced_accuracy),p1(bOf(k).balanced_accuracy),...(ext?[p1(x?.accuracy),p1(x?.balanced_accuracy),p1(x?.false_free_rate),p1(x?.false_occupied_rate)]:[]),`${m.feature_extraction.per_patch_ms_median} ms`];})];
 let html=`<p><strong>同一停车场，三种占用模型</strong> · 训练只用 CNRPark A；B 已在错例审查中查看，只作开发比较；默认模型在 EXT 评分前按 B 平衡正确率确定为 ${text(name(e.default_model.encoder))}。</p>`;
 html+=tbl(['模型','可训练参数','A 验证 · 平衡正确率','B 开发 · 平衡正确率',...(ext?['EXT · 正确率','EXT · 平衡正确率','EXT · 有车报空闲','EXT · 空位报占用']:[]),'单张编码耗时'],overview);
 html+=`<p class="subtle">A 验证与训练同一视角，接近满分不代表跨视角可靠。“有车报空闲”以实际占用数为分母，“空位报占用”以实际空闲数为分母。耗时为本机 Chrome 离线提取时的单张中位数：DINOv2 单线程 WASM、8 个页面并发，MobileNetV2 WebGL；提取期间机器满载，单独运行通常更快，不同设备也会不同。</p>`;
 if(!ext)html+='<p class="message">CNR-EXT 保留测试结果尚未生成；下面只含 A 验证与 B 开发比较。</p>';
 if(ext){
  const src=e.cnr_ext.source;
  html+=`<h3>CNR-EXT 保留测试 · ${src.count.toLocaleString()} 张，9 个新视角，${src.dates.length} 个日期</h3>`;
  html+=tbl(['天气','样本','MLP32',...keys.map(k=>text(e.models[k].name))],['sunny','overcast','rainy'].map(w=>[{sunny:'晴',overcast:'阴',rainy:'雨'}[w],src.weather[w].toLocaleString(),p1(e.cnr_ext.mlp32_by_weather[w].balanced_accuracy),...keys.map(k=>p1(e.models[k].cnr_ext?.by_weather[w].transfer.balanced_accuracy))]));
  html+=`<details><summary>按摄像头查看平衡正确率</summary>${tbl(['摄像头','样本','MLP32',...keys.map(k=>text(e.models[k].name))],Object.keys(src.cameras).sort().map(c=>[c,src.cameras[c].toLocaleString(),p1(e.models[keys[0]].cnr_ext?.by_camera[c].mlp32.balanced_accuracy),...keys.map(k=>p1(e.models[k].cnr_ext?.by_camera[c].transfer.balanced_accuracy))]))}</details>`;
 }
 const route=r=>r?`${p1(r.coverage)} 自动 · 判空闲错 ${p2(r.auto_free_error_rate)} · 判占用错 ${p2(r.auto_busy_error_rate)}`:'—';
 html+=`<h3>风险可控分流：训练视角的阈值能否带到新视角</h3><p class="subtle">失败基线：在 A 验证集按逐样本 Learn then Test（Bonferroni，Clopper–Pearson 上界，95% 置信）选阈值，目标为自动判空闲中错误 ≤ 1%、自动判占用中错误 ≤ 2%。同一车位连续快照并不独立，这一保证本身偏乐观；网页不把它用于任何摄像头。</p>`;
 html+=tbl(['模型','A 验证阈值','A 验证（校准集本身）','B 开发',...(ext?['EXT 保留测试']:[])],keys.map(k=>{const m=e.models[k];return [text(m.name),`≤ ${m.routing.t_free??'—'} / ≥ ${m.routing.t_busy??'—'}`,route(m.validation_routing),route(m.cnrpark_b.routing),...(ext?[route(m.cnr_ext?.routing)]:[])];}));
 // On-site recalibration: earliest 20% of each camera's snapshots as the labelled pool, last 70% as evaluation.
 // Each camera is judged on its own: a pooled rate can hide cameras that break the target.
 const agg=(list,a,rule)=>{const g={cams:list.length,pass:0,eligible:0,n:0,af:0,ff:0,ab:0,fb:0,freeCams:0,freeOver:0,uf:0,ufe:0};for(const x of list){const o=x.onsite[a][rule],r=o.eval;g.n+=r.n;g.af+=r.auto_free;g.ff+=r.auto_free_errors;g.ab+=r.auto_busy;g.fb+=r.auto_busy_errors;if(o.t_free!=null||o.t_busy!=null)g.pass++;if(rule==='naive'||o.eligible)g.eligible++;if(o.t_free!=null&&r.auto_free){g.freeCams++;const units=r.auto_free_units??r.auto_free,bad=r.auto_free_units_with_error??r.auto_free_errors;g.uf+=units;g.ufe+=bad;if(bad/units>Number(a))g.freeOver++;}}return g;};
 const cell=(g,rule)=>`${rule==='unit'?`跨天合格 ${g.eligible}/${g.cams} · `:''}得到阈值 ${g.pass}/${g.cams} · 自动 ${p1(g.n?(g.af+g.ab)/g.n:null)} · 判空闲错 ${g.af?`${p1(g.ff/g.af)}（${g.ff}/${g.af}）`:'—'}${g.freeCams?` · 空闲侧超标相机 ${g.freeOver}/${g.freeCams}，车位·日出错 ${p1(g.ufe/g.uf)}（${g.ufe}/${g.uf}）`:''}`;
 const onsiteRows=[];for(const k of keys)for(const [label,list] of [['B（1 个日期）',[e.models[k].cnrpark_b.adaptation]],...(ext?[['EXT 9 个摄像头合计',Object.values(e.models[k].cnr_ext?.adaptation||{})]]:[])])for(const a of ['0.01','0.02','0.05'])if(list[0]?.onsite?.[a])onsiteRows.push([text(e.models[k].name),label,`≤ ${Number(a)*100}%`,cell(agg(list,a,'naive'),'naive'),cell(agg(list,a,'unit'),'unit')]);
 html+=`<h3>现场重校准：用本相机最早 20% 时段的标注，检验最后 70% 时段</h3><p class="subtle">逐样本规则把每张快照算作独立证据（失败基线）；网页采用的“车位·日”规则把同一车位同一天的快照只算一次，并要求标注覆盖至少 2 个日期。“判空闲错”为评测段自动判空闲中实际有车的比例；“超标相机”按单个摄像头的车位·日出错比例与目标比较。即使按车位·日检验通过，冬季后续月份仍有多数相机的空闲侧超标，阈值必须配合抽检与重新校准。</p>`+tbl(['模型','数据','错报空闲目标','逐样本规则（失败基线）','车位·日规则（网页采用）'],onsiteRows);
 const curve=(k,where)=>{const sets=where==='b'?[e.models[k].cnrpark_b.adaptation]:Object.values(e.models[k].cnr_ext?.adaptation||{});if(!sets.length)return null;return sets[0].curve.map((c,i)=>{const vals=sets.map(x=>x.curve[i].balanced_accuracy.mean),sds=sets.map(x=>x.curve[i].balanced_accuracy.sd);return {k:c.k,mean:vals.reduce((a,b)=>a+b,0)/vals.length,sd:sds.reduce((a,b)=>a+b,0)/sds.length};});};
 const ks=e.models[keys[0]].cnrpark_b.adaptation.curve.map(c=>c.k);
 html+=`<h3>新相机少样本自适应（L2-SP，本机计算）</h3><p class="subtle">每个相机按时间切分：最早 20% 时段为标注池，随后 10% 不用，最后 70% 评测。从池中随机抽 k 张作为人工结论，各重复 10 次；表中为评测段平衡正确率均值（± 标准差${ext?'；EXT 为 9 个摄像头的平均':''}）。</p>`;
 html+=tbl(['人工结论 k',...keys.flatMap(k=>[`${text(e.models[k].name)} · B`,...(ext?[`${text(e.models[k].name)} · EXT`]:[])])],ks.map((kk,i)=>[String(kk),...keys.flatMap(k=>{const b=curve(k,'b')[i],x=ext?curve(k,'ext')?.[i]:null;return [`${p1(b.mean)}${kk?` ± ${(b.sd*100).toFixed(1)}`:''}`,...(ext?[x?`${p1(x.mean)}${kk?` ± ${(x.sd*100).toFixed(1)}`:''}`:'—']:[])];})]));
 html+=`<p class="subtle">EXT 与训练数据同一停车场、同一批作者采集，不能证明在其他小区、夜间或不同相机型号上的表现。图片是重复拍摄的历史快照，样本不等于独立车辆。</p><p><a href="data/parking-transfer/evaluation.json">完整评测 JSON</a>${ext?` · <a href="https://github.com/leon1111-wgl/estateguard/blob/main/docs/validation/parking-ext-predictions.csv.gz">EXT 全部逐样本分数</a>`:''} · <a href="https://github.com/leon1111-wgl/estateguard/blob/main/docs/PARKING_DATA.md">数据、训练与复现说明 ↗</a></p>`;
 box.innerHTML=html;
}
// On-site calibration and few-shot adaptation use human-confirmed decisions only, per camera and model.
// Evidence is counted per camera·slot·date (protocol appendix 3): repeated snapshots of one parked car are not independent.
function cameraReviews(camera,key=current,exclude=new Set()){const out=[];for(const [id,r] of Object.entries(reviews)){const sample=samples.get(id);if(!sample||sample.camera!==camera||!['free','busy'].includes(r.decision)||exclude.has(id)||!embeddings[key]?.has(id))continue;out.push([id,r.decision==='busy'?1:0]);}return out;}
const unitOf=id=>{const r=samples.get(id);return `${r.camera}|${r.slot}|${r.date}`;};
const riskTarget=()=>{const alpha=Number($('parking-risk-target').value);return {alpha_free:alpha,alpha_busy:Math.min(.2,alpha*2)};};
const modelNotice=(s,error=false)=>{$('parking-model-message').textContent=s;$('parking-model-message').classList.toggle('error',error);};
const pct=v=>v==null?'—':`${(v*100).toFixed(1)}%`;
let encoderBytes={};
function rescoreCamera(camera,key=current){for(const id of embeddings[key].keys())if(samples.get(id)?.camera===camera)scoreSample(id,key);}
// Any change to the evidence behind an adaptation or a threshold voids it for every model.
function invalidateOnsite(camera,id){let voided=false;for(const key of ['mobilenet','dinov2']){const a=adaptations[key][camera],o=onsiteRouting[key][camera];if(a?.used.has(id)){delete adaptations[key][camera];delete onsiteRouting[key][camera];rescoreCamera(camera,key);voided=true;}else if(o?.ids.includes(id)){delete onsiteRouting[key][camera];voided=true;}}if(voided)modelNotice(`已修改用于自适应或校准的人工结论，摄像头 ${camera} 的相关现场设置已作废，请重新设置。`);return voided;}
function clearOnsite(){let any=false;for(const key of ['mobilenet','dinov2']){for(const camera of Object.keys(adaptations[key])){delete adaptations[key][camera];rescoreCamera(camera,key);any=true;}if(Object.keys(onsiteRouting[key]).length)any=true;onsiteRouting[key]={};}if(any)modelNotice('已清除全部现场自适应与阈值。');return any;}
function updateModelPanel(){
 const panel=$('parking-onsite');if(!panel||!model)return;
 const e=transferEvaluation?.models?.[current],camera=frames[frameIndex]?.camera;
 for(const option of $('parking-model-choice').options){const base=option.dataset.label||(option.dataset.label=option.textContent),notes=[transferEvaluation?.default_model?.encoder===option.value?'默认':'',encoderBytes[option.value]&&!encoders[option.value]?`首次约 ${mib(encoderBytes[option.value])} MiB`:''].filter(Boolean);option.textContent=`${base}${notes.length?`（${notes.join('，')}）`:''}`;}
 const uncertainOption=$('parking-filter').querySelector('option[value="model_uncertain"]');if(uncertainOption)uncertainOption.textContent=transfer()?'模型送人工复核或未分析':'模型不确定或未分析';
 const size=encoderBytes[current]&&!encoders[current]?`首次分析需从本站下载约 ${mib(encoderBytes[current])} MiB 公共模型资源，之后复用缓存。`:'';
 $('parking-model-help').textContent=transfer()?`${ENCODERS[current].label}：${ENCODERS[current].detail}。${e?.cnr_ext?`CNR-EXT 保留测试平衡正确率 ${pct(e.cnr_ext.transfer.balanced_accuracy)}，`:'CNR-EXT 保留测试待评测；'}B 开发比较 ${pct(e?.cnrpark_b?.transfer?.balanced_accuracy)}。${size}`:'MLP32：原 32×32 像素特征小模型，保留为基线；0.35–0.65 标为不确定。不支持现场校准与自适应。';
 panel.hidden=!transfer();if(!transfer()||!camera)return;
 const ad=adaptations[current][camera],route=onsiteRouting[current][camera],all=cameraReviews(camera),fresh=cameraReviews(camera,current,ad?.used),target=riskTarget(),need=minimumEvidence(target.alpha_free,.05/(2*15));
 const busyCount=all.filter(x=>x[1]).length,dates=new Set(fresh.map(([id])=>samples.get(id).date)).size,units=new Set(fresh.map(([id])=>unitOf(id))).size;
 let status=`摄像头 ${camera}：已人工确认且已分析 ${all.length} 条（占用 ${busyCount} / 空闲 ${all.length-busyCount}）。`;
 const shadow=ad?fresh:all;if(shadow.length){let ff=0,fo=0;for(const [id,y] of shadow){const p=calibratedSets[current].get(id);if(y&&p<.5)ff++;if(!y&&p>=.5)fo++;}status+=`影子对比（模型 0.5 阈值 vs 人工${ad?`，不含自适应用过的 ${ad.n} 条`:''}，${shadow.length} 条）：有车报空闲 ${ff} 条，空位报占用 ${fo} 条。`;}
 if(ad)status+=`已用其中 ${ad.n} 条做自适应；校准只用之后新确认的 ${fresh.length} 条。`;
 if(route){const r=route.routing;status+=certified(r)?`在校准数据上通过检验（${r.calibration_units} 个车位·日，${route.dates} 个日期）：${r.t_free!=null?`校准概率 ≤ ${r.t_free} 自动判空闲`:'空闲侧未通过'}；${r.t_busy!=null?`≥ ${r.t_busy} 自动判占用`:'占用侧未通过'}。离线回放中这类阈值到后续季节有多数相机空闲侧超标，自动判定需抽检、画面变化时重新校准。`:`最近一次检验：${route.reason}，仍全部送人工。`;}
 else status+=`尚未校准，全部送人工。检验以“车位·日”计数，需覆盖至少 2 个日期；要通过错报空闲 ≤ ${target.alpha_free*100}%，至少需要约 ${need} 个无错的车位·日（当前可用 ${units} 个、${dates} 个日期）。`;
 if(!all.length)status+='保存本摄像头的空闲/占用结论（需填写说明）后，可校准或自适应。';
 $('parking-onsite-status').textContent=status;
 $('parking-calibrate').disabled=running||!fresh.length;$('parking-adapt').disabled=running||!all.length;$('parking-adapt-reset').disabled=running||!ad&&!route;
}
$('parking-model-choice').addEventListener('change',()=>{if(running)return;modelChosenByUser=true;current=$('parking-model-choice').value;predictions=sets[current];updateModelBar();modelNotice('');render();const n=currentRows().filter(r=>predictions.has(r.id)).length;notice(`已切换到 ${current==='mlp32'?'MLP32 基线':ENCODERS[current].label}。${n?`当前快照已有 ${n} 个该模型的结果。`:'请点击“分析当前快照”运行该模型。'}各模型结果分别保留，人工结论不受影响。`);});
$('parking-risk-target').addEventListener('change',()=>{const had=['mobilenet','dinov2'].some(key=>Object.values(onsiteRouting[key]).some(o=>certified(o.routing)));for(const key of ['mobilenet','dinov2'])onsiteRouting[key]={};modelNotice(had?'风险目标已改变，所有模型已通过的阈值作废，请重新校准。':'');render();});
$('parking-calibrate').addEventListener('click',()=>{try{
 const camera=frames[frameIndex].camera,ad=adaptations[current][camera],items=cameraReviews(camera,current,ad?.used);if(!items.length)throw new Error('当前摄像头还没有可用于校准的人工确认结论。');
 const dates=new Set(items.map(([id])=>samples.get(id).date)).size,target=riskTarget();
 let routing;let reason='';
 if(dates<2){routing={t_free:null,t_busy:null,...target,calibration_n:items.length,calibration_units:new Set(items.map(([id])=>unitOf(id))).size,unit:'camera-slot-date'};reason=`人工结论只来自 ${dates} 个日期，单日数据不能代表其他时段`;}
 else{routing=selectRouting(items.map(([id])=>calibratedSets[current].get(id)),items.map(x=>x[1]),{...target,units:items.map(([id])=>unitOf(id))});reason=`${routing.calibration_units} 个车位·日的证据不足以通过目标`;}
 onsiteRouting[current][camera]={routing,ids:items.map(x=>x[0]),dates,reason,at:new Date().toISOString()};changed=true;render();
 modelNotice(certified(routing)?`已用 ${items.length} 条人工结论（${routing.calibration_units} 个车位·日，${dates} 个日期）在校准数据上通过检验；本相机按阈值自动判定，其余送人工。这不保证以后的画面，请抽检并在条件变化时重新校准。`:`已检验 ${items.length} 条人工结论：${reason}，继续全部送人工。`);
}catch(e){modelNotice(e.message,true);}});
$('parking-adapt').addEventListener('click',()=>{try{
 const camera=frames[frameIndex].camera,items=cameraReviews(camera);if(!items.length)throw new Error('当前摄像头还没有已分析且人工确认的车位。');
 const head=heads[current],result=adaptHead(items.map(([id])=>standardize(embeddings[current].get(id),head)),items.map(x=>x[1]),head);
 adaptations[current][camera]={...result,used:new Set(items.map(x=>x[0])),at:new Date().toISOString()};delete onsiteRouting[current][camera];rescoreCamera(camera);changed=true;render();
 modelNotice(`已用摄像头 ${camera} 的 ${result.n} 条人工结论（占用 ${result.busy} / 空闲 ${result.n-result.busy}）在本机自适应分类头，并重新计算本相机已分析车位。${result.busy===0||result.busy===result.n?'样本只含一种结论，偏差风险高。':''}原阈值已作废；请用之后新确认的结论重新校准。`);
}catch(e){modelNotice(e.message,true);}});
$('parking-adapt-reset').addEventListener('click',()=>{const camera=frames[frameIndex]?.camera;if(!camera)return;delete adaptations[current][camera];delete onsiteRouting[current][camera];rescoreCamera(camera);render();modelNotice(`已清除摄像头 ${camera} 的现场自适应与校准，恢复源模型，全部送人工。`);});
async function enter(){try{if(location.hash==='#parking')await loadData();else {stopPlayback();if(location.hash==='#results')await loadCore();}}catch(e){notice(e.message,true);$('parking-model-status').textContent='加载失败，可重试';$('parking-evaluation-content').textContent=`训练记录加载失败：${e.message}`;}}
window.addEventListener('hashchange',enter);enter();
