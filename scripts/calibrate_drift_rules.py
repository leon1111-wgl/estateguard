"""Synthetic calibration and challenger selection for protocol appendix 7 (no real data is read).
Usage:
  python scripts/calibrate_drift_rules.py            # full run (appendix 7 sizes), writes the JSON below
  python scripts/calibrate_drift_rules.py --quick    # small smoke run, writes nothing
Every random stream is derived from the seeds fixed in appendix 7 (20261020 calibration, 20261021 selection).
"""
import argparse,json,math,os,time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'web/data/parking-transfer/drift-calibration.json'
SEED_CAL,SEED_SEL=20261020,20261021
TARGETS=[.01,.02,.04,.05,.10]          # free-side targets plus the busy-side 2a values
FRACTIONS=[.05,.10,.20]
NS=[20,35,60,100]                      # automatic slot·days per day and side
KS=[3,9]                               # cameras pooled by R5
HORIZONS=[1000,2000,5000]              # audited units
LN40=math.log(40)
MULTS=(2,4,8)                          # R2 mixture alternatives, p1 capped at 0.5
WINDOW=7                               # R3 calendar days, today included
SUSPEND_BUDGET=.01                     # R4/R5 trigger days per camera·side·day
GAMMAS=[1e-2,5e-3,2e-3,1e-3,5e-4,2e-4,1e-4,5e-5,2e-5,1e-5,5e-6,2e-6,1e-6]
RHOS=[.02,.1]
H_STEP=.01
RUN_LENGTH=dict(runs=2000,cap=100000)  # null run length of the forgetting rules (reported only)
SEL=dict(alpha=.05,fraction=.10,n=35,days=120,onset=30,runs=5000)
SCENARIOS=[('null',None),('null_overdispersed',.1),('persistent',1.5),('persistent',2.),('persistent',3.),
           ('shock',(3.,1)),('shock',(3.,4)),('shock',(6.,1)),('shock',(6.,4))]
SIMPLER=['r1','r3','r2','r4']          # tie-break order fixed in appendix 7

def llr(a,p1):return math.log(p1/a),math.log((1-p1)/(1-a))
def mix_ps(a):return [min(.5,m*a) for m in MULTS]
def rng_for(seed,*key):return np.random.default_rng(np.random.SeedSequence(seed,spawn_key=tuple(key)))

def tail_table(a,nmax):
    """T[n,x] = P(Bin(n,a) >= x) for 0 <= x <= n+1."""
    T=np.zeros((nmax+1,nmax+2));pmf=np.zeros(nmax+2);pmf[0]=1.
    for n in range(nmax+1):
        T[n]=np.cumsum(pmf[::-1])[::-1];nxt=pmf*(1-a);nxt[1:]+=pmf[:-1]*a;pmf=nxt
    return T

def mix_path(pos,us,vs):
    """Statistic of the (mixture) CUSUM W = max_k log[(1/J) sum_j exp sum_{i>=k} l_i(p_j)] at each error unit.
    pos: sorted 0-based positions of error units in the audited sequence. Only starts at error units can be the
    maximiser; a start whose sums are all <= 0 before the next error is dominated forever and is dropped."""
    J=len(us);lw=-math.log(J);cand=[];last=-1;out=[]
    for p in pos:
        g=p-last-1;last=p;nc=[]
        for c in cand:
            s=[ci+g*v for ci,v in zip(c,vs)]
            if max(s)>0:nc.append([si+u for si,u in zip(s,us)])
        nc.append(list(us));cand=nc;best=-math.inf
        for c in cand:
            m=max(c);w=m+math.log(sum(math.exp(ci-m) for ci in c))+lw
            if w>best:best=w
        out.append(best)
    return out

def page_at_errors(pos,u,v):
    """R0 (cumulative) and R1 (Page CUSUM) statistics at error units; pos is (runs, J) padded with large values."""
    j=np.arange(1,pos.shape[1]+1);s=j*u+(pos+1-j)*v;pre=s-u
    return s,s-np.minimum(0.,np.minimum.accumulate(pre,axis=1))

def error_positions(rng,a,runs,H):
    J=int(a*H+8*math.sqrt(a*H)+30)
    while True:
        pos=np.cumsum(rng.geometric(a,(runs,J)),axis=1)-1
        if (pos[:,-1]>=H).all():return pos
        J*=2

