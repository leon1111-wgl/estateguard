"""Drift-control replay of protocol appendix 7: rules R0-R5, with and without daily recalibration after a revocation.
Usage:
  python scripts/replay_parking_drift.py --dataset pklot   # held-out PKLot (descriptive: appendix 7.1 chose no challenger)
  python scripts/replay_parking_drift.py --dataset ext     # CNR-EXT re-run, descriptive only (observed data)
Constants come from web/data/parking-transfer/drift-calibration.json (synthetic, appendix 7.1). Thresholds are chosen
per camera from the earliest 20% of snapshots exactly as in appendix 3. The evaluation segment is replayed snapshot
by snapshot over one merged timeline of all cameras (R5 pools cameras on the same date). Spot-check, suspension and
revoked-side conclusions take the dataset label (prompt, correct reviewers). Every trigger takes effect from the next
snapshot. On EXT, R0 without recalibration must reproduce the published appendix 5 replay exactly, or the run stops.
"""
import argparse,bisect,csv,datetime as dt,gzip,hashlib,io,json,math,time
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
import numpy as np
from transfer_learning import audit_unit,chronological_roles,is_audited,route,routing_report,select_routing
from calibrate_drift_rules import LN40,WINDOW,llr,mix_ps

ROOT=Path(__file__).resolve().parents[1]
CAL=ROOT/'web/data/parking-transfer/drift-calibration.json'
DATA=dict(pklot=dict(path=ROOT/'docs/validation/pklot-predictions.csv.gz',record=ROOT/'docs/validation/pklot-evaluation.json',out=ROOT/'docs/validation/pklot-drift-replay.json',rules=['r0','r1','r2','r3','r4'],
                     role='held-out (appendix 7); descriptive because appendix 7.1 selected no challenger'),
          ext=dict(path=ROOT/'docs/validation/parking-ext-predictions.csv.gz',record=ROOT/'web/data/parking-transfer/evaluation.json',out=ROOT/'docs/validation/ext-drift-replay.json',rules=['r0','r1','r2','r3','r4','r5'],
                   role='observed CNR-EXT; descriptive re-run after appendix 7.1, never used to choose a rule'))
AUDIT_REPLAY=ROOT/'web/data/parking-transfer/audit-replay.json'
MODELS=['dinov2','mobilenet'];TARGETS=[.01,.02,.05];FRACTIONS=[0.,.05,.1,.2];RECAL=['none','daily'];SIDES=['free','busy']
PRIMARY=dict(model='dinov2',alpha=.05,fraction=.1,recal='none')
COUNTS=['n','auto_free','auto_free_errors','auto_busy','auto_busy_errors','auto_free_units','auto_free_units_with_error','auto_busy_units','auto_busy_units_with_error']

def day(d):return dt.date(int(d[:4]),int(d[4:6]),int(d[6:]))
def shift(d,k):return (day(d)+dt.timedelta(days=k)).strftime('%Y%m%d')

@lru_cache(maxsize=None)
def tail(n,x,a):
    """P(Bin(n,a) >= x)."""
    if x<=0:return 1.
    return min(1.,sum(math.comb(n,k)*a**k*(1-a)**(n-k) for k in range(x,n+1)))

class Constants:
    def __init__(self):
        c=json.loads(CAL.read_text());self.h1={u['alpha']:u['r1']['h'] for u in c['unit_rules']};self.h2={u['alpha']:u['r2']['h'] for u in c['unit_rules']}
        self.g={(d['alpha'],d['fraction']):dict(r3=d['r3']['gamma'],r4=d['r4']['gamma'],r5=d['r5']['gamma']) for d in c['day_rules']}
        self.sha256=hashlib.sha256(CAL.read_bytes()).hexdigest();self.chosen=c['selection']['chosen']

