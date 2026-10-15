import {predictPatch,classifyScore,frameSummary,parkingReviewSummary,filterParkingRows,nextParkingReviewId,exportParkingReview,importParkingReview,serializeParkingReview,MAX_PARKING_REVIEW_BYTES} from './parking-model.mjs';
const $=id=>document.getElementById(id);
const text=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={free:'空闲',busy:'占用',uncertain:'模型不确定',pending:'未分析'};
const humanLabels={free:'已确认空闲',busy:'已确认占用',uncertain:'需补证据',pending:'待人工复核'};
const base=new URL('./data/parking/',import.meta.url);
let model=null,evaluation=null,manifest=null,corePromise=null,dataPromise=null,samples=new Map(),frames=[],frameIndex=0,selected=null,running=false,playTimer=null,playSequence=0,cancelled=false,uploadSequence=0,importSequence=0,uploadURL=null,changed=false,analysisPromise=null,analysisFrameId=null,analysisSequence=0;
const predictions=new Map(),failures=new Map(),reviews={},drafts=new Map();
const notice=(s,error=false)=>{$('parking-message').textContent=s;$('parking-message').classList.toggle('error',error);};
const reviewNotice=(s,error=false)=>{$('parking-review-message').textContent=s;$('parking-review-message').classList.toggle('error',error);};
const download=(name,value)=>{const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
async function json(url){const r=await fetch(url);if(!r.ok)throw new Error(`资源加载失败 (${r.status})`);return r.json();}
async function loadCore(){
 if(model)return;if(corePromise)return corePromise;
 corePromise=(async()=>{
  $('parking-model-status').textContent='正在加载已训练的占用分类器…';
  const response=await fetch(new URL('./models/parking-occupancy/model.json',import.meta.url));if(!response.ok)throw new Error('分类器加载失败');
  const bytes=await response.arrayBuffer();const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const next=JSON.parse(new TextDecoder().decode(bytes));const report=await json(new URL('evaluation.json',base));
  if(next.format!=='estateguard-parking-mlp'||next.features!==240||report.model_sha256!==sha)throw new Error('模型与评测版本不一致，请刷新后重试');
  model=next;evaluation=report;$('parking-model-status').textContent=`已训练 · ${next.hidden?'32 隐藏单元神经网络':'线性分类器'} · ${(bytes.byteLength/1024).toFixed(0)} KB`;
  $('parking-model-status').previousElementSibling.classList.add('ready');renderEvaluation();
 })().catch(e=>{corePromise=null;throw e;});return corePromise;
}
async function loadData(){
 if(manifest)return;if(dataPromise)return dataPromise;
 dataPromise=(async()=>{
  await loadCore();const next=await json(new URL('manifest.json',base));if(next.model_sha256!==evaluation.model_sha256)throw new Error('样本与模型版本不一致');
  manifest=next;samples=new Map(next.samples.map(r=>[r.id,r]));
  const sessions=[...new Set(next.frames.map(f=>f.session))];$('parking-session').replaceChildren(...sessions.map(s=>{const option=document.createElement('option');option.value=s;const f=next.frames.find(f=>f.session===s);option.textContent=`摄像头 ${f.camera} · ${formatDate(f.date)} · 测试集`;return option;}));
  setSession();$('parking-run').disabled=false;
  notice(`已加载完整测试集：${next.samples.length} 张真实车位图片，${next.frames.length} 个历史快照。点击“分析当前快照”运行模型。`);
 })().catch(e=>{dataPromise=null;manifest=null;$('parking-run').disabled=false;throw e;});return dataPromise;
}
function formatDate(d){return `${d.slice(0,4)}/${d.slice(4,6)}/${d.slice(6,8)}`;}
function walltime(f){return `${formatDate(f.date)} ${f.time.slice(0,2)}:${f.time.slice(2)}`;}
function clockMinutes(f){return Date.UTC(+f.date.slice(0,4),+f.date.slice(4,6)-1,+f.date.slice(6,8),+f.time.slice(0,2),+f.time.slice(2))/60000;}
function currentRows(){return frames[frameIndex]?.sample_ids.map(id=>samples.get(id))||[];}
function stopPlayback(){playSequence++;clearTimeout(playTimer);playTimer=null;$('parking-play').textContent='播放快照';$('parking-play').setAttribute('aria-pressed','false');}
function setSession(){stopPlayback();reviewNotice('');frames=manifest.frames.filter(f=>f.session===$('parking-session').value);frameIndex=0;selected=null;$('parking-frame').max=String(Math.max(0,frames.length-1));render();}
function chooseFrame(index){reviewNotice('');const slot=samples.get(selected)?.slot;frameIndex=Math.max(0,Math.min(frames.length-1,index));selected=currentRows().find(r=>r.slot===slot)?.id||null;render();}
function render(){
 if(!manifest||!frames.length)return;const f=frames[frameIndex],rows=currentRows(),summary=frameSummary(rows,predictions),hasAny=rows.some(r=>predictions.has(r.id));
 $('parking-frame').value=String(frameIndex);$('parking-prev').disabled=running||frameIndex===0;$('parking-next').disabled=running||frameIndex===frames.length-1;
 const delta=frameIndex?clockMinutes(f)-clockMinutes(frames[frameIndex-1]):null;
 $('parking-time').textContent=`${walltime(f)} · 第 ${frameIndex+1} / ${frames.length} 张 · ${delta===null?'首个快照':`距上一张 ${delta} 分钟`} · 数据源当地钟面时间，未声明时区；间隔不证明连续停留。`;
 const items=[['当前快照车位',summary.total],['模型预测空闲',hasAny?summary.free:'—'],['模型预测占用',hasAny?summary.busy:'—'],['模型不确定 / 未分析',hasAny?`${summary.uncertain} / ${summary.pending}`:'—']];
 $('parking-metrics').innerHTML=items.map(([label,value])=>`<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
 const human=parkingReviewSummary(rows,reviews);
 $('parking-review-progress').textContent=`当前快照：已确认 ${human.confirmed} / ${human.total} · 待人工复核 ${human.pending+human.needs_evidence}（其中需补证据 ${human.needs_evidence}）`;
 const filter=$('parking-filter').value,visible=filterParkingRows(rows,predictions,reviews,filter);
 if(!selected||!visible.some(r=>r.id===selected))selected=visible[0]?.id||null;
 const truth=$('parking-show-truth').checked;
 $('parking-grid').replaceChildren(...visible.map(r=>{
  const p=predictions.get(r.id),state=p===undefined?'pending':classifyScore(p);const button=document.createElement('button');button.type='button';button.className='parking-tile';button.dataset.sampleId=r.id;button.setAttribute('aria-pressed',String(selected===r.id));
  button.innerHTML=`<img loading="lazy" src="${new URL(r.image,base)}" alt="摄像头 ${text(r.camera)} 车位 ${text(r.slot)} 的历史裁剪图"><strong>${text(r.camera)}:${text(r.slot)}</strong><span class="parking-tile-line"><span class="badge">${failures.has(r.id)?'读取失败':labels[state]}</span><span>${p===undefined?'—':`${(p*100).toFixed(1)}% 占用`}</span></span>${truth?`<small class="parking-truth">标注：${r.label?'占用':'空闲'}${p===undefined?'':Number(p>=.5)===r.label?' · 一致':' · 错判'}</small>`:''}<small>${humanLabels[reviews[r.id]?.decision]||'未人工复核'}</small>`;
  button.addEventListener('click',()=>{selected=r.id;reviewNotice('');render();if(matchMedia('(max-width:650px)').matches)document.querySelector('.parking-review')?.scrollIntoView({block:'start'});});return button;
 }));
 if(!visible.length){const p=document.createElement('p');p.className='empty';p.textContent=({review:'当前快照人工复核已完成。',confirmed:'当前快照还没有已人工确认的车位。',evidence:'当前快照没有标记为需补证据的车位。'})[filter]||(hasAny?'当前快照没有符合筛选的车位。':'请先分析当前快照，再筛选模型结果。');$('parking-grid').append(p);}
 renderDetail();
}
function renderDetail(){
 const r=samples.get(selected);$('parking-save').disabled=!r||running;$('parking-save-next').disabled=!r||running;
 if(!r){$('parking-detail').innerHTML='<p class="empty">选择一个车位查看详情。</p>';$('parking-decision').value='pending';$('parking-note').value='';return;}
 const p=predictions.get(r.id),state=p===undefined?'pending':classifyScore(p),truth=$('parking-show-truth').checked;
 $('parking-detail').innerHTML=`<img src="${new URL(r.image,base)}" alt="选中车位的原始图片"><h3>摄像头 ${text(r.camera)} · 车位 ${text(r.slot)}</h3><span class="badge">${labels[state]}</span><dl><dt>原始采样时间</dt><dd>${walltime(r)}</dd><dt>占用分数</dt><dd>${p===undefined?'未运行模型':`${(p*100).toFixed(2)}%`}</dd><dt>数据分区</dt><dd>独立测试集</dd>${truth?`<dt>原始数据标签</dt><dd>${r.label?'占用':'空闲'}</dd>`:''}</dl><p class="subtle">35%–65% 的分数优先复核。分数未做概率校准，明确分类也可能错判。</p>${failures.has(r.id)?'<p class="message error">图片读取失败，仍计入未分析；可重新分析重试。</p>':''}`;
 const d=drafts.get(r.id)||reviews[r.id]||{decision:'pending',note:''};$('parking-decision').value=d.decision;$('parking-note').value=d.note;
}
async function pixels(url){const image=new Image();image.src=url;let timer;try{await Promise.race([image.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('图片读取超时，请重试')),15000);})]);}catch(error){image.src='';throw error;}finally{clearTimeout(timer);}if(image.naturalWidth*image.naturalHeight>40000000)throw new Error('图片分辨率过大，请先裁剪单个车位');const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;if(c.width*c.height>40000000)throw new Error('图片分辨率过大，请先裁剪单个车位');const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const source=ctx.getImageData(0,0,c.width,c.height).data;const out=new Uint8ClampedArray(4096);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const sx=Math.floor((x+.5)*c.width/32),sy=Math.floor((y+.5)*c.height/32),i=(sy*c.width+sx)*4;out.set(source.subarray(i,i+4),(y*32+x)*4);}return out;}
function busy(value){running=value;$('parking-stop').hidden=!value;for(const id of ['parking-run','parking-session','parking-frame','parking-upload','parking-save','parking-save-next'])$(id).disabled=value;render();}
function runCurrent(){
 // Playback must await an existing manual run instead of treating it as finished.
 if(analysisPromise){
  const wanted=frames[frameIndex]?.id,ticket=analysisSequence;
  if(!wanted||wanted===analysisFrameId)return analysisPromise;
  return analysisPromise.then(()=>{if(ticket===analysisSequence&&frames[frameIndex]?.id===wanted&&location.hash==='#parking')return runCurrent();});
 }
 analysisPromise=(async()=>{try{await loadData();analysisFrameId=frames[frameIndex]?.id;const frameTime=walltime(frames[frameIndex]);busy(true);cancelled=false;const rows=currentRows(),start=performance.now();let done=0;
  // Small concurrency bound avoids loading the entire public corpus at once.
  let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<rows.length&&!cancelled){const r=rows[next++];try{const data=await pixels(new URL(r.input,base).href);predictions.set(r.id,predictPatch(data,model));failures.delete(r.id);}catch(e){failures.set(r.id,e.message);predictions.delete(r.id);}done++;notice(`正在分析快照 ${frameTime}：${done} / ${rows.length} 个车位。`);}}));
  const failed=rows.filter(r=>failures.has(r.id)).length;notice(`${cancelled?'分析已停止':'当前快照分析完成'}（${frameTime}）：${rows.filter(r=>predictions.has(r.id)).length} / ${rows.length} 个车位，${Math.round(performance.now()-start)} ms（含图片读取）。${failed?'读取失败项保留为未分析，可重试。':'预测来自图片像素；原始标注只用于对照。'}`,!!failed);
 }catch(e){notice(e.message,true);}finally{busy(false);}})().finally(()=>{analysisPromise=null;analysisFrameId=null;});
 return analysisPromise;
}
async function playback(){
 if(playTimer){stopPlayback();return;}if(!manifest)return;
 const ticket=++playSequence;playTimer=-1;$('parking-play').textContent='停止回放';$('parking-play').setAttribute('aria-pressed','true');
 const tick=async()=>{if(ticket!==playSequence||location.hash!=='#parking')return;await runCurrent();if(ticket!==playSequence)return;if(frameIndex>=frames.length-1){stopPlayback();return;}playTimer=setTimeout(()=>{if(ticket!==playSequence)return;chooseFrame(frameIndex+1);tick();},1800);};tick();
}
const stopButton=document.createElement('button');stopButton.id='parking-stop';stopButton.className='button';stopButton.type='button';stopButton.textContent='停止分析';stopButton.hidden=true;$('parking-run').after(stopButton);stopButton.addEventListener('click',()=>{analysisSequence++;cancelled=true;stopPlayback();notice('正在停止，已完成的预测会保留。');});
$('parking-run').addEventListener('click',runCurrent);
$('parking-session').addEventListener('change',setSession);
$('parking-frame').addEventListener('input',()=>{stopPlayback();chooseFrame(Number($('parking-frame').value));});
$('parking-prev').addEventListener('click',()=>{stopPlayback();chooseFrame(frameIndex-1);});$('parking-next').addEventListener('click',()=>{stopPlayback();chooseFrame(frameIndex+1);});$('parking-play').addEventListener('click',playback);
for(const id of ['parking-filter','parking-show-truth'])$(id).addEventListener('change',render);
for(const id of ['parking-note','parking-decision'])$(id).addEventListener('input',()=>{if(selected){stopPlayback();drafts.set(selected,{decision:$('parking-decision').value,note:$('parking-note').value});changed=true;}});
const context=()=>({model_sha256:evaluation.model_sha256,sample_ids:[...samples.keys()]});
function reviewDocument(nextReviews=reviews){const out=exportParkingReview(context(),nextReviews);out.dataset=manifest.dataset;out.source_frame=frames[frameIndex]?.id;out.frame_summary=frameSummary(currentRows(),predictions);out.review_summary=parkingReviewSummary(currentRows(),nextReviews);out.unanalysed_sample_ids=currentRows().filter(r=>!predictions.has(r.id)).map(r=>r.id);out.samples=[...predictions].map(([id,score])=>{const r=samples.get(id);return {id,camera:r.camera,slot:r.slot,source_time:`${r.date} ${r.time}`,source_timezone:manifest.dataset.timezone,split:r.split,image:r.image,source_sha256:r.source_sha256,predicted_occupied_score:score,prediction:Number(score>=.5),review_state:classifyScore(score),dataset_label:r.label};});out.failures=[...failures].map(([id,error])=>({id,error}));out.scope='停车位占用分类；真实历史快照；非连续视频，不判断违停或停留时长。';return out;}
function saveReview(advance){
 if(!selected||running)return;
 // A rejected save must also hold the current snapshot for corrections.
 stopPlayback();
 const savedId=selected,sample=samples.get(savedId);
 try{
  const record={decision:$('parking-decision').value,note:$('parking-note').value.trim(),at:new Date().toISOString()};
  // Validate the whole export before applying the decision or advancing the queue.
  serializeParkingReview(reviewDocument({...reviews,[savedId]:record}),context());
  reviews[savedId]=record;drafts.delete(savedId);changed=true;
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
importer.addEventListener('change',async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;const ticket=++importSequence;try{if(file.size>MAX_PARKING_REVIEW_BYTES)throw new Error('复核文件超过 32 MiB');await loadData();if(ticket!==importSequence)return;const data=JSON.parse(await file.text());if(ticket!==importSequence)return;const next=importParkingReview(data,context());if((changed||drafts.size)&&!confirm('恢复将替换本页人工记录。请先导出已有记录。继续恢复？'))return;for(const key of Object.keys(reviews))delete reviews[key];Object.assign(reviews,next);drafts.clear();changed=false;reviewNotice('人工复核已恢复，待办和进度已按保存的结论重新计算。');render();notice('已恢复人工复核。模型预测将通过当前模型重新分析，不采用导入文件中的分数。');}catch(e){if(ticket===importSequence)notice(`恢复失败：${e.message}`,true);}});
$('parking-upload').addEventListener('change',async e=>{const file=e.target.files[0],ticket=++uploadSequence;e.target.value='';if(!file)return;let url;try{if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024*1024)throw new Error('请选择不超过 10 MB 的 JPEG、PNG 或 WebP 单车位裁剪图');$('parking-upload-result').textContent='正在分析本地车位图片…';await loadCore();url=URL.createObjectURL(file);const data=await pixels(url);if(ticket!==uploadSequence){URL.revokeObjectURL(url);return;}const score=predictPatch(data,model);if(uploadURL)URL.revokeObjectURL(uploadURL);uploadURL=url;$('parking-upload-result').innerHTML=`<img src="${url}" alt="本地单车位裁剪图"><strong>${text(file.name)}</strong><p>${labels[classifyScore(score)]} · 占用分数 ${(score*100).toFixed(2)}%</p><p class="subtle">新场景结果未经验证，没有数据集标签可对照。不是违规判断。</p>`;}catch(e){if(url)URL.revokeObjectURL(url);if(ticket===uploadSequence)$('parking-upload-result').textContent=e.message;}});
window.addEventListener('beforeunload',e=>{if(changed||drafts.size){e.preventDefault();e.returnValue='';}});
async function renderEvaluation(){
 const e=evaluation;if(!e)return;const pct=v=>`${(v*100).toFixed(1)}%`;const s=e.splits,m=e.test.confusion_matrix;
 $('parking-evaluation-content').innerHTML=`<p><strong>本项目实际训练：${text(e.model_name)}</strong> · ${e.parameter_count.toLocaleString()} 个参数 · 种子 ${e.seed}</p><p class="training-history">固定比较线性分类器与 32 隐藏单元神经网络，各训练 ${e.epochs_per_candidate} 轮，按验证损失选模；最终第 ${e.selected_epoch} 轮。未微调原 COCO 检测器。</p><div class="table-wrap"><table><thead><tr><th>分区</th><th>样本 / 原始帧</th><th>摄像头</th><th>日期与时间范围</th></tr></thead><tbody>${[['训练','train'],['间隔排除','gap'],['验证','validation'],['测试','test']].map(([label,k])=>`<tr><td>${label}</td><td>${s[k].count} / ${s[k].frames}</td><td>${s[k].cameras.join(', ')}</td><td>${s[k].first} → ${s[k].last}</td></tr>`).join('')}</tbody></table></div><p class="subtle">${s.duplicate_excluded.count} 张跨分区完全重复图片被排除。只有一个停车场、两个摄像头；不代表新小区或新天气表现。</p><div class="metrics">${[['完整测试样本',e.test.n],['分类正确率',pct(e.test.accuracy)],['平衡正确率',pct(e.test.balanced_accuracy)],['占用召回率',pct(e.test.occupied_recall)]].map(([k,v])=>`<div class="metric"><strong>${v}</strong><span>${k}</span></div>`).join('')}</div><p>多数类基线正确率 ${pct(e.majority_baseline.accuracy)}。预测空闲但实际占用 <strong>${e.test.false_free}</strong> 张；预测占用但实际空闲 <strong>${e.test.false_occupied}</strong> 张。${e.review_samples} 张分数落在待复核区间，明确预测中仍有 ${e.confident_false_free} 张错误空闲判断。</p><div class="table-wrap"><table><thead><tr><th>原始标签 / 预测</th><th>空闲</th><th>占用</th></tr></thead><tbody><tr><th>空闲</th><td>${m[0][0]}</td><td>${m[0][1]}</td></tr><tr><th>占用</th><td>${m[1][0]}</td><td>${m[1][1]}</td></tr></tbody></table></div><p class="subtle">混淆矩阵采用 0.5 分类阈值；巡检页另将 0.35–0.65 标为待复核。所有测试样本均计入，未删除错例。</p><div id="parking-error-picker"><button id="parking-load-errors" class="button" type="button">浏览完整测试集错例</button></div><p><a href="data/parking/evaluation.json">完整评测 JSON</a> · <a href="data/parking/test-predictions.json">逐样本预测与全部错例</a> · <a href="https://github.com/leon1111-wgl/estateguard/blob/main/docs/PARKING_DATA.md">数据、训练与复现说明 ↗</a></p><p class="subtle">数据来自 <a href="http://cnrpark.it/">CNRPark / Amato 等</a>，按 <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a> 提供。历史图片不构成连续停车或违停证据。</p>`;
 $('parking-load-errors').addEventListener('click',async()=>{try{await loadData();const all=await json(new URL('test-predictions.json',base));const errors=all.filter(r=>!r.correct);const select=document.createElement('select');select.id='parking-error-example';select.setAttribute('aria-label','选择完整测试集中的错误样本');const first=new Option(`选择错例（全部 ${errors.length} 张）`,'');select.add(first);for(const r of errors)select.add(new Option(`${r.id} · 标注${r.label?'占用':'空闲'} / 预测${r.prediction?'占用':'空闲'}`,r.id));select.addEventListener('change',async()=>{if(!select.value)return;const r=samples.get(select.value);$('parking-session').value=`${r.camera}-${r.date}`;setSession();frameIndex=frames.findIndex(f=>f.sample_ids.includes(r.id));$('parking-filter').value='all';$('parking-show-truth').checked=true;selected=r.id;location.hash='parking';render();await runCurrent();});const label=document.createElement('label');label.className='field';label.textContent='完整测试集错误样本';label.append(select);$('parking-error-picker').replaceChildren(label);}catch(err){$('parking-error-picker').textContent=err.message;}});
}
async function enter(){try{if(location.hash==='#parking')await loadData();else {stopPlayback();if(location.hash==='#results')await loadCore();}}catch(e){notice(e.message,true);$('parking-model-status').textContent='加载失败，可重试';$('parking-evaluation-content').textContent=`训练记录加载失败：${e.message}`;}}
window.addEventListener('hashchange',enter);enter();
