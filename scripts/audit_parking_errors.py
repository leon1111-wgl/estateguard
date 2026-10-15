"""Audit frozen parking predictions without training, tuning, or network access.

Default mode uses only the Python standard library. Add --recompute to verify
all public input pixels with the frozen model using existing NumPy/Pillow.
Only --output is written; the dataset, labels, thresholds, and weights stay fixed.
"""
import argparse
import collections
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import platform
import sys

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def index_unique(rows, name):
    require(isinstance(rows, list) and len(rows) > 0, f'{name}: expected nonempty list')
    result = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('id'), str) and row['id'],
                f'{name}: invalid id')
        require(row['id'] not in result, f'{name}: duplicate id {row["id"]}')
        result[row['id']] = row
    return result


def fraction(numerator, denominator):
    return numerator / denominator if denominator else None


def summarize(rows):
    matrix = [[0, 0], [0, 0]]
    for row in rows:
        matrix[row['label']][row['prediction']] += 1
    tn, fp = matrix[0]
    fn, tp = matrix[1]
    return dict(n=len(rows), free=tn + fp, occupied=fn + tp,
                false_free=fn, false_occupied=fp,
                false_free_rate=fraction(fn, fn + tp),
                false_occupied_rate=fraction(fp, fp + tn),
                confident_false_free=sum(r['label'] == 1 and r['score'] <= .35 for r in rows),
                model_uncertain=sum(.35 < r['score'] < .65 for r in rows),
                confusion_matrix=matrix)


def grouped(rows, field):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row[field]].append(row)
    return [{field: key, **summarize(part)} for key, part in sorted(groups.items())]


def quantile(values, q):
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * q
    left = math.floor(position)
    right = math.ceil(position)
    return ordered[left] + (ordered[right] - ordered[left]) * (position - left)


