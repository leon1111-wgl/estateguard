/** Scores the event timeline on MEVA (docs/validation/event-timeline-protocol.md). Runs on GitHub Actions after
 * scripts/meva-timeline.cjs. Annotations are fetched from the pinned MEVA repository commit and never written out;
 * the report holds only counts, metrics and the system's own events.
 * Usage: node scripts/meva-score.mjs --split dev|test --detections DIR --out DIR */
import fs from 'node:fs';
import path from 'node:path';
import {buildTimeline,TIMELINE_SETTINGS,RULE_ORDER} from '../web/event-timeline.mjs';
import {scoreActivity,wilson} from './actev-score.mjs';
import {activities,types,geomAt,references,diagnostics,putDownObjects} from './meva-kpf.mjs';
import {parseClip,annotationPath,rawURL,MEVA_COMMIT} from './meva-subset.mjs';

export const RULE_TO_ACTIVITY=Object.freeze({vehicle_stop:'vehicle_stops',object_left:'person_puts_down_object',person_appears:'person_enters_scene_through_structure'});
// Reported beside the primary mapping, never used for selection.
export const SECONDARY=Object.freeze([{rule:'person_appears',activity:'person_opens_facility_door'}]);
export const DEV_GRID=Object.freeze({minimum_score:[.4,.5,.6],dwell_seconds:[2,3,4]});

/** Lowest mean nAUDC@0.2 over the rules that have dev references; ties: higher minimum_score, then longer dwell. */
export function chooseConfig(rows){
 const scored=rows.map(r=>{const v=RULE_ORDER.map(rule=>r.rules[rule].naudc).filter(x=>x!==null);return {...r,mean_naudc:v.length?v.reduce((a,b)=>a+b,0)/v.length:null};});
 return [...scored].sort((a,b)=>(a.mean_naudc??2)-(b.mean_naudc??2)||b.config.minimum_score-a.config.minimum_score||b.config.dwell_seconds-a.config.dwell_seconds)[0];
}
export function systemInstances(timeline,rule){return timeline.events.filter(e=>e.rule===rule).map(e=>({start:e.start,end:e.end,score:e.score,id:e.id,track:e.track,class:e.class}));}

