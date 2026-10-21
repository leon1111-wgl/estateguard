import {categories,defaultPolicy,validatePolicy,buildEvents,inReviewQueue,applyDecision,exportWorkspace,importWorkspace,statuses,MAX_BATCH_BYTES,MAX_WORKSPACE_BYTES} from './engine.mjs';
import {createEvidenceStore} from './evidence-media.mjs';
const $=id=>document.getElementById(id);
const escape=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const categoryNames={bulky_load:'客梯大件搬运',door_obstruction:'电梯门受阻',lift_impact:'疑似电梯碰撞',illegal_parking:'疑似不当停车',blocked_access:'通道占用线索',wrong_way:'疑似逆向行驶',waste_dumping:'垃圾放置位置异常',waste_overflow:'垃圾容器满溢'};
const areaNames={Lift:'电梯',Parking:'停车场','Shared space':'公共通道',Refuse:'垃圾收集点'};
const labels={open:'待复核',confirmed_concern:'已确认 · 待处理',dismissed:'已排除',needs_evidence:'待补充证据',resolved:'已处理',review:'待复核',urgent_review:'优先核查',insufficient_evidence:'证据不足',contextual_exception:'预约例外待核对',below_threshold:'低于分数阈值',short_observation:'观察时间不足'};
const reasons={review:'候选线索。核对现场规则和证据后再作结论。',urgent_review:'优先安排人工检查，尚不代表违规已确认。',insufficient_evidence:'画面质量不足、证据缺失或低分高风险线索，需要人工核实。',contextual_exception:'所有大件观察记录均声明有搬运预约，请核对有效性。其他风险类别不受此例外影响。',below_threshold:'低于当前分数下限，保留在全部事件中供审计。',short_observation:'有证据的观察时长未达到当前停车宽限；间隔未计入。'};
const actions={bulky_load:'核对搬运预约、客梯 / 货梯用途及防护安排。',door_obstruction:'查看完整开关门片段，由值班人员核查障碍。',lift_impact:'对照接触前后画面；仅凭接近或接触不能判定损坏和责任。',illegal_parking:'核对车位标识、临时装卸许可和停留证据。',blocked_access:'核实是否为指定通道，并安排现场检查。',wrong_way:'结合道路标识复核连续轨迹；单帧无法证明方向。',waste_dumping:'核对清运时段和指定投放位置。',waste_overflow:'核对容器状态，必要时安排清运。'};
const formatTime=x=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(x));
// dirty 仅表示未导出的工作区变化，输入草稿单独管理。
let ws=null,events=[],selected=null,dirty=false,loadSequence=0;
const drafts=new Map();
const media=createEvidenceStore({onChange:id=>{if(id===selected&&$('media-status'))renderMedia(id);}});
const titles={analyze:'视频与图片分析',workspace:'事件复核',parking:'车位巡检',policy:'场景规则',results:'评测与模型',story:'项目说明'};
function navigate(){const view=Object.hasOwn(titles,location.hash.slice(1))?location.hash.slice(1):'analyze';for(const section of document.querySelectorAll('[data-page]'))section.hidden=section.id!==view;for(const a of document.querySelectorAll('[data-nav]'))a.classList.toggle('active',a.dataset.nav===view);$('view-title').textContent=titles[view];}
window.addEventListener('hashchange',navigate);navigate();
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function clearMedia(){media.clear();}
const hasUnsavedWork=()=>dirty||drafts.size>0;
const comparableNote=note=>note.replace(/\r\n?/g,'\n').trim();
function replaceAllowed(){if(!hasUnsavedWork()||confirm('当前标签页有未导出的记录或草稿。替换前请先保存草稿并导出工作区。仍要继续吗？'))return true;message('已取消替换，当前记录、草稿和附件保持不变。');return false;}
function setWorkspace(next){++loadSequence;clearMedia();drafts.clear();ws=next;selected=null;dirty=false;syncPolicy();render(true);}
function syncPolicy(){for(const [key,id] of Object.entries({score_threshold:'score-threshold',quality_threshold:'quality-threshold',merge_gap_seconds:'merge-gap',parking_grace_seconds:'parking-grace'}))$(id).value=ws.policy[key];}
const decision=e=>ws.decisions[e.id]?.status||'open';
const pending=e=>!['dismissed','resolved'].includes(decision(e));
const requiresAttention=e=>pending(e)&&(inReviewQueue(e)||['confirmed_concern','needs_evidence'].includes(decision(e)));
function badge(e){let type=e.urgent?'urgent':'';if(e.routing==='insufficient_evidence')type='uncertain';const d=decision(e);return `<span class="badge ${pending(e)?type:'closed'}">${escape(labels[d!=='open'?d:e.routing])}</span>`;}
const reviewBadges=e=>badge(e)+(drafts.has(e.id)?' <span class="badge uncertain">未保存草稿</span>':'');
function resetQueueFilters(){$('area-filter').value='all';$('queue-filter').value=events.some(requiresAttention)?'review':'all';}
function render(resetFilters=false){events=buildEvents(ws.batch,ws.policy);if(resetFilters)resetQueueFilters();$('batch-name').textContent=ws.batch.name;const metrics=[[ws.batch.observations.length,'来源观察记录'],[events.length,'合并后事件'],[events.filter(requiresAttention).length,'待复核 / 待处理'],[events.filter(e=>e.urgent&&requiresAttention(e)).length,'优先核查（含证据不足）']];$('metrics').innerHTML=metrics.map(([v,l])=>`<div class="metric"><strong>${v}</strong><span>${l}</span></div>`).join('');renderQueue();}
function renderQueue(){const filter=$('queue-filter').value,area=$('area-filter').value;const visible=events.filter(e=>(area==='all'||categories[e.category].area===area)&&(filter==='all'||filter==='review'&&requiresAttention(e)||filter==='urgent'&&e.urgent&&pending(e)||filter==='resolved'&&!pending(e)));$('queue-count').textContent=visible.length;if(!visible.some(e=>e.id===selected))selected=visible[0]?.id||null;
 $('queue-list').innerHTML=visible.length?visible.map(e=>`<button class="event-button ${selected===e.id?'active':''}" data-event="${escape(e.id)}" aria-pressed="${selected===e.id}"><span class="event-top"><span>${escape(areaNames[categories[e.category].area])} · ${formatTime(e.start)}</span><span>${e.observation_ids.length} 条</span></span><strong>${categoryNames[e.category]}</strong><small>${escape(e.zone)}</small><span data-review-badges style="display:block;margin-top:8px">${reviewBadges(e)}</span></button>`).join(''):'<p class="empty">此筛选下没有事件。选择「全部事件」可查看例外和已处理记录。</p>';
 for(const b of $('queue-list').querySelectorAll('[data-event]'))b.addEventListener('click',()=>{selected=b.dataset.event;renderQueue();if(matchMedia('(max-width:650px)').matches)$('incident-detail').scrollIntoView({block:'start'});});renderDetail();}