class Monitor:
    """Spot-checked units of one camera·model·side in order of first check; status flips to error at most once."""
    def __init__(self,rule,a,f,k):
        self.rule,self.a=rule,a;self.units=[];self.pos={};self.bad=[];self.date=[]
        self.u,self.v=llr(a,2*a);ps=mix_ps(a);self.mu=np.array([llr(a,p)[0] for p in ps]);self.mv=np.array([llr(a,p)[1] for p in ps])
        self.h1=k.h1.get(a);self.h2=k.h2.get(a);g=k.g.get((a,f),{});self.g3,self.g4,self.g5=g.get('r3'),g.get('r4'),g.get('r5')
    def add(self,unit,date,wrong):
        """Returns True when this check makes a new error unit."""
        if unit not in self.pos:self.pos[unit]=len(self.units);self.units.append(unit);self.bad.append(False);self.date.append(date)
        i=self.pos[unit]
        if wrong and not self.bad[i]:self.bad[i]=True;return True
        return False
    def counts(self):return len(self.units),sum(self.bad)
    def day_counts(self,date):
        n=x=0
        for d,b in zip(self.date,self.bad):
            if d==date:n+=1;x+=b
        return n,x
    def revoke(self,today):
        """(statistic, revoke) of the revocation rule for the current state."""
        n,x=self.counts();bad=np.array(self.bad,bool)
        if self.rule=='r0':s=x*self.u+(n-x)*self.v;return s,s>=LN40
        if self.rule=='r1':
            c=np.concatenate([[0.],np.cumsum(np.where(bad,self.u,self.v))]);s=float(c[-1]-c.min());return s,s>=self.h1
        if self.rule in('r2','r4','r5'):
            if not x:return 0.,False
            c=np.concatenate([np.zeros((1,3)),np.cumsum(np.where(bad[:,None],self.mu[None,:],self.mv[None,:]),0)],0)
            k=np.flatnonzero(bad);S=c[-1][None,:]-c[k];m=S.max(1);s=float((m+np.log(np.exp(S-m[:,None]).mean(1))).max());return s,s>=self.h2
        if self.rule=='r3':return self.window(today,include_today=True)
        raise ValueError(self.rule)
    def window(self,today,include_today):
        lo=shift(today,-(WINDOW-1));n=x=0
        for d,b in zip(self.date,self.bad):
            if lo<=d<=today and (include_today or d<today):n+=1;x+=b
        p=tail(n,x,self.a);return p,(self.g3 is not None and p<=self.g3)

def load(dataset):
    raw=DATA[dataset]['path'].read_bytes();rows=list(csv.DictReader(io.StringIO(gzip.decompress(raw).decode())))
    rec=json.loads(DATA[dataset]['record'].read_text());want=rec['predictions']['sha256'] if dataset=='pklot' else rec['cnr_ext']['predictions']['sha256']
    if hashlib.sha256(raw).hexdigest()!=want:raise ValueError('predictions differ from their published record')
    return rows,hashlib.sha256(raw).hexdigest()

def cameras_for(rows,model,alpha):
    """Per camera: chronological roles, appendix 3 thresholds on the pool, evaluation rows in (date,time,slot) order."""
    by=defaultdict(list)
    for r in rows:by[r['camera']].append(r)
    out={}
    for cam in sorted(by):
        sub=by[cam];keys=[(r['date'],r['time']) for r in sub];roles=chronological_roles(sorted(set(keys)));role=np.array([roles[k] for k in keys])
        pool=np.flatnonzero(role=='pool');ev=np.flatnonzero(role=='eval');p=np.array([float(r[f'{model}_calibrated']) for r in sub]);y=np.array([int(r['label']) for r in sub])
        units=np.array([f"{r['slot']}|{r['date']}" for r in sub]);pool_dates=len({sub[i]['date'] for i in pool})
        target=dict(alpha_free=alpha,alpha_busy=min(.2,2*alpha))
        routing=select_routing(p[pool],y[pool],units=units[pool],**target) if pool_dates>=2 else dict(t_free=None,t_busy=None,**target)
        order=sorted(ev,key=lambda i:(sub[i]['date'],sub[i]['time'],sub[i]['slot']))
        evrows=[sub[i] for i in order];pe=p[order];ye=y[order]
        base=routing_report(pe,ye,routing,units[order])
        out[cam]=dict(rows=evrows,p=pe,y=ye,routing={k:routing[k] for k in ['t_free','t_busy','alpha_free','alpha_busy']},pool_dates=pool_dates,pool_snapshots=len({keys[i] for i in pool}),
            days=sorted({r['date'] for r in evrows}),base={k:base[k] for k in COUNTS},onset=onset(evrows,pe,ye,routing))
    return out

