"""Offline replay of spot checks and drift revocation on CNR-EXT (protocol appendix 5).
Usage:
  python scripts/replay_parking_audit.py [--labels artifacts/datasets/cnr-ext/CNRPark+EXT.csv]
  python scripts/replay_parking_audit.py --generic    # only the synthetic rule comparison in appendix 5
Reads the published EXT source-head scores, reproduces the appendix 3/4 thresholds and baselines exactly (stops
otherwise), then replays each camera's evaluation segment snapshot by snapshot in source-time order.
"""
import argparse,csv,gzip,hashlib,io,json,math,random,re,time
from collections import defaultdict
from pathlib import Path
import numpy as np
from transfer_learning import AUDIT,audit_evidence,audit_monitor,audit_unit,audit_hash,chronological_roles,cp_lower,is_audited,route,routing_report,select_routing

ROOT=Path(__file__).resolve().parents[1]
PREDICTIONS=ROOT/'docs/validation/parking-ext-predictions.csv.gz'
EVALUATION=ROOT/'web/data/parking-transfer/evaluation.json'
OUT=ROOT/'web/data/parking-transfer/audit-replay.json'
FIXTURE=ROOT/'tests/fixtures/parking-transfer-audit.json'
LABELS=dict(bytes=18132695,sha256='26416454cb8b184006431d0c149d31beabb8ef65d8eb2212cf4a39914a470dc8',url='https://github.com/fabiocarrara/deep-parking/releases/download/archive/CNRPark+EXT.csv')
MODELS=['dinov2','mobilenet'];TARGETS=[.01,.02,.05];FRACTIONS=[0.,.05,.1,.2];RULES=['sprt','cp']
PRIMARY=dict(model='dinov2',alpha=.05,fraction=.1,rule='sprt')
COUNTS=['n','auto_free','auto_free_errors','auto_busy','auto_busy_errors','auto_free_units','auto_free_units_with_error','auto_busy_units','auto_busy_units_with_error']

def save_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')

