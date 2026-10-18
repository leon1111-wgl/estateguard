"""Compare frozen audit replays; only CP lower-bound statistics have numerical tolerance.

The absolute 1e-12 allowance covers observed Linux/macOS binomial-CDF differences.
It applies only at the two CP statistic paths and cannot change statistic > alpha.
Elapsed wall time is not reproducible; its presence, type and finiteness still are.
"""
import json
import math

CP_ABS_TOL = 1e-12


def _cp_statistic_path(path):
    if len(path) not in (9, 10) or path[0] != 'cameras' or path[4] != 'runs':
        return False
    if path[6] != 'sides' or path[7] not in ('free', 'busy'):
        return False
    if path[8:] not in (('statistic',), ('revoked', 'statistic')):
        return False
    # These are the three CP replay settings in protocol appendix 5.
    return path[5] in ('0.05:cp', '0.1:cp', '0.2:cp')


def _cp_close(actual, expected, path, a, b):
    if not _cp_statistic_path(path) or type(a) is not float or type(b) is not float:
        return False
    for key in path[:8]:
        actual, expected = actual[key], expected[key]
    alpha, reference_alpha = actual.get('alpha'), expected.get('alpha')
    if type(alpha) is not float or type(reference_alpha) is not float:
        return False
    if not math.isfinite(alpha) or not 0 < alpha < .5 or alpha != reference_alpha:
        return False
    return (math.isclose(a, b, rel_tol=0, abs_tol=CP_ABS_TOL)
            and (a > alpha) == (b > alpha))


def replay_differences(actual, expected, limit=20):
    """Return bounded diagnostics, or [] when the complete replay contract matches.

    Containers are always traversed: Python's equality would otherwise equate
    booleans, integers and floats, or miss a shared NaN inside equal containers.
    """
    details = []
    counts = dict(total=0, numeric=0, non_numeric=0)
    largest = None

    def record(path, description, a=None, b=None):
        nonlocal largest
        where = 'audit replay' + ''.join(f'[{json.dumps(key, ensure_ascii=False)}]' for key in path)
        counts['total'] += 1
        if type(a) in (int, float) and type(b) in (int, float):
            counts['numeric'] += 1
            if math.isfinite(a) and math.isfinite(b):
                delta = a - b
                absolute, scale = abs(delta), max(abs(a), abs(b))
                description += f'; delta={delta!r}, abs_delta={absolute!r}, relative_delta={absolute / scale if scale else 0!r}'
                if largest is None or absolute > largest[0]:
                    largest = (absolute, where)
                if isinstance(a, float) or isinstance(b, float):
                    description += f'; fresh_hex={float(a).hex()}, published_hex={float(b).hex()}'
        else:
            counts['non_numeric'] += 1
        if len(details) < limit:
            details.append(f'{where}: {description}')

    def visit(a, b, path):
        description = f'fresh={a!r} ({type(a).__name__}), published={b!r} ({type(b).__name__})'
        if type(a) is not type(b):
            record(path, 'type differs; ' + description, a, b)
        elif type(a) is dict:
            for key in sorted(a.keys() | b.keys(), key=repr):
                child = path + (key,)
                if type(key) is not str:
                    record(child, 'JSON object key must be a string')
                elif key not in a:
                    record(child, 'missing from fresh result')
                elif key not in b:
                    record(child, 'missing from published result')
                else:
                    visit(a[key], b[key], child)
        elif type(a) is list:
            if len(a) != len(b):
                record(path, f'list length: fresh={len(a)}, published={len(b)}', len(a), len(b))
            for i, (av, bv) in enumerate(zip(a, b)):
                visit(av, bv, path + (i,))
        elif type(a) not in (str, int, float, bool, type(None)):
            record(path, 'unsupported JSON value; ' + description)
        elif type(a) is float and (not math.isfinite(a) or not math.isfinite(b)):
            record(path, 'non-finite number; ' + description, a, b)
        elif path == ('elapsed_seconds',):
            if type(a) is not float:
                record(path, 'elapsed_seconds must be a finite float; ' + description)
        elif a != b and not _cp_close(actual, expected, path, a, b):
            record(path, description, a, b)

    visit(actual, expected, ())
    if not counts['total']:
        return []
    summary = f'audit replay: differences={counts["total"]}, numeric={counts["numeric"]}, non_numeric={counts["non_numeric"]}'
    if largest is not None:
        summary += f', max_abs_delta={largest[0]!r} at {largest[1]}'
    if counts['total'] > len(details):
        details.append(f'... {counts["total"] - len(details)} further differences omitted')
    return [summary, *details]