def audit(manifest, predictions, evaluation, model_bytes):
    """Validate the published contract before computing any diagnostic counts."""
    model_hash = hashlib.sha256(model_bytes).hexdigest()
    model = json.loads(model_bytes)
    require(manifest.get('model_sha256') == evaluation.get('model_sha256') == model_hash,
            'Model hash mismatch in manifest/evaluation')
    require(model.get('review_band') == evaluation.get('review_band') == [.35, .65],
            'Unexpected triage band; this audit describes the fixed 0.35/0.65 policy')
    samples = index_unique(manifest.get('samples'), 'manifest samples')
    indexed_predictions = index_unique(predictions, 'predictions')
    require(samples.keys() == indexed_predictions.keys(), 'Prediction IDs do not match manifest IDs')
    rows = []
    for sid, sample in samples.items():
        prediction = indexed_predictions[sid]
        require(type(sample.get('label')) is int and sample['label'] in [0, 1], f'{sid}: invalid dataset label')
        require(type(prediction.get('label')) is int and prediction['label'] == sample['label'],
                f'{sid}: prediction label disagrees with source label')
        require(prediction.get('model_sha256') == model_hash, f'{sid}: stale prediction model hash')
        score = prediction.get('score')
        require(type(score) in [int, float] and math.isfinite(score) and 0 <= score <= 1, f'{sid}: invalid score')
        require(type(prediction.get('prediction')) is int and prediction['prediction'] == int(score >= .5),
                f'{sid}: classification does not use score >= 0.5')
        require(type(prediction.get('correct')) is bool and prediction['correct'] == (int(score >= .5) == sample['label']),
                f'{sid}: incorrect correctness flag')
        require(sample.get('split') == 'test', f'{sid}: sample is not in the test split')
        require(all(isinstance(sample.get(k), str) and sample[k] for k in ['camera', 'date', 'time', 'slot']),
                f'{sid}: invalid camera/date/time/slot')
        require(sid == '-'.join(sample[k] for k in ['camera', 'date', 'time', 'slot']), f'{sid}: identity metadata mismatch')
        require(len(sample['date']) == 8 and len(sample['time']) == 4, f'{sid}: invalid wall-clock format')
        datetime.strptime(sample['date'] + sample['time'], '%Y%m%d%H%M')
        rows.append({**sample, **prediction, 'camera_slot': f"{sample['camera']}:{sample['slot']}",
                     'camera_date': f"{sample['camera']}:{sample['date']}", 'hour': sample['time'][:2],
                     'frame': '-'.join(sample[k] for k in ['camera', 'date', 'time']),
                     'window': 'before_1300' if sample['time'] < '1300' else '1300_or_later'})
    frames = index_unique(manifest.get('frames'), 'manifest frames')
    frame_sample_ids = []
    for frame in frames.values():
        require(isinstance(frame.get('sample_ids'), list) and frame['sample_ids'], f'{frame["id"]}: empty frame')
        require(frame['id'] == '-'.join(str(frame.get(k)) for k in ['camera', 'date', 'time']),
                f'{frame["id"]}: frame identity mismatch')
        for sid in frame['sample_ids']:
            require(sid in samples and all(samples[sid][k] == frame.get(k) for k in ['camera', 'date', 'time']),
                    f'{sid}: frame metadata mismatch')
        frame_sample_ids.extend(frame['sample_ids'])
    require(len(frame_sample_ids) == len(set(frame_sample_ids)) == len(samples)
            and set(frame_sample_ids) == samples.keys(), 'Frame sample IDs are missing or duplicated')

    overall = summarize(rows)
    tn, fp = overall['confusion_matrix'][0]
    fn, tp = overall['confusion_matrix'][1]
    expected = dict(n=len(rows), free=tn + fp, occupied=fn + tp, false_free=fn, false_occupied=fp,
                    accuracy=(tn + tp) / len(rows), occupied_recall=fraction(tp, tp + fn),
                    balanced_accuracy=(tn / (tn + fp) + tp / (tp + fn)) / 2 if tn + fp and tp + fn else None,
                    confusion_matrix=overall['confusion_matrix'], confusion_order=['free', 'occupied'])
    for key, value in expected.items():
        actual = evaluation.get('test', {}).get(key)
        equal = (type(actual) in [int, float] and math.isclose(actual, value, rel_tol=0, abs_tol=1e-12)) if isinstance(value, float) else actual == value
        require(equal, f'Evaluation metric mismatch: {key}')
    uncertain = [r for r in rows if .35 < r['score'] < .65]
    band_counts = summarize(uncertain)
    band_fn, band_fp = band_counts['false_free'], band_counts['false_occupied']
    for key, value in [('review_samples', len(uncertain)), ('confident_false_free', fn - band_fn),
                       ('confident_false_occupied', fp - band_fp)]:
        require(evaluation.get(key) == value, f'Evaluation triage count mismatch: {key}')
    slots = sorted(grouped(rows, 'camera_slot'), key=lambda r: (-r['false_free'], r['camera_slot']))
    concentration = []
    for n in [3, 5, 10]:
        top = slots[:n]
        count = sum(r['false_free'] for r in top)
        occupied = sum(r['occupied'] for r in top)
        concentration.append(dict(top_n=n, camera_slots=[r['camera_slot'] for r in top], false_free=count,
                                  share_of_all_false_free=fraction(count, fn), occupied=occupied,
                                  false_free_rate=fraction(count, occupied)))
    fn_scores = [r['score'] for r in rows if r['label'] == 1 and r['prediction'] == 0]
    return dict(
        schema_version=1, model_sha256=model_hash,
        purpose='冻结基线的事后错误审计；不重新训练、选择模型、修改标签或调整阈值',
        dataset=manifest.get('dataset'),
        thresholds=dict(binary_occupied='score >= 0.5', triage_free='score <= 0.35',
                        triage_uncertain='0.35 < score < 0.65', triage_busy='score >= 0.65'),
        overall=overall, by_camera_date=grouped(rows, 'camera_date'), by_hour=grouped(rows, 'hour'),
        by_camera_slot=slots, by_frame=grouped(rows, 'frame'), by_time_window=grouped(rows, 'window'),
        by_slot_time_window=[dict(camera_slot=slot, windows=grouped([r for r in rows if r['camera_slot'] == slot], 'window'))
                             for slot in sorted({r['camera_slot'] for r in rows})],
        concentration=concentration,
        uncertain_band=dict(n=len(uncertain), correct=len(uncertain) - band_fn - band_fp,
                            false_free=band_fn, false_occupied=band_fp, covered_errors=band_fn + band_fp,
                            total_errors=fn + fp, errors_outside_band=fn + fp - band_fn - band_fp,
                            false_free_outside_band=fn - band_fn, false_occupied_outside_band=fp - band_fp,
                            fraction_of_all_errors_covered=fraction(band_fn + band_fp, fn + fp)),
        false_free_score_quantiles={str(q): quantile(fn_scores, q) for q in [0, .1, .25, .5, .75, .9, .95, 1]},
        false_free_score_cumulative=[dict(score_lte=t, n=sum(score <= t for score in fn_scores),
                                        share=fraction(sum(score <= t for score in fn_scores), fn))
                                     for t in [.01, .05, .1, .2, .35]],
        errors=[{k: r[k] for k in ['id', 'camera', 'date', 'time', 'slot', 'label', 'score', 'prediction']}
                for r in rows if not r['correct']],
        limitations=[
            '摄像头 B 仅包含 2015-07-08，无法据此评估 B 的跨日期泛化能力。',
            '统计单位为重复快照中的车位裁剪图，不能视为独立车辆或连续停留观测。',
            '各小时和车位的占用漏判率以原始占用标签数为分母；错误集中本身不能证明成因。',
            '公开 B 结果已被用于错误分析。后续若基于这些结果开发模型，不能再声称 B 完全未见。',
            '本次审计不选择或修改模型，原有冻结基线保持不变。',
        ])