def generic(seed=7,runs=2000,maxn=1000,delta=AUDIT['delta']):
    """Synthetic Bernoulli streams only (no EXT data): how fast each rule revokes at a given true error rate."""
    out=[]
    for alpha in [.05,.1]:
        # cp revokes at the j-th error iff n <= N_j (N_j grows with j); built lazily from audit_evidence itself.
        N={0:0}
        def limit(j):
            for k in range(len(N),j+1):
                n=N[k-1]
                while n<maxn and audit_evidence(k,n+1,alpha,delta,'cp')[1]:n+=1
                N[k]=n
            return N[j]
        for mult in [.5,1,1.5,2,2.6,3,4]:
            p=min(.99,alpha*mult)
            for rule in RULES:
                rng=random.Random(seed);hits=[]
                for _ in range(runs):
                    x=0;hit=None
                    for n in range(1,maxn+1):
                        if rng.random()<p:
                            x+=1
                            if (rule=='cp' and n<=limit(x)) or (rule=='sprt' and audit_evidence(x,n,alpha,delta,'sprt')[1]):hit=n;break
                    hits.append(hit)
                done=sorted(h for h in hits if h)
                out.append(dict(alpha=alpha,multiple=mult,p=p,rule=rule,runs=runs,max_units=maxn,revoked_within_60=sum(h<=60 for h in done)/runs,revoked_within_150=sum(h<=150 for h in done)/runs,revoked_within_max=len(done)/runs,median_units=done[len(done)//2] if done else None))
    return out

def check_labels(path,rows):
    raw=path.read_bytes()
    if len(raw)!=LABELS['bytes'] or hashlib.sha256(raw).hexdigest()!=LABELS['sha256']:raise ValueError('Official label file size/hash mismatch')
    name=re.compile(r'^CNR-EXT/PATCHES/(SUNNY|OVERCAST|RAINY)/(\d{4})-(\d{2})-(\d{2})/camera(\d)/[SOR]_\d{4}-\d{2}-\d{2}_(\d{2})\.(\d{2})_C0\d_(\d+)\.jpg$')
    official={}
    for r in csv.DictReader(io.StringIO(raw.decode())):
        m=name.match(r['image_url'])
        if m:
            w,y,mo,d,cam,hh,mm,slot=m.groups();official[f'C{cam}-{y}{mo}{d}-{hh}{mm}-{slot}']=(f'C{cam}',w.lower(),f'{y}{mo}{d}',f'{hh}{mm}',slot,int(r['occupancy']))
    published={r['id']:(r['camera'],r['weather'],r['date'],r['time'],r['slot'],int(r['label'])) for r in rows}
    if official!=published:raise ValueError(f'Published EXT rows differ from the official labels: {len(set(official.items())^set(published.items()))}')
    return dict(path='CNRPark+EXT.csv (official release, deleted after the check)',url=LABELS['url'],bytes=LABELS['bytes'],sha256=LABELS['sha256'],rows_matched=len(published))

def replay(cam,rows,p,y,routing,fraction,rule,delta=AUDIT['delta']):
    """One camera's evaluation segment in source-time order. Auto decisions in spot-checked camera·slot·date units go to
    a person (labels stand in for correct, immediate checks); a revocation takes effect from the next snapshot."""
    frames=defaultdict(list)
    for i in sorted(range(len(rows)),key=lambda i:(rows[i]['date'],rows[i]['time'],rows[i]['slot'])):frames[(rows[i]['date'],rows[i]['time'])].append(i)
    days=sorted({r['date'] for r in rows});alpha={'free':routing['alpha_free'] if routing['t_free'] is not None else None,'busy':routing['alpha_busy'] if routing['t_busy'] is not None else None}
    side_of=route(p,routing);events=[];revoked={'free':None,'busy':None};review=audited=revoked_review=0
    applied={s:dict(snapshots=0,errors=0,units=set(),bad=set()) for s in alpha};checked={s:dict(snapshots=0,units=set()) for s in alpha}
    for key,idx in frames.items():
        new_error=False
        for i in idx:
            side=side_of[i]
            if side=='review':review+=1;continue
            if revoked[side]:revoked_review+=1;continue
            unit=audit_unit(cam,rows[i]['slot'],rows[i]['date']);wrong=bool(y[i]==1 if side=='free' else y[i]==0)
            if fraction and is_audited(unit,fraction):
                audited+=1;checked[side]['snapshots']+=1;checked[side]['units'].add(unit);events.append(dict(unit=unit,side=side,wrong=wrong,date=key[0],time=key[1]));new_error|=wrong
            else:
                a=applied[side];a['snapshots']+=1;a['units'].add(unit)
                if wrong:a['errors']+=1;a['bad'].add(unit)
        if new_error:
            m=audit_monitor(events,alpha['free'],alpha['busy'],delta,rule)
            for s in alpha:
                hit=m[s]['revoked']
                if hit and not revoked[s]:e=events[hit['index']];revoked[s]=dict(date=e['date'],time=e['time'],day=days.index(e['date'])+1,unit=e['unit'],**{k:hit[k] for k in ['units','error_units','statistic']})
    m=audit_monitor(events,alpha['free'],alpha['busy'],delta,rule);sides={}
    for s in alpha:
        if alpha[s] is None:continue
        a=applied[s];u=len(a['units'])
        sides[s]=dict(alpha=alpha[s],threshold=routing['t_free' if s=='free' else 't_busy'],applied_snapshots=a['snapshots'],applied_errors=a['errors'],applied_units=u,applied_units_with_error=len(a['bad']),
            applied_unit_error_rate=len(a['bad'])/u if u else None,applied_error_rate=a['errors']/a['snapshots'] if a['snapshots'] else None,
            checked_snapshots=checked[s]['snapshots'],checked_units=m[s]['units'],checked_error_units=m[s]['error_units'],statistic=m[s]['statistic'],revoked=revoked[s])
    return dict(n=len(rows),days=len(days),review=review,checked=audited,revoked_review=revoked_review,manual_share=(review+audited+revoked_review)/len(rows),sides=sides)

def build_report(labels_path=None,with_generic=True):
    """Everything the published replay contains, recomputed from repository files (verify_parking_transfer.py reuses it)."""
    start=time.monotonic();raw=PREDICTIONS.read_bytes();evaluation=json.loads(EVALUATION.read_text())
    if hashlib.sha256(raw).hexdigest()!=evaluation['cnr_ext']['predictions']['sha256']:raise ValueError('EXT predictions differ from the evaluation record')
    rows=list(csv.DictReader(io.StringIO(gzip.decompress(raw).decode())));labels=check_labels(labels_path,rows) if labels_path else None
    if labels is None and OUT.exists():
        # The official label file is deleted after use; keep the earlier check while the scores file is unchanged.
        old=json.loads(OUT.read_text())
        if old.get('source',{}).get('sha256')==hashlib.sha256(raw).hexdigest():labels=old.get('official_labels')
    cams=sorted({r['camera'] for r in rows});report=dict(schema_version=1,protocol='docs/validation/parking-transfer-protocol.md#附录-5',source=dict(path='docs/validation/parking-ext-predictions.csv.gz',sha256=hashlib.sha256(raw).hexdigest(),rows=len(rows),scores='source-head calibrated scores, 6 significant digits'),
        official_labels=labels,audit=dict(AUDIT,unit='camera|slot|date',hash='32-bit FNV-1a of "salt|camera|slot|date" (UTF-8), MurmurHash3 fmix32, divided by 2^32',p1='2 x target',limit_sprt=math.log(2/AUDIT['delta']),cp_level='(delta/2)/(x(x+1))'),
        primary=PRIMARY,daily_note='daily: [date, weather, automatic units, units with an error] without spot checks; descriptive, added after the replay',fractions=FRACTIONS,rules=RULES,targets=TARGETS,cameras={},reproduced=[])
    fixture=dict(hash=[],cp=[],monitor=[],units={})
    for cam in cams:
        idx=[i for i,r in enumerate(rows) if r['camera']==cam];sub=[rows[i] for i in idx];keys=[(r['date'],r['time']) for r in sub]
        roles=chronological_roles(sorted(set(keys)));role=np.array([roles[k] for k in keys]);pool=np.flatnonzero(role=='pool');ev=np.flatnonzero(role=='eval')
        y=np.array([int(r['label']) for r in sub]);units=np.array([f"{r['slot']}|{r['date']}" for r in sub]);pool_dates=len({sub[i]['date'] for i in pool})
        evrows=[sub[i] for i in ev];report['cameras'][cam]={}
        for model in MODELS:
            p=np.array([float(r[f'{model}_calibrated']) for r in sub]);published=evaluation['models'][model]['cnr_ext']['adaptation'][cam]['onsite'];entries={}
            for a in TARGETS:
                target=dict(alpha_free=a,alpha_busy=min(.2,2*a));exp=published[str(a)]['unit']
                if pool_dates<2 or not exp['eligible']:raise ValueError(f'{cam}: unexpected eligibility')
                routing=select_routing(p[pool],y[pool],units=units[pool],**target);base=routing_report(p[ev],y[ev],routing,units[ev])
                got=dict(t_free=routing['t_free'],t_busy=routing['t_busy'],**{k:base[k] for k in COUNTS});want=dict(t_free=exp['t_free'],t_busy=exp['t_busy'],**{k:exp['eval'][k] for k in COUNTS})
                if got!=want:raise ValueError(f'{model} {cam} {a}: published thresholds/baseline not reproduced: {got} vs {want}')
                report['reproduced'].append(f'{model}:{cam}:{a}')
                if routing['t_free'] is None and routing['t_busy'] is None:entries[str(a)]=dict(t_free=None,t_busy=None);continue
                runs={}
                for f in FRACTIONS:
                    for rule in (RULES if f else ['none']):
                        runs[f'{f}:{rule}']=replay(cam,evrows,p[ev],y[ev],routing,f,rule if f else AUDIT['rule'])
                # Without spot checks the replay loop must give exactly the published baseline.
                for s,v in runs['0.0:none']['sides'].items():
                    if (v['applied_snapshots'],v['applied_errors'],v['applied_units'],v['applied_units_with_error'])!=(base[f'auto_{s}'],base[f'auto_{s}_errors'],base[f'auto_{s}_units'],base[f'auto_{s}_units_with_error']):raise ValueError(f'{model} {cam} {a} {s}: replay baseline differs')
                # Descriptive only (added after the replay, no decision metric depends on it): per evaluation day,
                # automatic units and units with an error without spot checks, to show when errors happened.
                side_of=route(p[ev],routing);daily={}
                for s in ('free','busy'):
                    if routing[f't_{s}'] is None:continue
                    per=defaultdict(lambda:[set(),set()])
                    for i,r in enumerate(evrows):
                        if side_of[i]==s:
                            per[r['date']][0].add(r['slot'])
                            if (y[ev][i]==1) if s=='free' else (y[ev][i]==0):per[r['date']][1].add(r['slot'])
                    weather={r['date']:r['weather'] for r in evrows}
                    daily[s]=[[d,weather[d],len(per[d][0]),len(per[d][1])] for d in sorted(weather)]
                entries[str(a)]=dict(t_free=routing['t_free'],t_busy=routing['t_busy'],runs=runs,daily=daily)
                # Cross-runtime fixture: the full 20% spot-check stream (no revocation applied) for two cameras, both rules.
                if model=='dinov2' and a==.05 and cam in ('C7','C8'):
                    side_of=route(p[ev],routing);names=[];code={};events=[]
                    for i in sorted(range(len(evrows)),key=lambda i:(evrows[i]['date'],evrows[i]['time'],evrows[i]['slot'])):
                        s=side_of[i];unit=audit_unit(cam,evrows[i]['slot'],evrows[i]['date'])
                        if s!='review' and is_audited(unit,.2):
                            if unit not in code:code[unit]=len(names);names.append(unit)
                            events.append([code[unit],int(s=='busy'),int(y[ev][i]==1 if s=='free' else y[ev][i]==0)])
                    af=routing['alpha_free'] if routing['t_free'] is not None else None;ab=routing['alpha_busy'] if routing['t_busy'] is not None else None
                    full=[dict(unit=names[u],side='busy' if b else 'free',wrong=bool(w)) for u,b,w in events]
                    fixture['monitor'].append(dict(camera=cam,alpha_free=af,alpha_busy=ab,units=names,events=events,expected={rule:audit_monitor(full,af,ab,rule=rule) for rule in RULES}))
            report['cameras'][cam][model]=entries
        allunits=sorted({audit_unit(cam,r['slot'],r['date']) for r in sub})
        fixture['units'][cam]={str(f):hashlib.sha256('\n'.join(u for u in allunits if is_audited(u,f)).encode()).hexdigest() for f in FRACTIONS[1:]}|dict(count=len(allunits),**{f'selected_{f}':sum(is_audited(u,f) for u in allunits) for f in FRACTIONS[1:]})
    report['summary']=summarise(report)
    if with_generic:report['generic']=generic()
    fixture['hash']=[dict(text=t,value=audit_hash(t)) for t in ['','a','estateguard-audit-v1|C1|184|20151116','摄像头·车位·日期','estateguard-audit-v1|B|12|20150708']]
    fixture['cp']=[dict(x=x,n=n,level=l,lower=cp_lower(x,n,l)) for x,n,l in [(1,1,.05),(3,5,.05),(5,5,.01),(10,200,.001),(40,400,1e-4),(2,2,.025/6)]]
    report['elapsed_seconds']=round(time.monotonic()-start,1)
    return report,fixture

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--labels',type=Path);ap.add_argument('--generic',action='store_true');args=ap.parse_args()
    if args.generic:
        for r in generic():print(json.dumps(r,ensure_ascii=False))
        return
    report,fixture=build_report(args.labels)
    save_json(OUT,report);save_json(FIXTURE,fixture)
    # Keep the transfer data lock in step with the published directory (same rule as train_parking_transfer.py).
    published=sorted(p for p in (ROOT/'web/data/parking-transfer').rglob('*') if p.is_file());lock_path=ROOT/'web/data/parking-transfer-assets.lock.json';lock=json.loads(lock_path.read_text())
    save_json(lock_path,dict(protocol=lock['protocol'],files=[dict(path=str(p.relative_to(ROOT/'web')),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in published]))
    print(json.dumps(report['summary'],ensure_ascii=False,indent=1));print('elapsed',report['elapsed_seconds'])

def summarise(report):
    """Per model, target, fraction and rule: detections, false revocations, delays, workload and residual error."""
    out=[]
    for model in MODELS:
        for a in TARGETS:
            for f in FRACTIONS:
                for rule in (RULES if f else ['none']):
                    g=dict(model=model,alpha=a,fraction=f,rule=rule,sides=[],over=0,over_revoked=0,within=0,within_revoked=0,checked=0,n=0,manual=0,base_manual=0,base_auto=0)
                    for cam,models in report['cameras'].items():
                        e=models[model][str(a)]
                        if 'runs' not in e:continue
                        r=e['runs'][f'{f}:{rule}'];b=e['runs']['0.0:none'];g['checked']+=r['checked'];g['n']+=r['n'];g['manual']+=r['manual_share']*r['n'];g['base_manual']+=b['manual_share']*b['n'];g['base_auto']+=b['n']-b['review']
                        for s,v in r['sides'].items():
                            bv=b['sides'][s];over=bv['applied_unit_error_rate'] is not None and bv['applied_unit_error_rate']>v['alpha']
                            g['over' if over else 'within']+=1
                            if v['revoked']:g['over_revoked' if over else 'within_revoked']+=1
                            g['sides'].append(dict(camera=cam,side=s,alpha=v['alpha'],baseline_unit_error_rate=bv['applied_unit_error_rate'],over_target=over,revoked_day=v['revoked']['day'] if v['revoked'] else None,
                                checked_units_at_revocation=v['revoked']['units'] if v['revoked'] else None,applied_units=v['applied_units'],applied_units_with_error=v['applied_units_with_error'],residual_unit_error_rate=v['applied_unit_error_rate'],
                                applied_snapshots=v['applied_snapshots'],applied_errors=v['applied_errors'],still_over_target=v['applied_unit_error_rate'] is not None and v['applied_unit_error_rate']>v['alpha']))
                    if not g['sides']:continue
                    for s in ['free','busy']:
                        part=[x for x in g['sides'] if x['side']==s]
                        if part:
                            u=sum(x['applied_units'] for x in part);bad=sum(x['applied_units_with_error'] for x in part);snap=sum(x['applied_snapshots'] for x in part);err=sum(x['applied_errors'] for x in part)
                            g[f'{s}_pooled']=dict(cameras=len(part),applied_units=u,applied_units_with_error=bad,unit_error_rate=bad/u if u else None,applied_snapshots=snap,applied_errors=err,error_rate=err/snap if snap else None,still_over_target=sum(x['still_over_target'] for x in part))
                    g.update(checked_share=g['checked']/g['n'],checked_share_of_auto=g['checked']/g['base_auto'],manual_share=g['manual']/g['n'],base_manual_share=g['base_manual']/g['n']);del g['manual'],g['base_manual']
                    out.append(g)
    return out

if __name__=='__main__':main()
