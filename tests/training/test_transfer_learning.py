import sys, math, unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from transfer_learning import adapt, bce, chronological_roles, cp_upper, ece, fit_temperature, route, routing_report, select_routing, sigmoid

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

if __name__=='__main__':unittest.main()