function renderDetail(){const e=events.find(x=>x.id===selected);if(!e){$('incident-detail').innerHTML='<div class="empty"><h3>此视图暂无待办</h3><p>所有观察记录仍保留在全部事件中。离开前可导出交接单。</p></div>';return;}
 const d=drafts.get(e.id)||ws.decisions[e.id],history=ws.audit.filter(x=>x.event_id===e.id);
 $('incident-detail').innerHTML=`<div class="detail-header"><div>${badge(e)}${e.urgent?'<span class="badge urgent" style="margin-left:6px">高风险类别</span>':''}<h3>${categoryNames[e.category]}</h3><p>${escape(e.camera)} · ${escape(e.zone)} · ${escape(e.track)}</p></div><span class="event-index">${escape(e.id)}</span></div><div class="reason">${reasons[e.routing]}</div><h4>观察时间</h4><div class="timeline" aria-label="${e.observation_ids.length} 个观察片段，仅为顺序示意">${e.observation_ids.map(()=>'<span></span>').join('')}</div><div class="timeline-labels"><span>${formatTime(e.start)} → ${formatTime(e.end)}（UTC+8）</span><span>顺序示意，非时间比例</span></div><div class="facts"><div><strong>${Number(e.observed_seconds.toFixed(3))} 秒</strong><span>输入时间窗覆盖（非实测停留）</span></div><div><strong>${Math.round(e.score*100)} / 100</strong><span>最大输入分数</span></div><div><strong>${Math.round(e.quality*100)} / 100</strong><span>最低输入质量</span></div></div><h4>来源描述</h4><ul>${e.summaries.map(s=>`<li>${escape(s)}</li>`).join('')}</ul><p class="subtle">${escape(ws.batch.provenance)}</p><h4>证据引用（媒体需另行打开）</h4><div class="evidence-labels">${e.evidence.length?e.evidence.map(label=>`<code>${escape(label)}</code>`).join(''):'<span class="badge uncertain">未提供来源引用</span>'}</div><div class="media-box"><label class="button file-button">打开本地图片 / 视频<input id="media-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"></label><p>用于人工复核，最大 100 MB。文件不上传、不随 JSON 导出；恢复工作区后需重新选择。</p><p id="media-status" role="status" aria-live="polite"></p><div id="media-preview"></div></div><h4>下一步检查</h4><p>${actions[e.category]}</p><form id="decision-form" class="decision-form"><label class="field">处理结论<select id="decision-status">${statuses.map(status=>`<option value="${status}" ${status===(d?.status||'open')?'selected':''}>${labels[status]}</option>`).join('')}</select></label><label class="field">理由 / 已检查的证据<textarea id="decision-note" required maxlength="2000" placeholder="例如：搬运预约已核对，但挡门片段仍需现场检查。">${escape(d?.note||'')}</textarea></label><button class="button primary" type="submit">保存复核记录</button></form><div class="history"><strong>复核历史 · ${history.length} 条</strong>${history.length?`<ul>${history.map(a=>`<li>${formatTime(a.at)} · ${labels[a.status]}：${escape(a.note)}</li>`).join('')}</ul>`:'<p>尚无人工结论，模型分数不能代替核实。</p>'}</div>`;
 const saveDraft=()=>{
  const draft={status:$('decision-status').value,note:$('decision-note').value},saved=ws.decisions[e.id]||{status:'open',note:''};
  // 比较时对齐输入框换行和保存时的首尾裁剪，不改写历史原文。
  if(draft.status===saved.status&&comparableNote(draft.note)===comparableNote(saved.note))drafts.delete(e.id);else drafts.set(e.id,draft);
  const badges=$('queue-list').querySelector('.event-button.active [data-review-badges]');
  if(selected===e.id&&badges)badges.innerHTML=reviewBadges(e);
 };$('decision-status').addEventListener('change',saveDraft);$('decision-note').addEventListener('input',saveDraft);
 $('decision-form').addEventListener('submit',event=>{event.preventDefault();if(media.state(e.id).status==='loading'){renderMedia(e.id);return;}try{ws=applyDecision(ws,e.id,$('decision-status').value,$('decision-note').value);drafts.delete(e.id);dirty=true;render();message('复核记录已保存在当前标签页。导出工作区后可以恢复。');}catch(err){message(err.message,true);}});
 $('media-file').addEventListener('change',event=>{const file=event.target.files[0];event.target.value='';if(file)void media.replace(e.id,file);});renderMedia(e.id);
}
function renderMedia(id){
 const state=media.state(id),item=state.item,status=$('media-status'),preview=$('media-preview');
 const retained=item?`仍保留原证据「${item.name}」和复核草稿。`:'尚未载入可查看的证据，复核草稿已保留。';
 status.textContent=state.status==='loading'?`正在检查「${state.attemptedName}」是否可打开。${retained}检查完成后可保存复核记录。`:state.status==='error'?`「${state.attemptedName}」读取失败：${state.error} ${retained}`:item?`${item.type.startsWith('video/')?'视频首帧已解码':'图片已解码'}，请核对画面是否对应本事件。`:'未载入本地证据。请选择与本事件对应的图片或视频。';
 status.classList.toggle('error',state.status==='error');preview.setAttribute('aria-busy',String(state.status==='loading'));
 $('decision-form').querySelector('[type="submit"]').disabled=state.status==='loading';
 // Loading or failed replacements must not interrupt the existing preview.
 if(preview.dataset.evidenceUrl===(item?.url||''))return;
 preview.dataset.evidenceUrl=item?.url||'';
 if(!item){preview.replaceChildren();return;}
 const label=document.createElement('p');label.textContent=item.name;const node=document.createElement(item.type.startsWith('video/')?'video':'img');node.src=item.url;
 if(node.tagName==='VIDEO'){node.controls=true;node.preload='auto';node.playsInline=true;}else node.alt='用于人工核查的本地证据';preview.replaceChildren(label,node);
}
function download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportJSON(){try{if(drafts.size)throw new Error('还有未保存草稿，请先逐条保存复核记录，再导出工作区。');const payload=exportWorkspace(ws);download(payload,'estateguard-workspace.json','application/json');dirty=false;message('已导出观察记录、规则和复核历史。媒体文件不包含在内。');}catch(err){message(err.message,true);}}
function brief(){return `# EstateGuard 班次交接单\n\n${ws.batch.name}\n\n导出时间：${new Date().toISOString()}\n\n数据来源：${ws.batch.provenance}\n\n## 使用边界\n\n以下记录为人工复核材料，不是责任或违法判定。媒体文件不包含在内。使用配套 JSON 恢复工作区。时间统一为 UTC+8。\n\n## 当前规则\n\n\`\`\`json\n${JSON.stringify(ws.policy,null,2)}\n\`\`\`\n\n${events.map(e=>`## ${categoryNames[e.category]}\n\n- 事件：${e.id}\n- 摄像头 / 区域 / 匿名轨迹：${e.camera} / ${e.zone} / ${e.track}\n- 时间：${formatTime(e.start)} 至 ${formatTime(e.end)}\n- 分流：${labels[e.routing]}\n- 原因：${reasons[e.routing]}\n- 来源 ID：${e.observation_ids.join(', ')}\n- 证据引用：${e.evidence.join(', ')||'缺失'}\n- 人工结论：${labels[decision(e)]}\n- 理由：${ws.decisions[e.id]?.note||'尚未复核'}\n\n`).join('')}## 审查历史\n\n${ws.audit.map(a=>`- ${formatTime(a.at)} | ${a.event_id} | ${labels[a.status]} | ${a.note}`).join('\n')||'暂无记录'}\n`;}
$('export-json').addEventListener('click',()=>{if(ws)exportJSON();});$('export-brief').addEventListener('click',()=>{if(!ws)return;if(drafts.size){message('请先保存复核草稿，再导出交接单。',true);return;}download(brief(),'estateguard-handover.md','text/markdown');message('交接单已导出。如需恢复工作区，请同时导出 JSON。');});
for(const id of ['queue-filter','area-filter'])$(id).addEventListener('change',()=>{if(ws)renderQueue();});
$('import-file').addEventListener('change',async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;const ticket=++loadSequence;try{if(file.size>MAX_WORKSPACE_BYTES)throw new Error('工作区超过 32 MiB，请按班次拆分。');const data=JSON.parse(await file.text());if(ticket!==loadSequence)return;if(data?.format!=='estateguard-workspace'&&file.size>MAX_BATCH_BYTES)throw new Error('原始观察批次超过 5 MiB。');const next=importWorkspace(data);if(!replaceAllowed())return;setWorkspace(next);message('JSON 已导入并通过校验。引用的媒体文件需另行打开。');}catch(err){if(ticket===loadSequence)message(`导入被拒绝，原工作区未改变。${err.message}`,true);}});
async function loadDemo(){const ticket=++loadSequence;message(ws?'正在读取合成班次，当前复核可继续操作。':'正在读取合成班次。');try{const r=await fetch('demo.json');if(!r.ok)throw new Error('无法读取示例数据');const next=importWorkspace(await r.json());if(ticket!==loadSequence||!replaceAllowed())return;setWorkspace(next);message('当前为合成班次：用于演示处理流程，不是模型识别结果。');}catch(err){if(ticket===loadSequence)message(`读取示例失败，当前工作区未改变。${err.message}`,true);}}
$('reset-demo').addEventListener('click',loadDemo);
$('policy-form').addEventListener('submit',event=>{event.preventDefault();if(!ws)return;try{const policy=validatePolicy(Object.fromEntries([...new FormData(event.target)].map(([k,v])=>[k,Number(v)])));if((ws.audit.length||hasUnsavedWork())&&!confirm('应用规则将清空当前复核和草稿。请先导出已有工作。继续吗？'))return;setWorkspace({...ws,policy,decisions:{},audit:[]});dirty=true;message('规则已应用，新的复核已开始。固定评测结果不受此操作影响。');}catch(err){message(err.message,true);}});
window.addEventListener('estateguard:candidates',event=>{try{
 const next=importWorkspace(event.detail.batch);
 // 同一检测任务的原批次只返回当前复核；不能按轨迹编号或候选相似度合并不同任务。
 if(next.batch.analysis_id&&JSON.stringify(next.batch)===JSON.stringify(ws?.batch)){
  ++loadSequence;
  if(!$('queue-list').querySelector('.event-button')){resetQueueFilters();renderQueue();}
  event.detail.accepted=true;event.detail.reused=true;location.hash='workspace';
  message('已返回本次分析的复核记录，原结论、草稿和附件保持不变。');return;
 }
 if(!replaceAllowed())return;setWorkspace(next);dirty=true;
 if(event.detail.file)void media.replace(events.map(e=>e.id),event.detail.file);
 event.detail.accepted=true;location.hash='workspace';message('已载入真实模型产生的规则候选。质量设为保守值，所有结论需人工核实。');
 }catch(err){message(err.message,true);}});
