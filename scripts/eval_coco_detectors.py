"""Score browser detections on COCO val2017 per docs/validation/detector-upgrade-protocol.md.
Usage: python scripts/eval_coco_detectors.py --annotations instances_val2017.json \
  --ssdlite ssdlite.json --dfine dfine.json --latency-ssdlite lat-ssdlite.json --latency-dfine lat-dfine.json --out web/data/detector/evaluation.json
"""
import argparse,contextlib,hashlib,io,json,platform
from pathlib import Path
import numpy as np
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval

RELEVANT=['person','bicycle','car','motorcycle','bus','truck','suitcase','chair','couch','bed','dining table','refrigerator']
THRESHOLDS=[round(.3+.05*i,2) for i in range(9)]
BASELINE_THRESHOLD=.5

def coco_stats(gt,dets,img_ids):
    ids=set(img_ids);sub=[d for d in dets if d['image_id'] in ids]
    with contextlib.redirect_stdout(io.StringIO()):
        dt=gt.loadRes(sub);E=COCOeval(gt,dt,'bbox');E.params.imgIds=sorted(ids);E.evaluate();E.accumulate();E.summarize()
    names=['AP','AP50','AP75','AP_small','AP_medium','AP_large','AR1','AR10','AR100','AR_small','AR_medium','AR_large']
    out={k:float(v) for k,v in zip(names,E.stats)};prec=E.eval['precision'];per={}
    for k,cid in enumerate(E.params.catIds):
        p=prec[:,:,k,0,-1];per[gt.cats[cid]['name']]=float(p[p>-1].mean()) if (p>-1).any() else None
    out['per_class_ap']=per;out['relevant_mean_ap']=float(np.mean([per[n] for n in RELEVANT]))
    return out

def iou(a,b):
    ax2,ay2,bx2,by2=a[0]+a[2],a[1]+a[3],b[0]+b[2],b[1]+b[3]
    iw=max(0.,min(ax2,bx2)-max(a[0],b[0]));ih=max(0.,min(ay2,by2)-max(a[1],b[1]));inter=iw*ih
    return inter,inter/(a[2]*a[3]+b[2]*b[3]-inter) if inter>0 else 0.

def operating_point(gt,dets,img_ids,threshold):
    """Greedy one-to-one matching at IoU 0.5 per image and class; crowd overlaps are ignored."""
    cats={c['id']:c['name'] for c in gt.loadCats(gt.getCatIds())};wanted={cid for cid,n in cats.items() if n in RELEVANT}
    by=dict();ids=set(img_ids)
    for d in dets:
        if d['image_id'] in ids and d['category_id'] in wanted and d['score']>=threshold:by.setdefault((d['image_id'],d['category_id']),[]).append(d)
    tp={c:0 for c in wanted};fp={c:0 for c in wanted};npos={c:0 for c in wanted}
    for img in ids:
        for cid in wanted:
            anns=gt.loadAnns(gt.getAnnIds(imgIds=[img],catIds=[cid]));real=[a['bbox'] for a in anns if not a['iscrowd']];crowd=[a['bbox'] for a in anns if a['iscrowd']]
            npos[cid]+=len(real);used=[False]*len(real)
            for d in sorted(by.get((img,cid),[]),key=lambda d:-d['score']):
                best,j=0.,-1
                for k,g in enumerate(real):
                    if used[k]:continue
                    o=iou(d['bbox'],g)[1]
                    if o>=.5 and o>best:best,j=o,k
                if j>=0:used[j]=True;tp[cid]+=1;continue
                area=d['bbox'][2]*d['bbox'][3]
                if area>0 and any(iou(d['bbox'],g)[0]/area>=.5 for g in crowd):continue
                fp[cid]+=1
    T,F,N=sum(tp.values()),sum(fp.values()),sum(npos.values())
    return dict(threshold=threshold,true_positive=T,false_positive=F,ground_truth=N,precision=T/(T+F) if T+F else None,recall=T/N if N else None,
        per_class={cats[c]:dict(recall=tp[c]/npos[c] if npos[c] else None,precision=tp[c]/(tp[c]+fp[c]) if tp[c]+fp[c] else None,ground_truth=npos[c],true_positive=tp[c],false_positive=fp[c]) for c in sorted(wanted)})

def dedupe(dets,threshold=.9,cap=100):
    """Mirror of web/detector-dfine.mjs: per image, greedy in score order, class-agnostic IoU >= threshold dropped."""
    by={}
    for d in dets:by.setdefault(d['image_id'],[]).append(d)
    out=[]
    for img,ds in by.items():
        kept=[]
        for d in sorted(ds,key=lambda d:-d['score']):
            if len(kept)>=cap:break
            if any(iou(k['bbox'],d['bbox'])[1]>=threshold for k in kept):continue
            kept.append(d)
        out.extend(kept)
    return out

def latency(path):
    data=json.loads(Path(path).read_text());meta=data['meta']
    return dict(images=meta['images'],backend=meta['backend'],browser=meta['browser'],detect_ms=meta['detect_ms'],total_ms=meta['total_ms'],workers=meta['workers'])

