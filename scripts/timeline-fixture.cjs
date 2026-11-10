/** Synthetic clip for the event-timeline browser checks: the project's CC0 bus photo drives in from the left for
 * 3 seconds and then stands still until the end (about 12 s), on a fixed 960×540 canvas recorded with MediaRecorder
 * in the page. A rule fixture, not surveillance footage; exact bytes vary with the Chrome version. */
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
/** setInputFiles payload: in memory up to 40 MB, otherwise a temporary file with the same name (Playwright limit 50 MB). */
function inputFile({name,type,buffer}){
 if(buffer.length<=40*1024*1024)return {name,mimeType:type,buffer};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eg-input-')),file=path.join(dir,name);fs.writeFileSync(file,buffer);return file;
}
const SPEC=Object.freeze({source:'web/samples/bus.jpg',canvas:[960,540],photo_size:[384,256],photo_y:200,start_x:20,end_x:470,arrival_seconds:3,duration_seconds:12.4});
async function makeTimelineClip(page,spec=SPEC){
 const result=await page.evaluate(async spec=>{
  const image=new Image();image.src='samples/bus.jpg';await image.decode();
  const canvas=document.createElement('canvas');[canvas.width,canvas.height]=spec.canvas;const ctx=canvas.getContext('2d');
  const draw=t=>{const p=Math.min(1,t/spec.arrival_seconds);ctx.fillStyle='#75818a';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#5d666d';ctx.fillRect(0,spec.photo_y+spec.photo_size[1]-12,canvas.width,40);ctx.drawImage(image,spec.start_x+(spec.end_x-spec.start_x)*p,spec.photo_y,...spec.photo_size);};
  const type=MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?'video/webm;codecs=vp8':'video/webm';
  draw(0);const stream=canvas.captureStream(10),chunks=[],recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:900000});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise(r=>recorder.onstop=r);
  const start=performance.now();recorder.start();const timer=setInterval(()=>draw((performance.now()-start)/1000),100);
  await new Promise(r=>setTimeout(r,spec.duration_seconds*1000));clearInterval(timer);recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
  const bytes=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
  return {type:'video/webm',base64:btoa(binary)};
 },spec);
 const buffer=Buffer.from(result.base64,'base64');
 return {name:'合成时间线-校车驶入停下.webm',type:result.type,buffer,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),spec};
}
/** Open a clip in the analysis page, choose the event timeline and run it; returns the page's final message. */
async function runTimeline(page,clip,{timeout=240000}={}){
 await page.evaluate(()=>{const m=document.querySelector('#vision-message');m.textContent='';m.classList.remove('error');});
 await page.locator('#analysis-file').setInputFiles(inputFile(clip));
 await page.waitForFunction(()=>{const m=document.querySelector('#vision-message');return (m.textContent.startsWith('素材已就绪')&&!document.querySelector('#run-analysis').disabled)||m.classList.contains('error');});
 const opened=await page.locator('#vision-message').textContent();if(!opened.startsWith('素材已就绪'))return {opened,message:null};
 await page.locator('#vision-rule').selectOption('timeline');
 await page.evaluate(()=>{const m=document.querySelector('#vision-message');m.textContent='';m.classList.remove('error');});
 await page.locator('#run-analysis').click();
 // A refusal (for example a photo, which the timeline cannot use) shows as an error message without a run.
 await page.waitForFunction(()=>{const m=document.querySelector('#vision-message');return (/^(分析完成|分析失败|分析已停止|模型加载已取消)/.test(m.textContent)||m.classList.contains('error'))&&!document.querySelector('#run-analysis').disabled;},null,{timeout});
 return {opened,message:await page.locator('#vision-message').textContent()};
}
/** Click an event's keyframe button and wait until the page has drawn that keyframe. */
async function openKeyframe(page,id,{via='row'}={}){
 await page.locator(via==='segment'?`.tl-seg[data-event="${id}"]`:`.tl-open[data-event="${id}"]`).click();
 await page.waitForFunction(id=>document.getElementById('analysis-stage').dataset.keyframe===id,id,{timeout:30000});
}
module.exports={SPEC,makeTimelineClip,runTimeline,openKeyframe,inputFile};
