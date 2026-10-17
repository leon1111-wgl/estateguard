"""Frozen-encoder occupancy heads, following docs/validation/parking-transfer-protocol.md.
Usage:
  python scripts/train_parking_transfer.py \
    --features mobilenet=artifacts/parking-transfer/cnrpark-features,dinov2=artifacts/parking-transfer/cnrpark-dinov2 \
    [--ext artifacts/parking-transfer/ext --ext-features mobilenet=...,dinov2=...]
Selection uses CNRPark A only. B is an observed development comparison; CNR-EXT is held out.
"""
import argparse,csv,gzip,hashlib,io,json,platform,time
from pathlib import Path
import numpy as np
from parking_learning import fit,metrics
from transfer_learning import ADAPT,adapt,bce,chronological_roles,cp_upper,ece,fit_temperature,route,routing_report,select_routing,sigmoid

ROOT=Path(__file__).resolve().parents[1]
SEED=20261015;KS=[0,8,16,32,64,128];SEEDS=list(range(1,11))
OLD_BAND=dict(t_free=.35,t_busy=.65,alpha_free=None,alpha_busy=None)
ENCODERS={
 'mobilenet':dict(feature_version='ssdlite-mnv2-conv1-gap-v1',dim=1280,name='MobileNetV2 迁移头',backbone='COCO-SSD SSDLite MobileNet V2 (COCO detection pretraining, frozen)',model='web/models/parking-transfer/model.json',license='Apache-2.0 backbone; project head MIT; training data ODbL-1.0'),
 'dinov2':dict(feature_version='dinov2-small-int8-cls-mean-112-v1',dim=768,name='DINOv2-small 线性探针',backbone='DINOv2-small ViT-S/14 (self-supervised LVD-142M pretraining, int8 ONNX, frozen)',model='web/models/parking-dinov2/model.json',license='Apache-2.0 backbone; project head MIT; training data ODbL-1.0'),
}

def save_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')

def pairs(text):return dict(item.split('=',1) for item in text.split(',')) if text else {}

def load_features(directory,encoder):
    directory=Path(directory);meta=json.loads((directory/'features.meta.json').read_text());raw=(directory/'features.f32').read_bytes()
    if hashlib.sha256(raw).hexdigest()!=meta['features_sha256']:raise ValueError('Feature file hash mismatch')
    spec=ENCODERS[encoder]
    if meta['feature_version']!=spec['feature_version'] or meta['dim']!=spec['dim']:raise ValueError(f'Unexpected feature schema for {encoder}')
    lock={a['path']:a['sha256'] for a in json.loads((ROOT/'web/assets.lock.json').read_text())['files']}
    for asset in meta['backbone_assets']:
        if lock.get(asset['path'])!=asset['sha256']:raise ValueError(f"Encoder asset changed since extraction: {asset['path']}")
    x=np.frombuffer(raw,dtype='<f4').reshape(meta['count'],meta['dim']).astype(np.float64)
    if not np.isfinite(x).all():raise ValueError('Nonfinite features')
    return meta,{sid:i for i,sid in enumerate(meta['ids'])},x

def rates(y,p):
    y=np.asarray(y).astype(int);m=metrics(y,p)
    m['false_free_rate']=m['false_free']/m['occupied'] if m['occupied'] else None
    m['false_occupied_rate']=m['false_occupied']/m['free'] if m['free'] else None
    return m

def evaluate(y,z,T,routing,mlp=None):
    raw,cal=sigmoid(z),sigmoid(z/T)
    out=dict(transfer=rates(y,raw),ece_raw=ece(raw,y),ece_calibrated=ece(cal,y),bce_raw=bce(z,y),bce_calibrated=bce(z/T,y),routing=routing_report(cal,y,routing))
    if mlp is not None:
        out.update(mlp32=rates(y,mlp),mlp32_ece=ece(mlp,y),mlp32_old_band=routing_report(mlp,y,OLD_BAND))
        a=(np.asarray(mlp)>=.5)==y;b=(raw>=.5)==y
        out['pairwise_vs_mlp32']=dict(both_correct=int((a&b).sum()),fixed=int((~a&b).sum()),new_errors=int((a&~b).sum()),both_wrong=int((~a&~b).sum()))
    return out

