/** Event timeline for video (0.5.0): detections on frames sampled at a fixed rate → a deterministic tracker defined
 * here → three zone and dwell rules → time segments. Pure functions, no DOM. The page and the MEVA evaluation harness
 * (scripts/meva-timeline.cjs) import this same module, so the logic that is scored is the logic that ships.
 * Times are seconds within the analysed clip, never wall-clock times. An event is a lead for a person to check;
 * no event is not evidence that nothing happened. Protocol: docs/validation/event-timeline-protocol.md. */

export const TIMELINE_RULES=Object.freeze({
 vehicle_stop:Object.freeze({label:'车辆停下',classes:Object.freeze(['car','truck','bus','motorcycle']),
  sees:'车辆轨迹先移动、再在区域内静止达到停留阈值。',
  misses:'一直停着的车不算“停下”；远处小车、被遮挡的车和检测框抖动会漏报或误报。'}),
 object_left:Object.freeze({label:'物品遗留（代理）',classes:Object.freeze(['backpack','handbag','suitcase']),
  sees:'背包、手提包或行李箱在片段中出现后静止达到停留阈值，期间没有人员框盖住它。',
  misses:'纸箱、快递包裹、推车不在 COCO 80 类里，看不到；不判断物主是谁、是否“丢弃”；片头已在画面中的物品不计。'}),
 person_appears:Object.freeze({label:'人员在门口出现',classes:Object.freeze(['person']),
  sees:'新的人员轨迹在关注区域内、离画面边缘有距离的位置开始（例如从门里走出）。',
  misses:'不区分进门和其他原因的新轨迹：遮挡后重新出现、轨迹换号都会多报；远处小人检测不到就漏报。'})
});
export const RULE_ORDER=Object.freeze(['vehicle_stop','object_left','person_appears']);

export const TIMELINE_SETTINGS=Object.freeze({
 version:'event-timeline-v1',
 sample_interval_seconds:1,   // fixed sampling rate (1 frame per second), same as the existing analysis
 max_frames:300,              // at most 5 minutes per run
 detection_floor:.25,         // detections at or above this may extend an existing track (second, low-score stage)
 minimum_score:.5,            // new tracks need this; fixed before scoring, re-chosen on MEVA dev only (protocol)
 dwell_seconds:3,             // stationary time before a stop / left object is confirmed (protocol)
 max_gap_seconds:2,           // a track survives this long without a matching detection
 iou_gate:.1,                 // association by IoU with the constant-velocity prediction ...
 distance_gate:1.5,           // ... or, below the IoU gate, by centre distance up to 1.5 box sizes
 moving_fraction:.25,         // moving: centre shift ≥ 0.25 box sizes per second
 still_fraction:.1,           // still: centre within 0.1 box sizes of where the stay began
 unattended_overlap:.1,       // a person box covering more than 10% of the object counts as attended
 edge_margin:.01,             // a new person track touching the frame edge walked in from outside the view
 min_person_samples:2         // a person track must be seen twice to count
});

const EPS=1e-6;
const GROUPS={car:'vehicle',truck:'vehicle',bus:'vehicle',backpack:'carried',handbag:'carried',suitcase:'carried'};
const groupOf=c=>GROUPS[c]||c;
const centre=b=>[b[0]+b[2]/2,b[1]+b[3]/2];
export function boxIoU(a,b){const w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1])),i=w*h,u=a[2]*a[3]+b[2]*b[3]-i;return u>0?i/u:0;}
// Normalised x and y have different units on a non-square frame; distances are measured in frame heights.
const boxSize=(b,aspect)=>Math.sqrt(Math.max(0,b[2]*aspect*b[3]));
const shift=(a,b,aspect)=>{const p=centre(a),q=centre(b);return Math.hypot((p[0]-q[0])*aspect,p[1]-q[1]);};
const insideZone=(b,zone)=>{const [x,y]=centre(b);return x>=zone[0]-EPS&&x<=zone[0]+zone[2]+EPS&&y>=zone[1]-EPS&&y<=zone[1]+zone[3]+EPS;};
const coveredFraction=(object,cover)=>{const w=Math.max(0,Math.min(object[0]+object[2],cover[0]+cover[2])-Math.max(object[0],cover[0])),h=Math.max(0,Math.min(object[1]+object[3],cover[1]+cover[3])-Math.max(object[1],cover[1])),a=object[2]*object[3];return a>0?w*h/a:0;};

