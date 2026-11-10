/** Event timeline view: lanes of coloured segments, an event list, the detail of the selected event, the limits of
 * the rules, and the JSON export document. The analysis itself lives in event-timeline.mjs. */
import {TIMELINE_RULES,RULE_ORDER,TIMELINE_LIMITS} from './event-timeline.mjs';
import {COCO_NAMES_ZH} from './coco-names.mjs';
const $=id=>document.getElementById(id);
const el=(tag,props={},...children)=>{const node=Object.assign(document.createElement(tag),props);node.append(...children.filter(c=>c!==null&&c!==undefined));return node;};
const sec=x=>`${Number(x).toFixed(x%1?1:0)} 秒`;
export const TIMELINE_EVENT_SCOPE='时间线事件只是待人工核实的线索，不送入事件复核，也不是违规认定。没有事件不等于安全；下方列出规则看不到的情形。';
const zoneText=zone=>zone.every((v,i)=>Math.abs(v-[0,0,1,1][i])<1e-9)?'整幅画面':`X ${Math.round(zone[0]*100)}% · Y ${Math.round(zone[1]*100)}% · 宽 ${Math.round(zone[2]*100)}% · 高 ${Math.round(zone[3]*100)}%`;
let selected=null,evaluation=null,evaluationRequested=false;

export function clearTimeline(){selected=null;const panel=$('timeline-panel');if(!panel)return;panel.hidden=true;for(const id of ['timeline-lanes','timeline-rows','timeline-detail'])$(id).replaceChildren();}