# ---------------------------------------------------------------- unit-indexed rules (R0, R1, R2)
def unit_task(args):
    ai,a,chunk,runs=args;rng=rng_for(SEED_CAL,1,ai,chunk);pos=error_positions(rng,a,runs,HORIZONS[-1])
    u,v=llr(a,2*a);s,w=page_at_errors(pos,u,v);ps=mix_ps(a);us,vs=zip(*(llr(a,p) for p in ps))
    out={}
    for H in HORIZONS:
        ok=pos<H;out[f'r0_{H}']=np.where(ok,s,-np.inf).max(1);out[f'r1_{H}']=np.where(ok,w,-np.inf).max(1)
    m2={H:np.full(runs,-np.inf) for H in HORIZONS}
    for r in range(runs):
        p=pos[r][pos[r]<HORIZONS[-1]];path=np.array(mix_path(p.tolist(),us,vs))
        for H in HORIZONS:
            k=p<H
            if k.any():m2[H][r]=path[k].max()
    for H in HORIZONS:out[f'r2_{H}']=m2[H]
    return ai,out

def run_length_task(args):
    ai,a,chunk,runs,h1,h2=args;rng=rng_for(SEED_CAL,2,ai,chunk);cap=RUN_LENGTH['cap'];pos=error_positions(rng,a,runs,cap)
    u,v=llr(a,2*a);s,w=page_at_errors(pos,u,v);ok=pos<cap;ps=mix_ps(a);us,vs=zip(*(llr(a,p) for p in ps))
    first=lambda hit:np.where(hit.any(1),np.take_along_axis(pos,hit.argmax(1)[:,None],1)[:,0]+1,-1)
    r0=first(ok&(s>=LN40));r1=first(ok&(w>=h1));r2=np.full(runs,-1)
    for r in range(runs):
        p=pos[r][pos[r]<cap].tolist()
        for q,x in zip(p,mix_path(p,us,vs)):
            if x>=h2:r2[r]=q+1;break
    return ai,dict(r0=r0,r1=r1,r2=r2)

def smallest_h(m,allowed):
    """Smallest multiple of H_STEP with at most `allowed` runs reaching it."""
    v=np.sort(m)[::-1];k=math.floor(v[allowed]/H_STEP)+1 if allowed<len(v) else 0
    while k>0 and (m>=(k-1)*H_STEP).sum()<=allowed:k-=1
    while (m>=k*H_STEP).sum()>allowed:k+=1
    return round(k*H_STEP,2)

# ---------------------------------------------------------------- day-structured audited streams
def audited_days(rng,runs,days,n,f,p_day):
    """Audited units only, in time order: day label, error flag and day start offsets (runs, days)."""
    nd=rng.binomial(n,f,(runs,days));cum=nd.cumsum(1);start=cum-nd;total=cum[:,-1];U=int(total.max())
    z=np.zeros((runs,U+1),np.int32);rows=np.repeat(np.arange(runs),days).reshape(runs,days);k=start<U
    np.add.at(z,(rows[k],start[k]),1);day=np.minimum(z.cumsum(1)[:,:U]-1,days-1)
    valid=np.arange(U)[None,:]<total[:,None];e=(rng.random((runs,U))<np.take_along_axis(p_day,day,1))&valid
    xc=np.concatenate([np.zeros((runs,1),np.int64),e.cumsum(1)],1)
    return dict(day=day,e=e,valid=valid,start=start,xc=xc,U=U)

def window_minp(d,T,days):
    """R3: smallest binomial tail over every check (each audited error, each day start) per run."""
    day,e,start,xc,U=d['day'],d['e'],d['start'],d['xc'],d['U'];lo=np.maximum(day-(WINDOW-1),0)
    s_lo=np.take_along_axis(start,lo,1);k=np.arange(U)[None,:]
    nW=k+1-s_lo;xW=xc[:,1:]-np.take_along_axis(xc,s_lo,1)
    pe=np.where(e,T[np.minimum(nW,T.shape[0]-1),xW],1.).min(1)
    dl=np.maximum(np.arange(days)-(WINDOW-1),0);s0=np.take_along_axis(start,np.broadcast_to(dl,start.shape),1)
    n0=start-s0;x0=np.take_along_axis(xc,start,1)-np.take_along_axis(xc,s0,1)
    return np.minimum(pe,T[np.minimum(n0,T.shape[0]-1),x0].min(1))

