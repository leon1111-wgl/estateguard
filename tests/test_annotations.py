import unittest, importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('audit',Path(__file__).parents[1]/'scripts/audit_annotations.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
def row(**extra):
    return dict(video_id='v1',track='t1',start_s=0,end_s=10,label='bulky_load',annotator='a',split='train',**extra)
class AuditTests(unittest.TestCase):
    def test_valid_independent_annotations(self):
        a=row();b={**a,'annotator':'b'}
        self.assertEqual(audit.audit([a,b])['issues'],[])
    def test_same_video_across_splits_is_leakage(self):
        a=row();b={**a,'split':'test','start_s':30,'end_s':40}
        self.assertIn('split_leakage',[i['code'] for i in audit.audit([a,b])['issues']])
    def test_disagreement_is_not_silently_majority_voted(self):
        a=row();b={**a,'annotator':'b','label':'door_obstruction'}
        self.assertIn('label_disagreement',[i['code'] for i in audit.audit([a,b])['issues']])
    def test_different_tracks_can_have_different_labels(self):
        a=row();b={**a,'track':'t2','annotator':'b','label':'door_obstruction'}
        self.assertEqual(audit.audit([a,b])['issues'],[])
    def test_nan_interval_rejected(self):
        a=row();a['end_s']=float('nan')
        self.assertIn('invalid_row',[i['code'] for i in audit.audit([a])['issues']])
    def test_duplicate_row_rejected(self):
        self.assertIn('duplicate',[i['code'] for i in audit.audit([row(),row()])['issues']])
if __name__=='__main__':unittest.main()
