/** Image-only occupancy inference. Ground truth and filenames are never inputs. */
export const MAX_PARKING_REVIEW_BYTES=32*1024*1024;
export const MAX_PARKING_NOTES_BYTES=24*1024*1024;
export function extractFeatures(rgba){
  if(rgba.length!==32*32*4)throw new Error('模型输入必须为 32×32 像素');
  const gray=new Float64Array(1024),rgb=new Float64Array(3072),bins=new Uint8Array(1024),mag=new Float64Array(1024);
  for(let i=0;i<1024;i++){for(let c=0;c<3;c++)rgb[i*3+c]=rgba[i*4+c]/255;gray[i]=.299*rgb[i*3]+.587*rgb[i*3+1]+.114*rgb[i*3+2];}
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){const i=y*32+x,gx=x>0&&x<31?(gray[i+1]-gray[i-1])/2:0,gy=y>0&&y<31?(gray[i+32]-gray[i-32])/2:0;mag[i]=Math.hypot(gx,gy);let angle=Math.atan2(gy,gx)%Math.PI;if(angle<0)angle+=Math.PI;bins[i]=Math.min(8,Math.floor(angle*9/Math.PI));}
  const result=[];
  for(let y=0;y<32;y+=8)for(let x=0;x<32;x+=8){const means=[0,0,0],variance=[0,0,0],hist=Array(9).fill(0);
    for(let yy=y;yy<y+8;yy++)for(let xx=x;xx<x+8;xx++){const i=yy*32+xx;for(let c=0;c<3;c++)means[c]+=rgb[i*3+c]/64;hist[bins[i]]+=mag[i];}
    for(let yy=y;yy<y+8;yy++)for(let xx=x;xx<x+8;xx++)for(let c=0;c<3;c++)variance[c]+=(rgb[(yy*32+xx)*3+c]-means[c])**2/64;
    const norm=Math.sqrt(hist.reduce((s,v)=>s+v*v,0)+1e-6);result.push(...means,...variance.map(v=>v<1e-28?0:Math.sqrt(v)),...hist.map(v=>v/norm));
  }return result;
}
export function predictPatch(rgba,model){
  const f=extractFeatures(rgba).map((v,i)=>(v-model.mean[i])/model.scale[i]);
  const h=model.hidden?Array.from({length:model.hidden},(_,j)=>Math.tanh(f.reduce((s,v,i)=>s+v*model.w1[i][j],model.b1[j]))):f;
  const z=Math.max(-40,Math.min(40,h.reduce((s,v,j)=>s+v*model.w2[j],model.b2)));
  return 1/(1+Math.exp(-z));
}
export function classifyScore(p){if(!Number.isFinite(p)||p<0||p>1)throw new Error('无效模型分数');return p<=.35?'free':p>=.65?'busy':'uncertain';}
export function frameSummary(rows,predictions){const result={total:rows.length,free:0,busy:0,uncertain:0,pending:0};for(const row of rows){if(predictions.has(row.id))result[classifyScore(predictions.get(row.id))]++;else result.pending++;}return result;}
// Human completion is independent of model confidence and belongs to one snapshot.
export function parkingReviewStatus(review){return review?.decision==='free'||review?.decision==='busy'?'confirmed':review?.decision==='uncertain'?'needs_evidence':'pending';}
export function parkingReviewSummary(rows,reviews){const result={total:rows.length,confirmed:0,pending:0,needs_evidence:0};for(const row of rows)result[parkingReviewStatus(reviews[row.id])]++;return result;}
export function filterParkingRows(rows,predictions,reviews,filter){return rows.filter(row=>{
 const status=parkingReviewStatus(reviews[row.id]);
 if(filter==='review')return status!=='confirmed';
 if(filter==='confirmed')return status==='confirmed';
 if(filter==='evidence')return status==='needs_evidence';
 if(filter==='model_uncertain')return !predictions.has(row.id)||classifyScore(predictions.get(row.id))==='uncertain';
 if(filter==='errors')return predictions.has(row.id)&&Number(predictions.get(row.id)>=.5)!==row.label;
 return true;
});}
export function nextParkingReviewId(rows,reviews,currentId){
 const start=rows.findIndex(row=>row.id===currentId);
 for(let step=1;step<=rows.length;step++){const row=rows[(start+step)%rows.length];if(parkingReviewStatus(reviews[row.id])!=='confirmed')return row.id;}
 return null;
}
export function exportParkingReview(context,reviews){const result={format:'estateguard-parking-review',version:1,model_sha256:context.model_sha256,reviews:structuredClone(reviews)};importParkingReview(result,context);return result;}
export function serializeParkingReview(data,context){importParkingReview(data,context);return JSON.stringify(data);}
export function importParkingReview(data,context){
 if(data?.format!=='estateguard-parking-review'||data.version!==1||data.model_sha256!==context.model_sha256)throw new Error('复核文件版本或模型版本不匹配');
 if(new TextEncoder().encode(JSON.stringify(data)).byteLength>MAX_PARKING_REVIEW_BYTES)throw new Error('复核文件超过 32 MiB；本次操作已取消，现有记录保持不变。');
 if(!data.reviews||typeof data.reviews!=='object'||Array.isArray(data.reviews))throw new Error('无效复核记录');
 if(new TextEncoder().encode(JSON.stringify(data.reviews)).byteLength>MAX_PARKING_NOTES_BYTES)throw new Error('人工复核记录超过 24 MiB；需为后续预测和来源信息保留 8 MiB。本次操作已取消，现有记录保持不变。');
 const allowed=new Set(context.sample_ids),result={};
 for(const [id,r] of Object.entries(data.reviews)){
  if(!allowed.has(id)||!r||!['pending','free','busy','uncertain'].includes(r.decision)||typeof r.note!=='string'||r.note.length>2000||(!r.note.trim()&&r.decision!=='pending')||typeof r.at!=='string'||!Number.isFinite(Date.parse(r.at)))throw new Error('复核记录含未知样本、状态或无效理由');
  result[id]={decision:r.decision,note:r.note,at:r.at};
 }return result;
}