function checkSettings(input){
 const s={...TIMELINE_SETTINGS,...input};
 for(const key of ['sample_interval_seconds','detection_floor','minimum_score','dwell_seconds','max_gap_seconds','iou_gate','distance_gate','moving_fraction','still_fraction','unattended_overlap','edge_margin','min_person_samples'])
  if(typeof s[key]!=='number'||!Number.isFinite(s[key])||s[key]<0)throw new Error(`时间线参数 ${key} 无效`);
 if(s.detection_floor>s.minimum_score)throw new Error('时间线参数：低分阶段的下限不能高于新轨迹分数下限');
 if(!(s.aspect>0))s.aspect=1;
 return s;
}
function checkFrames(frames){
 if(!Array.isArray(frames))throw new Error('时间线需要采样帧列表');
 const sorted=[...frames].sort((a,b)=>a.time-b.time);
 for(let i=0;i<sorted.length;i++){
  const f=sorted[i];
  if(!Number.isFinite(f.time)||!Array.isArray(f.detections))throw new Error('采样帧格式无效');
  if(i&&f.time-sorted[i-1].time<EPS)throw new Error('采样帧时间重复');
  for(const d of f.detections)if(typeof d.class!=='string'||!Number.isFinite(d.score)||!Array.isArray(d.bbox)||d.bbox.length!==4||d.bbox.some(v=>!Number.isFinite(v)))throw new Error('检测结果格式无效');
 }
 return sorted;
}
// Constant-velocity prediction from the last two samples: at one frame per second a walking person or a moving car
// can move more than its own width, so the previous box alone often no longer overlaps.
function predict(track,time,s){
 const last=track.samples.at(-1),prev=track.samples.at(-2);
 if(!prev||last.time-prev.time>s.max_gap_seconds+EPS)return last.bbox;
 const k=(time-last.time)/(last.time-prev.time),p=centre(prev.bbox),q=centre(last.bbox);
 return [last.bbox[0]+(q[0]-p[0])*k,last.bbox[1]+(q[1]-p[1])*k,last.bbox[2],last.bbox[3]];
}
function similarity(predicted,box,s){
 const iou=boxIoU(predicted,box);if(iou>=s.iou_gate)return iou;
 const size=Math.max(boxSize(predicted,s.aspect),boxSize(box,s.aspect)),ratio=boxSize(box,s.aspect)/Math.max(EPS,boxSize(predicted,s.aspect));
 if(ratio<.5||ratio>2)return 0;
 const d=shift(predicted,box,s.aspect),gate=s.distance_gate*size;
 // Always below the IoU gate, so any overlapping pair is preferred over a distance-only pair.
 return d<gate?s.iou_gate*(1-d/gate)*.999:0;
}

/** Two-stage greedy association in the style of ByteTrack: high-score detections first, then low-score ones only to
 * continue tracks that are still unmatched. Only high-score detections start tracks. Car, truck and bus share a
 * group, as do backpack, handbag and suitcase, so a class flip between frames does not break a track.
 * Ties are broken by track creation order, then detection order, so the result is deterministic. */