def day_minp(rng,days,units,f,a,T,p_day=None):
    """R4/R5: per day, smallest binomial tail of today's audited units at each new error."""
    nd=rng.binomial(units,f,days);M=max(int(nd.max()),1);k=np.arange(M)[None,:];valid=k<nd[:,None]
    p=a if p_day is None else p_day[:,None];e=(rng.random((days,M))<p)&valid
    return np.where(e,T[np.minimum(k+1,T.shape[0]-1),e.cumsum(1)],1.).min(1)

def frac_le(m,g):return float((m<=g).mean())

def day_task(args):
    ai,a,fi,f,quick=args;out=dict(r3={},r4={},r5={})
    rr=2000 if quick else 20000;dd=20000 if quick else 200000
    for ni,n in enumerate(NS):
        days=math.ceil(1000/(n*f));T=tail_table(a,WINDOW*n);m=[]
        for c in range(0,rr,2000):
            rng=rng_for(SEED_CAL,3,ai,fi,ni,c);m.append(window_minp(audited_days(rng,2000,days,n,f,np.full((2000,days),a)),T,days))
        m=np.concatenate(m);out['r3'][n]=dict(days=days,fa=[frac_le(m,g) for g in GAMMAS])
        T=tail_table(a,n);m=np.concatenate([day_minp(rng_for(SEED_CAL,4,ai,fi,ni,c),20000,n,f,a,T) for c in range(0,dd,20000)])
        out['r4'][n]=[frac_le(m,g) for g in GAMMAS]
        for ki,K in enumerate(KS):
            T=tail_table(a,K*n);m=np.concatenate([day_minp(rng_for(SEED_CAL,5,ai,fi,ni,ki,c),20000,K*n,f,a,T) for c in range(0,dd,20000)])
            out['r5'][f'{n}x{K}']=[frac_le(m,g) for g in GAMMAS]
    return ai,fi,out

def largest_gamma(rows,limit):
    ok=[i for i in range(len(GAMMAS)) if all(r[i]<=limit for r in rows)]
    return GAMMAS[min(ok)] if ok else None

# ---------------------------------------------------------------- overdispersed null (stress, report only)
def beta_days(rng,a,rho,shape):
    k=1/rho-1;return rng.beta(a*k,(1-a)*k,shape)

