"""Re-calibration after a spot-check revocation (protocol appendix 7 / 7.3): the page helpers, their Python mirror and
the appendix 7 replay must re-select only the revoked side, from that side's own revocation date.
Regenerate the shared JS/Python fixture with: python tests/training/test_recalibration.py --write"""
import csv,gzip,hashlib,io,json,math,sys,unittest
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from transfer_learning import audit_unit,drift_side_dates,is_audited,later_date,recalibration_sides,reselect_sides,select_routing
import replay_parking_drift as R

FIXTURE=ROOT/'tests/fixtures/parking-transfer-recal.json'
DATES=['20151217','20151218','20151219','20151222','20160112','20160113']
SCENARIOS=[dict(sides=['free','busy'],evidence_from={},alpha_free=.1,alpha_busy=.2),dict(sides=['free','busy'],evidence_from={},alpha_free=.05,alpha_busy=.1),
           dict(sides=['free'],evidence_from=dict(free='20160112'),alpha_free=.1,alpha_busy=.2),dict(sides=['busy'],evidence_from=dict(busy='20160113'),alpha_free=.05,alpha_busy=.1),
           dict(sides=['free','busy'],evidence_from=dict(free='20151222',busy='20160112'),alpha_free=.1,alpha_busy=.2)]
DRIFT=[dict(log=dict(evidence_from='20160114',evidence_from_by_side=dict(free=None,busy='20160112'),history=[])),
       dict(log=dict(evidence_from='20160114',history=[dict(side='free',source_time='20160112 0900'),dict(side='free',source_time='20160114 1000'),dict(side='busy',source_time='20160113 1100')])),
       dict(log=dict(evidence_from='20160113',history=[dict(side='busy',source_time='20160113 1100')])),
       dict(log=dict(evidence_from='20160113',history=[])),
       dict(log=dict(evidence_from='2016-01-13',history=[])),dict(log=dict(evidence_from_by_side=dict(free=None,busy=None),history=[])),
       dict(log=dict(evidence_from_by_side=dict(free='20160113'))),dict(log=dict(evidence_from_by_side=dict(free=20160113,busy=None),history=[]))]


def ext_items():
    """C7 DINOv2 calibrated scores and labels on six dates around the January 2016 drift, every fifth snapshot."""
    rows=[r for r in csv.DictReader(io.StringIO(gzip.decompress((ROOT/'docs/validation/parking-ext-predictions.csv.gz').read_bytes()).decode())) if r['camera']=='C7' and r['date'] in DATES]
    keep={d:sorted({r['time'] for r in rows if r['date']==d})[::5] for d in DATES}
    rows=sorted((r for r in rows if r['time'] in keep[r['date']]),key=lambda r:(r['date'],r['time'],r['slot']))
    return [dict(id=r['id'],score=float(r['dinov2_calibrated']),label=int(r['label']),unit=audit_unit(r['camera'],r['slot'],r['date']),date=r['date']) for r in rows]


def build_fixture():
    items=ext_items();scenarios=[]
    for s in SCENARIOS:
        out=reselect_sides(items,s['sides'],s['evidence_from'],alpha_free=s['alpha_free'],alpha_busy=s['alpha_busy'])
        for side in out.values():
            # Keep every certification decision away from ties so the JS/Python comparison cannot flip on rounding.
            for t in side['tests']:assert abs(t['upper_bound']-s[f"alpha_{t['side']}"])>1e-6,t
        scenarios.append(dict(**s,expected={k:dict(threshold=v['threshold'],from_date=v['from_date'],dates=v['dates'],calibration_n=v['calibration_n'],
            calibration_units=v['calibration_units'],evidence_n=len(v['evidence']),evidence_sha256=hashlib.sha256('\n'.join(v['evidence']).encode()).hexdigest(),tests=[[t['threshold'],t['accepted'],t['errors'],t['upper_bound'],t['passed']] for t in v['tests']]) for k,v in out.items()}))
    drift=[]
    for d in DRIFT:
        try:drift.append(dict(log=d['log'],expected=drift_side_dates(d['log'])))
        except ValueError:drift.append(dict(log=d['log'],error=True))
    return dict(source='docs/validation/parking-ext-predictions.csv.gz: C7 dinov2_calibrated, '+', '.join(DATES)+', every fifth snapshot',items=items,scenarios=scenarios,drift=drift,
        sides=[dict(revoked=r,routing=t,expected=recalibration_sides(r,t)) for r,t in [(None,None),({},dict(t_free=.1,t_busy=.9)),(dict(free=None,busy=None),dict(t_free=None,t_busy=.9)),
            (dict(free=None,busy={'units':6}),dict(t_free=.1,t_busy=.9)),(dict(free=None,busy={'units':6}),dict(t_free=None,t_busy=.9)),(dict(free={'units':5},busy={'units':6}),dict(t_free=.1,t_busy=.9))]])