export function trackFrames(frames,settings={}){
 const s=checkSettings(settings),tracks=[];
 for(const frame of checkFrames(frames)){
  const dets=frame.detections.map((d,i)=>({...d,i})).filter(d=>d.score>=s.detection_floor-EPS);
  const high=dets.filter(d=>d.score>=s.minimum_score-EPS),low=dets.filter(d=>d.score<s.minimum_score-EPS);
  const free=new Set(tracks.filter(t=>{const dt=frame.time-t.samples.at(-1).time;return dt>EPS&&dt<=s.max_gap_seconds+EPS;}));
  const assign=pool=>{
   const pairs=[];
   for(const t of free){const p=predict(t,frame.time,s);for(const d of pool)if(groupOf(d.class)===t.group){const sim=similarity(p,d.bbox,s);if(sim>0)pairs.push({t,d,sim});}}
   pairs.sort((a,b)=>b.sim-a.sim||a.t.index-b.t.index||a.d.i-b.d.i);
   const used=new Set();
   for(const {t,d} of pairs)if(free.has(t)&&!used.has(d)){t.samples.push({time:frame.time,bbox:[...d.bbox],score:d.score,class:d.class});free.delete(t);used.add(d);}
   return used;
  };
  const usedHigh=assign(high);assign(low);
  for(const d of high)if(!usedHigh.has(d)){const index=tracks.length;tracks.push({id:`t${index+1}`,index,group:groupOf(d.class),samples:[{time:frame.time,bbox:[...d.bbox],score:d.score,class:d.class}]});}
 }
 // The reported class is the most frequent one (ties: higher summed score, then name), never a mix.
 return tracks.map(({id,group,samples})=>{const tally=new Map();for(const x of samples){const v=tally.get(x.class)||{n:0,score:0};v.n++;v.score+=x.score;tally.set(x.class,v);}
  const cls=[...tally].sort((a,b)=>b[1].n-a[1].n||b[1].score-a[1].score||(a[0]<b[0]?-1:1))[0][0];return {id,class:cls,group,samples};});
}

function previousFrameTime(times,t,interval){let p=null;for(const x of times){if(x<t-EPS)p=x;else break;}return p??t-interval;}
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
const event=(rule,track,fields)=>({rule,label:TIMELINE_RULES[rule].label,track:track.id,class:track.class,...fields,duration:fields.end-fields.start});

function vehicleStops(tracks,ctx){
 const {s,zone,lastTime}=ctx,out=[];
 for(const track of tracks){
  if(!TIMELINE_RULES.vehicle_stop.classes.includes(track.class))continue;
  const S=track.samples;let a=1;
  while(a<S.length){
   const radius=s.still_fraction*boxSize(S[a].bbox,s.aspect);let k=a;
   while(k+1<S.length&&S[k+1].time-S[k].time<=s.max_gap_seconds+EPS&&shift(S[k+1].bbox,S[a].bbox,s.aspect)<=radius+EPS)k++;
   let confirm=-1;for(let j=a;j<=k;j++)if(S[j].time-S[a].time>=s.dwell_seconds-EPS){confirm=j;break;}
   // The stay must follow movement: the latest of the three steps before it moved at least moving_fraction sizes/s.
   let moved=-1;
   for(let j=a-1;j>=Math.max(0,a-3);j--){const dt=S[j+1].time-S[j].time;if(dt>s.max_gap_seconds+EPS)break;if(shift(S[j+1].bbox,S[j].bbox,s.aspect)/dt>=s.moving_fraction*boxSize(S[j+1].bbox,s.aspect)-EPS){moved=j;break;}}
   if(confirm>=0&&moved>=0&&insideZone(S[a].bbox,zone)){
    const run=S.slice(a,confirm+1);
    out.push(event('vehicle_stop',track,{start:S[moved].time,end:S[confirm].time,keyframe_time:S[a].time,bbox:S[a].bbox,score:mean(run.map(x=>x.score)),condition_seconds:S[k].time-S[a].time,condition_open:k===S.length-1&&S[k].time>=lastTime-EPS}));
    a=k+1;
   }else a++;
  }
 }
 return out;
}
function objectsLeft(tracks,ctx){
 const {s,zone,frameByTime,times,firstTime,lastTime}=ctx,out=[];
 const unattended=sample=>!(frameByTime.get(sample.time)?.detections||[]).some(d=>d.class==='person'&&d.score>=s.detection_floor-EPS&&coveredFraction(sample.bbox,d.bbox)>s.unattended_overlap);
 for(const track of tracks){
  if(!TIMELINE_RULES.object_left.classes.includes(track.class))continue;
  const S=track.samples;let a=0;
  while(a<S.length){
   const radius=s.still_fraction*boxSize(S[a].bbox,s.aspect);
   // A stay begins where the object first appears during the clip, or after it was carried, moved or covered by a
   // person. An object already standing there in the first analysed frame is not an event.
   const begins=a===0?S[0].time>firstTime+EPS:(S[a].time-S[a-1].time>s.max_gap_seconds+EPS||!unattended(S[a-1])||shift(S[a-1].bbox,S[a].bbox,s.aspect)>radius+EPS);
   if(!begins||!unattended(S[a])){a++;continue;}
   let k=a;
   while(k+1<S.length&&S[k+1].time-S[k].time<=s.max_gap_seconds+EPS&&shift(S[k+1].bbox,S[a].bbox,s.aspect)<=radius+EPS&&unattended(S[k+1]))k++;
   let confirm=-1;for(let j=a;j<=k;j++)if(S[j].time-S[a].time>=s.dwell_seconds-EPS){confirm=j;break;}
   if(confirm>=0&&insideZone(S[a].bbox,zone)){
    const run=S.slice(a,confirm+1);
    out.push(event('object_left',track,{start:previousFrameTime(times,S[a].time,s.sample_interval_seconds),end:S[confirm].time,keyframe_time:S[a].time,bbox:S[a].bbox,score:mean(run.map(x=>x.score)),condition_seconds:S[k].time-S[a].time,condition_open:k===S.length-1&&S[k].time>=lastTime-EPS}));
   }
   a=k+1;
  }
 }
 return out;
}
function personAppears(tracks,ctx){
 const {s,zone,times,firstTime,lastTime}=ctx,out=[],m=s.edge_margin;
 for(const track of tracks){
  const S=track.samples;
  if(track.class!=='person'||S.length<s.min_person_samples||S[0].time<=firstTime+EPS)continue;
  const b=S[0].bbox;
  if(!insideZone(b,zone)||b[0]<m||b[1]<m||b[0]+b[2]>1-m||b[1]+b[3]>1-m)continue;
  const confirm=S[s.min_person_samples-1];
  out.push(event('person_appears',track,{start:previousFrameTime(times,S[0].time,s.sample_interval_seconds),end:confirm.time,keyframe_time:S[0].time,bbox:b,score:mean(S.slice(0,s.min_person_samples).map(x=>x.score)),condition_seconds:S.at(-1).time-S[0].time,condition_open:S.at(-1).time>=lastTime-EPS}));
 }
 return out;
}

