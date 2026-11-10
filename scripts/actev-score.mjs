/** ActEV-style temporal activity scoring, written for docs/validation/event-timeline-protocol.md.
 * Follows the NIST ActEV SDL evaluation plan (Phase 3, 2021-08-03), sections 6, 6.1 and 6.5:
 * - Tfa = Σ_t max(0, S'(t) − R'(t)) / NR, where S' and R' count system and reference instances active at time t
 *   and NR is the clip time not covered by any reference instance. Computed exactly on intervals, summed over clips.
 * - A reference instance of ≥ 1 s is detected by a system instance overlapping it by ≥ 1 s (shorter references:
 *   ≥ 50% of their length). One-to-one Hungarian alignment that prefers higher presence confidence.
 * - Pmiss(x) at Tfa = x: 1.0 below the first achieved Tfa, linear between DET points, the minimum after the last.
 * - nAUDC_a = (1/a) ∫_0^a Pmiss(x) dx.
 * It is a re-implementation for this project, not NIST's ActEV_Scorer; numbers are "ActEV-style". */

export const overlapSeconds=(a,b)=>Math.max(0,Math.min(a.end,b.end)-Math.max(a.start,b.start));
export function mappable(ref,sys){
 const length=ref.end-ref.start,inter=overlapSeconds(ref,sys);
 return length>=1?inter>=1-1e-9:inter>=.5*length-1e-9;
}
/** Minimum-cost assignment for an n×m matrix with n ≤ m (Kuhn–Munkres with potentials). Returns column per row. */
export function hungarianMin(cost){
 const n=cost.length,m=n?cost[0].length:0;if(!n)return [];if(n>m)throw new Error('hungarianMin needs rows ≤ columns');
 const u=new Array(n+1).fill(0),v=new Array(m+1).fill(0),p=new Array(m+1).fill(0),way=new Array(m+1).fill(0);
 for(let i=1;i<=n;i++){
  p[0]=i;let j0=0;const minv=new Array(m+1).fill(Infinity),used=new Array(m+1).fill(false);
  do{
   used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;
   for(let j=1;j<=m;j++)if(!used[j]){const cur=cost[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}
   for(let j=0;j<=m;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;
   j0=j1;
  }while(p[j0]!==0);
  do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);
 }
 const assignment=new Array(n).fill(-1);for(let j=1;j<=m;j++)if(p[j])assignment[p[j]-1]=j-1;return assignment;
}
/** Align references and system instances of one activity in one clip. presence confidence range comes from the
 * whole system output for that activity (scoreRange), as in the plan's APcon. Returns [{ref, sys}] index pairs. */
export function alignClip(refs,sys,scoreRange){
 if(!refs.length||!sys.length)return [];
 const [lo,hi]=scoreRange??[Math.min(...sys.map(s=>s.score)),Math.max(...sys.map(s=>s.score))];
 const apcon=s=>hi>lo?(s.score-lo)/(hi-lo):0;
 // Kernel 1 + APcon for a mappable pair, −1 for an unmapped system instance and 0 for an unmapped reference, so a
 // mapped pair is worth 2 + APcon against leaving both unmapped. Weight 0 marks pairs that cannot be mapped.
 const w=refs.map(r=>sys.map(s=>mappable(r,s)?2+apcon(s):0));
 const transpose=refs.length>sys.length,mat=transpose?sys.map((_,j)=>refs.map((_,i)=>w[i][j])):w;
 const max=3,assignment=hungarianMin(mat.map(row=>row.map(x=>max-x)));
 const pairs=[];
 assignment.forEach((col,row)=>{if(col<0)return;const [i,j]=transpose?[col,row]:[row,col];if(w[i][j]>0)pairs.push({ref:i,sys:j});});
 return pairs.sort((a,b)=>a.ref-b.ref);
}
/** ∫ max(0, S'(t) − R'(t)) dt and the non-reference duration within [0, duration]. */
export function falseAlarmTime(refs,sys,duration){
 const clip=x=>({start:Math.max(0,Math.min(duration,x.start)),end:Math.max(0,Math.min(duration,x.end))});
 const R=refs.map(clip),S=sys.map(clip),cuts=[...new Set([0,duration,...R.flatMap(x=>[x.start,x.end]),...S.flatMap(x=>[x.start,x.end])])].sort((a,b)=>a-b);
 let fa=0,nr=0;
 for(let i=0;i+1<cuts.length;i++){
  const a=cuts[i],b=cuts[i+1],mid=(a+b)/2;if(b<=a)continue;
  const r=R.filter(x=>x.start<=mid&&mid<x.end).length,s=S.filter(x=>x.start<=mid&&mid<x.end).length;
  fa+=Math.max(0,s-r)*(b-a);if(!r)nr+=b-a;
 }
 return {false_alarm_seconds:fa,non_reference_seconds:nr};
}
export function pmissAt(det,x){
 // det: points sorted by decreasing threshold, so Tfa grows and Pmiss falls.
 if(!det.length)return 1;
 if(x<det[0].tfa)return 1;
 for(let i=0;i+1<det.length;i++){const a=det[i],b=det[i+1];if(x>=a.tfa&&x<=b.tfa){if(b.tfa===a.tfa)return Math.min(a.pmiss,b.pmiss);return a.pmiss+(b.pmiss-a.pmiss)*(x-a.tfa)/(b.tfa-a.tfa);}}
 return Math.min(...det.map(p=>p.pmiss));
}
export function naudc(det,a=.2,steps=20000){let sum=0;for(let i=0;i<steps;i++)sum+=pmissAt(det,(i+.5)*a/steps);return sum/steps;}
const tiou=(r,s)=>{const i=overlapSeconds(r,s),u=Math.max(r.end,s.end)-Math.min(r.start,s.start);return u>0?i/u:0;};
const quantile=(xs,q)=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(q*s.length))];};

