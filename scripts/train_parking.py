"""Train on CNRPark A, validate on a later A time block, test once on B.
Usage: python scripts/train_parking.py --archive /path/to/CNRPark-Patches-150x150.zip
The original detector is never modified. No paid compute or network is used here.
"""
import argparse,collections,csv,hashlib,io,json,platform,re,time,zipfile
from pathlib import Path
import numpy as np
from PIL import Image
from parking_learning import features,fit,predict,split_records,metrics

ROOT=Path(__file__).resolve().parents[1]
SOURCE='https://github.com/fabiocarrara/deep-parking/releases/download/archive/CNRPark-Patches-150x150.zip'
SEED=20261015

def save_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')

def prepare_image(raw):
    rgb=np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'))
    h,w=rgb.shape[:2]
    yi=np.floor((np.arange(32)+.5)*h/32).astype(int)
    xi=np.floor((np.arange(32)+.5)*w/32).astype(int)
    return rgb,rgb[yi[:,None],xi[None,:],:]

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--archive',type=Path,required=True);args=ap.parse_args();start=time.monotonic()
    rawzip=args.archive.read_bytes();archive_hash=hashlib.sha256(rawzip).hexdigest()
    if len(rawzip)!=36596809 or archive_hash!='2dc9b13892595e599e1f5025ddcce08ef7287babbb978670580c60abd86c5fdb':raise ValueError('Unexpected official archive size/hash; investigate before training')
    archive=zipfile.ZipFile(io.BytesIO(rawzip))
    if archive.testzip():raise ValueError('Archive CRC failure')
    pattern=re.compile(r'(?:^|/)([AB])/(free|busy)/(\d{8})_(\d{4})_(\d+)\.jpg$')
    records=[];vectors={};inputs={}
    for name in sorted(archive.namelist()):
        m=pattern.search(name)
        if not m:continue
        camera,category,date,stamp,slot=m.groups();raw=archive.read(name);rgb,small=prepare_image(raw)
        sid=f'{camera}-{date}-{stamp}-{slot}'
        records.append(dict(id=sid,camera=camera,date=date,time=stamp,slot=slot,label=int(category=='busy'),source_path=name,source_sha256=hashlib.sha256(raw).hexdigest(),sha256=hashlib.sha256(rgb.tobytes()).hexdigest()))
        vectors[sid]=features(small);inputs[sid]=small
    if len({r['id'] for r in records})!=len(records):raise ValueError('Duplicate camera/time/slot identifiers')
    if len(records)!=12584:raise ValueError(f'Expected 12584 patches, received {len(records)}')
    splits=split_records(records);distribution=collections.Counter(f"{r['camera']}:{r['date']}" for r in records)
    print('Source distribution:',dict(distribution),flush=True);print('Split sizes:',{k:len(v) for k,v in splits.items()},flush=True)
    X={k:np.array([vectors[r['id']] for r in v]) for k,v in splits.items() if k in ['train','validation','test']}
    Y={k:np.array([r['label'] for r in v]) for k,v in splits.items() if k in X}
    for k in Y:
        if len(np.unique(Y[k]))!=2:raise ValueError(f'{k} lacks a class')
    candidates=[];logs={}
    # This two-candidate protocol is fixed before the test set is scored.
    for hidden in [0,32]:
        name='linear' if hidden==0 else 'mlp32';print('Training',name,flush=True)
        model,log=fit(X['train'],Y['train'],X['validation'],Y['validation'],seed=SEED,epochs=40,hidden=hidden)
        validation_loss=min(x['validation_loss'] for x in log)
        candidates.append((validation_loss,name,model));logs[name]=log
        print(name,'selected epoch',model['selected_epoch'],'validation loss',validation_loss,flush=True)
    _,name,model=min(candidates,key=lambda x:x[0])
    model.update(name=f'EstateGuard Occupancy {name}',seed=SEED,trained_on='CNRPark camera A',source_archive_sha256=archive_hash,review_band=[.35,.65],training_date='2026-10-15')
    model_path=ROOT/'web/models/parking-occupancy/model.json';save_json(model_path,model);model_hash=hashlib.sha256(model_path.read_bytes()).hexdigest()
    # The frozen test partition is evaluated only after selection is finished.
    probabilities=predict(X['test'],model);test_metrics=metrics(Y['test'],probabilities)
    majority=int(Y['train'].mean()>=.5)
    source=dict(name='CNRPark (base subset)',authors=['Giuseppe Amato','Fabio Carrara','Fabrizio Falchi','Claudio Gennaro','Claudio Vairo'],homepage='http://cnrpark.it/',archive_url=SOURCE,archive_sha256=archive_hash,archive_bytes=len(rawzip),license='ODbL-1.0',license_url='https://opendatacommons.org/licenses/odbl/1-0/',publication='https://doi.org/10.1109/ISCC.2016.7543901',timezone='Source local wall-clock, timezone not declared; not converted to UTC+8')
    splitinfo={k:dict(count=len(v),cameras=sorted({r['camera'] for r in v}),dates=sorted({r['date'] for r in v}),frames=len({(r['camera'],r['date'],r['time']) for r in v}),first=min((r['date']+' '+r['time'] for r in v),default=None),last=max((r['date']+' '+r['time'] for r in v),default=None)) for k,v in splits.items()}
    output=ROOT/'web/data/parking';output.mkdir(parents=True,exist_ok=True);samples=[];predictions=[];frames={}
    for row,prob in zip(splits['test'],probabilities):
        sid=row['id'];orig=archive.read(row['source_path']);image_path=f'images/{sid}.jpg';input_path=f'inputs/{sid}.png'
        (output/'images').mkdir(exist_ok=True);(output/'inputs').mkdir(exist_ok=True)
        (output/image_path).write_bytes(orig);Image.fromarray(inputs[sid]).save(output/input_path,optimize=True)
        sample={**row,'split':'test','image':image_path,'input':input_path}
        samples.append(sample)
        predictions.append(dict(id=sid,label=row['label'],score=float(prob),prediction=int(prob>=.5),correct=bool((prob>=.5)==row['label']),model_sha256=model_hash))
        key=(row['camera'],row['date'],row['time']);frames.setdefault(key,[]).append(sid)
    grouped=[]
    for (camera,date,stamp),ids in sorted(frames.items()):
        grouped.append(dict(id=f'{camera}-{date}-{stamp}',session=f'{camera}-{date}',camera=camera,date=date,time=stamp,sample_ids=ids))
    report=dict(schema_version=1,dataset=source,model_name=model['name'],model_sha256=model_hash,feature_version=model['feature_version'],feature_count=model['features'],hidden=model['hidden'],parameter_count=(240*32+32+32+1 if model['hidden'] else 241),source_distribution=dict(distribution),splits=splitinfo,seed=SEED,epochs_per_candidate=40,selected_epoch=model['selected_epoch'],selection='Lowest validation binary cross-entropy; checkpoint and architecture selected without test labels',validation_candidates=[dict(name=n,loss=l) for l,n,m in candidates],test=test_metrics,majority_baseline=dict(training_majority=majority,**metrics(Y['test'],np.full(len(Y['test']),majority))),review_band=[.35,.65],review_samples=int(np.sum((probabilities>.35)&(probabilities<.65))),confident_false_free=int(np.sum((probabilities<=.35)&(Y['test']==1))),confident_false_occupied=int(np.sum((probabilities>=.65)&(Y['test']==0))),elapsed_seconds=round(time.monotonic()-start,3),python=platform.python_version(),numpy=np.__version__,limitations=['Single parking lot and two capture days; not a new-site or production benchmark','Camera A training and validation share a view; validation is a later block separated by an unused gap','Camera B test is a different view; the same physical parking lot may contain repeated vehicles','Snapshots are not continuous video; occupancy is not a violation or a dwell-time measurement','Scores are not calibrated safety probabilities; every test error is retained'])
    save_json(output/'manifest.json',dict(schema_version=1,dataset=source,model_sha256=model_hash,frames=grouped,samples=samples))
    save_json(output/'evaluation.json',report);save_json(output/'test-predictions.json',predictions)
    save_json(ROOT/'docs/validation/parking-training-log.json',logs)
    manifest=[]
    for split,rows in splits.items():
        for r in rows:manifest.append({**r,'split':split})
    p=ROOT/'docs/validation/parking-split.csv'
    with p.open('w',newline='') as f:
        writer=csv.DictWriter(f,lineterminator='\n',fieldnames=['id','camera','date','time','slot','label','source_path','source_sha256','sha256','split','intended_split']);writer.writeheader();writer.writerows(manifest)
    # Pixel-level cross-runtime check, including difficult predictions, never relabelled.
    ix=list(range(min(8,len(samples))))+list(np.flatnonzero((probabilities>=.5)!=Y['test'])[:8])
    fixtures=[dict(id=samples[i]['id'],rgb=inputs[samples[i]['id']].ravel().tolist(),features=vectors[samples[i]['id']].tolist(),score=float(probabilities[i])) for i in dict.fromkeys(ix)]
    save_json(ROOT/'tests/fixtures/parking-parity.json',fixtures)
    lock=[]
    for p in sorted(output.rglob('*')):
        if p.is_file():lock.append(dict(path=str(p.relative_to(ROOT/'web')),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()))
    save_json(ROOT/'web/data/parking-assets.lock.json',dict(dataset=source,files=lock))
    print('Selected:',name,'Test:',json.dumps(test_metrics),'Baseline:',majority,flush=True)
    print('Model hash:',model_hash,'Elapsed:',report['elapsed_seconds'],flush=True)
if __name__=='__main__':main()
