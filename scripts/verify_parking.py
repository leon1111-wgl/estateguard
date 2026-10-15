"""Audit published data, disjoint partitions and metrics without ML dependencies."""
import collections,csv,hashlib,json,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
WEB=ROOT/'web'
DATA=WEB/'data/parking'
load=lambda p:json.loads(p.read_text())
lock=load(WEB/'data/parking-assets.lock.json')
for asset in lock['files']:
    p=WEB/asset['path'];raw=p.read_bytes()
    assert p.resolve().is_relative_to(DATA.resolve()),'Invalid asset path'
    assert len(raw)==asset['bytes'] and hashlib.sha256(raw).hexdigest()==asset['sha256'],asset['path']
assert {str(p.relative_to(WEB)) for p in DATA.rglob('*') if p.is_file()}=={a['path'] for a in lock['files']},'Untracked dataset file'
report=load(DATA/'evaluation.json');manifest=load(DATA/'manifest.json');predictions=load(DATA/'test-predictions.json')
digest=hashlib.sha256((WEB/'models/parking-occupancy/model.json').read_bytes()).hexdigest()
assert report['model_sha256']==manifest['model_sha256']==digest
assert report['dataset']==manifest['dataset']==lock['dataset']
rows=list(csv.DictReader((ROOT/'docs/validation/parking-split.csv').open()))
assert len(rows)==12584 and len({r['id'] for r in rows})==12584
assert report['source_distribution']==dict(collections.Counter(r['camera']+':'+r['date'] for r in rows))
groups={};pixels={}
for split in ['train','validation','test','gap']:
    part=[r for r in rows if r['split']==split]
    assert len(part)==report['splits'][split]['count']
    groups[split]={(r['camera'],r['date'],r['time']) for r in part};pixels[split]={r['sha256'] for r in part}
    assert len(groups[split])==report['splits'][split]['frames']
for a in groups:
    for b in groups:
        if a!=b:assert not(groups[a]&groups[b] or pixels[a]&pixels[b]),f'Leakage: {a}, {b}'
assert {r['camera'] for r in rows if r['split']=='test'}=={'B'}
assert {r['camera'] for r in rows if r['split'] in ['train','validation']}=={'A'}
test={r['id']:r for r in rows if r['split']=='test'}
samples={r['id']:r for r in manifest['samples']}
assert len(samples)==len(manifest['samples'])==len(predictions)==6413
assert set(test)==set(samples)=={r['id'] for r in predictions}
frame_ids=[]
for frame in manifest['frames']:
    frame_ids.extend(frame['sample_ids'])
    for sid in frame['sample_ids']:
        assert all(samples[sid][k]==frame[k] for k in ['camera','date','time'])
assert len(frame_ids)==len(set(frame_ids))==6413 and set(frame_ids)==set(test)
for sid,r in samples.items():
    assert r['split']=='test' and r['label']==int(test[sid]['label'])
    assert hashlib.sha256((DATA/r['image']).read_bytes()).hexdigest()==r['source_sha256']==test[sid]['source_sha256']
    assert (DATA/r['input']).is_file()
matrix=[[0,0],[0,0]];review=0;confident_false_free=0;confident_false_occupied=0
for r in predictions:
    p=r['score'];label=samples[r['id']]['label'];pred=int(p>=.5)
    assert math.isfinite(p) and 0<=p<=1 and r['label']==label and r['prediction']==pred
    assert r['correct']==(label==pred) and r['model_sha256']==digest
    matrix[label][pred]+=1;review+=.35<p<.65
    confident_false_free+=p<=.35 and label==1;confident_false_occupied+=p>=.65 and label==0
tn,fp=matrix[0];fn,tp=matrix[1];n=tn+fp+fn+tp
expected=dict(n=n,free=tn+fp,occupied=fn+tp,accuracy=(tn+tp)/n,balanced_accuracy=(tn/(tn+fp)+tp/(tp+fn))/2,occupied_recall=tp/(tp+fn),false_free=fn,false_occupied=fp,confusion_matrix=matrix,confusion_order=['free','occupied'])
assert report['test']==expected
assert (report['review_samples'],report['confident_false_free'],report['confident_false_occupied'])==(review,confident_false_free,confident_false_occupied)
majority=int(sum(int(r['label']) for r in rows if r['split']=='train')>=report['splits']['train']['count']/2)
assert majority==report['majority_baseline']['training_majority']
assert report['majority_baseline']['accuracy']==sum(r['label']==majority for r in predictions)/n
history=load(ROOT/'docs/validation/parking-training-log.json')
best=min((entry['validation_loss'],name,entry['epoch']) for name,logs in history.items() for entry in logs)
assert report['model_name'].endswith(best[1]) and report['selected_epoch']==best[2]
print(f'PASS: {len(lock["files"])} public dataset hashes, all {n} test predictions, full split/metric/model audit; {fn+fp} errors retained.')
