import sys, unittest, json
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from parking_learning import features, fit, predict, split_records, metrics

class TrainingTests(unittest.TestCase):
    def test_uniform_patch_has_zero_texture(self):
        x=features(np.full((32,32,3),128,dtype=np.uint8))
        self.assertEqual(x.shape,(240,))
        self.assertTrue(np.isfinite(x).all())
        self.assertTrue(np.allclose(x.reshape(16,15)[:,3:],0))
    def test_camera_and_frame_groups_do_not_cross(self):
        rows=[dict(id=f'{c}-{t}-{s}',camera=c,date='20150703' if c=='A' else '20150708',time=f'{t:04d}',slot=s,sha256=f'{c}-{t}-{s}') for c in 'AB' for t in range(20) for s in range(3)]
        result=split_records(rows)
        groups={k:{(r['camera'],r['date'],r['time']) for r in v} for k,v in result.items()}
        for a,b in [('train','validation'),('train','test'),('validation','test')]: self.assertFalse(groups[a]&groups[b])
        self.assertEqual({r['camera'] for r in result['test']},{'B'})
        self.assertTrue(result['gap'])
    def test_training_uses_pixels_and_roundtrips(self):
        rng=np.random.default_rng(12); x=rng.normal(size=(96,8)); y=(x[:,0]+x[:,1]>0).astype(float)
        model,log=fit(x,y,x,y,seed=7,epochs=60,hidden=12)
        p=predict(x,json.loads(json.dumps(model)))
        self.assertGreater(np.mean((p>=.5)==y),.9)
        self.assertLess(log[-1]['train_loss'],log[0]['train_loss'])
    def test_counts_include_false_free(self):
        m=metrics([0,0,1,1],[.1,.8,.2,.9])
        self.assertEqual(m['confusion_matrix'],[[1,1],[1,1]])
        self.assertEqual(m['false_free'],1)
        self.assertEqual(m['balanced_accuracy'],.5)
if __name__=='__main__': unittest.main()
