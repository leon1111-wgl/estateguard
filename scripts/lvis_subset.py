"""Actions only. Build the LVIS v1 val subset of docs/validation/open-vocab-protocol.md for one half.

Downloads lvis_v1_val.json.zip (annotations CC BY 4.0) and, for the overlap check, the COCO 2017 annotation zip
(image ids only), hashes both, and writes:
  <out>/subset-<split>.json   image list + this split's labels for the 11 classes (stays with the run)
  <out>/subset-<split>-summary.json   counts, category records, overlap check (no boxes)
Usage: python3 scripts/lvis_subset.py --split dev|test --out artifacts/open-vocab
"""
import argparse, hashlib, io, json, os, urllib.request, zipfile

LVIS_URL = 'https://dl.fbaipublicfiles.com/LVIS/lvis_v1_val.json.zip'
COCO_URL = 'http://images.cocodataset.org/annotations/annotations_trainval2017.zip'
CLASSES = ['cart', 'handcart', 'shopping_cart', 'box', 'carton', 'crate', 'trash_can', 'barrel', 'ladder',
           'fire_extinguisher', 'cone']
SALT = 'estateguard-ovd-2026-11-10:'
PER_CLASS = 40


def key(image_id):
    return hashlib.sha256(f'{SALT}{image_id}'.encode()).hexdigest()


def split_of(image_id):
    return 'dev' if key(image_id)[0] in '01234567' else 'test'


def fetch(url):
    with urllib.request.urlopen(url, timeout=600) as r:
        data = r.read()
    return data, hashlib.sha256(data).hexdigest()


def select(images, pos, neg, split):
    """Per class: first 40 positive and first 40 negative images of this split by key. Returns ids, per-class picks."""
    picked, per_class = set(), {}
    for name, cid in CLASSES_IDS.items():
        p = sorted((i for i in pos.get(cid, ()) if split_of(i) == split), key=key)[:PER_CLASS]
        n = sorted((i for i in neg.get(cid, ()) if split_of(i) == split), key=key)[:PER_CLASS]
        per_class[name] = {'positive_images': len(p), 'negative_images': len(n)}
        picked.update(p)
        picked.update(n)
    return sorted(picked, key=key), per_class


def main():
    global CLASSES_IDS
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', choices=['dev', 'test'], required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    raw, lvis_sha = fetch(LVIS_URL)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        lvis = json.loads(z.read('lvis_v1_val.json'))
    del raw
    by_name = {c['name']: c for c in lvis['categories']}
    missing = [n for n in CLASSES if n not in by_name]
    if missing:
        raise SystemExit(f'LVIS v1 category names missing: {missing}')
    CLASSES_IDS = {n: by_name[n]['id'] for n in CLASSES}
    ours = set(CLASSES_IDS.values())
    name_of = {v: k for k, v in CLASSES_IDS.items()}

    images = {im['id']: im for im in lvis['images']}
    pos, neg, gt = {}, {}, {}
    for a in lvis['annotations']:
        if a['category_id'] in ours:
            pos.setdefault(a['category_id'], set()).add(a['image_id'])
            gt.setdefault(a['image_id'], {}).setdefault(name_of[a['category_id']], []).append(a['bbox'])
    for im in images.values():
        for cid in im.get('neg_category_ids', []):
            if cid in ours:
                neg.setdefault(cid, set()).add(im['id'])
    ids, per_class = select(images, pos, neg, args.split)

    raw, coco_sha = fetch(COCO_URL)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        val2017 = sorted(im['id'] for im in json.loads(z.read('annotations/instances_val2017.json'))['images'])
    del raw
    if len(val2017) != 5000:
        raise SystemExit(f'expected 5000 COCO val2017 images, found {len(val2017)}')
    coco_dev, coco_test = set(val2017[:2500]), set(val2017[2500:])

    records, overlap = [], {'train2017': 0, 'val2017_detector_dev_half': 0, 'val2017_detector_test_half': 0}
    for i in ids:
        im = images[i]
        folder = im['coco_url'].rstrip('/').split('/')[-2]
        if folder == 'train2017':
            overlap['train2017'] += 1
        elif i in coco_dev:
            overlap['val2017_detector_dev_half'] += 1
        elif i in coco_test:
            overlap['val2017_detector_test_half'] += 1
        else:
            raise SystemExit(f'image {i} from {folder} is in neither COCO half')
        records.append({
            'id': i, 'coco_url': im['coco_url'], 'width': im['width'], 'height': im['height'],
            'gt': gt.get(i, {}),
            'neg': [name_of[c] for c in im.get('neg_category_ids', []) if c in ours],
            'not_exhaustive': [name_of[c] for c in im.get('not_exhaustive_category_ids', []) if c in ours],
        })
    categories = {n: {k: by_name[n].get(k) for k in ('id', 'frequency', 'def', 'synonyms', 'image_count',
                                                       'instance_count')} for n in CLASSES}
    summary = {
        'split': args.split, 'salt': SALT, 'per_class_cap': PER_CLASS,
        'sources': {'lvis_v1_val': {'url': LVIS_URL, 'sha256': lvis_sha},
                    'coco_annotations_trainval2017': {'url': COCO_URL, 'sha256': coco_sha, 'used_for': 'val2017 ids only'}},
        'images': len(records), 'per_class_selection': per_class, 'overlap': overlap, 'categories': categories,
        'verified_per_class': {n: {'positive_images': sum(1 for r in records if n in r['gt']),
                                   'negative_images': sum(1 for r in records if n in r['neg']),
                                   'instances': sum(len(r['gt'].get(n, [])) for r in records)} for n in CLASSES},
    }
    with open(os.path.join(args.out, f'subset-{args.split}.json'), 'w') as f:
        json.dump({'split': args.split, 'images': records}, f)
    with open(os.path.join(args.out, f'subset-{args.split}-summary.json'), 'w') as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    print(json.dumps({k: summary[k] for k in ('split', 'images', 'overlap')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
