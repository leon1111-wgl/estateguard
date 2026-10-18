import sys, math, unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from transfer_learning import adapt, bce, chronological_roles, cp_upper, ece, fit_temperature, route, routing_report, select_routing, sigmoid
from transfer_learning import AUDIT, audit_evidence, audit_hash, audit_monitor, audit_unit, binom_cdf, cp_lower, is_audited
import random
from replay_parking_audit import replay

class TransferTests(unittest.TestCase):
    def test_clopper_pearson_matches_closed_form_and_is_monotone(self):
        self.assertAlmostEqual(cp_upper(0,300,.05),1-.05**(1/300),places=9)
        self.assertEqual(cp_upper(0,0,.05),1.)
        self.assertLess(cp_upper(2,1000,.05),cp_upper(2,100,.05))
        self.assertLess(cp_upper(1,500,.05),cp_upper(5,500,.05))
    def test_routing_refuses_without_enough_evidence(self):
        r=select_routing(np.full(100,.01),np.zeros(100))
        self.assertIsNone(r['t_free']);self.assertIsNone(r['t_busy'])
        self.assertTrue(all(t['upper_bound']>.01 for t in r['tests'] if t['side']=='free' and t['accepted']))
        self.assertTrue((route(np.array([.001,.999]),r)=='review').all())
    def test_routing_certifies_clean_large_sets_and_reports_realized_error(self):
        p=np.r_[np.full(800,.01),np.full(800,.99)];y=np.r_[np.zeros(800),np.ones(800)]
        r=select_routing(p,y);self.assertEqual((r['t_free'],r['t_busy']),(.01,.99))
        rep=routing_report(p,1-y,r)  # labels flipped: every automatic decision is wrong
        self.assertEqual(rep['coverage'],1.);self.assertEqual(rep['auto_free_error_rate'],1.)
    def test_temperature_keeps_decisions_and_reduces_overconfidence(self):
        rng=np.random.default_rng(3);y=rng.integers(0,2,4000);z=(2*y-1)*1.5+rng.normal(0,1.5,4000)
        T=fit_temperature(z*4,y)
        self.assertGreater(T,2.5)
        self.assertTrue(((z*4/T)>=0).tolist()==((z*4)>=0).tolist())
        self.assertLess(bce(z*4/T,y),bce(z*4,y))
        self.assertLess(ece(sigmoid(z*4/T),y),ece(sigmoid(z*4),y))
    def test_l2sp_adaptation_moves_toward_new_labels_but_stays_anchored(self):
        rng=np.random.default_rng(5);w0=rng.normal(size=16);x=rng.normal(size=(64,16));y=(x[:,0]>0).astype(float)
        w,b=adapt(x,y,w0,0.)
        self.assertLess(bce(x@w+b,y),bce(x@w0,y))
        w_loose,_=adapt(x,y,w0,0.,lam=0.)
        self.assertLess(np.linalg.norm(w-w0),np.linalg.norm(w_loose-w0))
        w2,b2=adapt(x,y,w0,0.);self.assertTrue(np.array_equal(w,w2) and b==b2)
    def test_chronological_roles_are_ordered_and_label_free(self):
        frames=[f'{h:02d}{m:02d}' for h in range(8,18) for m in (0,30)]
        roles=chronological_roles(frames);order=[roles[f] for f in frames]
        self.assertEqual(order.count('pool'),4);self.assertEqual(order.count('gap'),2);self.assertEqual(order.count('eval'),14)
        self.assertEqual(order,sorted(order,key=['pool','gap','eval'].index))

