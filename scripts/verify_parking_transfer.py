"""Audit the frozen-encoder occupancy models from published files only (no ML dependencies beyond NumPy).
Recomputes B and CNR-EXT metrics from per-sample scores, checks heads, hashes, routing and the
label-independent EXT inspector subset.
"""
import collections,csv,gzip,hashlib,io,json,math
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1];WEB=ROOT/'web'
load=lambda p:json.loads(Path(p).read_text())
sha=lambda raw:hashlib.sha256(raw).hexdigest()

def rates(y,p):
    y=np.asarray(y).astype(int);pred=np.asarray(p)>=.5
    tn=int(((y==0)&~pred).sum());fp=int(((y==0)&pred).sum());fn=int(((y==1)&~pred).sum());tp=int(((y==1)&pred).sum())
    return dict(n=len(y),accuracy=(tn+tp)/len(y),balanced_accuracy=(tp/(tp+fn)+tn/(tn+fp))/2,false_free=fn,false_occupied=fp,confusion_matrix=[[tn,fp],[fn,tp]])

def same(report,expected,label):
    for k,v in expected.items():
        got=report[k]
        assert (math.isclose(got,v,rel_tol=0,abs_tol=1e-12) if isinstance(v,float) else got==v),f'{label}: {k} {got} != {v}'

def route(p,t_free,t_busy):return 'free' if t_free is not None and p<=t_free else 'busy' if t_busy is not None and p>=t_busy else 'review'

evaluation=load(WEB/'data/parking-transfer/evaluation.json');lock={a['path']:a for a in load(WEB/'assets.lock.json')['files']}
tlock=load(WEB/'data/parking-transfer-assets.lock.json')
for a in tlock['files']:
    raw=(WEB/a['path']).read_bytes();assert len(raw)==a['bytes'] and sha(raw)==a['sha256'],a['path']
assert {str(p.relative_to(WEB)) for p in (WEB/'data/parking-transfer').rglob('*') if p.is_file()}=={a['path'] for a in tlock['files']},'Untracked transfer file'
protocol=(ROOT/evaluation['protocol']).read_text()
assert '附录 1' in protocol and '附录 2' in protocol,'Protocol appendices missing'
rows=list(csv.DictReader((ROOT/'docs/validation/parking-split.csv').open()));test=[r for r in rows if r['split']=='test']
features={'mobilenet':1280,'dinov2':768}
for key,entry in evaluation['models'].items():
    raw=(WEB/entry['model_path']).read_bytes();head=json.loads(raw)
    assert sha(raw)==entry['model_sha256']==lock[entry['model_path']]['sha256'],f'{key}: head hash'
    assert head['features']==features[key]==len(head['w'])==len(head['mean'])==len(head['scale']) and all(map(math.isfinite,head['w']+head['mean']+head['scale']+[head['b'],head['temperature']])),f'{key}: head shape'
    for asset in head['backbone']['assets']:assert lock[asset['path']]['sha256']==asset['sha256'],f'{key}: encoder asset {asset["path"]}'
    assert head['routing']['t_free']==entry['routing']['t_free'] and head['routing']['t_busy']==entry['routing']['t_busy']
    preds=load(WEB/f'data/parking-transfer/b-predictions-{key}.json');assert [p['id'] for p in preds]==[r['id'] for r in test],f'{key}: B ids'
    y=[int(r['label']) for r in test];score=[p['score'] for p in preds]
    for p,r in zip(preds,test):
        assert p['label']==int(r['label']) and p['model_sha256']==entry['model_sha256'] and p['prediction']==int(p['score']>=.5) and p['correct']==(p['prediction']==p['label'])
        assert p['route']==route(p['calibrated'],head['routing']['t_free'],head['routing']['t_busy']),f'{key}: route {p["id"]}'
        z=math.log(p['score']/(1-p['score'])) if 0<p['score']<1 else None
        if z is not None and abs(z)<30:assert math.isclose(1/(1+math.exp(-z/head['temperature'])),p['calibrated'],abs_tol=1e-9),f'{key}: calibration {p["id"]}'
    same(entry['cnrpark_b']['transfer'],rates(y,score),f'{key} B')
