import sys, math, unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import calibrate_drift_rules as C
import replay_parking_drift as R
from transfer_learning import routing_report

tail=lambda n,x,a:sum(math.comb(n,k)*a**k*(1-a)**(n-k) for k in range(x,n+1))

class DriftRuleTests(unittest.TestCase):
    def test_mixture_cusum_pruning_matches_exhaustive_search(self):
        rng=np.random.default_rng(1)
        for a in [.01,.05,.1]:
            us,vs=zip(*(C.llr(a,p) for p in C.mix_ps(a)));u,v=C.llr(a,2*a)
            for _ in range(40):
                x=rng.random(150)<a*rng.choice([1,4]);pos=np.flatnonzero(x).tolist()
                if not pos:continue
                L=np.array([[us[j] if xi else vs[j] for j in range(3)] for xi in x])
                for q,w in zip(pos,C.mix_path(pos,us,vs)):
                    self.assertAlmostEqual(w,max(math.log(np.exp(L[k:q+1].sum(0)).mean()) for k in range(q+1)),places=9)
                s,page=C.page_at_errors(np.array(pos)[None,:],u,v)
                self.assertTrue(np.allclose(page[0],C.mix_path(pos,[u],[v])))
    def test_binomial_tables_and_day_checks(self):
        T=C.tail_table(.05,12)
        for n in range(13):
            for x in range(n+2):self.assertAlmostEqual(T[n,x],tail(n,x,.05),places=12)
        a,f,n,days=.05,.3,6,12;T=C.tail_table(a,C.WINDOW*n)
        d=C.audited_days(np.random.default_rng(2),30,days,n,f,np.full((30,days),.2));m=C.window_minp(d,T,days)
        for r in range(30):
            U=int(d['valid'][r].sum());dy=d['day'][r][:U];e=d['e'][r][:U];best=1.
            for k in range(U):
                if e[k]:sel=[i for i in range(k+1) if dy[i]>=dy[k]-6];best=min(best,tail(len(sel),int(sum(e[i] for i in sel)),a))
            for dd in range(days):sel=[i for i in range(U) if dd-6<=dy[i]<dd];best=min(best,tail(len(sel),int(sum(e[i] for i in sel)),a))
            self.assertAlmostEqual(best,m[r],places=12)
    def test_replay_monitor_matches_calibration_statistics(self):
        k=R.Constants();rng=np.random.default_rng(5)
        for a in [.02,.05,.1]:
            us,vs=zip(*(C.llr(a,p) for p in C.mix_ps(a)));u,v=C.llr(a,2*a)
            for _ in range(50):
                bad=rng.random(int(rng.integers(1,120)))<a*3;bad[-1]=True;ms={r:R.Monitor(r,a,.1,k) for r in ['r0','r1','r2']}
                for i,b in enumerate(bad):
                    for m in ms.values():m.add(f'u{i}','20200101',bool(b))
                pos=np.flatnonzero(bad);s,w=C.page_at_errors(pos[None,:],u,v)
                self.assertAlmostEqual(ms['r0'].revoke('20200101')[0],s[0,-1],places=9)
                self.assertAlmostEqual(ms['r1'].revoke('20200101')[0],w[0,-1],places=9)
                self.assertAlmostEqual(ms['r2'].revoke('20200101')[0],C.mix_path(pos.tolist(),us,vs)[-1],places=9)
        m=R.Monitor('r3',.05,.1,k)
        for i,(d,b) in enumerate([('20200101',1),('20200103',0),('20200107',1),('20200108',1),('20200108',0)]):m.add(f'u{i}',d,bool(b))
        self.assertAlmostEqual(m.window('20200108',True)[0],tail(4,2,.05));self.assertAlmostEqual(m.window('20200108',False)[0],tail(2,1,.05))
        self.assertEqual(m.day_counts('20200108'),(2,1))
    def scene(self,wrong_day,slots=10):
        """One camera, 4 snapshots a day for 6 days, every score auto-free; all labels wrong on one day."""
        rows=[];p=[];y=[]
        for d in range(6):
            for t in ['0900','1100','1300','1500']:
                for s in range(slots):rows.append(dict(date=f'2020010{d+1}',time=t,slot=str(s)));p.append(.05);y.append(int(d==wrong_day))
        p,y=np.array(p),np.array(y);routing=dict(t_free=.1,t_busy=None,alpha_free=.05,alpha_busy=.1)
        base=routing_report(p,y,routing,np.array([f"{r['slot']}|{r['date']}" for r in rows]))
        return dict(cam=dict(rows=rows,p=p,y=y,routing=routing,days=sorted({r['date'] for r in rows}),base={k:base[k] for k in R.COUNTS},onset={}))
    def test_replay_without_checks_equals_routing_report(self):
        cams=self.scene(2);res=R.replay(cams,0.,'r0','none',R.Constants())['cam']['sides']['free'];b=cams['cam']['base']
        self.assertEqual((res['applied_snapshots'],res['applied_errors'],res['applied_units'],res['applied_units_with_error']),(b['auto_free'],b['auto_free_errors'],b['auto_free_units'],b['auto_free_units_with_error']))
    def test_suspension_and_recalibration_paths(self):
        k=R.Constants();cams=self.scene(1,slots=40)
        r4=R.replay(cams,.2,'r4','none',k)['cam'];v=r4['sides']['free']
        # The bad day also revokes through R2 in the same snapshot; revocation then takes precedence over the pause.
        self.assertEqual((v['suspensions'],v['suspended_snapshots'],v['revoked']['date']),(0,0,'20200102'))
        k.h2={a:1e9 for a in k.h2};r4=R.replay(cams,.2,'r4','none',k)['cam'];v=r4['sides']['free']
        self.assertIsNone(v['revoked']);self.assertEqual(v['first_suspension']['date'],'20200102')
        # Paused from the next snapshot through the end of the next day; spot-checked units still go to people as checks.
        self.assertGreater(v['suspended_snapshots'],0);self.assertLessEqual(v['suspended_snapshots'],7*40)
        self.assertEqual(v['applied_snapshots']+v['checked_snapshots']+v['suspended_snapshots']+v['revoked_snapshots'],960)
        self.assertEqual(r4['manual_share'],(r4['checked']+r4['suspended']+r4['revoked_review'])/960)
        r0=R.replay(self.scene(1),1.,'r0','daily',k)['cam']['sides']['free']
        self.assertTrue(r0['revocations']);self.assertEqual(r0['revocations'][0]['date'],'20200102')
        # Every score is 0.05, so any threshold that accepts anything also accepts the bad day's units, which are part
        # of the evidence from the revocation date on: the side must stay revoked instead of passing on old evidence.
        self.assertEqual(r0['reenables'],[])
    def test_daily_recalibration_recertifies_on_new_evidence_only(self):
        rows=[];p=[];y=[]
        for d in range(6):
            for t in ['0900','1100','1300','1500']:
                for s in range(40):bad=d==1 and t=='0900' and s<10;rows.append(dict(date=f'2020010{d+1}',time=t,slot=str(s)));p.append(.08 if bad else .01);y.append(int(bad))
        p,y=np.array(p),np.array(y);routing=dict(t_free=.1,t_busy=None,alpha_free=.05,alpha_busy=.1)
        cams=dict(cam=dict(rows=rows,p=p,y=y,routing=routing,days=sorted({r['date'] for r in rows}),base={},onset={}))
        v=R.replay(cams,1.,'r0','daily',R.Constants())['cam']['sides']['free']
        self.assertEqual((v['revocations'][0]['date'],v['revocations'][0]['time'],v['revocations'][0]['error_units']),('20200102','0900',9))
        # 40 clean slot·days a day from the revocation date: the Bonferroni level delta/30 needs 125, reached after 4 dates.
        self.assertEqual([(e['after_date'],e['threshold']) for e in v['reenables']],[('20200105',.01)])

if __name__=='__main__':unittest.main()