/** frames: [{time, detections:[{class, score, bbox:[x,y,w,h] normalised}]}] at a fixed interval.
 * options.zone: [x,y,w,h] normalised (whole frame by default); options.aspect: frame width / height. */
export function buildTimeline(frames,{zone=[0,0,1,1],aspect=1,settings={},rules=RULE_ORDER}={}){
 if(!Array.isArray(zone)||zone.length!==4||zone.some(v=>!Number.isFinite(v))||zone[2]<=0||zone[3]<=0)throw new Error('关注区域坐标无效');
 for(const r of rules)if(!TIMELINE_RULES[r])throw new Error(`未知时间线规则：${r}`);
 const s=checkSettings({...settings,aspect}),sorted=checkFrames(frames),times=sorted.map(f=>f.time);
 const tracks=trackFrames(sorted,s);
 const ctx={s,zone,times,frameByTime:new Map(sorted.map(f=>[f.time,f])),firstTime:times[0]??0,lastTime:times.at(-1)??0};
 const make={vehicle_stop:vehicleStops,object_left:objectsLeft,person_appears:personAppears};
 const events=rules.flatMap(r=>make[r](tracks,ctx)).sort((a,b)=>a.start-b.start||RULE_ORDER.indexOf(a.rule)-RULE_ORDER.indexOf(b.rule)||(a.track<b.track?-1:a.track>b.track?1:0))
  .map((e,i)=>({id:`e${String(i+1).padStart(3,'0')}`,...e}));
 const {aspect:_,...recorded}=s;
 return {settings:recorded,zone:[...zone],aspect,frames_analysed:sorted.length,first_time:ctx.firstTime,last_time:ctx.lastTime,tracks,events};
}

/** Short, plain statements of what the rules cannot see, shown next to the timeline and written into the export. */
export const TIMELINE_LIMITS=Object.freeze([
 '没有事件不等于安全：漏检、遮挡、夜间、远处小目标都会让时间线空着。',
 '每秒只看 1 帧：短于 1 秒的动作可能落在两帧之间。',
 '只认 COCO 80 类：纸箱、快递包裹、推车、门本身都不在其中。',
 '轨迹在遮挡后可能换号，同一个人或物会被算两次。',
 '时间是素材内的秒数，不是监控时钟；事件只是待人工核实的线索。'
]);
