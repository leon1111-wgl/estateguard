import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarise} from '../scripts/timeline-evaluation.mjs';
import {TIMELINE_SETTINGS} from '../web/event-timeline.mjs';
const read=p=>JSON.parse(readFileSync(new URL(`../${p}`,import.meta.url),'utf8'));
const dev=read('docs/validation/event-timeline-dev-report.json'),testReport=read('docs/validation/event-timeline-test-report.json');
test('the page reads exactly what the committed MEVA reports say',()=>{
 assert.deepEqual(read('web/data/timeline/evaluation.json'),JSON.parse(JSON.stringify(summarise(dev,testReport))));
});
test('the test run scored the frozen page configuration on cameras the dev run never saw',()=>{
 assert.equal(testReport.split,'test');assert.equal(testReport.detections_run_id,'42725830941');assert.equal(testReport.detections_commit,'a4f1132250683e1034c11477d409da8902b2709a');
 // The corrected re-score reads the same detection artifacts; only the annotation reader changed (rescore run).
 assert.equal(testReport.run_id,'42729382727');assert.match(testReport.rescore,/Same detections/);
 const first=read('docs/validation/event-timeline-test-report-firstrun.json');assert.equal(first.run_id,'42725830941');
 const events=r=>JSON.stringify(r.events);assert.equal(events(first),events(testReport),'system output must be identical');
 assert.ok(testReport.clips.every(c=>c.kpf_audit.activities.skipped_data===0&&c.kpf_audit.types.skipped_data===0));
 assert.equal(read('docs/validation/event-timeline-kpf-audit.json').skipped_data_lines,0);
 const devRescore=read('docs/validation/event-timeline-dev-rescore-report.json');assert.deepEqual(devRescore.chosen.config,dev.chosen.config);
 for(const rule of ['vehicle_stop','object_left','person_appears'])assert.equal(devRescore.rules[rule].references,dev.rules[rule].references);
 assert.deepEqual(testReport.config,{minimum_score:TIMELINE_SETTINGS.minimum_score,dwell_seconds:TIMELINE_SETTINGS.dwell_seconds});
 const devCameras=new Set(dev.clips.map(c=>c.camera));assert.ok(testReport.clips.every(c=>!devCameras.has(c.camera)));
 assert.equal(testReport.clips.length,16);assert.equal(dev.clips.length,8);
});
test('a rule that misses almost everything on the test half says so on the page',async()=>{
 const src=readFileSync(new URL('../web/timeline-view.mjs',import.meta.url),'utf8');
 assert.match(src,/x\.pmiss===1\?`，在公开测试中全部漏报（\$\{x\.references\} 个标注）`:x\.pmiss>=\.9\?'，在公开测试中几乎全部漏报'/);
 assert.equal(read('web/data/timeline/evaluation.json').test.rules.object_left.pmiss,1);
});