def onset(evrows,p,y,routing):
    """First evaluation date on which a side, without spot checks, auto-decides >= 5 slot·days and > 2x its target of them err."""
    side_of=route(p,routing);out={}
    for s in SIDES:
        if routing[f't_{s}'] is None:continue
        a=routing[f'alpha_{s}'];per=defaultdict(lambda:[set(),set()])
        for i,r in enumerate(evrows):
            if side_of[i]==s:
                per[r['date']][0].add(r['slot'])
                if (y[i]==1) if s=='free' else (y[i]==0):per[r['date']][1].add(r['slot'])
        out[s]=next((d for d in sorted(per) if len(per[d][0])>=5 and len(per[d][1])/len(per[d][0])>2*a),None)
        out[f'{s}_daily']=[[d,len(per[d][0]),len(per[d][1])] for d in sorted(per)]
    return out

def replay(cams,f,rule,recal,k):
    audited={}
    def aud(unit):
        if unit not in audited:audited[unit]=is_audited(unit,f)
        return audited[unit]
    st={}
    for cam,c in cams.items():
        r=c['routing'];S={}
        for s in SIDES:
            if r[f't_{s}'] is None:continue
            a=r[f'alpha_{s}']
            S[s]=dict(alpha=a,t=r[f't_{s}'],t0=r[f't_{s}'],revoked=None,susp_until='',last_trigger='',mon=Monitor(rule,a,f,k),applied_snapshots=0,applied_errors=0,units=set(),bad=set(),bad_times=[],
                checked_snapshots=0,checked_units=set(),checked_bad=set(),suspended_snapshots=0,revoked_snapshots=0,revocations=[],reenables=[],suspensions=[],after_rev_total=0,after_rev_applied=0,evidence_from=None)
        st[cam]=dict(S=S,n=0,review=0,checked=0,suspended=0,revoked_review=0,human=[],last_date=None)
    frames=defaultdict(list)
    for cam,c in cams.items():
        for i,row in enumerate(c['rows']):frames[(row['date'],row['time'])].append((cam,i))
    camdates={cam:set(c['days']) for cam,c in cams.items()};pooled_last={s:'' for s in SIDES};prev=None
    keys={cam:sorted({(r['date'],r['time']) for r in c['rows']}) for cam,c in cams.items()}
    def effective(cam,d,t):
        """Date of the camera's first snapshot on which an action triggered at (d,t) is in force."""
        ks=keys[cam];i=bisect.bisect_left(ks,(d,'')) if t=='day-start' else bisect.bisect_right(ks,(d,t))
        return ks[i][0] if i<len(ks) else None
    def dayno(cam,d):return cams[cam]['days'].index(d)+1 if d in camdates[cam] else None
    def end_of_day(d):
        if recal!='daily':return
        for cam,c in cams.items():
            T=st[cam]
            for s,v in T['S'].items():
                # Appendix 7: each side re-selects from conclusions since its own (latest) revocation date.
                if not v['revoked']:continue
                items=[i for i in T['human'] if v['evidence_from']<=c['rows'][i]['date']<=d]
                if len({c['rows'][i]['date'] for i in items})<2:continue
                rr=select_routing(c['p'][items],c['y'][items],units=np.array([f"{c['rows'][i]['slot']}|{c['rows'][i]['date']}" for i in items]),alpha_free=c['routing']['alpha_free'],alpha_busy=c['routing']['alpha_busy'])
                t=rr[f't_{s}']
                if t is not None:v.update(t=t,revoked=None,mon=Monitor(rule,v['alpha'],f,k));v['reenables'].append(dict(after_date=d,threshold=t,human_snapshots=len(items)))
    def start_of_day(d):
        if rule!='r3':return
        for cam in cams:
            if d not in camdates[cam]:continue
            last=st[cam]['last_date'];span=[d] if last is None else [shift(last,j) for j in range(1,(day(d)-day(last)).days+1)]
            for s,v in st[cam]['S'].items():
                if v['revoked']:continue
                # The 7-day window also moves on calendar days without snapshots; any of those days can cross the limit.
                for g in span:
                    p,hit=v['mon'].window(g,include_today=False)
                    if hit:revoke(cam,s,d,'day-start',None,p,*v['mon'].counts(),trigger_date=g);break
            st[cam]['last_date']=d
    def revoke(cam,s,d,t,unit,stat,n,x,trigger_date=None):
        v=st[cam]['S'][s];eff=effective(cam,d,t)
        rec=dict(date=d,time=t,day=dayno(cam,d),effective_date=eff,effective_day=dayno(cam,eff) if eff else None,unit=unit,units=n,error_units=x,statistic=stat,
            applied_bad_before=sum(1 for bt in v['bad_times'] if bt<=(d,t)),**({'trigger_date':trigger_date} if trigger_date and trigger_date!=d else {}))
        v['revoked']=rec;v['revocations'].append(rec);v['evidence_from']=d
    for key in sorted(frames):
        d,t=key
        if d!=prev:
            if prev is not None:end_of_day(prev)
            start_of_day(d);prev=d
        pend=[]
        for cam,i in frames[key]:
            c=cams[cam];T=st[cam];row=c['rows'][i];p=c['p'][i];y=c['y'][i];T['n']+=1
            S=T['S'];side='review'
            if 'busy' in S and p>=S['busy']['t']:side='busy'
            elif 'free' in S and p<=S['free']['t']:side='free'
            if side!='review' and S[side]['revocations']:S[side]['after_rev_total']+=1
            if side=='review':T['review']+=1;T['human'].append(i);continue
            v=S[side];wrong=bool(y==1) if side=='free' else bool(y==0)
            if v['revoked']:T['revoked_review']+=1;v['revoked_snapshots']+=1;T['human'].append(i);continue
            unit=audit_unit(cam,row['slot'],d)
            if f and aud(unit):
                T['checked']+=1;v['checked_snapshots']+=1;v['checked_units'].add(unit);T['human'].append(i)
                if wrong:v['checked_bad'].add(unit)
                if v['mon'].add(unit,d,wrong):
                    stat,hit=v['mon'].revoke(d)
                    if hit:pend.append(('revoke',cam,side,d,t,unit,stat,v['mon'].counts()))
                    if rule=='r4' and v['last_trigger']!=d and v['mon'].g4 is not None:
                        n,x=v['mon'].day_counts(d)
                        if tail(n,x,v['alpha'])<=v['mon'].g4:v['last_trigger']=d;pend.append(('suspend',cam,side,d,t,None,None,v['mon'].counts()))
                    if rule=='r5' and pooled_last[side]!=d and v['mon'].g5 is not None:
                        n=x=0
                        for cc in st.values():
                            w=cc['S'].get(side)
                            if w and not w['revoked']:dn,dx=w['mon'].day_counts(d);n+=dn;x+=dx
                        if tail(n,x,v['alpha'])<=v['mon'].g5:
                            pooled_last[side]=d;pend+=[('suspend',cc,side,d,t,None,None,st[cc]['S'][side]['mon'].counts()) for cc in st if side in st[cc]['S'] and not st[cc]['S'][side]['revoked']]
                continue
            if v['susp_until'] and d<=v['susp_until']:T['suspended']+=1;v['suspended_snapshots']+=1;T['human'].append(i);continue
            v['applied_snapshots']+=1;v['units'].add(unit)
            if v['revocations']:v['after_rev_applied']+=1
            if wrong:
                v['applied_errors']+=1
                if unit not in v['bad']:v['bad'].add(unit);v['bad_times'].append((d,t))
        # Both take effect from the next snapshot; a revocation in this snapshot takes precedence over a pause.
        for kind,cam,s,dd,tt,unit,stat,nx in sorted(pend,key=lambda e:e[0]!='revoke'):
            v=st[cam]['S'][s]
            if kind=='revoke' and not v['revoked']:revoke(cam,s,dd,tt,unit,stat,*nx)
            # A pause that coincides with a revocation of the same side never takes effect and is not logged.
            if kind=='suspend' and not v['revoked']:
                v['susp_until']=max(v['susp_until'],shift(dd,1));eff=effective(cam,dd,tt)
                v['suspensions'].append(dict(date=dd,time=tt,day=dayno(cam,dd),effective_date=eff,effective_day=dayno(cam,eff) if eff else None,units=nx[0],error_units=nx[1],
                    applied_bad_before=sum(1 for bt in v['bad_times'] if bt<=(dd,tt))))
    if prev is not None:end_of_day(prev)
    out={}
    for cam,T in st.items():
        sides={}
        for s,v in T['S'].items():
            u=len(v['units']);first=v['revocations'][0] if v['revocations'] else None
            sides[s]=dict(alpha=v['alpha'],threshold=v['t0'],applied_snapshots=v['applied_snapshots'],applied_errors=v['applied_errors'],applied_units=u,applied_units_with_error=len(v['bad']),
                applied_unit_error_rate=len(v['bad'])/u if u else None,applied_error_rate=v['applied_errors']/v['applied_snapshots'] if v['applied_snapshots'] else None,
                checked_snapshots=v['checked_snapshots'],checked_units=len(v['checked_units']),checked_error_units=len(v['checked_bad']),suspended_snapshots=v['suspended_snapshots'],revoked_snapshots=v['revoked_snapshots'],
                revoked=first,revocations=v['revocations'],reenables=v['reenables'],suspensions=len(v['suspensions']),first_suspension=v['suspensions'][0] if v['suspensions'] else None,
                auto_share_after_first_revocation=v['after_rev_applied']/v['after_rev_total'] if v['after_rev_total'] else None)
        out[cam]=dict(n=T['n'],review=T['review'],checked=T['checked'],suspended=T['suspended'],revoked_review=T['revoked_review'],manual_share=(T['review']+T['checked']+T['suspended']+T['revoked_review'])/T['n'] if T['n'] else None,sides=sides)
    return out