function detail(event,report){
 const rule=TIMELINE_RULES[event.rule],t=report.timeline,zoneName=report.params.zone?`${report.params.zone}（${zoneText(t.zone)}）`:zoneText(t.zone);
 const rows=[['规则',rule.label],['关注区域',zoneName],['事件段',`${sec(event.start)} – ${sec(event.end)}（${sec(event.duration)}）`],['关键帧',sec(event.keyframe_time)],
  ['之后持续',`${sec(event.condition_seconds)}${event.condition_open?'，分析结束时仍在':''}`],['匿名轨迹',`${event.track} · ${COCO_NAMES_ZH[event.class]||event.class}`],['平均检测分数',event.score.toFixed(2)]];
 const dl=el('dl',{className:'tl-facts'});for(const [k,v] of rows)dl.append(el('dt',{textContent:k}),el('dd',{textContent:v}));
 return [el('h4',{textContent:`${event.id} · ${rule.label}`}),dl,el('p',{className:'subtle',textContent:`规则看到的：${rule.sees}`}),el('p',{className:'subtle',textContent:`规则看不到的：${rule.misses}`})];
}
function select(event,report,onSelect){
 selected=event.id;
 for(const b of document.querySelectorAll('[data-event]'))b.setAttribute('aria-pressed',String(b.dataset.event===event.id));
 $('timeline-detail').replaceChildren(...detail(event,report));
 onSelect?.(event);
}
function evidenceLine(){
 const box=$('timeline-evidence');if(!box)return;
 if(!evaluationRequested){evaluationRequested=true;fetch(new URL('./data/timeline/evaluation.json',import.meta.url),{cache:'no-store'}).then(r=>r.ok?r.json():null).then(e=>{evaluation=e;evidenceLine();}).catch(()=>{});}
 if(!evaluation?.test){box.textContent='';return;}
 const t=evaluation.test,p=x=>x==null?'—':`${Math.round(x*100)}%`;
 box.textContent=`公开数据上的表现（MEVA 测试半，${t.clips} 段 / ${t.minutes.toFixed(0)} 分钟，按摄像头与开发半分开；唯一一次测试运行的检测输出，修正标注读取后评分）：`+RULE_ORDER.map(r=>{const x=t.rules[r];return `${TIMELINE_RULES[r].label}漏报 ${p(x.pmiss)}（${x.references} 个标注），每分钟多报 ${x.unmatched_per_minute.toFixed(1)} 个${x.pmiss===1?`，在公开测试中全部漏报（${x.references} 个标注）`:x.pmiss>=.9?'，在公开测试中几乎全部漏报':''}`;}).join('；')+'。';
}
export function renderTimeline(report,{onSelect}={}){
 const t=report.timeline,panel=$('timeline-panel');if(!t||!panel)return;
 panel.hidden=false;selected=null;
 const span=Math.max(1e-6,t.analysed.end-t.analysed.start),pos=x=>Math.max(0,Math.min(100,(x-t.analysed.start)/span*100));
 const counts=Object.fromEntries(RULE_ORDER.map(r=>[r,t.events.filter(e=>e.rule===r).length]));
 $('timeline-summary').textContent=t.events.length?`${t.events.length} 个待核实事件 · ${RULE_ORDER.map(r=>`${TIMELINE_RULES[r].label} ${counts[r]}`).join(' · ')} · 分析 ${sec(t.analysed.start)}–${sec(t.analysed.end)}，${t.frames_analysed} 帧`:`没有事件（分析 ${sec(t.analysed.start)}–${sec(t.analysed.end)}，${t.frames_analysed} 帧）。没有事件不等于安全：漏检、遮挡、远处小目标都会让时间线空着。`;
 $('timeline-start').textContent=sec(t.analysed.start);$('timeline-end').textContent=sec(t.analysed.end);
 $('timeline-lanes').replaceChildren(...RULE_ORDER.map(rule=>{
  // Overlapping events of one rule are packed into rows (greedy, in time order) so none hides another.
  const ends=[],rowOf=new Map();
  for(const e of t.events.filter(x=>x.rule===rule)){let r=ends.findIndex(end=>end<=e.start);if(r<0){r=ends.length;ends.push(0);}ends[r]=e.end;rowOf.set(e.id,r);}
  const rows=Math.max(1,ends.length),track=el('div',{className:'tl-track'});
  track.style.height=`${Math.max(26,rows*14+6)}px`;
  for(const e of t.events.filter(x=>x.rule===rule)){
   const b=el('button',{type:'button',className:`tl-seg tl-${rule}`,title:`${e.id} · ${TIMELINE_RULES[rule].label} · ${sec(e.start)}–${sec(e.end)}`});
   b.dataset.event=e.id;b.setAttribute('aria-pressed','false');b.setAttribute('aria-label',`${TIMELINE_RULES[rule].label}，${sec(e.start)} 到 ${sec(e.end)}，查看关键帧`);
   b.style.left=`${pos(e.start)}%`;b.style.width=`${Math.max(.6,pos(e.end)-pos(e.start))}%`;
   if(rows>1){b.style.top=`${3+rowOf.get(e.id)*14}px`;b.style.height='11px';b.style.bottom='auto';}b.addEventListener('click',()=>select(e,report,onSelect));track.append(b);
  }
  return el('div',{className:'tl-lane'},el('span',{className:`tl-lane-label tl-key-${rule}`,textContent:`${TIMELINE_RULES[rule].label} · ${counts[rule]}`}),track);
 }));
 $('timeline-rows').replaceChildren(...(t.events.length?t.events.map(e=>{
  const b=el('button',{type:'button',className:'button tl-open',textContent:'关键帧'});b.dataset.event=e.id;b.setAttribute('aria-pressed','false');b.setAttribute('aria-label',`${e.id} ${TIMELINE_RULES[e.rule].label} 查看关键帧`);b.addEventListener('click',()=>select(e,report,onSelect));
  return el('tr',{},el('td',{},el('span',{className:`tl-dot tl-key-${e.rule}`}),document.createTextNode(TIMELINE_RULES[e.rule].label)),el('td',{textContent:`${sec(e.start)}–${sec(e.end)}`}),el('td',{textContent:sec(e.condition_seconds)}),el('td',{textContent:`${e.track} · ${COCO_NAMES_ZH[e.class]||e.class}`}),el('td',{textContent:e.score.toFixed(2)}),el('td',{},b));
 }):[el('tr',{},el('td',{colSpan:6,textContent:'当前设置下没有事件。可以换关注区域、调低分数下限，或检查画面里目标是否太小。'}))]));
 $('timeline-detail').replaceChildren(el('p',{className:'subtle',textContent:t.events.length?'点时间线上的色块或列表里的“关键帧”，查看当时的画面、检测框、规则和持续时间。':'没有可查看的事件。'}));
 $('timeline-limits').replaceChildren(...[...RULE_ORDER.map(r=>`${TIMELINE_RULES[r].label}：看得到${TIMELINE_RULES[r].sees}看不到：${TIMELINE_RULES[r].misses}`),...TIMELINE_LIMITS].map(text=>el('li',{textContent:text})));
 evidenceLine();
}
/** The exported document: everything needed to read an event without the page, and nothing about the visitor. */
export function timelineDocument(report){
 const t=report.timeline;
 return {format:'estateguard-timeline',version:1,analysis_id:report.analysis_id,exported_at:new Date().toISOString(),
  media:report.media,model:report.model,runtime:report.runtime,backend:report.backend,
  settings:{...t.settings,detector:report.params.detector,sample_interval_seconds:report.params.sample_interval_seconds,max_frames:report.params.max_frames},
  zone:{name:report.params.zone||null,box:t.zone,note:'归一化 [x, y, 宽, 高]；三条规则共用'},
  analysed:{...t.analysed,frames:t.frames_analysed,unit:'素材内的秒数，不是监控时钟'},
  rules:Object.fromEntries(RULE_ORDER.map(r=>[r,{label:TIMELINE_RULES[r].label,sees:TIMELINE_RULES[r].sees,misses:TIMELINE_RULES[r].misses}])),
  events:t.events.map(e=>({...e,bbox:e.bbox.map(v=>Math.round(v*1e4)/1e4),score:Math.round(e.score*1e4)/1e4})),
  tracks:t.tracks.map(x=>({id:x.id,class:x.class,first:x.samples[0].time,last:x.samples.at(-1).time,samples:x.samples.length})),
  limits:TIMELINE_LIMITS,scope:TIMELINE_EVENT_SCOPE};
}
