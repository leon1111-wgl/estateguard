"""Prepare CNR-EXT as a held-out test: verify the official archive, join labels, extract JPEGs,
and score the frozen MLP32 baseline. No model is trained or selected here.
Usage: python scripts/prepare_cnr_ext.py --archive CNR-EXT-Patches-150x150.zip --csv CNRPark+EXT.csv --out artifacts/parking-transfer/ext
"""
import argparse,collections,csv,hashlib,io,json,re,time,zipfile
from pathlib import Path
import numpy as np
from PIL import Image
from parking_learning import features,predict
from train_parking import prepare_image

ROOT=Path(__file__).resolve().parents[1]
ARCHIVE=dict(bytes=449502403,sha256='84169527af6ad6aaf51729663b59283bc5f28368ff9ddd7856198eec226056d6',url='https://github.com/fabiocarrara/deep-parking/releases/download/archive/CNR-EXT-Patches-150x150.zip')
LABELS=dict(bytes=18132695,sha256='26416454cb8b184006431d0c149d31beabb8ef65d8eb2212cf4a39914a470dc8',url='https://github.com/fabiocarrara/deep-parking/releases/download/archive/CNRPark+EXT.csv')
WEATHER={'S':'SUNNY','O':'OVERCAST','R':'RAINY'}
NAME=re.compile(r'^PATCHES/(SUNNY|OVERCAST|RAINY)/(\d{4})-(\d{2})-(\d{2})/camera(\d)/([SOR])_\d{4}-\d{2}-\d{2}_(\d{2})\.(\d{2})_C0(\d)_(\d+)\.jpg$')

def checked(path,spec):
    raw=path.read_bytes()
    if len(raw)!=spec['bytes'] or hashlib.sha256(raw).hexdigest()!=spec['sha256']:raise ValueError(f'Unexpected size/hash for {path}; investigate before use')
    return raw

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--archive',type=Path,required=True);ap.add_argument('--csv',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args();start=time.monotonic()
    rawzip=checked(args.archive,ARCHIVE);checked(args.csv,LABELS)
    archive=zipfile.ZipFile(io.BytesIO(rawzip))
    if archive.testzip():raise ValueError('Archive CRC failure')
    labels={}
    for row in csv.DictReader(args.csv.open()):
        if row['image_url'].startswith('CNR-EXT/'):
            key=row['image_url'][len('CNR-EXT/'):]
            if key in labels:raise ValueError(f'Duplicate label row {key}')
            labels[key]=dict(camera=int(row['camera']),occupancy=int(row['occupancy']),slot=row['slot_id'],weather=row['weather'],datetime=row['datetime'])
    names=[n for n in sorted(archive.namelist()) if n.endswith('.jpg')]
    if set(names)!=set(labels):raise ValueError(f'Archive/label mismatch: {len(set(names)^set(labels))} paths')
    images=args.out/'jpeg';images.mkdir(parents=True,exist_ok=True)
    mlp=json.loads((ROOT/'web/models/parking-occupancy/model.json').read_text());mlp_hash=hashlib.sha256((ROOT/'web/models/parking-occupancy/model.json').read_bytes()).hexdigest()
    rows=[];mlp_scores=[];seen=set()
    for i,name in enumerate(names):
        m=NAME.match(name)
        if not m:raise ValueError(f'Unexpected path {name}')
        folder,y,mo,d,cam,w,hh,mm,cam2,slot=m.groups();label=labels[name]
        # Path, filename and label table must agree before a row is admitted.
        if cam!=cam2 or int(cam)!=label['camera'] or WEATHER[w]!=folder or w!=label['weather'] or slot!=label['slot'] or label['datetime']!=f'{y}-{mo}-{d}_{hh}.{mm}':raise ValueError(f'Inconsistent metadata {name}')
        raw=archive.read(name);rgb,small=prepare_image(raw)
        sid=f'C{cam}-{y}{mo}{d}-{hh}{mm}-{slot}'
        if sid in seen:raise ValueError(f'Duplicate id {sid}')
        seen.add(sid);(images/name).parent.mkdir(parents=True,exist_ok=True);(images/name).write_bytes(raw)
        rows.append(dict(id=sid,camera=f'C{cam}',weather=folder.lower(),date=f'{y}{mo}{d}',time=f'{hh}{mm}',slot=slot,label=label['occupancy'],source_path=name,source_sha256=hashlib.sha256(raw).hexdigest(),sha256=hashlib.sha256(rgb.tobytes()).hexdigest(),width=rgb.shape[1],height=rgb.shape[0]))
        mlp_scores.append(float(predict(features(small)[None],mlp)[0]))
        if i%10000==0:print(f'{i}/{len(names)} {time.monotonic()-start:.0f}s',flush=True)
    keys=list(rows[0])
    with (args.out/'ext-ids.csv').open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=keys,lineterminator='\n');writer.writeheader();writer.writerows(rows)
    # The browser extractor only needs identifiers and file hashes; labels stay out of it.
    with (args.out/'ext-extract.csv').open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=['id','source_path','source_sha256'],lineterminator='\n');writer.writeheader();writer.writerows({k:r[k] for k in ['id','source_path','source_sha256']} for r in rows)
    np.save(args.out/'ext-mlp32-scores.npy',np.array(mlp_scores,dtype=np.float64))
    split_rows=list(csv.DictReader((ROOT/'docs/validation/parking-split.csv').open()))
    overlap=collections.Counter(r['split'] for r in split_rows if r['sha256'] in {x['sha256'] for x in rows})
    summary=dict(archive=ARCHIVE,labels=LABELS,count=len(rows),mlp32_sha256=mlp_hash,cameras=dict(collections.Counter(r['camera'] for r in rows)),weather=dict(collections.Counter(r['weather'] for r in rows)),dates=sorted({r['date'] for r in rows}),occupied=sum(r['label'] for r in rows),sizes=dict(collections.Counter(f"{r['width']}x{r['height']}" for r in rows)),pixel_duplicates_with_cnrpark=dict(overlap),elapsed_seconds=round(time.monotonic()-start,1))
    (args.out/'ext-summary.json').write_text(json.dumps(summary,indent=1))
    print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