def check_ext_reproduction(model,alpha,f,cams,res):
    """R0 without recalibration must equal the published appendix 5 replay (same thresholds, counts and revocations)."""
    pub=json.loads(AUDIT_REPLAY.read_text())['cameras'];bad=[]
    for cam,c in cams.items():
        e=pub[cam][model][str(alpha)]
        if (e['t_free'],e['t_busy'])!=(c['routing']['t_free'],c['routing']['t_busy']):bad.append((cam,'thresholds'));continue
        if 'runs' not in e:continue
        want=e['runs'][f'{f}:sprt'];got=res[cam]
        for key in ['n','review','checked','revoked_review']:
            if want[key]!=got[key]:bad.append((cam,key,want[key],got[key]))
        for s,w in want['sides'].items():
            g=got['sides'][s]
            for key in ['applied_snapshots','applied_errors','applied_units','applied_units_with_error','checked_snapshots','checked_units','checked_error_units']:
                if w[key]!=g[key]:bad.append((cam,s,key,w[key],g[key]))
            wr,gr=w['revoked'],g['revoked']
            if bool(wr)!=bool(gr) or (wr and (wr['date'],wr['time'],wr['day'],wr['unit'],wr['units'],wr['error_units'])!=(gr['date'],gr['time'],gr['day'],gr['unit'],gr['units'],gr['error_units'])):bad.append((cam,s,'revoked',wr,gr))
    if bad:raise ValueError(f'EXT R0 replay differs from appendix 5 ({model} {alpha} {f}): {bad[:5]}')