def stress_task(args):
    ai,a,ri,rho,const,quick=args;n,f=35,.10;runs=2000 if quick else 20000;out={}
    days=math.ceil(1000/(n*f));u,v=llr(a,2*a);ps=mix_ps(a);us,vs=zip(*(llr(a,p) for p in ps))
    hits=dict(r0=0,r1=0,r2=0,r3=0);T=tail_table(a,WINDOW*n)
    for c in range(0,runs,2000):
        rng=rng_for(SEED_CAL,6,ai,ri,c);pd=beta_days(rng,a,rho,(2000,days*2))
        d=audited_days(rng,2000,days*2,n,f,pd);e,valid=d['e'],d['valid']
        cnt=np.cumsum(valid,1);in_h=valid&(cnt<=1000)
        s=np.cumsum(np.where(in_h,np.where(e,u,v),0.),1);w=s-np.minimum(0.,np.minimum.accumulate(s,1))
        er=e&in_h;hits['r0']+=int((er&(s>=LN40)).any(1).sum());hits['r1']+=int((er&(w>=const['h1'])).any(1).sum())
        for r in range(2000):
            p=(np.flatnonzero(er[r])).tolist()
            if p and max(mix_path(p,us,vs))>=const['h2']:hits['r2']+=1
        if const['g3'] is not None:
            d3=audited_days(rng,2000,days,n,f,beta_days(rng,a,rho,(2000,days)));hits['r3']+=int((window_minp(d3,T,days)<=const['g3']).sum())
    out={k:v/runs for k,v in hits.items()}
    T=tail_table(a,n);dd=20000 if quick else 200000;rng=rng_for(SEED_CAL,7,ai,ri)
    if const['g4'] is not None:
        out['r4_trigger_days']=float(np.mean([frac_le(day_minp(rng,20000,n,f,a,T,beta_days(rng,a,rho,20000)),const['g4']) for _ in range(dd//20000)]))
    if const['g5'] is not None:
        for K in KS:
            T=tail_table(a,K*n)
            out[f'r5_trigger_days_K{K}']=float(np.mean([frac_le(day_minp(rng,20000,K*n,f,a,T,beta_days(rng,a,rho,20000)),const['g5']) for _ in range(dd//20000)]))
    return ai,ri,out

# ---------------------------------------------------------------- challenger selection (appendix 7)
def scenario_days(name,arg,rng,runs,a,days,onset):
    p=np.full((runs,days),a);drift=np.zeros(days,bool);o=onset-1
    if name=='null_overdispersed':p=beta_days(rng,a,arg,(runs,days))
    elif name=='persistent':p[:,o:]=arg*a;drift[o:]=True
    elif name=='shock':m,L=arg;p[:,o:o+L]=m*a;drift[o:o+L]=True
    return p,drift

def selection_task(args):
    si,ci,runs,const=args;name,arg=SCENARIOS[si];a,f,n,days,onset=SEL['alpha'],SEL['fraction'],SEL['n'],SEL['days'],SEL['onset']
    rng=rng_for(SEED_SEL,si,ci);p,drift=scenario_days(name,arg,rng,runs,a,days,onset)
    aud=rng.random((runs,days,n))<f;err=rng.random((runs,days,n))<p[:,:,None];tn=days*n
    audf=aud.reshape(runs,tn);errf=err.reshape(runs,tn);base=~audf&errf&np.repeat(drift,n)[None,:]
    ac=np.concatenate([np.zeros((runs,1),np.int64),audf.cumsum(1)],1);xc=np.concatenate([np.zeros((runs,1),np.int64),(audf&errf).cumsum(1)],1)
    ae=audf&errf;t=np.arange(tn);dayof=t//n;none=np.full(runs,tn)
    def first(hit,shift=1):return np.where(hit.any(1),hit.argmax(1)+shift,tn)
    u,v=llr(a,2*a);s=np.cumsum(np.where(audf,np.where(errf,u,v),0.),1);w=s-np.minimum(0.,np.minimum.accumulate(s,1))
    rev=dict(r0=first(ae&(s>=LN40)),r1=first(ae&(w>=const['h1'])))
    ps=mix_ps(a);us,vs=zip(*(llr(a,q) for q in ps));r2=none.copy()
    for r in range(runs):
        te=np.flatnonzero(ae[r])
        for q,x in zip(te,mix_path((ac[r,te+1]-1).tolist(),us,vs)):
            if x>=const['h2']:r2[r]=q+1;break
    rev['r2']=r2
    if const['g3'] is not None:
        T=tail_table(a,WINDOW*n);lo=np.maximum(dayof-(WINDOW-1),0)*n
        nW=ac[:,1:]-ac[:,lo];xW=xc[:,1:]-xc[:,lo];hit=ae&(T[nW,xW]<=const['g3'])
        ds=np.arange(days)*n;dl=np.maximum(np.arange(days)-(WINDOW-1),0)*n
        n0=ac[:,ds]-ac[:,dl];x0=xc[:,ds]-xc[:,dl];hd=T[n0,x0]<=const['g3']
        rev['r3']=np.minimum(first(hit),np.where(hd.any(1),hd.argmax(1)*n,tn))
    susp=np.zeros((runs,tn),bool)
    if const['g4'] is not None:
        T=tail_table(a,n);nt=ac[:,1:]-ac[:,dayof*n];xt=xc[:,1:]-xc[:,dayof*n]
        trig=(ae&(T[np.minimum(nt,n),xt]<=const['g4'])).reshape(runs,days,n)
        rr,dd=np.nonzero(trig.any(2));ii=trig[rr,dd].argmax(1)
        diff=np.zeros((runs,tn+1),np.int32);np.add.at(diff,(rr,dd*n+ii+1),1);np.add.at(diff,(rr,np.minimum((dd+2)*n,tn)),-1)
        susp=diff.cumsum(1)[:,:tn]>0;rev['r4']=r2
    res={}
    for rule,sr in rev.items():
        inactive=t[None,:]>=sr[:,None]
        if rule=='r4':inactive|=susp
        harm=(base&~inactive).sum(1);manual=audf.sum(1)+(~audf&inactive).sum(1)
        rd=np.where(sr<tn,sr//n+1,-1)
        res[rule]=dict(harm=harm.tolist(),manual=(manual/tn).tolist(),revoked_day=rd.tolist(),suspended_units=((~audf&susp).sum(1).tolist() if rule=='r4' else None))
    return si,ci,res

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--quick',action='store_true');ap.add_argument('--workers',type=int,default=max(1,(os.cpu_count() or 2)-1))
    args=ap.parse_args();quick=args.quick;start=time.monotonic()
    runs=4000 if quick else 20000;chunk=1000;ex=ProcessPoolExecutor(args.workers)
    # 1. unit-indexed calibration: pi0(a) from R0, then h1 and h2
    acc={ai:{} for ai in range(len(TARGETS))}
    for ai,out in ex.map(unit_task,[(ai,a,c,chunk) for ai,a in enumerate(TARGETS) for c in range(runs//chunk)]):
        for k,v in out.items():acc[ai].setdefault(k,[]).append(v)
    unit=[]
    for ai,a in enumerate(TARGETS):
        m={k:np.concatenate(v) for k,v in acc[ai].items()};allowed=int((m['r0_1000']>=LN40).sum())
        h1=smallest_h(m['r1_1000'],allowed);h2=smallest_h(m['r2_1000'],allowed)
        unit.append(dict(alpha=a,runs=runs,pi0=allowed/runs,r0_false_revocation={H:float((m[f'r0_{H}']>=LN40).mean()) for H in HORIZONS},
            r1=dict(h=h1,false_revocation={H:float((m[f'r1_{H}']>=h1).mean()) for H in HORIZONS}),
            r2=dict(h=h2,p1=mix_ps(a),false_revocation={H:float((m[f'r2_{H}']>=h2).mean()) for H in HORIZONS})))
        print(f'a={a}: pi0={allowed/runs:.4f} h1={h1} h2={h2}',flush=True)
    rl_runs=400 if quick else RUN_LENGTH['runs'];rl={ai:dict(r0=[],r1=[],r2=[]) for ai in range(len(TARGETS))}
    for ai,out in ex.map(run_length_task,[(ai,a,c,200,unit[ai]['r1']['h'],unit[ai]['r2']['h']) for ai,a in enumerate(TARGETS) for c in range(rl_runs//200)]):
        for k,v in out.items():rl[ai][k].append(v)
    for ai in rl:
        for k in ['r0','r1','r2']:
            x=np.concatenate(rl[ai][k]);hit=np.sort(x[x>0])
            unit[ai][f'{k}_null_run_length']=dict(runs=len(x),cap_units=RUN_LENGTH['cap'],revoked_within_cap=len(hit)/len(x),median_units=int(np.median(np.where(x>0,x,10**12))) if 2*len(hit)>len(x) else None)
    print('unit-indexed done',round(time.monotonic()-start),'s',flush=True)
    # 2. day-structured constants: gamma3 (revocation budget pi0), gamma4/gamma5 (trigger days <= 1%)
    day=[]
    for ai,fi,out in ex.map(day_task,[(ai,a,fi,f,quick) for ai,a in enumerate(TARGETS) for fi,f in enumerate(FRACTIONS)]):
        pi0=unit[ai]['pi0'];day.append(dict(alpha=TARGETS[ai],fraction=FRACTIONS[fi],
            r3=dict(gamma=largest_gamma([v['fa'] for v in out['r3'].values()],pi0),budget=pi0,by_n=out['r3']),
            r4=dict(gamma=largest_gamma(list(out['r4'].values()),SUSPEND_BUDGET),budget=SUSPEND_BUDGET,trigger_days_by_n=out['r4']),
            r5=dict(gamma=largest_gamma(list(out['r5'].values()),SUSPEND_BUDGET),budget=SUSPEND_BUDGET,trigger_days_by_n_k=out['r5'])))
    day.sort(key=lambda x:(x['alpha'],x['fraction']))
    for x in day:print(f"a={x['alpha']} f={x['fraction']}: g3={x['r3']['gamma']} g4={x['r4']['gamma']} g5={x['r5']['gamma']}",flush=True)
    def const(a,f):
        u=next(x for x in unit if x['alpha']==a);d=next(x for x in day if x['alpha']==a and x['fraction']==f)
        return dict(h1=u['r1']['h'],h2=u['r2']['h'],g3=d['r3']['gamma'],g4=d['r4']['gamma'],g5=d['r5']['gamma'])
    # 3. stress: overdispersed null at N=35, f=10%
    stress=[]
    for ai,ri,out in ex.map(stress_task,[(ai,a,ri,rho,const(a,.10),quick) for ai,a in enumerate(TARGETS) for ri,rho in enumerate(RHOS)]):
        stress.append(dict(alpha=TARGETS[ai],rho=RHOS[ri],n=35,fraction=.10,**out))
    stress.sort(key=lambda x:(x['alpha'],x['rho']));print('stress done',round(time.monotonic()-start),'s',flush=True)
    # 4. challenger selection
    c5=const(SEL['alpha'],SEL['fraction']);sel_runs=500 if quick else SEL['runs'];agg={}
    for si,ci,res in ex.map(selection_task,[(si,ci,250,c5) for si in range(len(SCENARIOS)) for ci in range(sel_runs//250)]):
        for rule,v in res.items():
            a=agg.setdefault((si,rule),dict(harm=[],manual=[],revoked_day=[],suspended_units=[]))
            for k in a:
                if v[k] is not None:a[k]+=v[k]
    ex.shutdown()
    scen=[];rules=sorted({r for _,r in agg})
    for si,(name,arg) in enumerate(SCENARIOS):
        row=dict(name=name,parameter=arg,runs=sel_runs,rules={})
        for r in rules:
            v=agg[(si,r)];rd=[d for d in v['revoked_day'] if d>0]
            row['rules'][r]=dict(mean_harm=float(np.mean(v['harm'])),manual_share=float(np.mean(v['manual'])),revoked=len(rd)/len(v['revoked_day']),
                median_revoked_day=float(np.median(rd)) if rd else None,mean_suspended_units=float(np.mean(v['suspended_units'])) if v['suspended_units'] else None)
        scen.append(row)
    drift=[s for s in scen if s['name'] in ('persistent','shock')];nulls=[s for s in scen if s['name'].startswith('null')]
    summary={}
    for r in rules:
        if r=='r0':continue
        ratios=[s['rules'][r]['mean_harm']/s['rules']['r0']['mean_harm'] for s in drift]
        extra=[s['rules'][r]['manual_share']-s['rules']['r0']['manual_share'] for s in nulls]
        summary[r]=dict(harm_ratios=ratios,geometric_mean=float(np.exp(np.mean(np.log(ratios)))),extra_manual_share_under_nulls=extra,eligible=all(x<=.02 for x in extra))
    cands=[r for r in SIMPLER if r in summary and summary[r]['eligible']]
    best=min(cands,key=lambda r:(round(summary[r]['geometric_mean'],12),SIMPLER.index(r))) if cands else None
    chosen=best if best and summary[best]['geometric_mean']<.9 else None
    print('selection',{r:round(v['geometric_mean'],3) for r,v in summary.items()},'chosen',chosen,flush=True)
    report=dict(schema_version=1,protocol='docs/validation/parking-transfer-protocol.md#附录-7',quick=quick,
        seeds=dict(calibration=SEED_CAL,selection=SEED_SEL),settings=dict(targets=TARGETS,fractions=FRACTIONS,n_grid=NS,k_grid=KS,horizons=HORIZONS,
            gamma_grid=GAMMAS,h_step=H_STEP,mixture_multiples=MULTS,window_days=WINDOW,suspend_budget=SUSPEND_BUDGET,rhos=RHOS,run_length=RUN_LENGTH,selection=SEL),
        unit_rules=unit,day_rules=day,stress=stress,selection=dict(constants=c5,scenarios=scen,summary=summary,tie_break=SIMPLER,chosen=chosen),
        elapsed_seconds=round(time.monotonic()-start,1))
    if not quick:OUT.write_text(json.dumps(report,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n');print('wrote',OUT.relative_to(ROOT))
    else:print(json.dumps(report['selection']['summary'],indent=1))

if __name__=='__main__':main()
