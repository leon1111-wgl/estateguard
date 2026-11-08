"""Stream the official PKLot archive (protocol appendix 7) without ever writing it to disk.
Usage:
  python -I scripts/fetch_pklot.py --out artifacts/datasets/pklot
The .tar.gz is read once through curl (resumed with HTTP ranges if the connection drops) and hashed on the fly.
Only the half-hour subsample fixed in appendix 7 is written: the official XML of each kept snapshot and its
PKLotSegmented patches, under paths this script builds itself (tar member paths are never used for writing).
Full 1280x720 images are skipped. A manifest records size, SHA-256, ETag and every count. Delete --out after use.
"""
import argparse,hashlib,json,re,subprocess,sys,tarfile,time
from collections import defaultdict
from pathlib import Path

URL='https://www.inf.ufpr.br/vri/databases/PKLot.tar.gz'
EXPECTED=dict(bytes=4898276304,etag='"574da3cd-123f5c3d0"',last_modified='Tue, 31 May 2016 14:46:37 GMT')
LOTS={'PUC':'PUC','PUCPR':'PUC','UFPR04':'UFPR04','UFPR05':'UFPR05'}
STAMP=r'(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})'
SEG=re.compile(r'^PKLot/PKLotSegmented/([^/]+)/([^/]+)/[^/]+/(Empty|Occupied)/'+STAMP+r'#(\d+)(\(\d+\))?\.jpg$')
XML=re.compile(r'^PKLot/PKLot/([^/]+)/([^/]+)/[^/]+/'+STAMP+r'\.xml$')
FULL=re.compile(r'^PKLot/PKLot/([^/]+)/([^/]+)/[^/]+/'+STAMP+r'\.jpg$')

def head():
    out=subprocess.run(['curl','-sSIL','--max-time','60',URL],capture_output=True,text=True,check=True).stdout
    last=out.strip().split('\r\n\r\n')[-1];h={}
    for line in last.splitlines()[1:]:
        k,_,v=line.partition(':');h[k.strip().lower()]=v.strip()
    return h

class Stream:
    """File-like reader over curl that resumes at the current offset and hashes every byte it hands out."""
    def __init__(self,total,log,retries=50):
        self.total,self.log,self.retries=total,log,retries;self.sha=hashlib.sha256();self.n=0;self.proc=None;self.next_log=0;self.t0=time.monotonic()
    def _open(self):
        if self.proc:self.proc.kill();self.proc.wait()
        h=head()
        if h.get('etag')!=EXPECTED['etag'] or int(h.get('content-length',-1))!=self.total:raise SystemExit(f'archive changed on the server: {h}')
        self.proc=subprocess.Popen(['curl','-sS','--fail','-L','--speed-limit','2000','--speed-time','120','-r',f'{self.n}-',URL],stdout=subprocess.PIPE)
    def read(self,size=-1):
        if self.n>=self.total:return b''
        size=min(size if size and size>0 else 1<<20,self.total-self.n)
        for attempt in range(self.retries):
            if self.proc is None:self._open()
            chunk=self.proc.stdout.read(size)
            if chunk:
                self.sha.update(chunk);self.n+=len(chunk)
                if self.n>=self.next_log:
                    el=time.monotonic()-self.t0;self.log(f'{self.n/1e9:.2f} / {self.total/1e9:.2f} GB, {self.n/max(el,1)/1e6:.2f} MB/s');self.next_log+=200_000_000
                return chunk
            self.log(f'connection ended at {self.n} bytes, resuming (attempt {attempt+1})');self.proc.wait();self.proc=None;time.sleep(min(60,5*(attempt+1)))
        raise SystemExit('too many interrupted downloads')
    def drain(self):
        while self.read(1<<20):pass
        if self.proc:self.proc.kill();self.proc.wait()

