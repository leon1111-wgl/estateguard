/** Validate a local replacement before releasing any evidence already in use. */
const supported=new Set(['image/jpeg','image/png','image/webp','video/mp4','video/webm']);
const abortError=()=>new DOMException('已取消证据读取','AbortError');
function bounded(work,signal){
 return new Promise((resolve,reject)=>{
  const finish=(fn,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);};
  const abort=()=>finish(reject,abortError());
  const timer=setTimeout(()=>finish(reject,new Error('文件读取超时，请重新选择可打开的图片或短视频。')),10000);
  signal?.addEventListener('abort',abort,{once:true});
  Promise.resolve(work).then(value=>finish(resolve,value),error=>finish(reject,error));
  if(signal?.aborted)abort();
 });
}
export async function prepareEvidence(file,{signal}={}){
 if(!file||!supported.has(file.type))throw new Error('请使用 JPEG、PNG、WebP、MP4 或 WebM。');
 if(!Number.isFinite(file.size)||file.size<=0)throw new Error('文件为空，无法作为可查看的证据。');
 if(file.size>100*1024*1024)throw new Error('文件超过 100 MB，请截取更短的片段。');
 if(signal?.aborted)throw abortError();
 const url=URL.createObjectURL(file),video=file.type.startsWith('video/');
 let node,cleanup=()=>{};
 try{
  if(video){
   node=document.createElement('video');node.preload='auto';node.muted=true;node.playsInline=true;
   const readable=new Promise((resolve,reject)=>{
    const ready=()=>resolve(),failed=()=>reject(new Error('无法解码这段视频，请选择可播放的 MP4 或 WebM。'));
    cleanup=()=>{node.removeEventListener('loadeddata',ready);node.removeEventListener('error',failed);};
    node.addEventListener('loadeddata',ready,{once:true});node.addEventListener('error',failed,{once:true});
   });
   node.src=url;node.load();await bounded(readable,signal);
   if(!node.videoWidth||!node.videoHeight||!Number.isFinite(node.duration)||node.duration<=0)throw new Error('无法读取有效的视频画面或时长，请选择普通短视频文件。');
  }else{
   node=new Image();node.src=url;
   await bounded(node.decode().catch(()=>{throw new Error('无法解码这张图片，请选择可打开的 JPEG、PNG 或 WebP。');}),signal);
   if(!node.naturalWidth||!node.naturalHeight)throw new Error('无法读取有效的图片尺寸。');
  }
  if(signal?.aborted)throw abortError();
  return {url,name:file.name,type:file.type,width:video?node.videoWidth:node.naturalWidth,height:video?node.videoHeight:node.naturalHeight,...(video?{duration:node.duration}:{})};
 }catch(error){URL.revokeObjectURL(url);throw error;}
 finally{cleanup();if(node){if(video)node.pause();node.removeAttribute('src');if(video)node.load();}}
}

export function createEvidenceStore({prepare=prepareEvidence,release=item=>URL.revokeObjectURL(item.url),onChange=()=>{}}={}){
 const items=new Map(),jobs=new Map(),feedback=new Map();
 const current=(id,job)=>jobs.get(id)===job;
 const releaseUnused=item=>{if(item&&![...items.values()].includes(item))release(item);};
 function detach(id){const job=jobs.get(id);jobs.delete(id);if(job&&![...jobs.values()].includes(job))job.controller.abort();}
 function state(id){return {status:'empty',...feedback.get(id),item:items.get(id)||null};}
 async function replace(target,file){
  const ids=[...new Set(Array.isArray(target)?target:[target])];if(!ids.length)return false;
  const job={controller:new AbortController()};
  for(const id of ids){detach(id);jobs.set(id,job);feedback.set(id,{status:'loading',attemptedName:file?.name||''});}
  for(const id of ids)onChange(id);
  try{
   const item=await prepare(file,{signal:job.controller.signal});
   const active=ids.filter(id=>current(id,job));if(!active.length){release(item);return false;}
   for(const id of active){const old=items.get(id);items.set(id,item);jobs.delete(id);feedback.set(id,{status:'ready',attemptedName:file.name});releaseUnused(old);}
   for(const id of active)onChange(id);return true;
  }catch(error){
   for(const id of ids)if(current(id,job)){jobs.delete(id);feedback.set(id,{status:'error',attemptedName:file?.name||'',error:error.message});onChange(id);}
   return false;
  }
 }
 function clear(){
  const pending=new Set(jobs.values()),used=new Set(items.values());jobs.clear();items.clear();feedback.clear();
  for(const job of pending)job.controller.abort();for(const item of used)release(item);
 }
 return {replace,state,clear};
}