class DriftControlTests(unittest.TestCase):
    def test_hash_is_fnv1a_fmix32_and_selection_is_nested(self):
        h=0x811c9dc5;h^=h>>16;h=(h*0x85ebca6b)&0xffffffff;h^=h>>13;h=(h*0xc2b2ae35)&0xffffffff;h^=h>>16
        self.assertEqual(audit_hash(''),h/2**32)
        units=[audit_unit(f'C{c}',str(s),f'201511{d:02d}') for c in range(1,10) for s in range(40) for d in range(1,29)]
        for f in (.05,.1,.2):self.assertAlmostEqual(sum(map(lambda u:is_audited(u,f),units))/len(units),f,delta=.015)
        self.assertTrue(all(is_audited(u,.2) for u in units if is_audited(u,.1)))
    def test_cp_lower_matches_closed_form_and_upper_bound(self):
        self.assertAlmostEqual(cp_lower(4,4,.05),.05**(1/4),places=12);self.assertEqual(cp_lower(0,9,.05),0.)
        for x,n in [(1,3),(5,40),(12,300)]:self.assertAlmostEqual(cp_lower(x,n,.01),1-cp_upper(n-x,n,.01),places=9)
    def test_cp_rule_spends_level_over_error_count(self):
        # Revoking at the j-th error with n units is the same as P_alpha(Bin(n,alpha)>=j) <= (delta/2)/(j(j+1)).
        for j in range(1,25):
            for n in range(j,8*j+40):
                tail=1-binom_cdf(j-1,n,.05);level=(AUDIT['delta']/2)/(j*(j+1))
                if abs(tail-level)>1e-9*level:self.assertEqual(audit_evidence(j,n,.05,rule='cp')[1],tail<=level,(j,n))
    def test_sprt_boundary_and_validity(self):
        a,b=math.log(2),math.log(.9/.95)
        for n in range(1,300):
            for x in range(0,min(n,40)+1):self.assertEqual(audit_evidence(x,n,.05)[1],x*a+(n-x)*b>=math.log(40))
        rng=random.Random(5);revoked=0
        for _ in range(2000):
            x=0
            for n in range(1,1001):
                if rng.random()<.05:
                    x+=1
                    if audit_evidence(x,n,.05)[1]:revoked+=1;break
        self.assertLessEqual(revoked/2000,AUDIT['delta']/2+.01)
    def test_monitor_counts_units_once_and_unreviewed_as_correct(self):
        e=lambda u,s,w:dict(unit=u,side=s,wrong=w)
        m=audit_monitor([e('a','free',None)]*3+[e('b','free',False)],.05,None)
        self.assertEqual((m['free']['units'],m['free']['error_units'],m['free']['pending']),(2,0,3));self.assertEqual(m['busy']['units'],0)
        m=audit_monitor([e('a','free',True)]*6+[e(u,'free',True) for u in 'bcdef'],.05,.1)
        self.assertEqual(m['free']['revoked']['index'],10);self.assertEqual(m['free']['revoked']['error_units'],6)
    def test_replay_matches_baseline_and_revokes_from_next_snapshot(self):
        # One camera, 40 slots, 6 days x 4 snapshots; everything is auto-free and every slot is occupied from day 3.
        rows=[dict(date=f'2016010{d}',time=f'{t:02d}00',slot=str(s)) for d in range(1,7) for t in (8,10,12,14) for s in range(40)]
        y=np.array([int(r['date']>='20160103') for r in rows]);p=np.full(len(rows),.001);routing=dict(t_free=.005,t_busy=None,alpha_free=.05,alpha_busy=.1)
        base=replay('CX',rows,p,y,routing,0.,'sprt');units=np.array([f"{r['slot']}|{r['date']}" for r in rows]);rep=routing_report(p,y,routing,units)
        self.assertEqual((base['sides']['free']['applied_snapshots'],base['sides']['free']['applied_units_with_error']),(rep['auto_free'],rep['auto_free_units_with_error']))
        r=replay('CX',rows,p,y,routing,.2,'sprt');rv=r['sides']['free']['revoked']
        self.assertIsNotNone(rv);self.assertGreaterEqual(rv['date'],'20160103')
        # The triggering snapshot itself still auto-decides its unchecked slots; later snapshots go to people.
        later=sum(1 for q in rows if (q['date'],q['time'])>(rv['date'],rv['time']))
        self.assertEqual(r['revoked_review'],later)
        self.assertEqual(r['checked']+r['sides']['free']['applied_snapshots']+r['revoked_review'],len(rows))

if __name__=='__main__':unittest.main()