class RecalibrationTests(unittest.TestCase):
    def test_fixture_is_current(self):
        # Structure, counts, ids, dates and booleans must match exactly. Floats may differ in the last bits between
        # platforms (the fixture was written on macOS; CI runs Ubuntu), so they are compared to 1e-12 relative.
        def same(a,b,path='$'):
            if isinstance(a,float) or isinstance(b,float):
                self.assertFalse(isinstance(a,bool) or isinstance(b,bool),path)
                self.assertTrue(math.isclose(a,b,rel_tol=1e-12,abs_tol=1e-15),f'{path}: {a!r} != {b!r}');return
            self.assertIs(type(a),type(b),path)
            if isinstance(a,dict):
                self.assertEqual(list(a),list(b),path)
                for k in a:same(a[k],b[k],f'{path}.{k}')
            elif isinstance(a,list):
                self.assertEqual(len(a),len(b),path)
                for i,(x,y) in enumerate(zip(a,b)):same(x,y,f'{path}[{i}]')
            else:self.assertEqual(a,b,path)
        same(json.loads(FIXTURE.read_text()),json.loads(json.dumps(build_fixture())))
        # The tolerance is not a loophole: a changed count or threshold still fails.
        broken=json.loads(json.dumps(build_fixture()))
        broken['source']=str(broken.get('source'))+'x' if 'source' in broken else 'x'
        with self.assertRaises(AssertionError):same(json.loads(FIXTURE.read_text()),broken)

    def test_only_listed_sides_and_own_dates(self):
        items=ext_items();target=dict(alpha_free=.1,alpha_busy=.2)
        # On all six dates the free side passes; from a 2016-01-12 revocation on, the same rule refuses it.
        self.assertEqual(reselect_sides(items,['free'],**target)['free']['threshold'],.05)
        r=reselect_sides(items,['free'],dict(free='20160112',busy='20151217'),**target)
        self.assertEqual(list(r),['free'])
        use=[x for x in items if x['date']>='20160112'];ref=select_routing([x['score'] for x in use],[x['label'] for x in use],units=[x['unit'] for x in use],**target)
        self.assertEqual((r['free']['threshold'],r['free']['dates'],r['free']['calibration_n']),(ref['t_free'],2,len(use)));self.assertIsNone(ref['t_free'])
        # Evidence for a side is what can move its threshold: scores inside its candidate range only.
        self.assertTrue(all(x['score']<=.5 for x in use if x['id'] in set(r['free']['evidence'])))
        self.assertEqual(len(r['free']['evidence']),sum(x['score']<=.5 for x in use))
        one=reselect_sides(items,['busy'],dict(busy='20160113'),**target)['busy']
        self.assertEqual((one['threshold'],one['dates'],one['tests']),(None,1,[]))

    def test_drift_dates_and_sides(self):
        self.assertEqual(recalibration_sides(None),['free','busy']);self.assertEqual(recalibration_sides(dict(free=None,busy={'units':6}),dict(t_free=.1,t_busy=.9)),['busy'])
        # A side that never passed is always re-tested: its region always went to people, so its conclusions are complete.
        self.assertEqual(recalibration_sides(dict(free=None,busy={'units':6}),dict(t_free=None,t_busy=.9)),['free','busy'])
        self.assertEqual(later_date(None,'20160112'),'20160112');self.assertEqual(later_date('20160113','20160112'),'20160113')
        old=dict(evidence_from='20160114',history=[dict(side='busy',source_time='20160112 0900')])
        # An older file's camera date is the later of both sides; the free side was never revoked, so it stays open.
        self.assertEqual(drift_side_dates(old),dict(free=None,busy='20160112'))
        self.assertEqual(drift_side_dates(dict(evidence_from='20160114',history=[])),dict(free='20160114',busy='20160114'))
        for bad in [None,[],dict(history=[]),dict(evidence_from='x',history=[]),dict(evidence_from_by_side=dict(free=None,busy=None),history=[])]:
            with self.assertRaises(ValueError):drift_side_dates(bad)

    def two_sided(self):
        """One camera, 40 slots, 4 snapshots a day for 8 days. Free side (scores .01, threshold .1) is wrong on day 2
        for 10 slots in the first snapshot; busy side (scores .99, threshold .9) is always right."""
        rows=[];p=[];y=[]
        for d in range(8):
            for t in ['0900','1100','1300','1500']:
                for s in range(40):
                    free=s<20;bad=free and d==1 and t=='0900' and s<10
                    rows.append(dict(date=f'2020010{d+1}',time=t,slot=str(s)));p.append(.08 if bad else .01 if free else .99);y.append(int(bad or not free))
        p,y=np.array(p),np.array(y);routing=dict(t_free=.1,t_busy=.9,alpha_free=.05,alpha_busy=.1)
        return dict(cam=dict(rows=rows,p=p,y=y,routing=routing,days=sorted({r['date'] for r in rows}),base={},onset={}))

    def test_replay_reselects_only_the_revoked_side_from_its_own_date(self):
        cams=self.two_sided();k=R.Constants()
        daily=R.replay(cams,1.,'r0','daily',k)['cam']['sides'];none=R.replay(cams,1.,'r0','none',k)['cam']['sides']
        free=daily['free'];rev=free['revocations'][0]
        self.assertEqual((rev['date'],len(free['revocations'])),('20200102',1))
        # The busy side is never re-tested: its threshold, checks and applied decisions equal the run without recalibration.
        self.assertEqual(daily['busy'],none['busy']);self.assertIsNone(daily['busy']['revoked'])
        # With every unit spot-checked, every snapshot reaches a person, so the replay's evidence at the end of date d is
        # every row dated from the revocation date to d. reselect_sides on the same rows gives the same first pass.
        rows=cams['cam']['rows'];P=cams['cam']['p'];Y=cams['cam']['y']
        items=[dict(id=i,score=float(P[i]),label=int(Y[i]),unit=f"{r['slot']}|{r['date']}",date=r['date']) for i,r in enumerate(rows)]
        first=None
        for d in cams['cam']['days']:
            r=reselect_sides([x for x in items if x['date']<=d],['free'],dict(free=rev['date']),alpha_free=.05,alpha_busy=.1)['free']
            if r['threshold'] is not None:first=(d,r['threshold']);break
        self.assertIsNotNone(first)
        self.assertEqual([(e['after_date'],e['threshold']) for e in free['reenables']],[first])

    def test_replay_evidence_under_ten_percent_checks_equals_the_conclusions_that_exist(self):
        """With 10% spot checks, the replay's re-selection must see exactly what a page would hold: the review band, the
        spot-checked units' would-be automatic snapshots, and the revoked side from the snapshot after its revocation."""
        rows=[];p=[];y=[]
        for d in range(8):
            for t in ['0900','1100','1300','1500']:
                for s in range(120):
                    date=f'2020010{d+1}';bad=s<80 and d==1 and t=='0900'
                    score=.08 if bad else .01 if s<80 else .99 if s<110 else .5;label=1 if bad else 0 if s<80 else 1 if s<110 else int((s+d)%2)
                    rows.append(dict(date=date,time=t,slot=str(s)));p.append(score);y.append(label)
        p,y=np.array(p),np.array(y);routing=dict(t_free=.1,t_busy=.9,alpha_free=.05,alpha_busy=.1)
        cams=dict(cam=dict(rows=rows,p=p,y=y,routing=routing,days=sorted({r['date'] for r in rows}),base={},onset={}))
        calls=[];real=R.select_routing
        def spy(pp,yy,**kw):calls.append(sorted(zip(kw['units'].tolist(),np.asarray(pp).tolist(),np.asarray(yy).tolist())));return real(pp,yy,**kw)
        R.select_routing=spy
        try:res=R.replay(cams,.1,'r0','daily',R.Constants())['cam']['sides']
        finally:R.select_routing=real
        free=res['free'];rev=free['revocations'][0];self.assertEqual((rev['date'],len(free['revocations'])),('20200102',1))
        self.assertEqual(res['busy'],R.replay(cams,.1,'r0','none',R.Constants())['cam']['sides']['busy'])
        def human(i,r):
            side='free' if p[i]<=.1 else 'busy' if p[i]>=.9 else 'review'
            return side=='review' or is_audited(audit_unit('cam',r['slot'],r['date']),.1) or side=='free' and (r['date'],r['time'])>(rev['date'],rev['time'])
        self.assertTrue(calls)
        for call in calls:
            d=max(u.split('|')[1] for u,_,_ in call)
            want=[(f"{r['slot']}|{r['date']}",float(p[i]),int(y[i])) for i,r in enumerate(rows) if rev['date']<=r['date']<=d and human(i,r)]
            self.assertEqual(call,sorted(want),d)
        # The first date on which those conclusions pass is the replay's re-enable date, with the same threshold.
        items=[dict(id=i,score=float(p[i]),label=int(y[i]),unit=f"{r['slot']}|{r['date']}",date=r['date']) for i,r in enumerate(rows) if human(i,r) and r['date']>=rev['date']]
        first=next(((d,v['threshold']) for d in cams['cam']['days'] for v in [reselect_sides([x for x in items if x['date']<=d],['free'],dict(free=rev['date']),alpha_free=.05,alpha_busy=.1)['free']] if v['threshold'] is not None),None)
        self.assertEqual([(e['after_date'],e['threshold']) for e in free['reenables']],[first])

    def test_page_style_evidence_would_certify_a_drifting_live_side(self):
        """Why a live side is kept: after the other side is revoked, a live side's own region has only spot checks.
        Re-testing it then admits units through their reviewed snapshots while their automatic ones stay unseen."""
        items=[];truth=[]
        for d in range(10):
            date=f'201601{d+10:02d}'
            for s in range(300):
                mixed=s%7==0  # parked in the morning (0.7, busy); empty in the afternoon but read as 0.95 (wrong)
                for t,(p,yy) in enumerate([(.7,1),(.95,0)] if mixed else [(.95,1),(.95,1)]):
                    unit=audit_unit('C',str(s),date);x=dict(id=f'{unit}|{t}',score=p,label=yy,unit=unit,date=date);truth.append(x)
                    if p<.9 or is_audited(unit):items.append(x)  # live busy >= 0.9 auto-decides the rest
        seen=reselect_sides(items,['busy'],alpha_free=.05,alpha_busy=.1)['busy'];full=reselect_sides(truth,['busy'],alpha_free=.05,alpha_busy=.1)['busy']
        bad={x['unit'] for x in truth if x['score']>=.7 and x['label']==0};units={x['unit'] for x in truth}
        self.assertEqual((seen['threshold'],full['threshold']),(.7,None))
        self.assertGreater(len(bad)/len(units),.1)  # 14.3% of slot·days err against a 10% target


if __name__=='__main__':
    if '--write' in sys.argv:FIXTURE.write_text(json.dumps(build_fixture(),ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n');print('wrote',FIXTURE.relative_to(ROOT))
    else:unittest.main()
