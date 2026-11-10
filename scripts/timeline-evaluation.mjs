/** Builds web/data/timeline/evaluation.json (what the page shows) from the committed MEVA dev and test reports.
 * Usage: node scripts/timeline-evaluation.mjs [--check]. --check fails if the published file differs. */
import fs from 'node:fs';
const read=p=>JSON.parse(fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8'));
export function summarise(dev,test){
 const rules=r=>Object.fromEntries(Object.entries(r.rules).map(([k,v])=>[k,{activity:v.activity,references:v.references,events:v.system_instances,matched:v.operating_point.matched,pmiss:v.operating_point.pmiss,pmiss_wilson_95:v.pmiss_wilson_95,tfa:v.operating_point.tfa,unmatched_per_minute:v.operating_point.unmatched_per_minute,pmiss_at_tfa_0_02:v.pmiss_at_tfa?.['0.02']??null,pmiss_at_tfa_0_1:v.pmiss_at_tfa?.['0.1']??null,naudc_0_2:v.naudc,temporal_iou_mean:v.temporal_iou.mean,temporal_iou_pairs:v.temporal_iou.pairs}]));
 const part=r=>({run_id:r.run_id,commit:r.commit,clips:r.clips.length,minutes:r.analysed_minutes,sites:[...new Set(r.clips.map(c=>c.site))].sort(),cameras:[...new Set(r.clips.map(c=>c.camera))].length,config:r.config,rules:rules(r),
  secondary:r.secondary.map(s=>({rule:s.rule,activity:s.activity,references:s.references,matched:s.operating_point.matched,pmiss:s.operating_point.pmiss})),
  failure_modes:r.failure_modes.aggregate});
 return {protocol:'docs/validation/event-timeline-protocol.md',dataset:'MEVA KF1, evaluation-level Kitware annotations (CC BY 4.0)',annotations:test.annotations,
  scope:'ActEV-style scoring re-implemented in this repository; whole-frame zones; 1 frame per second; first run on the test half, reported as measured.',
  dev:{...part(dev),chosen:dev.chosen},test:part(test)};
}
if(import.meta.url===`file://${process.argv[1]}`){
 const out=JSON.stringify(summarise(read('docs/validation/event-timeline-dev-report.json'),read('docs/validation/event-timeline-test-report.json')),null,1)+'\n';
 const target=new URL('../web/data/timeline/evaluation.json',import.meta.url);
 if(process.argv.includes('--check')){if(fs.readFileSync(target,'utf8')!==out){console.error('web/data/timeline/evaluation.json is stale');process.exit(1);}console.log('evaluation.json matches the reports');}
 else{fs.mkdirSync(new URL('./',target),{recursive:true});fs.writeFileSync(target,out);console.log('wrote',target.pathname);}
}
