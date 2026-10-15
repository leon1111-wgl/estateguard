/** A local acknowledgement of scene metadata, never automatic verification of it. */
const fail=(field,message)=>{throw Object.assign(new Error(message),{field});};
export function parseRecordingTime(value){
 if(!value)return null;
 const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
 if(!parts)fail('vision-start','请输入有效的素材起始时间（UTC+8）。');
 const [year,month,day,hour,minute,second]=parts.slice(1).map(x=>Number(x||0));
 const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)fail('vision-start','素材起始时间不是有效的日历日期。');
 return `${value.length===16?value+':00':value}+08:00`;
}
function signature(revision,p){return JSON.stringify([revision,p.rule,p.camera,p.zone,p.roi,p.started_at,p.offset_seconds,p.is_video,p.expected_direction]);}
function requireMetadata(p){
 for(const [key,field,label] of [['camera','vision-camera','摄像头 / 素材来源'],['zone','vision-zone','区域名称']])if(typeof p[key]!=='string'||!p[key].trim()||p[key].length>100)fail(field,`请填写本素材的${label}（最多100字）。`);
 if(!p.started_at||!Number.isFinite(Date.parse(p.started_at)))fail('vision-start','生成候选前请填写本素材的实际起始时间；未知时可选择通用物体检测。');
}
export function confirmContext(revision,params,confirmedAt=new Date().toISOString()){
 if(!revision)fail('analysis-file','请先选择素材。');
 requireMetadata(params);
 return {media_revision:revision,signature:signature(revision,params),confirmed_at:confirmedAt};
}
export function isContextConfirmed(confirmation,revision,params){return !!confirmation&&confirmation.media_revision===revision&&confirmation.signature===signature(revision,params);}
export function validateContext(params,revision,confirmation){
 if(params.rule==='objects')return;
 requireMetadata(params);
 if(!isContextConfirmed(confirmation,revision,params))fail('vision-context-confirmed','请核对当前素材的来源、关注区域与采集时间，再勾选确认。');
}
export function reusableScene(params,geometry){
 const {camera,zone,rule,expected_direction,dwell_seconds}=params;
 return {geometry:{...geometry},settings:{camera,zone,rule,expected_direction,dwell_seconds,roi:[...params.roi]}};
}
export function restoreScene(scene,geometry){
 const changed=scene.geometry.width!==geometry.width||scene.geometry.height!==geometry.height;
 return {settings:{...scene.settings,roi:changed?[0,0,1,1]:[...scene.settings.roi],started_at:null,offset_seconds:0},roi_reset:changed};
}