def summarise(cams,res,model,alpha,f,rule,recal):
    g=dict(model=model,alpha=alpha,fraction=f,rule=rule,recal=recal,sides=[],over=0,over_revoked=0,within=0,within_revoked=0,n=0,manual=0,checked=0,suspended=0,revoked_review=0,base_auto=0)
    for cam,c in cams.items():
        r=res[cam]
        if not r['sides']:continue
        g['n']+=r['n'];g['manual']+=r['manual_share']*r['n'];g['checked']+=r['checked'];g['suspended']+=r['suspended'];g['revoked_review']+=r['revoked_review'];g['base_auto']+=c['base']['auto_free']+c['base']['auto_busy']
        for s,v in r['sides'].items():
            nu=c['base'][f'auto_{s}_units'];bu=c['base'][f'auto_{s}_units_with_error'];base=bu/nu if nu else None;over=base is not None and base>v['alpha']
            g['over' if over else 'within']+=1
            if v['revoked']:g['over_revoked' if over else 'within_revoked']+=1
            on=c['onset'].get(s);rv=v['revoked'];fs=v['first_suspension']
            g['sides'].append(dict(camera=cam,side=s,alpha=v['alpha'],threshold=v['threshold'],baseline_unit_error_rate=base,over_target=over,onset=on,
                revoked_date=rv['date'] if rv else None,revoked_day=rv['day'] if rv else None,revoked_effective_day=rv['effective_day'] if rv else None,
                days_from_onset=(day(rv['effective_date'])-day(on)).days if rv and on and rv['effective_date'] else None,
                checked_units_at_revocation=rv['units'] if rv else None,applied_bad_before_revocation=rv['applied_bad_before'] if rv else None,
                first_suspension_day=fs['day'] if fs else None,first_suspension_effective_day=fs['effective_day'] if fs else None,
                suspension_days_from_onset=(day(fs['effective_date'])-day(on)).days if fs and on and fs['effective_date'] else None,
                checked_units_at_suspension=fs['units'] if fs else None,applied_bad_before_suspension=fs['applied_bad_before'] if fs else None,suspensions=v['suspensions'],revocations=len(v['revocations']),reenables=len(v['reenables']),
                applied_units=v['applied_units'],applied_units_with_error=v['applied_units_with_error'],residual_unit_error_rate=v['applied_unit_error_rate'],
                applied_snapshots=v['applied_snapshots'],applied_errors=v['applied_errors'],auto_share_after_first_revocation=v['auto_share_after_first_revocation'],
                still_over_target=v['applied_unit_error_rate'] is not None and v['applied_unit_error_rate']>v['alpha']))
    if not g['sides']:return None
    for s in SIDES:
        part=[x for x in g['sides'] if x['side']==s]
        if part:
            u=sum(x['applied_units'] for x in part);b=sum(x['applied_units_with_error'] for x in part);sn=sum(x['applied_snapshots'] for x in part);e=sum(x['applied_errors'] for x in part)
            g[f'{s}_pooled']=dict(cameras=len(part),applied_units=u,applied_units_with_error=b,unit_error_rate=b/u if u else None,applied_snapshots=sn,applied_errors=e,error_rate=e/sn if sn else None,still_over_target=sum(x['still_over_target'] for x in part))
    n=g['n'];g.update(manual_share=g['manual']/n,checked_share=g['checked']/n,checked_share_of_auto=g['checked']/g['base_auto'] if g['base_auto'] else None,suspended_share=g['suspended']/n,revoked_share=g['revoked_review']/n);del g['manual']
    return g

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--dataset',choices=sorted(DATA),required=True);args=ap.parse_args();start=time.monotonic()
    spec=DATA[args.dataset];rows,digest=load(args.dataset);k=Constants();runs=[];cams_out={}
    for model in MODELS:
        for alpha in TARGETS:
            cams=cameras_for(rows,model,alpha)
            cams_out.setdefault(model,{})[str(alpha)]={cam:dict(routing=c['routing'],pool_dates=c['pool_dates'],pool_snapshots=c['pool_snapshots'],eval_days=len(c['days']),eval_snapshots=len({(r['date'],r['time']) for r in c['rows']}),
                baseline=c['base'],onset={s:c['onset'].get(s) for s in SIDES},daily={s:c['onset'].get(f'{s}_daily') for s in SIDES if f'{s}_daily' in c['onset']}) for cam,c in cams.items()}
            if not any(c['routing']['t_free'] is not None or c['routing']['t_busy'] is not None for c in cams.values()):continue
            for f in FRACTIONS:
                for rule in (spec['rules'] if f else ['r0']):
                    for recal in (RECAL if f else ['none']):
                        res=replay(cams,f,rule,recal,k)
                        if f==0:
                            for cam,c in cams.items():
                                for s,v in res[cam]['sides'].items():
                                    if (v['applied_snapshots'],v['applied_errors'],v['applied_units'],v['applied_units_with_error'])!=(c['base'][f'auto_{s}'],c['base'][f'auto_{s}_errors'],c['base'][f'auto_{s}_units'],c['base'][f'auto_{s}_units_with_error']):raise ValueError(f'{model} {alpha} {cam} {s}: f=0 replay differs from routing_report')
                        if args.dataset=='ext' and rule=='r0' and recal=='none' and f:check_ext_reproduction(model,alpha,f,cams,res)
                        g=summarise(cams,res,model,alpha,f,'none' if not f else rule,recal)
                        if g:g['cameras']=res;runs.append(g)
            print(f'{model} {alpha} done {time.monotonic()-start:.0f}s',flush=True)
    report=dict(schema_version=1,protocol='docs/validation/parking-transfer-protocol.md#附录-7',dataset=args.dataset,role=spec['role'],predictions=dict(path=str(spec['path'].relative_to(ROOT)),sha256=digest,rows=len(rows)),
        constants=dict(path=str(CAL.relative_to(ROOT)),sha256=k.sha256,chosen_challenger=k.chosen),primary=PRIMARY,rules=spec['rules'],targets=TARGETS,fractions=FRACTIONS,recal=RECAL,
        reproduced_appendix5=args.dataset=='ext',thresholds=cams_out,runs=runs,elapsed_seconds=round(time.monotonic()-start,1))
    spec['out'].write_text(json.dumps(report,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n');print('wrote',spec['out'].relative_to(ROOT),report['elapsed_seconds'],'s')

if __name__=='__main__':main()
