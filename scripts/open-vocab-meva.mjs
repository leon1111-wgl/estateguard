/** MEVA object-left re-score with the open-vocabulary lane on (docs/validation/open-vocab-protocol.md, appendix 4).
 * Merges the 0.5.0 test detections (D-FINE-N, unchanged) with the lane's detections on the same frames, then runs the
 * unchanged 0.5.0 scorer. Lane boxes of the frozen classes that also count as left objects, at or above the frozen lane
 * threshold, enter the frozen timeline rule as members of its carried-object group (class "suitcase") with score
 * max(score, minimum_score) so they can start a track; everything else in the timeline module is unchanged.
 * Usage: node scripts/open-vocab-meva.mjs --dfine DIR --lane DIR --config web/data/open-vocab/config.json --out DIR */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {TIMELINE_SETTINGS} from '../web/event-timeline.mjs';
export const LEFT_OBJECT_CLASSES=Object.freeze(['box','carton','crate','cart','handcart','shopping_cart','trash_can','barrel']);
export function mergeFrames(dfine,lane,config){
 const classes=LEFT_OBJECT_CLASSES.filter(c=>config.classes.includes(c)),byFrame=new Map(lane.frames.map(f=>[f.frame,f]));let added=0;
 const frames=dfine.frames.map(f=>{const l=byFrame.get(f.frame);if(!l)throw new Error(`${dfine.clip}: lane frame ${f.frame} missing`);
  const extra=l.detections.filter(d=>classes.includes(d.class)&&d.score>=config.threshold).map(d=>({class:'suitcase',score:Math.max(d.score,TIMELINE_SETTINGS.minimum_score),bbox:d.bbox,lane_class:d.class,lane_score:d.score}));added+=extra.length;
  return {...f,detections:[...f.detections,...extra]};});
 if(lane.frames.length!==dfine.frames.length)throw new Error(`${dfine.clip}: ${lane.frames.length} lane frames vs ${dfine.frames.length}`);
 return {record:{...dfine,frames,open_vocab:{candidate:config.candidate,threshold:config.threshold,classes,boxes_added:added}},added};
}
if(import.meta.url===`file://${process.argv[1]}`){
 const args=Object.fromEntries(process.argv.slice(2).reduce((p,v,i,a)=>i%2?p:[...p,[v.replace(/^--/,''),a[i+1]]],[]));
 const config=JSON.parse(fs.readFileSync(args.config,'utf8')),out=path.resolve(args.out),merged=path.join(out,'merged');fs.mkdirSync(merged,{recursive:true});
 const clips=fs.readdirSync(args.dfine).filter(f=>f.endsWith('.json')&&!f.startsWith('_')).sort(),summary={candidate:config.candidate,threshold:config.threshold,clips:[]};
 for(const f of clips){const d=JSON.parse(fs.readFileSync(path.join(args.dfine,f),'utf8')),l=JSON.parse(fs.readFileSync(path.join(args.lane,f),'utf8'));
  const {record,added}=mergeFrames(d,l,config);fs.writeFileSync(path.join(merged,f),JSON.stringify(record));summary.clips.push({clip:d.clip,frames:d.frames.length,lane_boxes_added:added});}
 fs.writeFileSync(path.join(out,'merge-summary.json'),JSON.stringify(summary,null,1));
 execFileSync(process.execPath,['scripts/meva-score.mjs','--split','test','--detections',merged,'--out',path.join(out,'score')],{stdio:'inherit'});
}
