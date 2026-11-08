"""Prepare the PKLot half-hour subsample (protocol appendix 7) for frozen-encoder scoring.
Usage: python scripts/prepare_pklot.py --data artifacts/datasets/pklot --out artifacts/parking-transfer/pklot
Reads what scripts/fetch_pklot.py wrote: labels come from the official XML (`occupied`); a slot image is kept only
when it has a non-duplicate PKLotSegmented patch whose folder label agrees with the XML. Each patch is resized to
150x150 (Pillow bilinear) and stored as PNG so no second lossy compression is added; the frozen MLP32 baseline is
scored here. No model is trained or selected. Labels are not passed to the browser extractor.
"""
import argparse,collections,csv,hashlib,io,json,re,time
import xml.etree.ElementTree as ET
from pathlib import Path
import numpy as np
from PIL import Image
from parking_learning import features,predict
from train_parking import prepare_image

ROOT=Path(__file__).resolve().parents[1]
ARCHIVE=dict(bytes=4898276304,sha256='e89bbc1dc735298c478688d50c7a682fb3b0076a87b6634923132709f2d2fa9b',url='https://www.inf.ufpr.br/vri/databases/PKLot.tar.gz',license='CC-BY-4.0')
SIZE=150

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--data',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args();start=time.monotonic()
    manifest=json.loads((args.data/'manifest.json').read_text())
    if manifest['bytes']!=ARCHIVE['bytes'] or manifest['sha256']!=ARCHIVE['sha256']:raise ValueError('fetch manifest does not match the archive registered in appendix 7.1')
    folder={}
    for r in csv.DictReader((args.data/'segmented-folder-labels.csv').open()):folder[(r['camera'],r['date'],r['time'],int(r['slot']))]=r['folder_state']
    weather={(k['camera'],k['date'],k['time']):'+'.join(k['weather']).lower() for k in manifest['kept']}
    dup=re.compile(r'/(\w+)/[^/]+/(\d{4})-(\d{2})-(\d{2})/[^/]+/\d{4}-\d{2}-\d{2}_(\d{2})_(\d{2})_(\d{2})#(\d+)')
    lots={'PUC':'PUC','PUCPR':'PUC','UFPR04':'UFPR04','UFPR05':'UFPR05'}
    dups={(lots[m[0]],m[1]+m[2]+m[3],m[4]+m[5]+m[6],int(m[7])) for m in (dup.search(n).groups() for n in manifest['duplicate_patch_files'])}
    mlp=json.loads((ROOT/'web/models/parking-occupancy/model.json').read_text())
    args.out.mkdir(parents=True,exist_ok=True);png=args.out/'png';rows=[];excluded=collections.Counter();sizes=collections.Counter();mlp_scores=[]
    for (cam,date,t),w in sorted(weather.items()):
        root=ET.parse(args.data/'xml'/cam/f'{date}_{t}.xml').getroot()
        for space in root.iter('space'):
            slot=int(space.get('id'));occ=space.get('occupied');key=(cam,date,t,slot)
            src=args.data/'patches'/cam/f'{date}_{t}_{slot:03d}.jpg'
            if occ not in ('0','1'):excluded['xml_missing_occupied']+=1;continue
            if key in dups:excluded['duplicate_patch']+=1;continue
            if key not in folder or not src.exists():excluded['no_patch']+=1;continue
            if (folder[key]=='Occupied')!=(occ=='1'):excluded['folder_xml_disagree']+=1;continue
            raw=src.read_bytes();img=Image.open(io.BytesIO(raw)).convert('RGB');sizes[f'{img.width}x{img.height}']+=1
            small=img.resize((SIZE,SIZE),Image.BILINEAR);buf=io.BytesIO();small.save(buf,format='PNG',optimize=False);data=buf.getvalue()
            rel=f'{cam}/{date}_{t}_{slot:03d}.png';(png/rel).parent.mkdir(parents=True,exist_ok=True);(png/rel).write_bytes(data)
            rgb,s32=prepare_image(data);mlp_scores.append(float(predict(features(s32)[None],mlp)[0]))
            rows.append(dict(id=f'{cam}-{date}-{t}-{slot}',camera=cam,weather=w,date=date,time=t,slot=str(slot),label=int(occ),source_path=rel,source_sha256=hashlib.sha256(data).hexdigest(),patch_sha256=hashlib.sha256(raw).hexdigest(),patch_size=f'{img.width}x{img.height}'))
        if len(rows)%20000<100:print(f'{len(rows)} rows {time.monotonic()-start:.0f}s',flush=True)
    keys=list(rows[0])
    with (args.out/'pklot-ids.csv').open('w',newline='') as f:
        wr=csv.DictWriter(f,fieldnames=keys,lineterminator='\n');wr.writeheader();wr.writerows(rows)
    with (args.out/'pklot-extract.csv').open('w',newline='') as f:
        wr=csv.DictWriter(f,fieldnames=['id','source_path','source_sha256'],lineterminator='\n');wr.writeheader();wr.writerows({k:r[k] for k in ['id','source_path','source_sha256']} for r in rows)
    np.save(args.out/'pklot-mlp32-scores.npy',np.array(mlp_scores,dtype=np.float64))
    xml_slots=sum(1 for _ in rows)+sum(excluded.values())
    summary=dict(archive=ARCHIVE,fetch=dict(sha256=manifest['sha256'],kept_snapshots=manifest['kept_snapshots'],kept_patches=manifest['kept_patches'],duplicate_patch_keys=manifest['duplicate_patch_keys']),
        resize=dict(size=SIZE,method='Pillow Image.resize BILINEAR, stored as PNG',pillow=Image.__version__),count=len(rows),xml_slot_entries=xml_slots,excluded=dict(excluded),
        cameras=dict(collections.Counter(r['camera'] for r in rows)),weather=dict(collections.Counter(r['weather'] for r in rows)),
        dates={c:sorted({r['date'] for r in rows if r['camera']==c}) for c in sorted({r['camera'] for r in rows})},snapshots={c:len({(r['date'],r['time']) for r in rows if r['camera']==c}) for c in sorted({r['camera'] for r in rows})},
        occupied=sum(r['label'] for r in rows),patch_sizes_top=dict(sizes.most_common(10)),patch_size_range=dict(min_w=min(int(s.split('x')[0]) for s in sizes),max_w=max(int(s.split('x')[0]) for s in sizes),min_h=min(int(s.split('x')[1]) for s in sizes),max_h=max(int(s.split('x')[1]) for s in sizes)),
        mlp32_sha256=hashlib.sha256((ROOT/'web/models/parking-occupancy/model.json').read_bytes()).hexdigest(),
        source_digest=hashlib.sha256(''.join(f"{r['id']}:{r['patch_sha256']}\n" for r in sorted(rows,key=lambda r:r['id'])).encode()).hexdigest(),elapsed_seconds=round(time.monotonic()-start,1))
    (args.out/'pklot-summary.json').write_text(json.dumps(summary,indent=1,ensure_ascii=False))
    print(json.dumps({k:v for k,v in summary.items() if k!='dates'},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
