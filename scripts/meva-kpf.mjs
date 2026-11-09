/** MEVA KPF annotation reading and the label side of the event-timeline evaluation
 * (docs/validation/event-timeline-protocol.md). Pure functions; the score script fetches the files on Actions. */

/** Each KPF line is a YAML flow mapping in Python-literal style, e.g.
 *  - {'act': {'act2': {'vehicle_stops': 1.0}, 'actors': [...], 'id2': 14, 'timespan': [{'tsr0': [3444, 3590]}]}} */
export function parseKpf(text){
 const records=[];let skipped=0;
 for(const raw of text.split('\n')){
  const line=raw.trim();if(!line.startsWith('- {'))continue;
  try{records.push(JSON.parse(line.slice(2).replace(/'/g,'"').replace(/\bTrue\b/g,'true').replace(/\bFalse\b/g,'false').replace(/\bNone\b/g,'null')));}catch{skipped++;}
 }
 return {records,skipped};
}
const span=ts=>{const t=ts?.[0]?.tsr0;return Array.isArray(t)&&t.length===2?t.map(Number):null;};
/** Activity instances: [{activity, id, frames:[f0,f1], actors:[{id, frames}]}]. */
export function activities(text){
 return parseKpf(text).records.filter(r=>r.act).map(({act})=>({activity:Object.keys(act.act2||{})[0],id:act.id2,frames:span(act.timespan),actors:(act.actors||[]).map(a=>({id:a.id1,frames:span(a.timespan)}))})).filter(a=>a.activity&&a.frames);
}
/** Actor types: Map(actor id → type name). */
export function types(text){return new Map(parseKpf(text).records.filter(r=>r.types).map(({types:t})=>[t.id1,Object.keys(t.cset3||{})[0]]));}
/** Actor boxes at the given frames only (the sampled ones): Map(frame → [{actor, box:[x1,y1,x2,y2]}]). */
export function geomAt(text,frames){
 const want=new Set(frames),out=new Map();
 for(const raw of text.split('\n')){
  const m=/'g0': '(\d+) (\d+) (\d+) (\d+)'.*'id1': (\d+).*'ts0': (\d+)/.exec(raw);if(!m)continue;
  const frame=Number(m[6]);if(!want.has(frame))continue;
  if(!out.has(frame))out.set(frame,[]);out.get(frame).push({actor:Number(m[5]),box:[1,2,3,4].map(i=>Number(m[i]))});
 }
 return out;
}
/** Reference instances in seconds for one activity; the last annotated frame is inclusive. Instances that start after
 * the analysed range are dropped and the rest are clipped to it (protocol). */
export function references(acts,activity,fps,analysedSeconds){
 return acts.filter(a=>a.activity===activity).map(a=>({id:a.id,start:a.frames[0]/fps,end:(a.frames[1]+1)/fps,actors:a.actors.map(x=>x.id)}))
  .filter(r=>r.start<analysedSeconds).map(r=>({...r,end:Math.min(r.end,analysedSeconds)}));
}
const iou=(a,b)=>{const w=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1])),i=w*h,u=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i;return u>0?i/u:0;};
/** Normalised [x,y,w,h] → pixel [x1,y1,x2,y2] in the source frame. */
export const toPixels=(b,width,height)=>[b[0]*width,b[1]*height,(b[0]+b[2])*width,(b[1]+b[3])*height];
export const HEIGHT_BUCKETS=Object.freeze([[0,50],[50,100],[100,200],[200,Infinity]]);
/** Failure-mode diagnostics. geom: Map(frame → actors) at sampled frames; detFrames: [{frame, time, detections}];
 * tracks from the timeline. Small people: person-box recall by box height. Tracks: distinct track ids per actor
 * and switches between consecutive matched samples. */
export function diagnostics({geom,actorTypes,detFrames,tracks,width,height,minimumScore,matchIoU=.3}){
 const byFrame=new Map(detFrames.map(f=>[f.frame,f])),trackAt=new Map();
 for(const t of tracks)for(const s of t.samples){const key=s.time.toFixed(4);if(!trackAt.has(key))trackAt.set(key,[]);trackAt.get(key).push({id:t.id,group:t.group,box:toPixels(s.bbox,width,height)});}
 const buckets=HEIGHT_BUCKETS.map(([lo,hi])=>({min_px:lo,max_px:Number.isFinite(hi)?hi:null,boxes:0,found:0}));
 const perActor=new Map();
 for(const [frame,actors] of geom){
  const f=byFrame.get(frame);if(!f)continue;
  const dets=f.detections.filter(d=>d.score>=minimumScore).map(d=>({class:d.class,box:toPixels(d.bbox,width,height)}));
  for(const a of actors){
   const type=actorTypes.get(a.actor);
   if(type==='person'){const h=a.box[3]-a.box[1],b=buckets.find(x=>h>=x.min_px&&(x.max_px===null||h<x.max_px));b.boxes++;if(dets.some(d=>d.class==='person'&&iou(d.box,a.box)>=matchIoU))b.found++;}
   if(type!=='person'&&type!=='vehicle')continue;
   const group=type==='person'?'person':'vehicle',cands=(trackAt.get(f.time.toFixed(4))||[]).filter(t=>t.group===group).map(t=>({...t,iou:iou(t.box,a.box)})).filter(t=>t.iou>=matchIoU).sort((x,y)=>y.iou-x.iou);
   if(!perActor.has(a.actor))perActor.set(a.actor,{type,samples:[]});perActor.get(a.actor).samples.push({frame,track:cands[0]?.id??null});
  }
 }
 const idStats={};
 for(const type of ['person','vehicle']){
  const actors=[...perActor.values()].filter(a=>a.type===type).map(a=>a.samples.sort((x,y)=>x.frame-y.frame).map(s=>s.track).filter(Boolean)).filter(xs=>xs.length>=3);
  const switches=actors.reduce((n,xs)=>n+xs.filter((x,i)=>i&&x!==xs[i-1]).length,0),matched=actors.reduce((n,xs)=>n+xs.length,0);
  idStats[type]={actors_with_3_matched_samples:actors.length,matched_samples:matched,mean_distinct_tracks_per_actor:actors.length?actors.reduce((n,xs)=>n+new Set(xs).size,0)/actors.length:null,id_switches:switches,switches_per_100_matched_samples:matched?100*switches/matched:null};
 }
 return {person_recall_by_height_px:buckets,id_switches:idStats};
}
/** Put-down objects: the non-person actor of each person_puts_down_object instance, its type, and whether a COCO
 * backpack / handbag / suitcase detection overlaps it (IoU ≥ 0.1) at a sampled frame from the instance end to 5 s on. */
export function putDownObjects({acts,actorTypes,geom,detFrames,fps,width,height,minimumScore}){
 const byFrame=new Map(detFrames.map(f=>[f.frame,f])),rows=[];
 for(const a of acts.filter(x=>x.activity==='person_puts_down_object')){
  for(const actor of a.actors){
   const type=actorTypes.get(actor.id);if(type==='person')continue;
   let seen=false,boxes=0;
   for(const [frame,actors] of geom){if(frame<a.frames[1]||frame>a.frames[1]+5*fps)continue;const box=actors.find(x=>x.actor===actor.id)?.box;const f=byFrame.get(frame);if(!box||!f)continue;boxes++;
    if(f.detections.some(d=>['backpack','handbag','suitcase'].includes(d.class)&&d.score>=minimumScore&&iou(toPixels(d.bbox,width,height),box)>=.1))seen=true;}
   rows.push({type:type||'unknown',annotated_boxes_after:boxes,coco_carry_class_detected:seen});
  }
 }
 const byType={};for(const r of rows){const t=byType[r.type]||(byType[r.type]={objects:0,with_boxes:0,detected:0});t.objects++;if(r.annotated_boxes_after)t.with_boxes++;if(r.coco_carry_class_detected)t.detected++;}
 return byType;
}
