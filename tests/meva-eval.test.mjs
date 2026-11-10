import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseKpf,activities,types,geomAt,references,diagnostics} from '../scripts/meva-kpf.mjs';
import {splitAndOrder,candidates,parseClip,annotationPath,videoURL} from '../scripts/meva-subset.mjs';
import {chooseConfig,RULE_TO_ACTIVITY,DEV_GRID} from '../scripts/meva-score.mjs';
import {TIMELINE_SETTINGS} from '../web/event-timeline.mjs';

// Synthetic lines in the KPF layout; no MEVA content is stored in the repository.
const ACT=`- { meta: synthetic }
- {'act': {'act2': {'vehicle_stops': 1.0}, 'actors': [{'id1': 7, 'timespan': [{'tsr0': [300, 449]}]}], 'id2': 1, 'src_status': 'good', 'timespan': [{'tsr0': [300, 449]}]}}
- {'act': {'act2': {'person_puts_down_object': 1.0}, 'actors': [{'id1': 3, 'timespan': [{'tsr0': [900, 960]}]}, {'id1': 4, 'timespan': [{'tsr0': [900, 960]}]}], 'id2': 2, 'timespan': [{'tsr0': [900, 960]}]}}
- {'act': {'act2': {'vehicle_stops': 1.0}, 'actors': [], 'id2': 3, 'timespan': [{'tsr0': [9300, 9400]}]}}`;
const TYPES=`- {'types': {'cset3': {'vehicle': 1.0}, 'id1': 7}}
- {'types': {'cset3': {'person': 1.0}, 'id1': 3}}`;
const GEOM=`- {'geom': {'g0': '100 200 140 300', 'id0': 1, 'id1': 3, 'keyframe': True, 'ts0': 30}}
- {'geom': {'g0': '100 200 140 300', 'id0': 2, 'id1': 3, 'keyframe': True, 'ts0': 31}}
- {'geom': {'g0': '500 500 700 600', 'id0': 3, 'id1': 7, 'keyframe': True, 'ts0': 60}}`;

