"""Score the PKLot subsample with the frozen source heads (protocol appendix 7). Nothing is trained or selected.
Usage: python scripts/score_pklot.py --pklot artifacts/parking-transfer/pklot
Needs pklot-ids.csv, pklot-summary.json, pklot-mlp32-scores.npy and features-{dinov2,mobilenet}/ from
prepare_pklot.py and extract_backbone_features.cjs. Writes docs/validation/pklot-predictions.csv.gz (per-sample
scores, the input of replay_parking_drift.py) and docs/validation/pklot-evaluation.json (accuracy).
"""
import argparse,csv,gzip,hashlib,io,json,time
from pathlib import Path
import numpy as np
from train_parking_transfer import ENCODERS,load_features,rates,save_json
from transfer_learning import bce,ece,sigmoid

ROOT=Path(__file__).resolve().parents[1]
PRED=ROOT/'docs/validation/pklot-predictions.csv.gz'
OUT=ROOT/'docs/validation/pklot-evaluation.json'
ATTRIBUTION='PKLot (Almeida, Oliveira, Silva Jr, Britto Jr, Koerich, Expert Systems with Applications 42(11):4937-4949, 2015), UFPR, CC BY 4.0; half-hour subsample resized to 150x150, scores derived by EstateGuard'

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--pklot',type=Path,required=True);args=ap.parse_args();start=time.monotonic()
    rows=list(csv.DictReader((args.pklot/'pklot-ids.csv').open()));summary=json.loads((args.pklot/'pklot-summary.json').read_text())
    y=np.array([int(r['label']) for r in rows]);mlp=np.load(args.pklot/'pklot-mlp32-scores.npy');cams=np.array([r['camera'] for r in rows]);weather=np.array([r['weather'] for r in rows])
    if len(mlp)!=len(rows):raise ValueError('MLP32 scores do not match the id list')
    report=dict(schema_version=1,protocol='docs/validation/parking-transfer-protocol.md#附录-7',role='held-out: PKLot (UFPR/PUCPR, Curitiba, 2012-09..2013-04), never used for training, thresholds, model or rule choice',
        source=dict(summary,attribution=ATTRIBUTION),models={},mlp32=dict(model_sha256=summary['mlp32_sha256'],all=rates(y,mlp),ece=ece(mlp,y),by_camera={c:rates(y[cams==c],mlp[cams==c]) for c in sorted(set(cams))}))
    scores={}
    for enc in ['dinov2','mobilenet']:
        path=ROOT/ENCODERS[enc]['model'];model=json.loads(path.read_text());meta,index,X=load_features(args.pklot/f'features-{enc}',enc)
        if meta['ids']!=[r['id'] for r in rows]:raise ValueError(f'{enc}: feature order differs from the id list')
        mean,scale,w,b,T=np.array(model['mean']),np.array(model['scale']),np.array(model['w']),float(model['b']),float(model['temperature'])
        z=((X-mean)/scale)@w+b;raw,cal=sigmoid(z),sigmoid(z/T);scores[enc]=(raw,cal)
        a=(mlp>=.5)==y;c=(raw>=.5)==y
        report['models'][enc]=dict(model=ENCODERS[enc]['model'],model_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),temperature=T,
            extraction={k:meta.get(k) for k in ['browser','backend','per_patch_ms_median','features_sha256','workers','wall_seconds','feature_version']},
            all=rates(y,raw),ece_raw=ece(raw,y),ece_calibrated=ece(cal,y),bce_raw=bce(z,y),bce_calibrated=bce(z/T,y),
            by_camera={k:rates(y[cams==k],raw[cams==k]) for k in sorted(set(cams))},by_weather={k:rates(y[weather==k],raw[weather==k]) for k in sorted(set(weather))},
            pairwise_vs_mlp32=dict(both_correct=int((a&c).sum()),fixed=int((~a&c).sum()),new_errors=int((a&~c).sum()),both_wrong=int((~a&~c).sum())))
        m=report['models'][enc]['all'];print(f"[{enc}] acc {m['accuracy']:.4f} bal {m['balanced_accuracy']:.4f} false-free {m['false_free_rate']:.4f} false-busy {m['false_occupied_rate']:.4f}",flush=True)
    m=report['mlp32']['all'];print(f"[mlp32] acc {m['accuracy']:.4f} bal {m['balanced_accuracy']:.4f}",flush=True)
    out=io.StringIO();wr=csv.writer(out,lineterminator='\n');keys=sorted(scores)
    wr.writerow(['id','camera','weather','date','time','slot','label','mlp32',*[f'{k}{s}' for k in keys for s in ['','_calibrated']]])
    for i,r in enumerate(rows):wr.writerow([r['id'],r['camera'],r['weather'],r['date'],r['time'],r['slot'],r['label'],f'{mlp[i]:.6g}',*[f'{scores[k][j][i]:.6g}' for k in keys for j in [0,1]]])
    PRED.write_bytes(gzip.compress(out.getvalue().encode(),mtime=0))
    report['predictions']=dict(path=str(PRED.relative_to(ROOT)),sha256=hashlib.sha256(PRED.read_bytes()).hexdigest(),rows=len(rows),columns=['mlp32',*[f'{k}{s}' for k in keys for s in ['','_calibrated']]],license='CC-BY-4.0 (derived from PKLot)')
    report['elapsed_seconds']=round(time.monotonic()-start,1);save_json(OUT,report);print('wrote',PRED.relative_to(ROOT),OUT.relative_to(ROOT))

if __name__=='__main__':main()
