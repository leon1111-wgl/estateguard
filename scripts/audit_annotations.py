"""Audit annotation intervals, video-level split leakage and disagreements.

Usage: python3 scripts/audit_annotations.py data/annotations-example.json
Exit 0: clean; 1: findings to review; 2: invalid file / input shape.
Overlapping labels are review candidates, not automatically corrected truth.
"""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path

LABELS={'bulky_load','door_obstruction','lift_impact','illegal_parking','blocked_access','wrong_way','waste_dumping','waste_overflow','normal'}

def audit(rows):
    if not isinstance(rows,list) or len(rows)>10000:
        raise ValueError('Expected an array of at most 10,000 annotation rows.')
    issues=[];valid=[];seen={};splits=defaultdict(set)
    for index,r in enumerate(rows):
        try:
            if not isinstance(r,dict):raise ValueError('Row must be an object')
            for key in ('video_id','track','annotator'):
                if not isinstance(r.get(key),str) or not r[key].strip():raise ValueError(f'Missing {key}')
            if r.get('label') not in LABELS:raise ValueError('Unknown label')
            if r.get('split') not in ('train','validation','test'):raise ValueError('Unknown split')
            for key in ('start_s','end_s'):
                if type(r.get(key)) not in (int,float) or not math.isfinite(r[key]) or r[key]<0:raise ValueError(f'Invalid {key}')
            if r['end_s']<=r['start_s']:raise ValueError('end_s must be after start_s')
        except ValueError as error:
            issues.append(dict(code='invalid_row',rows=[index],detail=str(error)));continue
        identity=tuple(r[k] for k in ('video_id','track','start_s','end_s','label','annotator','split'))
        if identity in seen:issues.append(dict(code='duplicate',rows=[seen[identity],index],detail='Exact duplicate annotation.'))
        else:seen[identity]=index
        splits[r['video_id']].add(r['split']);valid.append((index,r))
    for video,parts in sorted(splits.items()):
        if len(parts)>1:issues.append(dict(code='split_leakage',video_id=video,detail='The same source video appears in multiple splits: '+', '.join(sorted(parts))))
    groups=defaultdict(list)
    for i,r in valid:groups[(r['video_id'],r['track'])].append((i,r))
    for records in groups.values():
        records.sort(key=lambda pair:pair[1]['start_s'])
        for pos,(i,a) in enumerate(records):
            for j,b in records[pos+1:]:
                if b['start_s']>=a['end_s']:break
                overlap=min(a['end_s'],b['end_s'])-max(a['start_s'],b['start_s'])
                union=max(a['end_s'],b['end_s'])-min(a['start_s'],b['start_s'])
                if a['annotator']!=b['annotator'] and a['label']!=b['label'] and overlap/union>=.5:
                    issues.append(dict(code='label_disagreement',rows=[i,j],detail='Different annotators assign different labels at temporal IoU >= 0.5. Review multilabel intent; do not auto-correct.'))
    return dict(rows=len(rows),valid_rows=len(valid),issues=issues,scope='Integrity and disagreement candidates; not a measure of annotation accuracy. Row indices are zero-based.')

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('input',type=Path);args=parser.parse_args()
    try:
        if args.input.stat().st_size>5*1024*1024:raise ValueError('File exceeds 5 MB')
        report=audit(json.loads(args.input.read_text()))
    except (OSError,ValueError,TypeError) as error:
        print(json.dumps({'error':str(error)}));return 2
    print(json.dumps(report,indent=2));return 1 if report['issues'] else 0
if __name__=='__main__':raise SystemExit(main())