test('KPF lines parse; unreadable lines are counted, not guessed',()=>{
 const {records,skipped}=parseKpf(ACT);assert.equal(records.length,3);assert.equal(skipped,1);
 const a=activities(ACT);assert.deepEqual(a.map(x=>x.activity),['vehicle_stops','person_puts_down_object','vehicle_stops']);assert.deepEqual(a[1].actors.map(x=>x.id),[3,4]);
 assert.equal(types(TYPES).get(7),'vehicle');
 const g=geomAt(GEOM,[30,60]);assert.deepEqual([...g.keys()],[30,60]);assert.deepEqual(g.get(30)[0],{actor:3,box:[100,200,140,300]});
});
test('references are in seconds with an inclusive last frame, clipped to the analysed range',()=>{
 const r=references(activities(ACT),'vehicle_stops',30,312);
 assert.equal(r.length,2);assert.equal(r[0].start,10);assert.equal(r[0].end,15);assert.equal(r[1].start,310);assert.equal(r[1].end,312);
 assert.equal(references(activities(ACT),'vehicle_stops',30,300).length,1);
});
test('the subset split is by camera, so no camera is in both halves, and candidates keep at most two clips per camera',()=>{
 const names=['2018-03-07.16-50-00.16-55-00.admin.G329','2018-03-07.16-55-00.17-00-00.admin.G329','2018-03-07.17-00-00.17-05-00.admin.G329','2018-03-07.16-50-00.16-55-00.bus.G340','2018-03-07.16-50-00.16-55-00.school.G330','2018-03-07.16-50-00.16-55-00.school.G299'];
 const s=splitAndOrder(names);
 assert.equal(s.cameras.dev.filter(c=>s.cameras.test.includes(c)).length,0);
 assert.ok(candidates([...s.dev,...s.test],{count:10}).filter(c=>c.camera==='G329').length<=2);
 const c=parseClip(names[0]);assert.equal(annotationPath(c,'activities'),'annotation/DIVA-phase-2/MEVA/kitware/2018-03-07/16/2018-03-07.16-50-00.16-55-00.admin.G329.activities.yml');
 assert.match(videoURL(c),/drops-123-r13\/2018-03-07\/16\/2018-03-07\.16-50-00\.16-55-00\.admin\.G329\.r13\.avi$/);
});
test('the committed subset is the one the script describes',()=>{
 const sub=JSON.parse(readFileSync(new URL('../docs/validation/event-timeline-meva-subset.json',import.meta.url),'utf8'));
 const dev=new Set(sub.split.dev_cameras);
 assert.ok(sub.dev_candidates.every(c=>dev.has(c.camera)));assert.ok(sub.test_candidates.every(c=>!dev.has(c.camera)));
});
test('dev selection: lowest mean nAUDC, ties to the higher score floor and then the longer dwell',()=>{
 const row=(minimum_score,dwell_seconds,v)=>({config:{minimum_score,dwell_seconds},rules:{vehicle_stop:{naudc:v},object_left:{naudc:null},person_appears:{naudc:v}}});
 assert.deepEqual(chooseConfig([row(.4,2,.9),row(.5,3,.8),row(.6,4,.85)]).config,{minimum_score:.5,dwell_seconds:3});
 assert.deepEqual(chooseConfig([row(.4,2,.8),row(.6,2,.8),row(.6,4,.8)]).config,{minimum_score:.6,dwell_seconds:4});
 assert.deepEqual(Object.keys(RULE_TO_ACTIVITY),['vehicle_stop','object_left','person_appears']);
 assert.ok(DEV_GRID.minimum_score.includes(TIMELINE_SETTINGS.minimum_score)&&DEV_GRID.dwell_seconds.includes(TIMELINE_SETTINGS.dwell_seconds));
});
test('diagnostics: person recall by height and ID switches per actor',()=>{
 const geom=new Map([[0,[{actor:1,box:[100,100,120,140]},{actor:2,box:[400,100,500,400]}]],[30,[{actor:2,box:[410,100,510,400]}]],[60,[{actor:2,box:[420,100,520,400]}]]]);
 const det=(x,y,w,h)=>({class:'person',score:.9,bbox:[x/1000,y/1000,w/1000,h/1000]});
 const detFrames=[{frame:0,time:0,detections:[det(400,100,100,300)]},{frame:30,time:1,detections:[det(410,100,100,300)]},{frame:60,time:2,detections:[det(420,100,100,300)]}];
 const tracks=[{id:'t1',group:'person',samples:[{time:0,bbox:[.4,.1,.1,.3]},{time:1,bbox:[.41,.1,.1,.3]}]},{id:'t2',group:'person',samples:[{time:2,bbox:[.42,.1,.1,.3]}]}];
 const d=diagnostics({geom,actorTypes:new Map([[1,'person'],[2,'person']]),detFrames,tracks,width:1000,height:1000,minimumScore:.5});
 assert.equal(d.person_recall_by_height_px[0].boxes,1);assert.equal(d.person_recall_by_height_px[0].found,0);
 assert.equal(d.person_recall_by_height_px[3].boxes,3);assert.equal(d.person_recall_by_height_px[3].found,3);
 assert.equal(d.id_switches.person.id_switches,1);assert.equal(d.id_switches.person.mean_distinct_tracks_per_actor,2);
});
test('the page default is the configuration chosen on MEVA dev (frozen before the test run)',()=>{
 const dev=JSON.parse(readFileSync(new URL('../docs/validation/event-timeline-dev-report.json',import.meta.url),'utf8'));
 assert.equal(dev.split,'dev');assert.equal(dev.run_id,'42725109355');
 assert.deepEqual(dev.chosen.config,{minimum_score:TIMELINE_SETTINGS.minimum_score,dwell_seconds:TIMELINE_SETTINGS.dwell_seconds});
});
