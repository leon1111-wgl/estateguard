/** Fixed MEVA subset for the event-timeline evaluation (docs/validation/event-timeline-protocol.md).
 * Reads only clip names (the annotated-clip list) and video object sizes (HTTP HEAD on the public S3 bucket); no
 * labels, no video. Cameras are split dev/test by a salted hash of the camera id; clips are ordered by a salted hash
 * of the clip name. Usage: node scripts/meva-subset.mjs > docs/validation/event-timeline-meva-subset.json */
import {createHash} from 'node:crypto';
export const MEVA_REPO='https://gitlab.kitware.com/api/v4/projects/meva%2Fmeva-data-repo/repository';
export const MEVA_COMMIT='421841a75577b697c314e952e585aecbb1b99e17';
export const MEVA_VIDEO='https://mevadata-public-01.s3.amazonaws.com/drops-123-r13';
export const SALT='estateguard-event-timeline-2026-11';
const hash=s=>createHash('sha256').update(`${SALT}:${s}`).digest('hex');
export const parseClip=name=>{const [date,start,end,site,camera]=name.split('.');return {name,date,hour:start.slice(0,2),start,end,site,camera};};
export const annotationPath=(clip,kind)=>`annotation/DIVA-phase-2/MEVA/kitware/${clip.date}/${clip.hour}/${clip.name}.${kind}.yml`;
export const videoURL=clip=>`${MEVA_VIDEO}/${clip.date}/${clip.hour}/${clip.name}.r13.avi`;
export const rawURL=path=>`${MEVA_REPO}/files/${encodeURIComponent(path)}/raw?ref=${MEVA_COMMIT}`;

export function splitAndOrder(names,{devFraction=1/3}={}){
 const clips=names.map(parseClip),cameras=[...new Set(clips.map(c=>c.camera))].sort((a,b)=>hash(a)<hash(b)?-1:1);
 const devCameras=new Set(cameras.slice(0,Math.round(cameras.length*devFraction)));
 const order=xs=>[...xs].sort((a,b)=>hash(a.name)<hash(b.name)?-1:1);
 return {cameras:{dev:[...devCameras].sort(),test:cameras.filter(c=>!devCameras.has(c)).sort()},dev:order(clips.filter(c=>devCameras.has(c.camera))),test:order(clips.filter(c=>!devCameras.has(c.camera)))};
}
// Candidate lists are longer than the target so that the plan step can apply the pre-registered skip rule
// (video missing or under 20 MB) and still take the first clips that pass, in this order.
export function candidates(ordered,{perCamera=2,count}){
 const seen=new Map(),out=[];
 for(const c of ordered){if((seen.get(c.camera)||0)>=perCamera)continue;seen.set(c.camera,(seen.get(c.camera)||0)+1);out.push(c);if(out.length>=count)break;}
 return out;
}

if(import.meta.url===`file://${process.argv[1]}`){
 const list=await (await fetch(rawURL('annotation/DIVA-phase-2/MEVA/kitware/list-of-annotated-meva-clips.txt'))).text();
 const names=list.split('\n').map(s=>s.trim()).filter(s=>/^\d{4}-\d{2}-\d{2}\.\d{2}-\d{2}-\d{2}\.\d{2}-\d{2}-\d{2}\.[a-z]+\.G\d+$/.test(s));
 const {cameras,dev,test}=splitAndOrder(names);
 const withSize=async c=>{const r=await fetch(videoURL(c),{method:'HEAD'});return {name:c.name,site:c.site,camera:c.camera,video:videoURL(c),bytes:r.ok?Number(r.headers.get('content-length')):null};};
 const dump=async xs=>Promise.all(xs.map(withSize));
 const out={
  written:new Date().toISOString().slice(0,10),
  source:{annotations:`gitlab.kitware.com/meva/meva-data-repo @ ${MEVA_COMMIT}, annotation/DIVA-phase-2/MEVA/kitware (evaluation-level)`,videos:MEVA_VIDEO,licence:'CC BY 4.0 (mevadata.org; repository LICENSE)'},
  salt:SALT,annotated_clips:names.length,
  split:{rule:'cameras ordered by sha256(salt:camera); the first third are dev, the rest test',dev_cameras:cameras.dev,test_cameras:cameras.test},
  order:'clips ordered by sha256(salt:clip name), at most 2 per camera',
  dev_candidates:await dump(candidates(dev,{count:16})),
  test_candidates:await dump(candidates(test,{count:32}))
 };
 console.log(JSON.stringify(out,null,1));
}
