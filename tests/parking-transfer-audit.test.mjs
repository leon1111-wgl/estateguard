import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {AUDIT,auditHash,auditUnit,isAudited,cpLower,cpUpper,auditEvidence,auditMonitor} from '../web/parking-transfer.mjs';

const read=path=>readFileSync(new URL(path,import.meta.url));
const fixture=JSON.parse(read('./fixtures/parking-transfer-audit.json'));
const replay=JSON.parse(read('../web/data/parking-transfer/audit-replay.json'));
const close=(a,b,tol,msg)=>assert.ok(Math.abs(a-b)<=tol,`${msg}: ${a} vs ${b}`);
const [header,...lines]=gunzipSync(read('../docs/validation/parking-ext-predictions.csv.gz')).toString().trim().split('\n');
const cols=header.split(','),ext=lines.map(line=>Object.fromEntries(line.split(',').map((v,i)=>[cols[i],v])));

test('spot-check hash equals Python, including non-ASCII text',()=>{
 for(const {text,value} of fixture.hash)assert.equal(auditHash(text),value,text);
 assert.ok(fixture.hash.every(h=>h.value>=0&&h.value<1));
});

test('spot-checked camera·slot·date sets equal Python on every EXT camera',()=>{
 for(const [camera,expected] of Object.entries(fixture.units)){
  const units=[...new Set(ext.filter(r=>r.camera===camera).map(r=>auditUnit(r.camera,r.slot,r.date)))].sort();
  assert.equal(units.length,expected.count,camera);
  for(const f of [.05,.1,.2]){
   const chosen=units.filter(u=>isAudited(u,f));assert.equal(chosen.length,expected[`selected_${f}`],`${camera} ${f}`);
   assert.equal(createHash('sha256').update(chosen.join('\n')).digest('hex'),expected[String(f)],`${camera} ${f} digest`);
  }
 }
 // Selection is nested in the fraction and close to it overall (it never looks at scores or labels).
 const all=[...new Set(ext.map(r=>auditUnit(r.camera,r.slot,r.date)))];
 assert.ok(all.filter(u=>isAudited(u,.05)).every(u=>isAudited(u,.1)&&isAudited(u,.2)));
 close(all.filter(u=>isAudited(u,AUDIT.fraction)).length/all.length,AUDIT.fraction,.02,'overall fraction');
});

test('Clopper-Pearson lower bound matches Python and closed forms',()=>{
 for(const c of fixture.cp)close(cpLower(c.x,c.n,c.level),c.lower,1e-10,JSON.stringify(c));
 close(cpLower(4,4,.05),.05**(1/4),1e-12,'all errors');assert.equal(cpLower(0,50,.05),0);
 close(cpLower(7,90,.01),1-cpUpper(83,90,.01),1e-9,'symmetry');
});

test('sequential rule: 5% target revokes exactly when x >= 4.94 + 0.0724 n',()=>{
 for(let n=1;n<=400;n++)for(let x=0;x<=Math.min(n,60);x++){const [,hit]=auditEvidence(x,n,.05);assert.equal(hit,x>=(Math.log(40)-n*Math.log(.9/.95))/(Math.log(2)-Math.log(.9/.95)),`${x}/${n}`);}
 // A single error never revokes; two errors out of two do under the CP rule but not the likelihood-ratio rule.
 assert.equal(auditEvidence(1,1,.05,{rule:'cp'})[1],false);assert.equal(auditEvidence(2,2,.05,{rule:'cp'})[1],true);assert.equal(auditEvidence(2,2,.05)[1],false);
 assert.throws(()=>auditEvidence(1,1,.6),/0.5/);assert.throws(()=>auditEvidence(1,1,.05,{rule:'x'}),/未知/);
});

test('monitor equals Python on real 20% spot-check streams from EXT',()=>{
 assert.ok(fixture.monitor.length>=2);
 for(const m of fixture.monitor){
  const events=m.events.map(([u,b,w])=>({unit:m.units[u],side:b?'busy':'free',wrong:!!w}));
  for(const [rule,want] of Object.entries(m.expected)){
   const got=auditMonitor(events,{alpha_free:m.alpha_free,alpha_busy:m.alpha_busy,rule});
   for(const side of ['free','busy']){
    const g=got[side],w=want[side];assert.equal(g.units,w.units);assert.equal(g.error_units,w.error_units);assert.equal(g.pending,w.pending);
    if(w.statistic===null)assert.equal(g.statistic,null);else close(g.statistic,w.statistic,1e-9,`${m.camera} ${rule} ${side}`);
    assert.deepEqual(g.revoked&&{index:g.revoked.index,units:g.revoked.units,error_units:g.revoked.error_units},w.revoked&&{index:w.revoked.index,units:w.revoked.units,error_units:w.revoked.error_units},`${m.camera} ${rule} ${side}`);
   }
  }
 }
});

test('monitor counts units once, treats unreviewed checks as correct and ignores uncertified sides',()=>{
 const e=(unit,side,wrong)=>({unit,side,wrong});
 const pending=auditMonitor(Array.from({length:30},(_,i)=>e(`u${i}`,'free',null)),{alpha_free:.05,alpha_busy:null});
 assert.equal(pending.free.units,30);assert.equal(pending.free.error_units,0);assert.equal(pending.free.pending,30);assert.equal(pending.free.revoked,null);assert.equal(pending.busy.units,0);
 // Repeated wrong snapshots of one slot-day are one error unit; revocation is the first crossing.
 const stream=[...Array(6).fill(e('a','free',true)),...['b','c','d','e','f'].map(u=>e(u,'free',true)),e('g','busy',true)];
 const m=auditMonitor(stream,{alpha_free:.05,alpha_busy:null});
 assert.equal(m.free.units,6);assert.equal(m.free.error_units,6);assert.equal(m.free.revoked.index,10);assert.equal(m.free.revoked.error_units,6);
 assert.equal(m.busy.units,0,'a side without a threshold is not monitored');
});

test('likelihood-ratio rule rarely revokes a side that meets its target (anytime, synthetic)',()=>{
 let seed=20261018;const rand=()=>(seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296;let revoked=0;
 for(let run=0;run<2000;run++){let x=0;for(let n=1;n<=1000;n++){if(rand()<.05){x++;if(auditEvidence(x,n,.05)[1]){revoked++;break;}}}}
 assert.ok(revoked/2000<=AUDIT.delta/2+.01,`false revocation ${revoked/2000}`);
});

test('published replay reproduces the baselines and reports the pre-registered primary analysis',()=>{
 assert.equal(replay.reproduced.length,54);assert.equal(replay.official_labels.rows_matched,144965);
 assert.deepEqual(replay.primary,{model:'dinov2',alpha:.05,fraction:AUDIT.fraction,rule:AUDIT.rule});
 const base=replay.summary.find(g=>g.model==='dinov2'&&g.alpha===.05&&g.fraction===0),primary=replay.summary.find(g=>g.model==='dinov2'&&g.alpha===.05&&g.fraction===.1&&g.rule==='sprt');
 // The no-audit replay is the appendix 4 failure: 185 of 2,553 automatic free slot-days wrong.
 assert.equal(base.free_pooled.applied_units_with_error,185);assert.equal(base.free_pooled.applied_units,2553);
 assert.ok(primary.within_revoked===0&&primary.over>=1);
 for(const g of replay.summary)assert.ok(g.checked_share_of_auto<=g.fraction*1.5+.01,`${g.model} ${g.fraction}`);
});