async function fetchText(p){const r=await fetch(rawURL(p));if(!r.ok)throw new Error(`HTTP ${r.status} for ${p}`);return r.text();}
async function main(){
 const args=Object.fromEntries(process.argv.slice(2).reduce((p,v,i,all)=>i%2?p:[...p,[v.replace(/^--/,''),all[i+1]]],[]));
 const split=args.split,dir=path.resolve(args.detections),out=path.resolve(args.out);fs.mkdirSync(out,{recursive:true});
 if(!['dev','test'].includes(split))throw new Error('--split dev|test');
 const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!f.startsWith('_')).sort();
 const clips=[];
 for(const f of files){
  const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')),c=parseClip(d.clip);
  const [actsText,typesText,geomText]=await Promise.all(['activities','types','geom'].map(k=>fetchText(annotationPath(c,k))));
  const acts=activities(actsText),fps=d.video.fps,interval=d.sampling.interval_seconds;
  const analysed=Math.min(d.video.duration_seconds,d.frames.at(-1).time+interval);
  const refs=Object.fromEntries([...Object.values(RULE_TO_ACTIVITY),...SECONDARY.map(s=>s.activity)].map(a=>[a,references(acts,a,fps,analysed)]));
  clips.push({name:d.clip,site:c.site,camera:c.camera,d,acts,actorTypes:types(typesText),geom:geomAt(geomText,d.frames.map(x=>x.frame)),refs,analysed,aspect:d.sampling.analysed_width/d.sampling.analysed_height});
  console.log(d.clip,Object.fromEntries(Object.entries(refs).map(([k,v])=>[k,v.length])));
 }
 const evaluate=settings=>{
  const timelines=clips.map(c=>buildTimeline(c.d.frames,{aspect:c.aspect,settings}));
  const per=(rule,activity)=>scoreActivity(clips.map((c,i)=>({id:c.name,duration:c.analysed,refs:c.refs[activity],sys:systemInstances(timelines[i],rule)})));
  const rules=Object.fromEntries(RULE_ORDER.map(rule=>{const s=per(rule,RULE_TO_ACTIVITY[rule]);const {det,...rest}=s;return [rule,{activity:RULE_TO_ACTIVITY[rule],...rest,pmiss_wilson_95:s.references?wilson(s.references-s.operating_point.matched,s.references):null,det_points:det.length}];}));
  const secondary=SECONDARY.map(({rule,activity})=>{const {det,...rest}=per(rule,activity);return {rule,activity,...rest};});
  return {timelines,rules,secondary};
 };
 const report={protocol:'docs/validation/event-timeline-protocol.md',split,commit:process.env.GITHUB_SHA||null,run_id:process.env.GITHUB_RUN_ID||null,annotations:`meva-data-repo@${MEVA_COMMIT}`,
  clips:clips.map(c=>({clip:c.name,site:c.site,camera:c.camera,width:c.d.video.width,height:c.d.video.height,fps:c.d.video.fps,analysed_seconds:c.analysed,frames:c.d.frames.length,references:Object.fromEntries(Object.entries(c.refs).map(([k,v])=>[k,v.length]))})),
  analysed_minutes:clips.reduce((a,c)=>a+c.analysed,0)/60};
 let chosen;
 if(split==='dev'){
  const rows=[];
  for(const minimum_score of DEV_GRID.minimum_score)for(const dwell_seconds of DEV_GRID.dwell_seconds){const config={minimum_score,dwell_seconds};const {rules}=evaluate(config);rows.push({config,rules});}
  const best=chooseConfig(rows);
  report.grid=rows.map(r=>({config:r.config,naudc:Object.fromEntries(RULE_ORDER.map(k=>[k,r.rules[k].naudc])),pmiss_at_tfa_0_02:Object.fromEntries(RULE_ORDER.map(k=>[k,r.rules[k].pmiss_at_tfa?.['0.02']??null]))}));
  report.chosen={config:best.config,mean_naudc:best.mean_naudc,rule:'lowest mean nAUDC@0.2 over rules with dev references; ties → higher minimum_score, then longer dwell'};
  chosen=best.config;
 }else{
  chosen={minimum_score:TIMELINE_SETTINGS.minimum_score,dwell_seconds:TIMELINE_SETTINGS.dwell_seconds};
  report.frozen={config:chosen,settings_version:TIMELINE_SETTINGS.version,note:'web/event-timeline.mjs TIMELINE_SETTINGS at this commit; the only configuration scored on test'};
 }
 const {timelines,rules,secondary}=evaluate(chosen);
 report.config=chosen;report.rules=rules;report.secondary=secondary;
 report.failure_modes={
  per_clip:clips.map((c,i)=>({clip:c.name,...diagnostics({geom:c.geom,actorTypes:c.actorTypes,detFrames:c.d.frames,tracks:timelines[i].tracks,width:c.d.video.width,height:c.d.video.height,minimumScore:chosen.minimum_score})})),
  put_down_objects:clips.map(c=>putDownObjects({acts:c.acts,actorTypes:c.actorTypes,geom:c.geom,detFrames:c.d.frames,fps:c.d.video.fps,width:c.d.video.width,height:c.d.video.height,minimumScore:chosen.minimum_score}))
 };
 // Aggregate the per-clip diagnostics.
 const agg={person_recall_by_height_px:null,id_switches:{},put_down_objects:{}};
 for(const pc of report.failure_modes.per_clip){
  agg.person_recall_by_height_px=agg.person_recall_by_height_px?agg.person_recall_by_height_px.map((b,i)=>({...b,boxes:b.boxes+pc.person_recall_by_height_px[i].boxes,found:b.found+pc.person_recall_by_height_px[i].found})):pc.person_recall_by_height_px.map(b=>({...b}));
  for(const [t,v] of Object.entries(pc.id_switches)){const a=agg.id_switches[t]||(agg.id_switches[t]={actors:0,matched_samples:0,id_switches:0,distinct_sum:0});a.actors+=v.actors_with_3_matched_samples;a.matched_samples+=v.matched_samples;a.id_switches+=v.id_switches;a.distinct_sum+=(v.mean_distinct_tracks_per_actor||0)*v.actors_with_3_matched_samples;}
 }
 for(const v of Object.values(agg.id_switches)){v.mean_distinct_tracks_per_actor=v.actors?v.distinct_sum/v.actors:null;v.switches_per_100_matched_samples=v.matched_samples?100*v.id_switches/v.matched_samples:null;delete v.distinct_sum;}
 for(const pd of report.failure_modes.put_down_objects)for(const [t,v] of Object.entries(pd)){const a=agg.put_down_objects[t]||(agg.put_down_objects[t]={objects:0,with_boxes:0,detected:0});a.objects+=v.objects;a.with_boxes+=v.with_boxes;a.detected+=v.detected;}
 report.failure_modes.aggregate=agg;
 report.events=clips.map((c,i)=>({clip:c.name,events:timelines[i].events.map(({id,rule,start,end,keyframe_time,score,track,class:cls,condition_seconds})=>({id,rule,start,end,keyframe_time,score:Math.round(score*1e4)/1e4,track,class:cls,condition_seconds}))}));
 fs.writeFileSync(path.join(out,`report-${split}.json`),JSON.stringify(report,null,1));
 const pct=x=>x===null||x===undefined?'—':(100*x).toFixed(1)+'%',n3=x=>x===null||x===undefined?'—':x.toFixed(3);
 const md=[`# Event timeline on MEVA · ${split}`,'',`Commit ${report.commit} · run ${report.run_id} · ${clips.length} clips · ${report.analysed_minutes.toFixed(1)} min · config minimum_score ${chosen.minimum_score}, dwell ${chosen.dwell_seconds} s`,'',
  '| Rule → MEVA activity | refs | events | Pmiss (all events) | Pmiss@Tfa 0.02 | Pmiss@Tfa 0.1 | nAUDC@0.2 | Tfa (all) | mean tIoU (pairs) |','|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...RULE_ORDER.map(r=>{const x=rules[r];return `| ${r} → ${x.activity} | ${x.references} | ${x.system_instances} | ${pct(x.operating_point.pmiss)} | ${pct(x.pmiss_at_tfa?.['0.02'])} | ${pct(x.pmiss_at_tfa?.['0.1'])} | ${n3(x.naudc)} | ${n3(x.operating_point.tfa)} | ${n3(x.temporal_iou.mean)} (${x.temporal_iou.pairs}) |`;}),
  '',...(report.grid?['Dev grid (mean nAUDC selects):','',...report.grid.map(g=>`- ${JSON.stringify(g.config)} nAUDC ${JSON.stringify(g.naudc)}`),'',`Chosen: ${JSON.stringify(report.chosen)}`]:[]),''];
 fs.writeFileSync(path.join(out,`summary-${split}.md`),md.join('\n'));
 console.log(md.join('\n'));
}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(e=>{console.error(e);process.exit(1);});