window.addEventListener('beforeunload',event=>{if(hasUnsavedWork()){event.preventDefault();event.returnValue='';}});
async function showBenchmark(){try{const r=await fetch('benchmark.json');if(!r.ok)throw new Error('无法读取评测');const b=await r.json();const pct=n=>n===null?'不适用':`${(n*100).toFixed(1)}%`;$('benchmark').innerHTML=`<div class="bench-result"><strong>${b.baseline.predictions} → ${b.proposed.predictions}</strong><p>固定合成班次中的待办条目减少 ${pct(b.queue_reduction)}。仍保留一个错误提示和一个完全漏掉的事件，避免把流程评测误写成完美识别。</p></div><div class="table-wrap"><table><thead><tr><th>事件级匹配</th><th>仅按分数告警</th><th>场景规则队列</th></tr></thead><tbody>${[['待办条目','predictions'],['匹配到的参考事件','true_positive'],['未匹配 / 重复条目','false_positive'],['漏掉的参考事件','missed'],['本用例精确率','precision'],['本用例召回率','recall']].map(([l,k])=>`<tr><td>${l}</td><td>${['precision','recall'].includes(k)?pct(b.baseline[k]):b.baseline[k]}</td><td>${['precision','recall'].includes(k)?pct(b.proposed[k]):b.proposed[k]}</td></tr>`).join('')}</tbody></table></div><p class="benchmark-note">${b.raw_observations} 条人工构造的观察、${b.proposed.references} 个参考事件。摄像头、区域、轨迹和类别一致，时间 IoU ≥ 0.1，按重叠从高到低一对一匹配。重复告警算未匹配条目；改进队列还保留低分高风险提示，因此这是流程对比，不是单一模型消融。</p>`;}catch(err){$('benchmark').textContent=err.message;}}
await loadDemo();await showBenchmark();
