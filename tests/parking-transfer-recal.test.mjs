import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {selectRouting,reselectSides,recalibrationSides,driftSideDates,laterDate,sideRecord,applyRecalibration} from '../web/parking-transfer.mjs';

// Shared with tests/training/test_recalibration.py, which regenerates it from the Python mirror.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/parking-transfer-recal.json',import.meta.url)));
const sha=ids=>createHash('sha256').update(ids.join('\n')).digest('hex');

test('re-selection of listed sides equals the Python mirror on real EXT scores',()=>{
 assert.equal(fixture.items.length,1104);let passes=0;
 for(const s of fixture.scenarios){
  const got=reselectSides(fixture.items,s.sides,{from:s.evidence_from,alpha_free:s.alpha_free,alpha_busy:s.alpha_busy});
  assert.deepEqual(Object.keys(got),s.sides);
  for(const [side,want] of Object.entries(s.expected)){
   const g=got[side],msg=`${JSON.stringify(s.evidence_from)} ${side}`;
   assert.deepEqual([g.threshold,g.from,g.dates,g.calibration_n,g.calibration_units,g.evidence.length,sha(g.evidence)],[want.threshold,want.from_date,want.dates,want.calibration_n,want.calibration_units,want.evidence_n,want.evidence_sha256],msg);
   assert.deepEqual(g.tests.map(t=>[t.threshold,t.accepted,t.errors,t.passed]),want.tests.map(t=>[t[0],t[1],t[2],t[4]]),msg);
   g.tests.forEach((t,i)=>assert.ok(Math.abs(t.upper_bound-want.tests[i][3])<=1e-9,msg));passes+=g.threshold!==null;
  }
 }
 assert.ok(passes>=3,'fixture covers passing and failing sides');
});

test('a side only sees conclusions from its own evidence date and needs two dates',()=>{
 const items=fixture.items,target={alpha_free:.1,alpha_busy:.2};
 // Every date: the free side passes. From the 2016-01-12 revocation on: refused, even though busy has an earlier floor.
 assert.equal(reselectSides(items,['free'],target).free.threshold,.05);
 const r=reselectSides(items,['free'],{...target,from:{free:'20160112',busy:'20151217'}}),use=items.filter(x=>x.date>='20160112');
 assert.deepEqual(Object.keys(r),['free']);assert.equal(r.free.calibration_n,use.length);assert.equal(r.free.dates,2);
 const ref=selectRouting(use.map(x=>x.score),use.map(x=>x.label),{...target,units:use.map(x=>x.unit)});assert.equal(r.free.threshold,ref.t_free);assert.equal(ref.t_free,null);
 assert.ok(r.free.evidence.every(id=>items.find(x=>x.id===id).score<=.5));
 const one=reselectSides(items,['busy'],{...target,from:{busy:'20160113'}}).busy;assert.deepEqual([one.threshold,one.dates,one.tests],[null,1,[]]);
 assert.throws(()=>reselectSides(items,['both']),/未知分流侧/);
});

test('drift dates per side: current files, older camera-level files and invalid records',()=>{
 for(const d of fixture.drift){if(d.error)assert.throws(()=>driftSideDates(d.log),/抽检撤销日期或历史格式无效/,JSON.stringify(d.log));else assert.deepEqual(driftSideDates(d.log),d.expected);}
 for(const s of fixture.sides)assert.deepEqual(recalibrationSides(s.revoked,s.routing),s.expected);
 assert.equal(laterDate(null,'20160112'),'20160112');assert.equal(laterDate('20160113','20160112'),'20160113');assert.equal(laterDate(undefined,undefined),null);
});

test('recalibration after a revocation keeps the live side and re-enables or keeps the revoked one',()=>{
 const at0='2026-01-01T00:00:00Z',at1='2026-01-02T00:00:00Z';
 const side=(threshold,from,ids)=>({threshold,from,dates:2,calibration_n:ids.length,calibration_units:ids.length,evidence:ids});
 const prev={routing:{t_free:.1,t_busy:.9,alpha_free:.05,alpha_busy:.1},revoked:{free:null,busy:{units:6,error_units:6}},sides:{free:sideRecord(side(.1,null,['a','b']),at0),busy:sideRecord(side(.9,null,['c']),at0)},attempts:{free:null,busy:null}};
 assert.deepEqual(recalibrationSides(prev.revoked,prev.routing),['busy']);assert.deepEqual(recalibrationSides(prev.revoked,{...prev.routing,t_free:null}),['free','busy']);
 // Pass: busy comes back with new evidence and a restarted monitor; free is the very same record.
 const pass=applyRecalibration(prev,{busy:side(.95,'20160112',['d','e'])},at1);
 assert.equal(pass.routing.t_busy,.95);assert.equal(pass.revoked.busy,null);assert.deepEqual([...pass.sides.busy.evidence],['d','e']);assert.equal(pass.sides.busy.from,'20160112');assert.equal(pass.sides.busy.reselected,true);
 assert.equal(pass.sides.free,prev.sides.free);assert.equal(pass.routing.t_free,.1);assert.equal(pass.attempts.busy,null);
 // Fail: still revoked, threshold kept on record, attempt logged; nothing else moves; the input is not mutated.
 const fail=applyRecalibration(prev,{busy:side(null,'20160112',['d'])},at1);
 assert.deepEqual(fail.revoked.busy,prev.revoked.busy);assert.equal(fail.routing.t_busy,.9);assert.equal(fail.sides.busy,prev.sides.busy);assert.equal(fail.sides.free,prev.sides.free);
 assert.deepEqual(fail.attempts.busy,{at:at1,from:'20160112',dates:2,calibration_n:1,calibration_units:1});
 assert.deepEqual(prev.attempts,{free:null,busy:null});assert.equal(prev.routing.t_busy,.9);
 // A previous failed attempt is cleared by a later pass.
 assert.equal(applyRecalibration(fail,{busy:side(.97,'20160113',['f'])},at1).attempts.busy,null);
});