b_bal={k:v['cnrpark_b']['transfer']['balanced_accuracy'] for k,v in evaluation['models'].items()}
assert evaluation['default_model']['encoder']==max(b_bal,key=b_bal.get),'Default model rule'
mlp=load(WEB/'data/parking/test-predictions.json');same(evaluation['cnrpark_b_baseline']['mlp32'],rates([r['label'] for r in mlp],[r['score'] for r in mlp]),'MLP32 B')
summary=f"{len(evaluation['models'])} heads, B recomputed"
if 'cnr_ext' in evaluation:
    meta=evaluation['cnr_ext']['predictions'];raw=(ROOT/meta['path']).read_bytes();assert sha(raw)==meta['sha256'],'EXT predictions hash'
    ext=list(csv.DictReader(io.StringIO(gzip.decompress(raw).decode())));assert len(ext)==meta['rows']==evaluation['cnr_ext']['source']['count']==144965
    assert len({r['id'] for r in ext})==len(ext),'EXT duplicate ids'
    y=np.array([int(r['label']) for r in ext]);weather=np.array([r['weather'] for r in ext]);cams=np.array([r['camera'] for r in ext])
    assert dict(collections.Counter(weather))==evaluation['cnr_ext']['source']['weather'] and dict(collections.Counter(cams))==evaluation['cnr_ext']['source']['cameras']
    # Scores are written with 6 significant digits, so recomputed counts may move only at the 0.5 boundary.
    def close_counts(rep,exp,label):
        for k in ['false_free','false_occupied']:assert abs(rep[k]-exp[k])<=3,f'{label}: {k} {rep[k]} vs {exp[k]}'
        assert abs(rep['balanced_accuracy']-exp['balanced_accuracy'])<5e-4,label
    close_counts(evaluation['cnr_ext']['mlp32'],rates(y,[float(r['mlp32']) for r in ext]),'EXT MLP32')
    for key,entry in evaluation['models'].items():
        p=np.array([float(r[key]) for r in ext]);close_counts(entry['cnr_ext']['transfer'],rates(y,p),f'EXT {key}')
        for w in ['sunny','overcast','rainy']:close_counts(entry['cnr_ext']['by_weather'][w]['transfer'],rates(y[weather==w],p[weather==w]),f'EXT {key} {w}')
    # The inspector subset must follow the published label-independent rule exactly.
    sub=load(WEB/'data/parking-ext/manifest.json');sublock=load(WEB/'data/parking-ext-assets.lock.json')
    for a in sublock['files']:
        content=(WEB/a['path']).read_bytes();assert len(content)==a['bytes'] and sha(content)==a['sha256'],a['path']
    assert {str(p.relative_to(WEB)) for p in (WEB/'data/parking-ext').rglob('*') if p.is_file()}=={a['path'] for a in sublock['files']},'Untracked EXT subset file'
    frames=collections.defaultdict(list)
    for r in ext:frames[(r['camera'],r['weather'],r['date'],r['time'])].append(r)
    expected=[]
    for c in sorted(set(cams)):
        for w in ['sunny','overcast','rainy']:
            keys=[k for k in frames if k[0]==c and k[1]==w]
            if keys:d=min(k[2] for k in keys);expected.append(min([k for k in keys if k[2]==d],key=lambda k:(abs(int(k[3][:2])*60+int(k[3][2:])-720),k[3])))
    assert sorted(f'{k[0]}-{k[2]}-{k[3]}' for k in expected)==sorted(f['id'] for f in sub['frames']),'EXT subset does not follow the selection rule'
    byid={r['id']:r for r in ext}
    for s in sub['samples']:
        r=byid[s['id']];assert s['label']==int(r['label']) and all(s[k]==r[k] for k in ['camera','weather','date','time','slot']) and sha((WEB/'data/parking-ext'/s['image']).read_bytes())==s['source_sha256'],s['id']
    assert sum(len(frames[k]) for k in expected)==len(sub['samples'])
    summary+=f"; all {len(ext):,} EXT scores recomputed for MLP32 + {len(evaluation['models'])} heads; EXT subset {len(sub['frames'])} snapshots / {len(sub['samples'])} images follow the rule"
print('PASS:',summary)