def key(lot,y,mo,d,hh,mm,ss):return (LOTS.get(lot,lot),f'{y}{mo}{d}',f'{hh}{mm}{ss}')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
    out=args.out
    if out.exists() and any(out.iterdir()):raise SystemExit(f'{out} must be empty')
    out.mkdir(parents=True,exist_ok=True);logf=open(out/'fetch.log','a')
    def log(m):print(m,flush=True);logf.write(m+'\n');logf.flush()
    h=head();log(f'HEAD {h.get("content-length")} {h.get("etag")} {h.get("last-modified")}')
    if int(h['content-length'])!=EXPECTED['bytes'] or h.get('etag')!=EXPECTED['etag']:raise SystemExit('size or ETag differs from appendix 7')
    s=Stream(EXPECTED['bytes'],log);seg={};dups=[];dup_keys=set();xml={};weather=defaultdict(set);counts=defaultdict(int);other=[];lots_seen=defaultdict(int)
    with tarfile.open(fileobj=s,mode='r|gz') as tar:
        for m in tar:
            if not m.isfile():counts['non_file']+=1;continue
            g=SEG.match(m.name)
            if g:
                lot,w,state,y,mo,d,hh,mm,ss,slot,dup=g.groups();lots_seen['segmented/'+lot]+=1
                counts['segmented']+=1;k=key(lot,y,mo,d,hh,mm,ss)+(int(slot),)
                if dup or k in seg:dups.append(m.name);dup_keys.add(k)
                if not dup and k not in seg:seg[k]=(state,tar.extractfile(m).read())
                continue
            g=XML.match(m.name)
            if g:
                lot,w,y,mo,d,hh,mm,ss=g.groups();lots_seen['xml/'+lot]+=1
                counts['xml']+=1;k=key(lot,y,mo,d,hh,mm,ss);weather[k].add(w)
                if k in xml:counts['xml_duplicate_snapshot']+=1
                xml[k]=tar.extractfile(m).read();continue
            if FULL.match(m.name):counts['full_image']+=1;continue
            other.append(m.name)
    s.drain();digest=s.sha.hexdigest();log(f'read {s.n} bytes, sha256 {digest}')
    if s.n!=EXPECTED['bytes']:raise SystemExit('byte count differs')
    # Pre-registered subsample: per camera, snapshots (official XML) in time order, first one in each half-hour bucket.
    # Snapshots come from the official XML; only if the archive has none, fall back to patch timestamps (reported).
    snapshots=set(xml) if xml else {k[:3] for k in seg};keep={};per_lot=defaultdict(list)
    for k in sorted(snapshots):per_lot[k[0]].append(k)
    for lot,ks in per_lot.items():
        seen=set()
        for k in ks:
            b=(k[1],k[2][:2],int(k[2][2:4])//30)
            if b not in seen:seen.add(b);keep[k]=True
    written=defaultdict(int);excluded_dup=0
    for k in keep:
        if k not in xml:continue
        lot,date,t=k;p=out/'xml'/lot/f'{date}_{t}.xml';p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(xml[k])
    rows=['camera,date,time,slot,folder_state']
    for k,(state,data) in sorted(seg.items()):
        if k[:3] not in keep:continue
        if k in dup_keys:excluded_dup+=1;continue
        lot,date,t,slot=k;p=out/'patches'/lot/f'{date}_{t}_{slot:03d}.jpg';p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
        written[lot]+=1;rows.append(f'{lot},{date},{t},{slot},{state}')
    (out/'segmented-folder-labels.csv').write_text('\n'.join(rows)+'\n')
    seg_snap={k[:3] for k in seg}
    manifest=dict(url=URL,bytes=s.n,sha256=digest,etag=h.get('etag'),last_modified=h.get('last-modified'),fetched_at=time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        counts=dict(counts),lots_seen=dict(lots_seen),snapshot_source='xml' if xml else 'segmented_patch_names (no XML found)',other_members=other[:50],other_member_count=len(other),duplicate_patch_files=dups,duplicate_patch_keys=len(dup_keys),
        snapshots_with_xml={lot:len(v) for lot,v in per_lot.items()},snapshots_with_patches_but_no_xml=len(seg_snap-set(xml)),
        xml_snapshots_without_patches=len(set(xml)-seg_snap),kept_snapshots={lot:sum(1 for k in keep if k[0]==lot) for lot in per_lot},
        kept_patches=dict(written),kept_patch_slots_excluded_as_duplicates=excluded_dup,
        multi_weather_snapshots=sum(1 for v in weather.values() if len(v)>1),
        kept=[dict(camera=k[0],date=k[1],time=k[2],weather=sorted(weather[k])) for k in sorted(keep)])
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=1)+'\n')
    log(json.dumps({k:v for k,v in manifest.items() if k not in('kept','duplicate_patch_files','other_members')},ensure_ascii=False))

if __name__=='__main__':main()
