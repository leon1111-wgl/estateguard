"""Calibration, risk-controlled routing and few-shot head adaptation for frozen embeddings.
Mirrors web/parking-transfer.mjs; both must stay numerically aligned (see tests).
"""
import math
import numpy as np

FREE_GRID=[.005,.01,.02,.03,.05,.075,.1,.15,.2,.25,.3,.35,.4,.45,.5]
ALPHA_FREE,ALPHA_BUSY,DELTA=.01,.02,.05
ADAPT=dict(lam=.01,lr=.01,steps=150)


def logit(w,b,z): return np.asarray(z)@np.asarray(w)+b


def sigmoid(z): return 1/(1+np.exp(-np.clip(z,-40,40)))


def bce(z,y):
    z=np.asarray(z,dtype=np.float64);y=np.asarray(y,dtype=np.float64)
    return float(np.mean(np.logaddexp(0,z)-y*z))


def fit_temperature(z,y):
    """Single temperature on validation logits; golden-section search on log T."""
    lo,hi=math.log(.05),math.log(20.);g=(math.sqrt(5)-1)/2
    f=lambda t:bce(np.asarray(z)/math.exp(t),y)
    a,b=hi-g*(hi-lo),lo+g*(hi-lo)
    for _ in range(80):
        if f(a)<f(b):hi=b
        else:lo=a
        a,b=hi-g*(hi-lo),lo+g*(hi-lo)
    return math.exp((lo+hi)/2)


def binom_cdf(x,n,p):
    if p<=0:return 1.
    if p>=1:return 1. if x>=n else 0.
    return min(1.,sum(math.exp(math.lgamma(n+1)-math.lgamma(k+1)-math.lgamma(n-k+1)+k*math.log(p)+(n-k)*math.log1p(-p)) for k in range(x+1)))


def cp_upper(x,n,level):
    """One-sided Clopper-Pearson upper bound: smallest u with P(Bin(n,u)<=x)<=level."""
    if n==0:return 1.
    if x>=n:return 1.
    lo,hi=x/n,1.
    for _ in range(100):
        mid=(lo+hi)/2
        if binom_cdf(x,n,mid)>level:lo=mid
        else:hi=mid
    return hi


def _count(accepted,wrong,units):
    """Accepted and erroneous counts; with units, each unit counts once and is wrong if any sample is."""
    if units is None:return int(accepted.sum()),int((accepted&wrong).sum())
    return len(set(units[accepted].tolist())),len(set(units[accepted&wrong].tolist()))


def select_routing(p,y,alpha_free=ALPHA_FREE,alpha_busy=ALPHA_BUSY,delta=DELTA,grid=FREE_GRID,units=None):
    """Learn-then-Test with Bonferroni over both sides; returns the largest certified coverage.
    units (e.g. camera|slot|date) stops repeated snapshots of one slot from counting as independent evidence."""
    p=np.asarray(p);y=np.asarray(y).astype(int);level=delta/(2*len(grid));tests=[];units=None if units is None else np.asarray(units)
    best_free=best_busy=None
    for t in grid:
        free=p<=t;n,x=_count(free,y==1,units);ub=cp_upper(x,n,level)
        tests.append(dict(side='free',threshold=t,accepted=n,errors=x,upper_bound=ub,passed=ub<=alpha_free))
        if ub<=alpha_free and (best_free is None or n>best_free[1]):best_free=(t,n)
        tb=round(1-t,6);busy=p>=tb;n,x=_count(busy,y==0,units);ub=cp_upper(x,n,level)
        tests.append(dict(side='busy',threshold=tb,accepted=n,errors=x,upper_bound=ub,passed=ub<=alpha_busy))
        if ub<=alpha_busy and (best_busy is None or n>best_busy[1]):best_busy=(tb,n)
    return dict(t_free=best_free[0] if best_free else None,t_busy=best_busy[0] if best_busy else None,alpha_free=alpha_free,alpha_busy=alpha_busy,delta=delta,per_test_level=level,calibration_n=int(len(y)),unit='sample' if units is None else 'camera-slot-date',calibration_units=int(len(y)) if units is None else len(set(units.tolist())),tests=tests)