def recompute(samples, predictions, model_bytes, data_root):
    """Recompute all input patches; if source JPEGs are provided, verify preprocessing too."""
    try:
        import numpy as np
        import PIL
        from PIL import Image
    except ImportError as error:
        raise ValueError('--recompute needs the existing NumPy/Pillow training dependencies') from error
    sys.path.insert(0, str(ROOT / 'scripts'))
    from parking_learning import features, predict
    model = json.loads(model_bytes)
    expected = index_unique(predictions, 'recompute predictions')
    vectors, scores = [], []
    source_verified = 0
    for sample in samples:
        path = (data_root / sample['input']).resolve()
        require(path.is_relative_to(data_root.resolve()), 'Input path is outside the public data directory')
        with Image.open(path) as image:
            small = np.asarray(image.convert('RGB'))
        require(small.shape == (32, 32, 3), f'{sample["id"]}: wrong input dimensions')
        if 'image' in sample:
            original = (data_root / sample['image']).resolve()
            require(original.is_relative_to(data_root.resolve()), 'Original path is outside the public data directory')
            require(hashlib.sha256(original.read_bytes()).hexdigest() == sample['source_sha256'],
                    f'{sample["id"]}: source JPEG hash mismatch')
            with Image.open(original) as image:
                rgb = np.asarray(image.convert('RGB'))
            require(hashlib.sha256(rgb.tobytes()).hexdigest() == sample['sha256'], f'{sample["id"]}: decoded RGB hash mismatch')
            h, w = rgb.shape[:2]
            yi = np.floor((np.arange(32) + .5) * h / 32).astype(int)
            xi = np.floor((np.arange(32) + .5) * w / 32).astype(int)
            require(np.array_equal(small, rgb[yi[:, None], xi[None, :], :]), f'{sample["id"]}: source/input pixels differ')
            source_verified += 1
        vectors.append(features(small))
        scores.append(expected[sample['id']]['score'])
    actual = predict(np.asarray(vectors), model)
    expected_scores = np.asarray(scores)
    delta = np.abs(actual - expected_scores)
    maximum = float(delta.max())
    require(math.isfinite(maximum) and maximum <= 1e-10, f'Frozen prediction mismatch: max absolute error {maximum}')
    binary_changes = int(np.sum((actual >= .5) != (expected_scores >= .5)))
    band_changes = int(np.sum((actual <= .35) != (expected_scores <= .35)) + np.sum((actual >= .65) != (expected_scores >= .65)))
    require(binary_changes == band_changes == 0, 'Frozen inference changes a classification or triage band')
    return dict(executed=True, n=len(samples), maximum_absolute_score_difference=maximum,
                tolerance=1e-10, classification_differences=binary_changes, triage_band_differences=band_changes,
                source_and_input_pixel_matches=source_verified, python=platform.python_version(),
                numpy=np.__version__, pillow=PIL.__version__)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recompute', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/validation/parking-error-audit.json')
    args = parser.parse_args()
    data = ROOT / 'web/data/parking'
    model_path = ROOT / 'web/models/parking-occupancy/model.json'
    model_bytes = model_path.read_bytes()
    manifest = json.loads((data / 'manifest.json').read_text())
    predictions = json.loads((data / 'test-predictions.json').read_text())
    evaluation = json.loads((data / 'evaluation.json').read_text())
    report = audit(manifest, predictions, evaluation, model_bytes)
    report['recomputation'] = recompute(manifest['samples'], predictions, model_bytes, data) if args.recompute else {'executed': False}
    inputs = [model_path, data / 'manifest.json', data / 'test-predictions.json', data / 'evaluation.json',
              ROOT / 'scripts/parking_learning.py', Path(__file__).resolve()]
    report['input_sha256'] = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    require(model_path.read_bytes() == model_bytes, 'Model changed during the audit')
    output = args.output.resolve()
    require(not output.is_relative_to((ROOT / 'web').resolve()), 'Audit output must not overwrite public assets')
    require(output not in inputs, 'Audit output must not overwrite its inputs')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    print(f"PASS: {report['overall']['n']} frozen predictions; "
          f"{report['overall']['false_free']} false-free, {report['overall']['false_occupied']} false-occupied; "
          f"uncertain band covers {report['uncertain_band']['covered_errors']}/{report['uncertain_band']['total_errors']} errors.")
    if args.recompute:
        print(f"Full image recomputation: max score difference {report['recomputation']['maximum_absolute_score_difference']}; "
              f"{report['recomputation']['source_and_input_pixel_matches']} source/input pairs verified.")
    print(f'Wrote {output}')


if __name__ == '__main__':
    main()
