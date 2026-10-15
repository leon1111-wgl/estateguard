/** Deterministic, auditable rules on actual model detections. No learned behavior classifier. */
const vehicles=new Set(['car','truck','bus','motorcycle']);
const furniture=new Set(['couch','chair','bed','dining table','refrigerator','suitcase']);
export function boxIoU(a,b){const w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]));const h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));const intersection=w*h;return intersection/(a[2]*a[3]+b[2]*b[3]-intersection||1);}
export function trackDetections(frames,maxGap=1.6){
 const tracks=[];
 for(const frame of frames){
  const used=new Set();
  for(const detection of [...frame.detections].sort((a,b)=>b.score-a.score)){
   let best=null,bestOverlap=.2;
   for(const track of tracks){const prev=track.samples.at(-1);if(used.has(track.id)||track.class!==detection.class||frame.time<=prev.time||frame.time-prev.time>maxGap)continue;const overlap=boxIoU(prev.bbox,detection.bbox);if(overlap>bestOverlap){bestOverlap=overlap;best=track;}}
   if(!best){best={id:`track-${tracks.length+1}`,class:detection.class,samples:[]};tracks.push(best);}
   best.samples.push({time:frame.time,bbox:detection.bbox,score:detection.score});used.add(best.id);
  }
 }
 return tracks;
}
const centre=b=>[b[0]+b[2]/2,b[1]+b[3]/2];
const inside=(box,roi)=>{const [x,y]=centre(box);return x>=roi[0]&&x<=roi[0]+roi[2]&&y>=roi[1]&&y<=roi[1]+roi[3];};
export function makeCandidates(tracks,config){
 const {roi,rule}=config;
 if(!['objects','access','lift','parking','direction'].includes(rule))throw new Error('未知场景规则');
 if(!Array.isArray(roi)||roi.length!==4||roi.some(x=>!Number.isFinite(x))||roi[0]<0||roi[1]<0||roi[2]<=0||roi[3]<=0||roi[0]+roi[2]>1.00001||roi[1]+roi[3]>1.00001)throw new Error('区域坐标必须位于画面内，且宽高大于 0');
 if(rule==='objects')return [];
 if(!Number.isFinite(Date.parse(config.started_at)))throw new Error('请输入有效的录像开始时间');
 const candidates=[];
 for(const track of tracks){
  // Split visits when a track leaves the ROI; never add two separate stays.
  const runs=[];let current=[];
  for(const sample of track.samples){if(inside(sample.bbox,roi)){current.push(sample);}else if(current.length){runs.push(current);current=[];}}
  if(current.length)runs.push(current);
  for(const samples of runs){
   const first=samples[0],last=samples.at(-1),span=last.time-first.time;
   let category=null,why='';
   if(rule==='access'&&vehicles.has(track.class)){category='blocked_access';why='车辆中心落在用户指定区域。是否为通道、是否阻塞，仍需人工确认。';}
   if(rule==='lift'&&furniture.has(track.class)&&samples.some(s=>s.bbox[2]*s.bbox[3]>=.04)){category='bulky_load';why='检测到支持类别的物品，且画面占比达到示例阈值。是否为客梯、是否允许搬运，需人工确认。';}
   if(rule==='parking'&&config.is_video&&vehicles.has(track.class)&&samples.length>=3&&span>=config.dwell_seconds){
    const origin=centre(first.bbox);const movement=Math.max(...samples.map(s=>Math.hypot(centre(s.bbox)[0]-origin[0],centre(s.bbox)[1]-origin[1])));
    if(movement<=.06){category='illegal_parking';why=`采样中车辆在指定区域内持续约 ${span.toFixed(1)} 秒，中心位移未超过画面对角坐标的 0.06。不是连续停车时长的证明。`;}
   }
   if(rule==='direction'&&config.is_video&&vehicles.has(track.class)&&samples.length>=3){
    const a=centre(first.bbox),b=centre(last.bbox),vector={right:[1,0],left:[-1,0],down:[0,1],up:[0,-1]}[config.expected_direction];
    if(!vector)throw new Error('请选择预期行驶方向');
    if((b[0]-a[0])*vector[0]+(b[1]-a[1])*vector[1]<-.12){category='wrong_way';why='匿名轨迹与用户指定方向相反，投影位移超过归一化画面的 0.12。需核对道路标识、镜头运动和关联是否正确。';}
   }
   if(!category)continue;
   const base=Date.parse(config.started_at);const id=`vision-${track.id}-${candidates.length+1}`;
   candidates.push({id,camera:config.camera,zone:config.zone,track:track.id,category,start:new Date(base+first.time*1000).toISOString(),end:new Date(base+Math.max(first.time+.001,last.time)*1000).toISOString(),score:Math.max(...samples.map(s=>s.score)),quality:.4,summary:`模型检测：${track.class}；${samples.length} 个采样帧。${why} 单图时间窗仅为格式占位，不表示停留时间。`,evidence:samples.slice(0,20).map(s=>`${config.media_name} @ ${s.time.toFixed(2)}s`)});
  }
 }
 return candidates;
}