def route(p,routing):
    p=np.asarray(p);out=np.full(len(p),'review',dtype=object)
    if routing['t_free'] is not None:out[p<=routing['t_free']]='free'
    if routing['t_busy'] is not None:out[p>=routing['t_busy']]='busy'
    return out


def routing_report(p,y,routing,units=None):
    r=route(p,routing);y=np.asarray(y).astype(int);n=len(y);level=.05
    free=r=='free';busy=r=='busy';ff=int((y[free]==1).sum());fb=int((y[busy]==0).sum())
    extra={}
    if units is not None:
        units=np.asarray(units);nf,xf=_count(free,y==1,units);nb,xb=_count(busy,y==0,units)
        extra=dict(auto_free_units=nf,auto_free_units_with_error=xf,auto_free_unit_error_rate=xf/nf if nf else None,auto_busy_units=nb,auto_busy_units_with_error=xb,auto_busy_unit_error_rate=xb/nb if nb else None)
    return dict(**extra,n=n,auto_free=int(free.sum()),auto_busy=int(busy.sum()),review=int((r=='review').sum()),coverage=float((free.sum()+busy.sum())/n) if n else 0.,
        auto_free_errors=ff,auto_free_error_rate=ff/int(free.sum()) if free.sum() else None,auto_free_error_upper95=cp_upper(ff,int(free.sum()),level) if free.sum() else None,
        auto_busy_errors=fb,auto_busy_error_rate=fb/int(busy.sum()) if busy.sum() else None,auto_busy_error_upper95=cp_upper(fb,int(busy.sum()),level) if busy.sum() else None,
        target_free=routing['alpha_free'],target_busy=routing['alpha_busy'])


def ece(p,y,bins=15):
    p=np.asarray(p);y=np.asarray(y);conf=np.maximum(p,1-p);pred=(p>=.5).astype(int);total=0.
    edges=np.linspace(.5,1,bins+1)
    for i in range(bins):
        m=(conf>edges[i])&(conf<=edges[i+1]) if i else (conf>=edges[i])&(conf<=edges[i+1])
        if m.any():total+=m.sum()/len(p)*abs(float(np.mean(pred[m]==y[m]))-float(conf[m].mean()))
    return float(total)


def adapt(x,y,w0,b0,lam=ADAPT['lam'],lr=ADAPT['lr'],steps=ADAPT['steps']):
    """L2-SP head adaptation: mean BCE + lam*||w-w0||^2, full-batch Adam from the source head."""
    x=np.asarray(x,dtype=np.float64);y=np.asarray(y,dtype=np.float64);w0=np.asarray(w0,dtype=np.float64)
    w=w0.copy();b=float(b0);mw=np.zeros_like(w);vw=np.zeros_like(w);mb=vb=0.
    for step in range(1,steps+1):
        err=(sigmoid(x@w+b)-y)/len(y)
        gw=x.T@err+2*lam*(w-w0);gb=float(err.sum())
        mw=.9*mw+.1*gw;vw=.999*vw+.001*gw*gw;mb=.9*mb+.1*gb;vb=.999*vb+.001*gb*gb
        w-=lr*(mw/(1-.9**step))/(np.sqrt(vw/(1-.999**step))+1e-8);b-=lr*(mb/(1-.9**step))/(math.sqrt(vb/(1-.999**step))+1e-8)
    return w,b


def chronological_roles(frames):
    """frames: sorted unique frame keys. First 20% pool, next 10% gap, last 70% evaluation."""
    n=len(frames);pool=set(frames[:int(n*.2)]);gap=set(frames[int(n*.2):int(n*.3)])
    return {f:'pool' if f in pool else 'gap' if f in gap else 'eval' for f in frames}