def adaptation_study(zs,y,frame_keys,slots,w0,b0,T,routing):
    """Chronological pool/eval split inside one camera; k labels sampled from the pool only."""
    roles=chronological_roles(sorted(set(frame_keys)));role=np.array([roles[k] for k in frame_keys])
    pool=np.flatnonzero(role=='pool');ev=np.flatnonzero(role=='eval');yev=y[ev];curve=[]
    for k in KS:
        runs=[]
        for seed in ([0] if k==0 else SEEDS):
            if k:pick=np.random.default_rng(seed).choice(pool,size=min(k,len(pool)),replace=False);w,b=adapt(zs[pick],y[pick],w0,b0);busy=int(y[pick].sum())
            else:w,b,busy=w0,b0,0
            m=rates(yev,sigmoid((zs[ev]@w+b)/T))
            runs.append(dict(seed=seed,labels_busy=busy,**{key:m[key] for key in ['accuracy','balanced_accuracy','false_free_rate','false_occupied_rate']}))
        curve.append(dict(k=k,runs=runs,**{key:dict(mean=float(np.mean([r[key] for r in runs])),sd=float(np.std([r[key] for r in runs]))) for key in ['accuracy','balanced_accuracy','false_free_rate','false_occupied_rate']}))
    # On-site calibration (protocol appendix 3): the naive per-sample rule is kept as the failing baseline;
    # the deployed rule counts camera·slot·date units and needs at least two calibration dates.
    source=sigmoid((zs@w0+b0)/T);units=np.array([f'{s}|{k[0]}' for s,k in zip(slots,frame_keys)]);pool_dates=len({frame_keys[i][0] for i in pool});onsite={}
    for a in [.01,.02,.05]:
        target=dict(alpha_free=a,alpha_busy=min(.2,2*a));naive=select_routing(source[pool],y[pool],**target)
        entry=dict(naive=dict(t_free=naive['t_free'],t_busy=naive['t_busy'],eval=routing_report(source[ev],yev,naive,units[ev])),unit=dict(eligible=pool_dates>=2,calibration_units=len(set(units[pool].tolist()))))
        if pool_dates>=2:
            unit=select_routing(source[pool],y[pool],units=units[pool],**target);entry['unit'].update(t_free=unit['t_free'],t_busy=unit['t_busy'],eval=routing_report(source[ev],yev,unit,units[ev]))
        else:entry['unit'].update(t_free=None,t_busy=None,eval=routing_report(source[ev],yev,dict(t_free=None,t_busy=None,**target),units[ev]))
        onsite[str(a)]=entry
    return dict(frames={r:int(sum(v==r for v in roles.values())) for r in ['pool','gap','eval']},samples=dict(pool=int(len(pool)),eval=int(len(ev)),pool_occupied=int(y[pool].sum()),eval_occupied=int(yev.sum())),
        pool_first=' '.join(min(frame_keys[i] for i in pool)),pool_last=' '.join(max(frame_keys[i] for i in pool)),pool_dates=pool_dates,eval_first=' '.join(min(frame_keys[i] for i in ev)),eval_last=' '.join(max(frame_keys[i] for i in ev)),eval_dates=len({frame_keys[i][0] for i in ev}),curve=curve,
        source_routing_on_eval=routing_report(source[ev],yev,routing,units[ev]),onsite=onsite)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--features',required=True);ap.add_argument('--ext',type=Path);ap.add_argument('--ext-features');args=ap.parse_args();start=time.monotonic()
    rows=list(csv.DictReader((ROOT/'docs/validation/parking-split.csv').open()))
    part={k:[r for r in rows if r['split']==k] for k in ['train','validation','test']};yof=lambda k:np.array([int(r['label']) for r in part[k]])
    ytr,yv,yb=yof('train'),yof('validation'),yof('test');bframes=[(r['date'],r['time']) for r in part['test']]
    old=json.loads((ROOT/'web/data/parking/test-predictions.json').read_text());old_hash=hashlib.sha256((ROOT/'web/models/parking-occupancy/model.json').read_bytes()).hexdigest()
    oldmap={r['id']:r['score'] for r in old};mlp_b=np.array([oldmap[r['id']] for r in part['test']])
    if args.ext:
        erows=list(csv.DictReader((args.ext/'ext-ids.csv').open()));summary=json.loads((args.ext/'ext-summary.json').read_text())
        if summary['mlp32_sha256']!=old_hash:raise ValueError('EXT baseline scores were computed with another MLP32')
        mlp_e=np.load(args.ext/'ext-mlp32-scores.npy');ye=np.array([int(r['label']) for r in erows]);cams=np.array([r['camera'] for r in erows]);weather=np.array([r['weather'] for r in erows])
        efeatures=pairs(args.ext_features);ext_scores={}
    report=dict(schema_version=1,protocol='docs/validation/parking-transfer-protocol.md',baseline=dict(name='MLP32 (frozen, 2026-10-15)',model_sha256=old_hash),
        roles=dict(validation='CNRPark A later block; checkpoint, temperature and routing thresholds',cnrpark_b='observed development comparison (viewed in the 2026-10-16 error audit); not a blind test',cnr_ext='held-out: 9 new views of the same lot, 2015-11..2016-02, sunny/overcast/rainy; no model, threshold or default choice used it'),models={})
    fixtures={}
    for encoder,directory in pairs(args.features).items():
        spec=ENCODERS[encoder];meta,index,X=load_features(directory,encoder);take=lambda k:X[[index[r['id']] for r in part[k]]]
        xtr,xv,xb=take('train'),take('validation'),take('test')
        print(f'[{encoder}] fitting fixed linear head on A',flush=True)
        head,log=fit(xtr,ytr,xv,yv,seed=SEED,epochs=40,hidden=0)
        mean,scale,w0,b0=np.array(head['mean']),np.array(head['scale']),np.array(head['w2']),float(head['b2']);std=lambda x:(x-mean)/scale
        zv=std(xv)@w0+b0;T=fit_temperature(zv,yv);routing=select_routing(sigmoid(zv/T),yv)
        model=dict(format='estateguard-parking-transfer-head',version=1,encoder=encoder,name=f"EstateGuard Occupancy · {spec['name']}",feature_version=spec['feature_version'],
            backbone=dict(model=spec['backbone'],input=meta['input'],assets=[dict(path=a['path'],sha256=a['sha256']) for a in meta['backbone_assets']]),
            features=spec['dim'],mean=mean.tolist(),scale=scale.tolist(),w=w0.tolist(),b=b0,temperature=T,
            routing={k:routing[k] for k in ['t_free','t_busy','alpha_free','alpha_busy','delta','calibration_n']}|dict(calibration='CNRPark A validation (same view as training); not valid for other cameras without on-site calibration'),
            adaptation=dict(method='L2-SP logistic head, full-batch Adam',**ADAPT),selected_epoch=head['selected_epoch'],seed=SEED,trained_on='CNRPark camera A',training_date='2026-10-17',protocol=report['protocol'],license=spec['license'])
        model_path=ROOT/spec['model'];save_json(model_path,model);model_hash=hashlib.sha256(model_path.read_bytes()).hexdigest()
        zb=std(xb)@w0+b0
        entry=dict(name=spec['name'],encoder=encoder,model_path=spec['model'].removeprefix('web/'),model_sha256=model_hash,feature_version=spec['feature_version'],parameter_count=spec['dim']+1,
            feature_extraction={k:meta.get(k) for k in ['browser','backend','tfjs','per_patch_ms_median','features_sha256','workers','wall_seconds']},
            selection=dict(selected_epoch=head['selected_epoch'],validation_bce=min(e['validation_loss'] for e in log),temperature=T),routing=routing,
            validation=dict(**rates(yv,sigmoid(zv)),ece_raw=ece(sigmoid(zv),yv),ece_calibrated=ece(sigmoid(zv/T),yv)),validation_routing=routing_report(sigmoid(zv/T),yv,routing),cnrpark_b=evaluate(yb,zb,T,routing,mlp_b),training_log=log)
        entry['cnrpark_b']['adaptation']=adaptation_study(std(xb),yb,bframes,[r['slot'] for r in part['test']],w0,b0,T,routing)
        save_json(ROOT/f'web/data/parking-transfer/b-predictions-{encoder}.json',[dict(id=r['id'],label=int(r['label']),score=float(sigmoid(z)),calibrated=float(sigmoid(z/T)),route=str(q),prediction=int(z>=0),correct=bool(int(z>=0)==int(r['label'])),model_sha256=model_hash) for r,z,q in zip(part['test'],zb,route(sigmoid(zb/T),routing))])
        if args.ext and encoder in efeatures:
            emeta,eindex,EX=load_features(efeatures[encoder],encoder);ze=std(EX[[eindex[r['id']] for r in erows]])@w0+b0;ext_scores[encoder]=(sigmoid(ze),sigmoid(ze/T))
            ext=evaluate(ye,ze,T,routing,mlp_e)
            ext['by_camera']={c:evaluate(ye[cams==c],ze[cams==c],T,routing,mlp_e[cams==c]) for c in sorted(set(cams))}
            ext['by_weather']={w:evaluate(ye[weather==w],ze[weather==w],T,routing,mlp_e[weather==w]) for w in ['sunny','overcast','rainy']}
            zse=std(EX[[eindex[r['id']] for r in erows]]);ext['adaptation']={}
            for c in sorted(set(cams)):
                idx=np.flatnonzero(cams==c);print(f'[{encoder}] adapting {c} ({len(idx)})',flush=True)
                ext['adaptation'][c]=adaptation_study(zse[idx],ye[idx],[(erows[i]['date'],erows[i]['time']) for i in idx],[erows[i]['slot'] for i in idx],w0,b0,T,routing)
            ext['extraction']={k:emeta.get(k) for k in ['browser','backend','per_patch_ms_median','features_sha256','workers','wall_seconds']}
            entry['cnr_ext']=ext
            subset=json.loads((ROOT/'web/data/parking-ext/manifest.json').read_text())['samples'][::160]
            fixture_ext=[dict(id=r['id'],features=EX[eindex[r['id']]].tolist(),score=float(sigmoid(std(EX[eindex[r['id']]])@w0+b0)),calibrated=float(sigmoid((std(EX[eindex[r['id']]])@w0+b0)/T))) for r in subset]
        report['models'][encoder]=entry
        # Cross-runtime fixtures: head scores, routing and few-shot adaptation must match the browser.
        pick=list(range(6))+list(np.flatnonzero((zb>=0)!=yb)[:4]);cut=sorted(set(bframes))[int(len(set(bframes))*.2)-1];bpool=[i for i,f in enumerate(bframes) if f<=cut][:12]
        aw,ab=adapt(std(xb[bpool]),yb[bpool],w0,b0)
        fixtures[encoder]=dict(model_sha256=model_hash,samples=[dict(id=part['test'][i]['id'],features=xb[i].tolist(),score=float(sigmoid(zb[i])),calibrated=float(sigmoid(zb[i]/T))) for i in pick],
            adaptation=dict(ids=[part['test'][i]['id'] for i in bpool],labels=yb[bpool].tolist(),features=xb[bpool].tolist(),b=ab,w_head=aw[:16].tolist(),w_norm=float(np.linalg.norm(aw)),scores=[float(sigmoid((std(xb[i])@aw+ab)/T)) for i in pick]),
            routing=dict(p=[float(v) for v in sigmoid(zv/T)],y=yv.tolist(),t_free=routing['t_free'],t_busy=routing['t_busy']))
        bu=[f"{r['slot']}|{r['date']}" for r in part['test']];bp=[float(v) for v in sigmoid(zb/T)];ur=select_routing(bp,yb,alpha_free=.05,alpha_busy=.1,units=bu)
        fixtures[encoder]['unit_routing']=dict(p=bp,y=yb.tolist(),units=bu,alpha_free=.05,alpha_busy=.1,t_free=ur['t_free'],t_busy=ur['t_busy'],tests=[(t['accepted'],t['errors']) for t in ur['tests']])
        if args.ext and encoder in efeatures:fixtures[encoder]['ext_samples']=fixture_ext
        pr=lambda m:f"acc {m['accuracy']:.4f} bal {m['balanced_accuracy']:.4f} ff {m['false_free']} fo {m['false_occupied']}"
        print(f"[{encoder}] epoch {head['selected_epoch']} T {T:.3f} route {routing['t_free']}/{routing['t_busy']} | A-val {pr(entry['validation'])} | B {pr(entry['cnrpark_b']['transfer'])}",flush=True)
    fixtures['cp']=[dict(x=x,n=n,level=l,upper=cp_upper(x,n,l)) for x,n,l in [(0,300,.05),(3,500,.05/30),(10,100,.001),(0,10,.05)]]
    save_json(ROOT/'tests/fixtures/parking-transfer-parity.json',fixtures)
    b_bal={k:v['cnrpark_b']['transfer']['balanced_accuracy'] for k,v in report['models'].items()}
    report['default_model']=dict(encoder=max(b_bal,key=b_bal.get),rule='highest balanced accuracy on the observed CNRPark B development comparison; fixed before CNR-EXT scoring (protocol appendix 1)',b_balanced_accuracy=b_bal)
    report['cnrpark_b_baseline']=dict(mlp32=rates(yb,mlp_b),majority_busy=rates(yb,np.ones(len(yb))))
    if args.ext:
        report['cnr_ext']=dict(source=dict(archive=summary['archive'],labels=summary['labels'],license='ODbL-1.0',count=summary['count'],cameras=summary['cameras'],weather=summary['weather'],dates=summary['dates'],sizes=summary['sizes'],pixel_duplicates_with_cnrpark=summary['pixel_duplicates_with_cnrpark']),
            mlp32=rates(ye,mlp_e),mlp32_ece=ece(mlp_e,ye),majority_busy=rates(ye,np.ones(len(ye))),mlp32_by_weather={w:rates(ye[weather==w],mlp_e[weather==w]) for w in ['sunny','overcast','rainy']})
        out=io.StringIO();writer=csv.writer(out,lineterminator='\n');keys=sorted(ext_scores)
        writer.writerow(['id','camera','weather','date','time','slot','label','mlp32',*[f'{k}{s}' for k in keys for s in ['','_calibrated']]])
        for i,r in enumerate(erows):writer.writerow([r['id'],r['camera'],r['weather'],r['date'],r['time'],r['slot'],r['label'],f'{mlp_e[i]:.6g}',*[f'{ext_scores[k][j][i]:.6g}' for k in keys for j in [0,1]]])
        path=ROOT/'docs/validation/parking-ext-predictions.csv.gz';path.write_bytes(gzip.compress(out.getvalue().encode(),mtime=0))
        # Per-image hashes would triple the file; one digest over sorted id:sha256 lines ties scores to the official archive.
        report['cnr_ext']['source_digest']=dict(method='sha256 of sorted "id:source_sha256\\n" lines over all EXT images',sha256=hashlib.sha256(''.join(f"{r['id']}:{r['source_sha256']}\n" for r in sorted(erows,key=lambda r:r['id'])).encode()).hexdigest())
        report['cnr_ext']['predictions']=dict(path='docs/validation/parking-ext-predictions.csv.gz',sha256=hashlib.sha256(path.read_bytes()).hexdigest(),rows=len(erows),columns=['mlp32',*[f'{k}{s}' for k in keys for s in ['','_calibrated']]])
        for k in keys:print(f"[{k}] EXT {pr(report['models'][k]['cnr_ext']['transfer'])} | MLP32 {pr(report['cnr_ext']['mlp32'])}",flush=True)
    report.update(elapsed_seconds=round(time.monotonic()-start,1),python=platform.python_version(),numpy=np.__version__)
    save_json(ROOT/'web/data/parking-transfer/evaluation.json',report)
    # Register heads with the runtime asset lock and hash every published transfer file.
    lock_path=ROOT/'web/assets.lock.json';lock=json.loads(lock_path.read_text());lock['files']=[f for f in lock['files'] if f['path'] not in {ENCODERS[k]['model'].removeprefix('web/') for k in report['models']}]
    for k,entry in report['models'].items():
        raw=(ROOT/ENCODERS[k]['model']).read_bytes();lock['files'].append(dict(path=entry['model_path'],bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),source=f'scripts/train_parking_transfer.py; CNRPark camera A, seed {SEED}; frozen {k} features',license=ENCODERS[k]['license']))
    lock_path.write_text(json.dumps(lock,indent=2,ensure_ascii=False)+'\n')
    published=sorted(p for p in (ROOT/'web/data/parking-transfer').rglob('*') if p.is_file())
    save_json(ROOT/'web/data/parking-transfer-assets.lock.json',dict(protocol=report['protocol'],files=[dict(path=str(p.relative_to(ROOT/'web')),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in published]))
    print('default',report['default_model'],'elapsed',report['elapsed_seconds'])

if __name__=='__main__':main()
