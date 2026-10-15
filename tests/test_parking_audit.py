"""Data-contract tests for the fixed-model audit; no training or network."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/audit_parking_errors.py'


def load_auditor():
    if not SCRIPT.is_file():
        raise AssertionError('The reusable parking-error auditor is not implemented')
    spec = importlib.util.spec_from_file_location('audit_parking_errors', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixtures():
    model_bytes = b'{"name":"fixture frozen model","review_band":[0.35,0.65]}'
    sha = hashlib.sha256(model_bytes).hexdigest()
    # Includes exact boundaries and the same slot number on different cameras.
    records = [('B', '1', '0805', 1, .35), ('B', '1', '0905', 1, .36),
               ('B', '2', '0905', 0, .5), ('B', '2', '1005', 0, .65),
               ('B', '3', '1005', 1, .7), ('A', '1', '1105', 0, .1),
               ('B', '4', '1105', 0, .49)]
    samples, predictions, frames = [], [], []
    for camera, slot, stamp, label, score in records:
        sid = f'{camera}-20150708-{stamp}-{slot}'
        frame = f'{camera}-20150708-{stamp}'
        samples.append(dict(id=sid, camera=camera, date='20150708', time=stamp,
                            slot=slot, label=label, split='test', image=f'images/{sid}.jpg',
                            input=f'inputs/{sid}.png'))
        predictions.append(dict(id=sid, label=label, score=score, prediction=int(score >= .5),
                                correct=(int(score >= .5) == label), model_sha256=sha))
        match = next((r for r in frames if r['id'] == frame), None)
        if match is None:
            match = dict(id=frame, camera=camera, date='20150708', time=stamp, sample_ids=[])
            frames.append(match)
        match['sample_ids'].append(sid)
    manifest = dict(model_sha256=sha, dataset={'license':'ODbL-1.0'}, samples=samples, frames=frames)
    evaluation = dict(model_sha256=sha, review_band=[.35,.65], review_samples=3,
                      confident_false_free=1, confident_false_occupied=1,
                      test=dict(n=7,free=4,occupied=3,accuracy=3/7,
                                balanced_accuracy=(2/4+1/3)/2,occupied_recall=1/3,
                                false_free=2,false_occupied=2,confusion_matrix=[[2,2],[2,1]],
                                confusion_order=['free','occupied']))
    return manifest, predictions, evaluation, model_bytes


class ParkingAuditTests(unittest.TestCase):
    def setUp(self):
        self.auditor = load_auditor()
        self.manifest, self.predictions, self.evaluation, self.model = fixtures()

    def audit(self):
        return self.auditor.audit(self.manifest, self.predictions, self.evaluation, self.model)

    def test_exact_thresholds_separate_binary_errors_from_uncertain_band(self):
        report = self.audit()
        self.assertEqual(report['overall']['false_free'], 2)
        self.assertEqual(report['overall']['false_occupied'], 2)
        self.assertEqual(report['uncertain_band'], dict(n=3,correct=1,false_free=1,false_occupied=1,
            covered_errors=2,total_errors=4,errors_outside_band=2,false_free_outside_band=1,
            false_occupied_outside_band=1,fraction_of_all_errors_covered=.5))

    def test_group_rates_use_truth_denominators_and_camera_slot_key(self):
        report = self.audit()
        groups = {r['camera_slot']:r for r in report['by_camera_slot']}
        self.assertEqual(set(groups), {'A:1','B:1','B:2','B:3','B:4'})
        self.assertEqual(groups['B:1']['false_free_rate'], 1)
        self.assertEqual(groups['B:2']['false_occupied_rate'], 1)
        self.assertIsNone(groups['A:1']['false_free_rate'])
        self.assertEqual({r['hour']:r['n'] for r in report['by_hour']}, {'08':1,'09':2,'10':2,'11':2})
        self.assertEqual(len(report['errors']), 4)

    def test_duplicate_missing_or_unknown_prediction_ids_are_rejected(self):
        for mutation in ['duplicate','missing','unknown']:
            with self.subTest(mutation=mutation):
                self.manifest,self.predictions,self.evaluation,self.model = fixtures()
                if mutation == 'duplicate': self.predictions[-1] = copy.deepcopy(self.predictions[0])
                if mutation == 'missing': self.predictions.pop()
                if mutation == 'unknown': self.predictions[0]['id'] = 'unknown'
                with self.assertRaises(ValueError): self.audit()

    def test_manifest_duplicate_or_frame_corruption_is_rejected(self):
        for mutation in ['duplicate','missing_frame_id','wrong_frame_time']:
            with self.subTest(mutation=mutation):
                self.manifest,self.predictions,self.evaluation,self.model = fixtures()
                if mutation == 'duplicate': self.manifest['samples'].append(self.manifest['samples'][0])
                if mutation == 'missing_frame_id': self.manifest['frames'][0]['sample_ids'].pop()
                if mutation == 'wrong_frame_time': self.manifest['frames'][0]['time'] = '1805'
                with self.assertRaises(ValueError): self.audit()

    def test_invalid_label_score_prediction_correct_or_hash_is_rejected(self):
        changes = [('label',0),('label',True),('score',float('nan')),('score',float('inf')),
                   ('score',-.1),('score',1.1),('score',True),('prediction',1),
                   ('prediction',False),('correct',True),('model_sha256','stale')]
        for key,value in changes:
            with self.subTest(key=key,value=value):
                self.manifest,self.predictions,self.evaluation,self.model = fixtures()
                self.predictions[0][key] = value
                with self.assertRaises(ValueError): self.audit()

    def test_model_manifest_evaluation_hash_and_metric_drift_are_rejected(self):
        for mutation in ['model','manifest','evaluation','matrix','accuracy','band','review_count']:
            with self.subTest(mutation=mutation):
                self.manifest,self.predictions,self.evaluation,self.model = fixtures()
                if mutation == 'model': self.model += b' '
                if mutation == 'manifest': self.manifest['model_sha256'] = 'stale'
                if mutation == 'evaluation': self.evaluation['model_sha256'] = 'stale'
                if mutation == 'matrix': self.evaluation['test']['confusion_matrix'][0][0] += 1
                if mutation == 'accuracy': self.evaluation['test']['accuracy'] += .01
                if mutation == 'band': self.evaluation['review_band'] = [.3,.7]
                if mutation == 'review_count': self.evaluation['review_samples'] += 1
                with self.assertRaises(ValueError): self.audit()

    def test_published_baseline_counts_and_concentrations(self):
        data = ROOT / 'web/data/parking'
        report = self.auditor.audit(json.loads((data/'manifest.json').read_text()),
            json.loads((data/'test-predictions.json').read_text()),
            json.loads((data/'evaluation.json').read_text()),
            (ROOT/'web/models/parking-occupancy/model.json').read_bytes())
        self.assertEqual(report['overall']['confusion_matrix'], [[1281,351],[1134,3647]])
        self.assertEqual(report['uncertain_band']['n'], 263)
        self.assertEqual(report['uncertain_band']['covered_errors'], 127)
        self.assertEqual(report['uncertain_band']['false_free_outside_band'], 1037)
        self.assertEqual(report['uncertain_band']['false_occupied_outside_band'], 321)
        self.assertEqual(report['concentration'][0]['camera_slots'], ['B:12','B:40','B:30'])
        self.assertEqual(report['concentration'][0]['false_free'], 271)

    def test_recompute_detects_pixel_prediction_mismatch_without_changing_model(self):
        try:
            import numpy as np
            from PIL import Image
        except ImportError:
            self.skipTest('Optional recomputation requires NumPy and Pillow')
        model = dict(hidden=0,mean=[0]*240,scale=[1]*240,w2=[0]*240,b2=0)
        model_bytes = json.dumps(model).encode()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Image.fromarray(np.zeros((32,32,3),dtype=np.uint8)).save(root/'patch.png')
            samples = [dict(id='a',input='patch.png')]
            good = [dict(id='a',score=.5)]
            result = self.auditor.recompute(samples,good,model_bytes,root)
            self.assertEqual(result['n'], 1)
            self.assertEqual(result['maximum_absolute_score_difference'], 0)
            with self.assertRaises(ValueError):
                self.auditor.recompute(samples,[dict(id='a',score=.6)],model_bytes,root)
        self.assertEqual(model_bytes,json.dumps(model).encode())


if __name__ == '__main__':
    unittest.main()
