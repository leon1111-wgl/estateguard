"""Audit web/data/detector/evaluation.json without COCO images (they are not redistributed):
threshold choice follows the dev-half rule, the default follows the test-half criteria, counts are
self-consistent, and the published model and protocol are the ones the record names."""
import hashlib,json,math
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1];WEB=ROOT/'web'
e=json.loads((WEB/'data/detector/evaluation.json').read_text())
protocol=(ROOT/e['protocol']).read_text()
assert '附录 1' in protocol and '附录 2' in protocol,'protocol appendices missing'
lock={a['path']:a for a in json.loads((WEB/'assets.lock.json').read_text())['files']}
export=json.loads((WEB/'models/dfine-n/export.json').read_text())
assert lock['models/dfine-n/model.onnx']['sha256']==export['onnx_sha256']==hashlib.sha256((WEB/'models/dfine-n/model.onnx').read_bytes()).hexdigest(),'D-FINE model hash'
assert export['bus_score']>.9 and export['parity_vs_pytorch_on_bus']['logits']<1e-3,'export parity'
sel=e['threshold_selection'];base=sel['ssdlite_dev'];sweep=sel['dfine_dev_sweep']
assert [s['threshold'] for s in sweep]==[round(.3+.05*i,2) for i in range(9)]
def check_op(op,label):
    assert op['precision']==(op['true_positive']/(op['true_positive']+op['false_positive']) if op['true_positive']+op['false_positive'] else None),label
    assert op['recall']==op['true_positive']/op['ground_truth'],label
    assert sum(c['true_positive'] for c in op['per_class'].values())==op['true_positive'] and sum(c['ground_truth'] for c in op['per_class'].values())==op['ground_truth'],label
for s in [base,*sweep]:check_op(s,f"dev {s['threshold']}")
feasible=[s for s in sweep if s['precision'] is not None and s['precision']>=base['precision']]
chosen=max(feasible,key=lambda s:(s['recall'],s['threshold'])) if feasible else max(sweep,key=lambda s:(s['precision'] or 0,s['threshold']))
assert sel['chosen']==chosen['threshold']==e['models']['dfine']['operating_threshold'] and sel['met_precision_constraint']==bool(feasible),'threshold rule'
assert e['models']['ssdlite']['operating_threshold']==e['baseline_threshold']==.5
s,d=(e['models'][k]['test'] for k in ['ssdlite','dfine'])
for k in ['ssdlite','dfine']:
    t=e['models'][k]['test'];check_op(t['operating_point'],f'test {k}');assert t['operating_point']['threshold']==e['models'][k]['operating_threshold']
    assert math.isclose(t['coco']['relevant_mean_ap'],sum(t['coco']['per_class_ap'][n] for n in e['relevant_classes'])/len(e['relevant_classes']),abs_tol=1e-12)
    assert e['models'][k]['run']['images']==5000 and e['models'][k]['latency']['images']==200
criteria=dict(ap_higher=d['coco']['AP']>s['coco']['AP'],recall_not_lower=d['operating_point']['recall']>=s['operating_point']['recall'],precision_within_1pt=d['operating_point']['precision']>=s['operating_point']['precision']-.01,p95_latency_within_500ms=e['models']['dfine']['latency']['total_ms']['p95']<=500)
assert e['default_decision']['criteria']==criteria and e['default_decision']['default']==('dfine' if all(criteria.values()) else 'ssdlite'),'default rule'
dd=e['models']['dfine']['deployed_dedupe090']['test'];check_op(dd['operating_point'],'deployed dedupe')
recheck=dict(ap_higher=dd['coco']['AP']>s['coco']['AP'],recall_not_lower=dd['operating_point']['recall']>=s['operating_point']['recall'],precision_within_1pt=dd['operating_point']['precision']>=s['operating_point']['precision']-.01,p95_latency_within_500ms=criteria['p95_latency_within_500ms'])
assert e['default_decision']['deployed_recheck']==recheck,'deployed recheck'
assert '附录 3' in protocol,'appendix 3 missing'
print(f"PASS: detector evaluation self-consistent; D-FINE threshold {sel['chosen']} by dev rule; default {e['default_decision']['default']} ({sum(criteria.values())}/4 criteria); model hash matches export record.")