/** clips: [{id, duration, refs:[{start,end}], sys:[{start,end,score}]}] for one activity. */
export function scoreActivity(clips,{tfaPoints=[.02,.1,.2],naudcRange=.2}={}){
 const allSys=clips.flatMap(c=>c.sys),range=allSys.length?[Math.min(...allSys.map(s=>s.score)),Math.max(...allSys.map(s=>s.score))]:[0,0];
 const aligned=clips.map(c=>({...c,pairs:alignClip(c.refs,c.sys,range)}));
 const nRef=clips.reduce((a,c)=>a+c.refs.length,0),nSys=allSys.length;
 const nr=aligned.reduce((a,c)=>a+falseAlarmTime(c.refs,[],c.duration).non_reference_seconds,0);
 const thresholds=[...new Set(allSys.map(s=>s.score))].sort((a,b)=>b-a);
 const det=thresholds.map(th=>{
  let matched=0,fa=0;
  for(const c of aligned){matched+=c.pairs.filter(p=>c.sys[p.sys].score>=th).length;fa+=falseAlarmTime(c.refs,c.sys.filter(s=>s.score>=th),c.duration).false_alarm_seconds;}
  return {threshold:th,tfa:nr>0?fa/nr:null,pmiss:nRef?1-matched/nRef:null,matched,false_alarm_seconds:fa};
 });
 const ious=aligned.flatMap(c=>c.pairs.map(p=>tiou(c.refs[p.ref],c.sys[p.sys])));
 const matched=aligned.reduce((a,c)=>a+c.pairs.length,0),minutes=clips.reduce((a,c)=>a+c.duration,0)/60;
 const last=det.at(-1);
 return {
  references:nRef,system_instances:nSys,non_reference_seconds:nr,
  operating_point:{matched,pmiss:nRef?1-matched/nRef:null,tfa:last?.tfa??0,false_alarm_seconds:last?.false_alarm_seconds??0,unmatched_system_instances:nSys-matched,unmatched_per_minute:minutes?(nSys-matched)/minutes:null},
  pmiss_at_tfa:nRef?Object.fromEntries(tfaPoints.map(x=>[String(x),pmissAt(det.filter(p=>p.tfa!==null),x)])):null,
  naudc_range:naudcRange,naudc:nRef?naudc(det.filter(p=>p.tfa!==null),naudcRange):null,
  temporal_iou:{pairs:ious.length,mean:ious.length?ious.reduce((a,b)=>a+b,0)/ious.length:null,median:quantile(ious,.5),at_least_0_5:ious.filter(x=>x>=.5).length},
  det
 };
}
/** Wilson 95% interval for k of n. */
export function wilson(k,n,z=1.96){if(!n)return null;const p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-h),Math.min(1,c+h)];}
