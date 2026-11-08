/** Frozen-encoder occupancy heads: calibrated scores, risk-controlled routing and on-site
 * few-shot adaptation. Pure functions; mirrors scripts/transfer_learning.py. Labels from the
 * dataset are never inputs; adaptation only uses human-confirmed decisions. */
export const FREE_GRID=[.005,.01,.02,.03,.05,.075,.1,.15,.2,.25,.3,.35,.4,.45,.5];
export const DINO_SIZE=112,DINO_MEAN=[.485,.456,.406],DINO_STD=[.229,.224,.225];
const sigmoid=z=>1/(1+Math.exp(-Math.max(-40,Math.min(40,z))));
export function validateHead(head,expected){
 if(head?.format!=='estateguard-parking-transfer-head'||head.version!==1)throw new Error('迁移分类头格式不受支持');
 if(head.feature_version!==expected.feature_version||head.features!==expected.features)throw new Error('分类头与编码器特征版本不一致');
 for(const key of ['mean','scale','w'])if(!Array.isArray(head[key])||head[key].length!==head.features||!head[key].every(Number.isFinite))throw new Error('分类头参数无效');
 if(!Number.isFinite(head.b)||!(head.temperature>0))throw new Error('分类头参数无效');
 return head;
}
export function standardize(features,head){const out=new Float64Array(head.features);for(let i=0;i<head.features;i++)out[i]=(features[i]-head.mean[i])/head.scale[i];return out;}
export function headLogit(z,w,b){let s=b;for(let i=0;i<z.length;i++)s+=z[i]*w[i];return s;}
/** Returns raw occupied probability and the temperature-calibrated one used for routing. */
export function predictHead(features,head,adapted=null){
 if(features.length!==head.features)throw new Error('特征维度不匹配');
 const z=headLogit(standardize(features,head),adapted?.w||head.w,adapted?adapted.b:head.b);
 return {score:sigmoid(z),calibrated:sigmoid(z/head.temperature)};
}
export function routeScore(p,routing){
 if(!Number.isFinite(p)||p<0||p>1)throw new Error('无效模型分数');
 if(routing?.t_free!=null&&p<=routing.t_free)return 'free';
 if(routing?.t_busy!=null&&p>=routing.t_busy)return 'busy';
 return 'review';
}
const lgamma=x=>{// Lanczos approximation, adequate for the binomial tails used here.
 const g=7,c=[0.99999999999980993,676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
 if(x<.5)return Math.log(Math.PI/Math.abs(Math.sin(Math.PI*x)))-lgamma(1-x);
 x-=1;let a=c[0];const t=x+g+.5;for(let i=1;i<9;i++)a+=c[i]/(x+i);return .5*Math.log(2*Math.PI)+(x+.5)*Math.log(t)-t+Math.log(a);
};
export function binomCdf(x,n,p){
 if(p<=0)return 1;if(p>=1)return x>=n?1:0;let s=0;
 for(let k=0;k<=x;k++)s+=Math.exp(lgamma(n+1)-lgamma(k+1)-lgamma(n-k+1)+k*Math.log(p)+(n-k)*Math.log1p(-p));
 return Math.min(1,s);
}
/** One-sided Clopper-Pearson upper bound on an error rate. */
export function cpUpper(x,n,level){if(n===0||x>=n)return 1;let lo=x/n,hi=1;for(let i=0;i<100;i++){const mid=(lo+hi)/2;if(binomCdf(x,n,mid)>level)lo=mid;else hi=mid;}return hi;}
// With units (camera|slot|date) each unit counts once and is wrong if any of its samples is wrong,
// so repeated snapshots of one parked car are not mistaken for independent evidence.
function count(scores,labels,units,accept,wrongLabel){
 if(!units){let n=0,x=0;for(let i=0;i<scores.length;i++)if(accept(scores[i])){n++;x+=labels[i]===wrongLabel;}return [n,x];}
 const seen=new Set(),bad=new Set();for(let i=0;i<scores.length;i++)if(accept(scores[i])){seen.add(units[i]);if(labels[i]===wrongLabel)bad.add(units[i]);}return [seen.size,bad.size];
}
/** Learn-then-Test with Bonferroni across both sides. Inputs are human-confirmed labels only. */
export function selectRouting(scores,labels,{alpha_free=.01,alpha_busy=.02,delta=.05,grid=FREE_GRID,units=null}={}){
 if(scores.length!==labels.length||units&&units.length!==labels.length)throw new Error('分数与人工结论数量不一致');
 const level=delta/(2*grid.length);let free=null,busy=null;const tests=[];
 for(const t of grid){
  let [n,x]=count(scores,labels,units,p=>p<=t,1);
  let ub=cpUpper(x,n,level);tests.push({side:'free',threshold:t,accepted:n,errors:x,upper_bound:ub,passed:ub<=alpha_free});if(ub<=alpha_free&&(!free||n>free.n))free={t,n};
  const tb=Math.round((1-t)*1e6)/1e6;[n,x]=count(scores,labels,units,p=>p>=tb,0);
  ub=cpUpper(x,n,level);tests.push({side:'busy',threshold:tb,accepted:n,errors:x,upper_bound:ub,passed:ub<=alpha_busy});if(ub<=alpha_busy&&(!busy||n>busy.n))busy={t:tb,n};
 }
 return {t_free:free?.t??null,t_busy:busy?.t??null,alpha_free,alpha_busy,delta,per_test_level:level,calibration_n:labels.length,unit:units?'camera-slot-date':'sample',calibration_units:units?new Set(units).size:labels.length,tests};
}
/** Smallest number of error-free accepted samples that could certify a target at this level. */
export function minimumEvidence(alpha,level){return Math.ceil(Math.log(level)/Math.log(1-alpha));}
/** L2-SP head adaptation: mean BCE + lam*||w-w0||^2, full-batch Adam from the source head. */
export function adaptHead(rows,labels,head,{lam=head.adaptation?.lam??.01,lr=head.adaptation?.lr??.01,steps=head.adaptation?.steps??150}={}){
 if(!rows.length||rows.length!==labels.length)throw new Error('自适应需要至少一条人工确认结论');
 const d=head.features,n=rows.length,w0=Float64Array.from(head.w),w=Float64Array.from(head.w),mw=new Float64Array(d),vw=new Float64Array(d),g=new Float64Array(d);
 let b=head.b,mb=0,vb=0;
 for(let step=1;step<=steps;step++){
  g.fill(0);let gb=0;
  for(let i=0;i<n;i++){const z=rows[i];const err=(sigmoid(headLogit(z,w,b))-labels[i])/n;gb+=err;for(let j=0;j<d;j++)g[j]+=z[j]*err;}
  const c1=1-.9**step,c2=1-.999**step;
  for(let j=0;j<d;j++){const gj=g[j]+2*lam*(w[j]-w0[j]);mw[j]=.9*mw[j]+.1*gj;vw[j]=.999*vw[j]+.001*gj*gj;w[j]-=lr*(mw[j]/c1)/(Math.sqrt(vw[j]/c2)+1e-8);}
  mb=.9*mb+.1*gb;vb=.999*vb+.001*gb*gb;b-=lr*(mb/c1)/(Math.sqrt(vb/c2)+1e-8);
 }
 return {w,b,n,busy:labels.reduce((s,v)=>s+v,0),lam,lr,steps};
}
/** DINOv2 input: half-pixel bilinear resize (no antialias) to 112 (latency budget), ImageNet normalisation, NCHW. */
export function dinoInput(rgba,width,height,size=DINO_SIZE){
 if(rgba.length!==width*height*4)throw new Error('图片像素尺寸不匹配');
 const out=new Float32Array(3*size*size),plane=size*size;
 for(let oy=0;oy<size;oy++){
  const sy=Math.min(height-1,Math.max(0,(oy+.5)*height/size-.5)),y0=Math.floor(sy),y1=Math.min(y0+1,height-1),wy=sy-y0;
  for(let ox=0;ox<size;ox++){
   const sx=Math.min(width-1,Math.max(0,(ox+.5)*width/size-.5)),x0=Math.floor(sx),x1=Math.min(x0+1,width-1),wx=sx-x0;
   const a=(y0*width+x0)*4,b=(y0*width+x1)*4,c=(y1*width+x0)*4,e=(y1*width+x1)*4;
   for(let ch=0;ch<3;ch++){const top=rgba[a+ch]*(1-wx)+rgba[b+ch]*wx,bottom=rgba[c+ch]*(1-wx)+rgba[e+ch]*wx;out[ch*plane+oy*size+ox]=((top*(1-wy)+bottom*wy)/255-DINO_MEAN[ch])/DINO_STD[ch];}
  }
 }
 return out;
}
/** Linear-probe features: CLS token concatenated with the mean of patch tokens (768 values). */
export function dinoPool(hidden,tokens,dim=384){
 if(hidden.length!==tokens*dim)throw new Error('DINOv2 输出尺寸不匹配');
 const out=new Float64Array(dim*2);for(let j=0;j<dim;j++)out[j]=hidden[j];
 for(let t=1;t<tokens;t++)for(let j=0;j<dim;j++)out[dim+j]+=hidden[t*dim+j];
 for(let j=0;j<dim;j++)out[dim+j]/=tokens-1;
 return Float32Array.from(out);
}
// Drift control (protocol appendix 5): unit-level random spot checks of automatic decisions and an
// anytime-valid sequential revocation rule. Mirrors scripts/transfer_learning.py.
export const AUDIT={fraction:.1,delta:.05,salt:'estateguard-audit-v1',rule:'sprt'};
/** 32-bit FNV-1a over UTF-8 with the MurmurHash3 fmix32 finaliser, scaled to [0,1). */
export function auditHash(value){
 let h=0x811c9dc5;for(const byte of new TextEncoder().encode(value))h=Math.imul(h^byte,0x01000193)>>>0;
 h^=h>>>16;h=Math.imul(h,0x85ebca6b)>>>0;h^=h>>>13;h=Math.imul(h,0xc2b2ae35)>>>0;h^=h>>>16;return (h>>>0)/4294967296;
}
export const auditUnit=(camera,slot,date)=>`${camera}|${slot}|${date}`;
/** Selection depends only on the camera·slot·date identifier, never on scores, labels or the model. */
export function isAudited(unit,fraction=AUDIT.fraction,salt=AUDIT.salt){return auditHash(`${salt}|${unit}`)<fraction;}
/** One-sided Clopper-Pearson lower bound: largest l with P(Bin(n,l)>=x)<=level (x terms, not n-x). */
export function cpLower(x,n,level){if(x<=0||n===0)return 0;let lo=0,hi=x/n;for(let i=0;i<100;i++){const mid=(lo+hi)/2;if(1-binomCdf(x-1,n,mid)>level)hi=mid;else lo=mid;}return lo;}
/** [statistic, revoke] for x error units among n spot-checked units. sprt: log likelihood ratio of p1=2*alpha
 * against alpha, revoking at log(2/delta) (Ville: a side meeting its target is ever revoked with chance <= delta/2).
 * cp: Clopper-Pearson lower bound at level (delta/2)/(x(x+1)), spent over the error count; revoke above alpha. */
export function auditEvidence(x,n,alpha,{delta=AUDIT.delta,rule=AUDIT.rule}={}){
 if(!(alpha>0&&alpha<.5))throw new Error('抽检目标必须在 0 与 0.5 之间');
 if(rule==='sprt'){const p1=2*alpha,llr=x*Math.log(p1/alpha)+(n-x)*Math.log((1-p1)/(1-alpha));return [llr,llr>=Math.log(2/delta)];}
 if(rule==='cp'){const lb=x?cpLower(x,n,(delta/2)/(x*(x+1))):0;return [lb,lb>alpha];}
 throw new Error(`未知撤销规则 ${rule}`);
}
/** events: chronological {unit,side:'free'|'busy',wrong:true|false|null (not reviewed yet)}. A unit counts once per
 * side and is an error unit if any of its spot-checked snapshots on that side was wrong; unreviewed checks count as
 * correct, which can only delay revocation. Sides without a threshold (alpha null) are ignored. Returns per-side
 * counts and the first event index at which the rule revokes that side. */
export function auditMonitor(events,{alpha_free,alpha_busy,delta=AUDIT.delta,rule=AUDIT.rule}={}){
 const out={rule,delta};
 for(const [side,alpha] of [['free',alpha_free],['busy',alpha_busy]]){
  const units=new Set(),bad=new Set();let pending=0,revoked=null;
  if(alpha!=null)events.forEach((e,i)=>{
   if(e.side!==side)return;units.add(e.unit);
   if(e.wrong===null)pending++;
   else if(e.wrong&&!bad.has(e.unit)){bad.add(e.unit);const [statistic,hit]=auditEvidence(bad.size,units.size,alpha,{delta,rule});if(hit&&!revoked)revoked={index:i,units:units.size,error_units:bad.size,statistic};}
  });
  out[side]={alpha:alpha??null,units:units.size,error_units:bad.size,pending,statistic:alpha==null?null:auditEvidence(bad.size,units.size,alpha,{delta,rule})[0],limit:alpha==null?null:rule==='sprt'?Math.log(2/delta):alpha,revoked};
 }
 return out;
}
// Re-calibration after a revocation (protocol appendix 7 / 7.3). Mirrors scripts/transfer_learning.py.
const DAY=/^\d{8}$/;
export const laterDate=(a,b)=>!a?b??null:!b?a:a>b?a:b;
/** Sides that 重新校准 re-selects. Once a side is revoked, a side that is still live keeps its threshold, evidence and
 * spot-check monitor (as in scripts/replay_parking_drift.py): only revoked sides and sides that never passed are
 * re-tested (a never-certified side's region always went to people). Without a revocation, both sides. */
export function recalibrationSides(revoked,routing){
 if(!['free','busy'].some(s=>revoked?.[s]!=null))return ['free','busy'];
 return ['free','busy'].filter(s=>revoked?.[s]!=null||routing?.[`t_${s}`]==null);
}
/** Re-selects only the listed sides. Side s uses the human conclusions dated on or after its own evidence date (null:
 * all), needs at least 2 dates among them, and takes t_s from the usual Learn-then-Test selection on that set, so the
 * other side is never re-tested. items: [{id,score,label,unit,date}]. evidence: ids whose score lies in that side's
 * candidate range (free <= the largest grid value, busy >= 1 minus it); only those can change that side's threshold. */
export function reselectSides(items,sides,{from={},alpha_free=.01,alpha_busy=.02,delta=.05,grid=FREE_GRID}={}){
 const edge=Math.max(...grid),busyEdge=Math.round((1-edge)*1e6)/1e6,out={};
 for(const side of sides){
  if(side!=='free'&&side!=='busy')throw new Error(`未知分流侧 ${side}`);
  const f=from[side]??null,use=items.filter(x=>f===null||x.date>=f),dates=new Set(use.map(x=>x.date)).size;
  const routing=dates>=2?selectRouting(use.map(x=>x.score),use.map(x=>x.label),{alpha_free,alpha_busy,delta,grid,units:use.map(x=>x.unit)}):null;
  const inRange=side==='free'?x=>x.score<=edge:x=>x.score>=busyEdge;
  out[side]={threshold:routing?routing[`t_${side}`]:null,from:f,dates,calibration_n:use.length,calibration_units:new Set(use.map(x=>x.unit)).size,
   per_test_level:delta/(2*grid.length),evidence:use.filter(inRange).map(x=>x.id),tests:routing?routing.tests.filter(t=>t.side===side):[]};
 }
 return out;
}
/** Per-side evidence dates of one exported camera drift record. Current files carry evidence_from_by_side; older files
 * have one camera-level evidence_from, so each side takes the date of its own latest revocation in the history and only
 * a record without history applies the camera date to both sides. */
export function driftSideDates(log){
 if(!log||typeof log!=='object'||Array.isArray(log)||!Array.isArray(log.history))throw new Error('抽检撤销日期或历史格式无效');
 const out={free:null,busy:null},by=log.evidence_from_by_side;
 if(by!==undefined){
  if(!by||typeof by!=='object'||Array.isArray(by))throw new Error('抽检撤销日期或历史格式无效');
  for(const s of ['free','busy']){const v=by[s]??null;if(v!==null&&(typeof v!=='string'||!DAY.test(v)))throw new Error('抽检撤销日期或历史格式无效');out[s]=v;}
  if(!out.free&&!out.busy)throw new Error('抽检撤销日期或历史格式无效');
  return out;
 }
 if(typeof log.evidence_from!=='string'||!DAY.test(log.evidence_from))throw new Error('抽检撤销日期或历史格式无效');
 for(const h of log.history){const d=typeof h?.source_time==='string'?h.source_time.slice(0,8):'';if(['free','busy'].includes(h?.side)&&DAY.test(d))out[h.side]=laterDate(out[h.side],d);}
 if(!out.free&&!out.busy)out.free=out.busy=log.evidence_from;
 return out;
}
/** Evidence behind one side's current threshold: its spot-check monitor skips these conclusions and every snapshot
 * dated before `from`, so a threshold is only monitored on data it was not certified with. */
export function sideRecord(r,at,reselected=false){return {from:r.from,evidence:new Set(r.evidence),dates:r.dates,calibration_n:r.calibration_n,calibration_units:r.calibration_units,at,reselected};}
/** Applies reselectSides results for revoked sides to an on-site record {routing,revoked,sides,attempts}. A pass
 * re-enables that side with fresh evidence (its spot-check count restarts); a fail keeps it revoked and records the
 * attempt. Sides missing from result are carried over unchanged, including their monitor. */
export function applyRecalibration(prev,result,at){
 const next={...prev,routing:{...prev.routing},revoked:{...prev.revoked},sides:{...prev.sides},attempts:{free:null,busy:null,...prev.attempts}};
 for(const [s,r] of Object.entries(result)){
  if(r.threshold!==null){next.routing[`t_${s}`]=r.threshold;next.revoked[s]=null;next.sides[s]=sideRecord(r,at,true);next.attempts[s]=null;}
  else next.attempts[s]={at,from:r.from,dates:r.dates,calibration_n:r.calibration_n,calibration_units:r.calibration_units};
 }
 return next;
}
