"""Portable replay comparison must not hide changed audit decisions or data contracts."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('replay_comparison', ROOT / 'scripts/replay_comparison.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def at(report, path):
    for key in path:
        report = report[key]
    return report


CP_SIDE = ('cameras', 'C5', 'mobilenet', '0.05', 'runs', '0.2:cp', 'sides', 'free')


class ReplayComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.published = json.loads((ROOT / 'web/data/parking-transfer/audit-replay.json').read_text())

    def setUp(self):
        self.fresh = copy.deepcopy(self.published)

    def differences(self):
        return comparison.replay_differences(self.fresh, self.published)

    def test_linux_ci_cp_values_are_accepted_without_changing_the_published_report(self):
        # Actual Linux/glibc vs macOS pairs from failed CI 39095950159 (2026-10-18).
        cases = [
            (CP_SIDE + ('statistic',), 0.016390225285976546, 0.016390225285182074),
            (('cameras', 'C4', 'mobilenet', '0.05', 'runs', '0.1:cp', 'sides', 'free', 'revoked', 'statistic'), 0.05342464178181901, 0.0534246417812359),
            (('cameras', 'C7', 'dinov2', '0.05', 'runs', '0.1:cp', 'sides', 'free', 'statistic'), 0.049620007805078546, 0.04962000780527058),
        ]
        for path, linux, macos in cases:
            self.assertEqual(at(self.published, path), macos)
            at(self.fresh, path[:-1])[path[-1]] = linux
        before = copy.deepcopy(self.fresh)
        self.assertEqual(self.differences(), [])
        self.assertEqual(self.fresh, before, 'comparison must not round or rewrite values')

    def test_only_elapsed_seconds_can_vary_outside_cp_statistics(self):
        self.fresh['elapsed_seconds'] += 123.0
        self.assertEqual(self.differences(), [])
        self.fresh['summary'][0]['manual_share'] = math.nextafter(self.fresh['summary'][0]['manual_share'], 1)
        self.assertTrue(self.differences())

    def test_sprt_and_other_fields_named_statistic_remain_exact(self):
        for path in [CP_SIDE[:5] + ('0.2:sprt',) + CP_SIDE[6:] + ('statistic',), ('audit', 'limit_sprt')]:
            with self.subTest(path=path):
                self.fresh = copy.deepcopy(self.published)
                value = at(self.fresh, path)
                at(self.fresh, path[:-1])[path[-1]] = math.nextafter(value, math.inf)
                self.assertTrue(self.differences())

    def test_cp_tolerance_is_absolute_and_rejects_values_above_one_e_minus_twelve(self):
        side = at(self.fresh, CP_SIDE)
        side['statistic'] += 1.01e-12
        self.assertTrue(self.differences())

    def test_cp_alpha_crossing_is_rejected_even_within_tolerance(self):
        for suffix in [(), ('revoked',)]:
            for a, b in [(.05, math.nextafter(.05, math.inf)), (math.nextafter(.05, math.inf), .05)]:
                with self.subTest(suffix=suffix, fresh=a, published=b):
                    fresh = copy.deepcopy(self.published)
                    expected = copy.deepcopy(self.published)
                    if suffix:
                        at(fresh, CP_SIDE)['revoked'] = {'statistic': a, 'day': 1}
                        at(expected, CP_SIDE)['revoked'] = {'statistic': b, 'day': 1}
                    else:
                        at(fresh, CP_SIDE)['statistic'] = a
                        at(expected, CP_SIDE)['statistic'] = b
                    self.assertTrue(comparison.replay_differences(fresh, expected))

    def test_counts_thresholds_alpha_dates_and_revocation_location_remain_exact(self):
        revoked = ('cameras', 'C4', 'mobilenet', '0.05', 'runs', '0.1:cp', 'sides', 'free', 'revoked')
        changes = [(CP_SIDE + ('checked_units',), 153), (CP_SIDE + ('threshold',), math.nextafter(.02, 1)),
                   (CP_SIDE + ('alpha',), math.nextafter(.05, 1)), (revoked + ('day',), 999),
                   (revoked + ('date',), '20160101'), (revoked + ('time',), '0000'),
                   (revoked + ('unit',), 'C4|tampered|20160101'), (revoked, None)]
        for path, value in changes:
            with self.subTest(path=path):
                self.fresh = copy.deepcopy(self.published)
                self.assertNotEqual(at(self.fresh, path), value)
                at(self.fresh, path[:-1])[path[-1]] = value
                self.assertTrue(self.differences())

    def test_keys_array_lengths_and_array_order_remain_exact(self):
        for mutation in ['missing_root', 'extra_root', 'missing_side', 'extra_side', 'short_array', 'reordered_array']:
            with self.subTest(mutation=mutation):
                self.fresh = copy.deepcopy(self.published)
                if mutation == 'missing_root': del self.fresh['schema_version']
                elif mutation == 'extra_root': self.fresh['unexpected'] = 1
                elif mutation == 'missing_side': del at(self.fresh, CP_SIDE)['checked_units']
                elif mutation == 'extra_side': at(self.fresh, CP_SIDE)['unexpected'] = 1
                elif mutation == 'short_array': self.fresh['reproduced'].pop()
                elif mutation == 'reordered_array': self.fresh['reproduced'].reverse()
                self.assertTrue(self.differences())

    def test_equal_valued_bool_int_and_float_type_drift_is_rejected(self):
        changes = [(('schema_version',), True), (('schema_version',), 1.0),
                   (CP_SIDE + ('checked_units',), 152.0), (('elapsed_seconds',), '1.0')]
        for path, value in changes:
            with self.subTest(path=path, value=value):
                self.fresh = copy.deepcopy(self.published)
                at(self.fresh, path[:-1])[path[-1]] = value
                self.assertTrue(self.differences())
        for value in [0, False]:
            fresh = copy.deepcopy(self.published); expected = copy.deepcopy(self.published)
            at(fresh, CP_SIDE)['statistic'] = value; at(expected, CP_SIDE)['statistic'] = 0.0
            self.assertTrue(comparison.replay_differences(fresh, expected))

    def test_nonfinite_values_are_rejected_even_when_both_inputs_match(self):
        for path in [CP_SIDE + ('statistic',), ('elapsed_seconds',), ('audit', 'limit_sprt')]:
            for value in [float('nan'), float('inf'), -float('inf')]:
                with self.subTest(path=path, value=value):
                    fresh = copy.deepcopy(self.published); expected = copy.deepcopy(self.published)
                    at(fresh, path[:-1])[path[-1]] = value; at(expected, path[:-1])[path[-1]] = value
                    self.assertTrue(comparison.replay_differences(fresh, expected))

    def test_diagnostics_retain_paths_values_and_all_top_level_mismatches(self):
        at(self.fresh, CP_SIDE)['checked_units'] += 1
        self.fresh['summary'][0]['n'] += 1
        self.fresh['schema_version'] = 2
        message = '\n'.join(self.differences())
        for field in ['"checked_units"', '"summary"', '"schema_version"', 'fresh=', 'published=', 'max_abs_delta=']:
            self.assertIn(field, message)


if __name__ == '__main__':
    unittest.main()
