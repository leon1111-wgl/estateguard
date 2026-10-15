"""Small, inspectable occupancy classifier. No test labels enter training."""
import numpy as np


def features(rgb):
    a=np.asarray(rgb,dtype=np.float64)/255
    if a.shape!=(32,32,3): raise ValueError('Expected a 32 x 32 RGB patch')
    gray=a @ np.array([.299,.587,.114])
    gx=np.zeros((32,32));gy=gx.copy()
    gx[:,1:-1]=(gray[:,2:]-gray[:,:-2])/2
    gy[1:-1]=(gray[2:]-gray[:-2])/2
    mag=np.hypot(gx,gy); bins=np.minimum(8,np.floor((np.arctan2(gy,gx)%np.pi)*9/np.pi).astype(int))
    result=[]
    for y in range(0,32,8):
        for x in range(0,32,8):
            cell=a[y:y+8,x:x+8].reshape(-1,3)
            hist=np.bincount(bins[y:y+8,x:x+8].ravel(),weights=mag[y:y+8,x:x+8].ravel(),minlength=9)
            hist/=np.sqrt(np.sum(hist*hist)+1e-6)
            result.extend([*cell.mean(0),*cell.std(0),*hist])
    return np.array(result)


def split_records(records):
    # Camera B is held out before looking at labels. A's last 20% frames validate;
    # a 10% block between train and validation is unused to reduce temporal overlap.
    frames=sorted({(r['date'],r['time']) for r in records if r['camera']=='A'})
    if len(frames)<10: raise ValueError('Not enough source frames')
    train=set(frames[:int(len(frames)*.7)]);val=set(frames[int(len(frames)*.8):])
    out={k:[] for k in ['train','validation','test','gap','duplicate_excluded']}
    seen={}
    ordered=sorted(records,key=lambda r:(r['camera'],r['date'],r['time'],str(r['slot'])))
    for r in ordered:
        key=(r['date'],r['time'])
        split='test' if r['camera']=='B' else 'train' if key in train else 'validation' if key in val else 'gap'
        # Exact duplicates across partitions cannot inflate holdout performance.
        previous=seen.get(r['sha256'])
        if previous is not None and previous!=split:
            out['duplicate_excluded'].append({**r,'intended_split':split});continue
        seen[r['sha256']]=split;out[split].append(r)
    return out


def sigmoid(z): return 1/(1+np.exp(-np.clip(z,-40,40)))


def predict(x,model):
    z=(np.asarray(x)-np.asarray(model['mean']))/np.asarray(model['scale'])
    if model['hidden']:
        z=np.tanh(z @ np.array(model['w1'])+np.array(model['b1']))
    return sigmoid(z @ np.array(model['w2'])+model['b2'])


def metrics(y,p):
    y=np.asarray(y,dtype=int);pred=np.asarray(p)>=.5
    tn=int(np.sum((y==0)&~pred));fp=int(np.sum((y==0)&pred));fn=int(np.sum((y==1)&~pred));tp=int(np.sum((y==1)&pred))
    recall=tp/(tp+fn) if tp+fn else None;specificity=tn/(tn+fp) if tn+fp else None
    return dict(n=len(y),free=int(np.sum(y==0)),occupied=int(np.sum(y==1)),accuracy=float(np.mean(pred==y)),balanced_accuracy=(recall+specificity)/2 if recall is not None and specificity is not None else None,occupied_recall=recall,false_free=fn,false_occupied=fp,confusion_matrix=[[tn,fp],[fn,tp]],confusion_order=['free','occupied'])


def fit(x,y,xv,yv,seed=20261015,epochs=40,hidden=32):
    x=np.asarray(x);y=np.asarray(y);xv=np.asarray(xv);yv=np.asarray(yv)
    rng=np.random.default_rng(seed);mean=x.mean(0);scale=np.maximum(x.std(0),.05);x=(x-mean)/scale;xv=(xv-mean)/scale
    d=x.shape[1];params={}
    if hidden:
        params['w1']=rng.normal(0,np.sqrt(1/d),(d,hidden));params['b1']=np.zeros(hidden)
    params['w2']=rng.normal(0,np.sqrt(1/(hidden or d)),hidden or d);params['b2']=np.array(0.)
    m={k:np.zeros_like(v) for k,v in params.items()};v={k:np.zeros_like(w) for k,w in params.items()}
    best_loss=float('inf');best=None;history=[];step=0
    def forward(a):
        h=np.tanh(a@params['w1']+params['b1']) if hidden else a
        return h,sigmoid(h@params['w2']+params['b2'])
    def loss(a,b):return float(np.mean(np.logaddexp(0,a)-b*a))
    for epoch in range(1,epochs+1):
        for ids in np.array_split(rng.permutation(len(x)),max(1,int(np.ceil(len(x)/128)))):
            h,p=forward(x[ids]);err=(p-y[ids])/len(ids)
            grads={'w2':h.T@err+1e-4*params['w2'],'b2':np.sum(err)}
            if hidden:
                dz=err[:,None]*params['w2'][None,:]*(1-h*h)
                grads.update(w1=x[ids].T@dz+1e-4*params['w1'],b1=dz.sum(0))
            step+=1
            for key in params:
                m[key]=.9*m[key]+.1*grads[key];v[key]=.999*v[key]+.001*grads[key]**2
                params[key]-=.003*(m[key]/(1-.9**step))/(np.sqrt(v[key]/(1-.999**step))+1e-8)
        ht,pt=forward(x);hv,pv=forward(xv)
        tl=loss(ht@params['w2']+params['b2'],y);vl=loss(hv@params['w2']+params['b2'],yv)
        history.append(dict(epoch=epoch,train_loss=tl,validation_loss=vl,validation_balanced_accuracy=metrics(yv,pv)['balanced_accuracy']))
        if vl<best_loss:
            best_loss=vl;best={k:w.copy() for k,w in params.items()};selected=epoch
    model=dict(format='estateguard-parking-mlp',version=1,feature_version='rgb-hog-32-v1',input_size=32,features=d,hidden=hidden,mean=mean.tolist(),scale=scale.tolist(),selected_epoch=selected,**{k:w.tolist() for k,w in best.items()})
    return model,history