def main():
    ap=argparse.ArgumentParser();[ap.add_argument(f'--{k}',required=True) for k in ['annotations','ssdlite','dfine','latency-ssdlite','latency-dfine','out']]
    # Descriptive only: 640x480 images avoid WebGL shader recompilation for each new input size.
    [ap.add_argument(f'--{k}') for k in ['steady-ssdlite','steady-dfine']];args=ap.parse_args()
    raw=Path(args.annotations).read_bytes()
    with contextlib.redirect_stdout(io.StringIO()):gt=COCO(args.annotations)
    img_ids=sorted(gt.getImgIds());assert len(img_ids)==5000
    dev,test=img_ids[:2500],img_ids[2500:]
    runs={k:json.loads(Path(getattr(args,k)).read_text()) for k in ['ssdlite','dfine']}
    for k,r in runs.items():assert r['meta']['images']==5000 and {d['image_id'] for d in r['detections']}<=set(img_ids),k
    dets={k:r['detections'] for k,r in runs.items()}
    base_dev=operating_point(gt,dets['ssdlite'],dev,BASELINE_THRESHOLD)
    sweep=[operating_point(gt,dets['dfine'],dev,t) for t in THRESHOLDS]
    feasible=[s for s in sweep if s['precision'] is not None and s['precision']>=base_dev['precision']]
    chosen=max(feasible,key=lambda s:(s['recall'],s['threshold'])) if feasible else max(sweep,key=lambda s:(s['precision'] or 0,s['threshold']))
    report=dict(schema_version=1,protocol='docs/validation/detector-upgrade-protocol.md',dataset=dict(name='COCO val2017',annotations_sha256=hashlib.sha256(raw).hexdigest(),images=5000,dev_images=len(dev),test_images=len(test),split='image id ascending: first 2,500 dev, last 2,500 test',license='annotations CC BY 4.0; images used locally only, not redistributed'),
        relevant_classes=RELEVANT,baseline_threshold=BASELINE_THRESHOLD,
        threshold_selection=dict(rule='on dev: D-FINE pooled precision >= SSDLite@0.5 pooled precision, maximise recall; fallback highest precision',ssdlite_dev=base_dev,dfine_dev_sweep=sweep,chosen=chosen['threshold'],met_precision_constraint=bool(feasible)),
        models={})
    for k,name in [('ssdlite','SSDLite MobileNet V2 (COCO-SSD 2.2.3, fixed-nms-v1)'),('dfine','D-FINE-N (self-exported fp32 ONNX)')]:
        thr=BASELINE_THRESHOLD if k=='ssdlite' else chosen['threshold']
        report['models'][k]=dict(name=name,run=runs[k]['meta'],operating_threshold=thr,test=dict(coco=coco_stats(gt,dets[k],test),operating_point=operating_point(gt,dets[k],test,thr)),dev=dict(coco=coco_stats(gt,dets[k],dev)),all=dict(coco=coco_stats(gt,dets[k],img_ids)),
            latency=latency(getattr(args,f'latency_{k}')),steady_state_640x480=latency(getattr(args,f'steady_{k}')) if getattr(args,f'steady_{k}') else None)
        print(k,'test AP',round(report['models'][k]['test']['coco']['AP'],4),'relevant',round(report['models'][k]['test']['coco']['relevant_mean_ap'],4),'op',{x:report['models'][k]['test']['operating_point'][x] for x in ['threshold','precision','recall']},flush=True)
    # Protocol appendix 3 (after test results): the page drops near-identical duplicates. Re-score the deployed
    # post-processing on both halves and re-check the default criteria; nothing is re-selected.
    deployed=dedupe(dets['dfine']);thr=chosen['threshold']
    report['models']['dfine']['deployed_dedupe090']=dict(postprocess='dfine-topk-dedupe090-v1',removed=len(dets['dfine'])-len(deployed),
        dev=dict(coco=coco_stats(gt,deployed,dev),operating_point=operating_point(gt,deployed,dev,thr)),test=dict(coco=coco_stats(gt,deployed,test),operating_point=operating_point(gt,deployed,test,thr)))
    s,d=report['models']['ssdlite']['test'],report['models']['dfine']['test']
    criteria=dict(ap_higher=d['coco']['AP']>s['coco']['AP'],recall_not_lower=d['operating_point']['recall']>=s['operating_point']['recall'],precision_within_1pt=d['operating_point']['precision']>=s['operating_point']['precision']-.01,
        p95_latency_within_500ms=report['models']['dfine']['latency']['total_ms']['p95']<=500)
    report['default_decision']=dict(criteria=criteria,default='dfine' if all(criteria.values()) else 'ssdlite',rule='all criteria on the test half (protocol)')
    dd=report['models']['dfine']['deployed_dedupe090']['test']
    report['default_decision']['deployed_recheck']=dict(ap_higher=dd['coco']['AP']>s['coco']['AP'],recall_not_lower=dd['operating_point']['recall']>=s['operating_point']['recall'],precision_within_1pt=dd['operating_point']['precision']>=s['operating_point']['precision']-.01,p95_latency_within_500ms=criteria['p95_latency_within_500ms'])
    report.update(python=platform.python_version(),numpy=np.__version__)
    out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,ensure_ascii=False,separators=(',',':'))+'\n')
    print('chosen threshold',chosen['threshold'],'criteria',criteria,'default',report['default_decision']['default'])

if __name__=='__main__':main()
