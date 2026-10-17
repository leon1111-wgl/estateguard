"""Publish a small, label-independent CNR-EXT subset for the in-browser inspector.
Rule (fixed before any EXT scoring): per camera and weather, the earliest date with that weather,
then the snapshot closest to 12:00 (ties: earlier). Labels are copied for comparison only.
Usage: python scripts/package_ext_subset.py --ext artifacts/parking-transfer/ext
"""
import argparse,collections,csv,hashlib,io,json,shutil
from pathlib import Path
from PIL import Image
from train_parking import prepare_image

ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'web/data/parking-ext'
WEATHER=['sunny','overcast','rainy']

def save_json(path,value):path.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--ext',type=Path,required=True);args=ap.parse_args()
    rows=list(csv.DictReader((args.ext/'ext-ids.csv').open()));summary=json.loads((args.ext/'ext-summary.json').read_text())
    frames=collections.defaultdict(list)
    for r in rows:frames[(r['camera'],r['weather'],r['date'],r['time'])].append(r)
    chosen=[]
    for camera in sorted({r['camera'] for r in rows}):
        for weather in WEATHER:
            keys=[k for k in frames if k[0]==camera and k[1]==weather]
            if not keys:continue
            date=min(k[2] for k in keys);day=[k for k in keys if k[2]==date]
            chosen.append(min(day,key=lambda k:(abs(int(k[3][:2])*60+int(k[3][2:])-720),k[3])))
    if OUT.exists():shutil.rmtree(OUT)
    (OUT/'images').mkdir(parents=True);(OUT/'inputs').mkdir()
    samples=[];grouped=[]
    for camera,weather,date,stamp in sorted(chosen,key=lambda k:(k[0],k[2],k[3])):
        ids=[]
        for r in sorted(frames[(camera,weather,date,stamp)],key=lambda r:int(r['slot'])):
            raw=(args.ext/'jpeg'/r['source_path']).read_bytes()
            if hashlib.sha256(raw).hexdigest()!=r['source_sha256']:raise ValueError(r['id'])
            image=f"images/{r['id']}.jpg";inp=f"inputs/{r['id']}.png";(OUT/image).write_bytes(raw)
            Image.fromarray(prepare_image(raw)[1]).save(OUT/inp,optimize=True)
            samples.append(dict(id=r['id'],camera=camera,weather=weather,date=date,time=stamp,slot=r['slot'],label=int(r['label']),source_path=r['source_path'],source_sha256=r['source_sha256'],split='ext_holdout',image=image,input=inp));ids.append(r['id'])
        grouped.append(dict(id=f'{camera}-{date}-{stamp}',session=f'{camera}-ext',camera=camera,date=date,time=stamp,weather=weather,sample_ids=ids))
    dataset=dict(name='CNR-EXT (CNRPark+EXT extension)',authors=['Giuseppe Amato','Fabio Carrara','Fabrizio Falchi','Claudio Gennaro','Carlo Meghini','Claudio Vairo'],homepage='http://cnrpark.it/',archive_url=summary['archive']['url'],archive_sha256=summary['archive']['sha256'],labels_url=summary['labels']['url'],labels_sha256=summary['labels']['sha256'],license='ODbL-1.0',license_url='https://opendatacommons.org/licenses/odbl/1-0/',publication='https://doi.org/10.1016/j.eswa.2016.10.055',timezone='Source local wall-clock, timezone not declared; not converted to UTC+8',
        selection='Per camera and weather: earliest date with that weather, snapshot closest to 12:00; label-independent. Held-out test data, never used to train or select models.')
    (OUT/'NOTICE.md').write_text('# CNR-EXT 演示子集\n\n来源：Amato、Carrara、Falchi、Gennaro、Meghini、Vairo，*Deep learning for decentralized parking lot occupancy detection*，Expert Systems with Applications 72 (2017)，[doi:10.1016/j.eswa.2016.10.055](https://doi.org/10.1016/j.eswa.2016.10.055)；数据主页 <http://cnrpark.it/>。按 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 使用与再分发。\n\n'
        f"本目录只含 {len(samples)} 张原始 150×150 级车位裁剪（未修改字节）、由其生成的 32×32 PNG 模型输入，以及按固定规则选出的 {len(grouped)} 个快照索引。完整归档 {summary['archive']['bytes']:,} 字节，SHA-256 `{summary['archive']['sha256']}`，下载地址见 `manifest.json`。选择规则与标签无关；EXT 未用于训练、选模、阈值或默认模型选择。\n")
    save_json(OUT/'manifest.json',dict(schema_version=1,dataset=dataset,frames=grouped,samples=samples))
    lock=[dict(path=str(p.relative_to(ROOT/'web')),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(OUT.rglob('*')) if p.is_file()]
    save_json(ROOT/'web/data/parking-ext-assets.lock.json',dict(dataset=dataset,files=lock))
    print(json.dumps(dict(frames=len(grouped),samples=len(samples),bytes=sum(f['bytes'] for f in lock),per_camera=dict(collections.Counter(s['camera'] for s in samples)))))

if __name__=='__main__':main()
