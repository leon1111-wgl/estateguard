"""Reproduce the single NMS correction to the pinned Apache-2.0 COCO-SSD bundle."""
from pathlib import Path
import argparse
import hashlib

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / 'tests/fixtures/coco-ssd-2.2.3.upstream.min.js'
TARGET = ROOT / 'web/vendor/coco-ssd.min.js'
UPSTREAM_SHA256 = '8875b8c1bb57723990c9d6506226e0e51cd21b8b6943eb53201086096de52df5'
PATCH_ID = 'coco-ssd-2.2.3-fixed-nms-v1'


def build_bundle():
    original = UPSTREAM.read_bytes()
    if hashlib.sha256(original).hexdigest() != UPSTREAM_SHA256:
        raise ValueError('上游 COCO-SSD 文件与固定 SHA-256 不符；停止补丁。')
    old = b'i.image.nonMaxSuppression(e,c,a,m,m)'
    if original.count(old) != 1:
        raise ValueError('NMS 调用不是唯一预期位置；停止补丁。')
    notice = (
        '/* EstateGuard modification, 2026-10-16: fixed NMS IoU=0.5; '
        'score cutoff remains independent. Patch: ' + PATCH_ID + '.\n'
        ' * Upstream copyright and Apache-2.0 license below are retained.\n'
        ' * Reproduce with scripts/patch_coco_ssd.py. */\n'
    ).encode()
    return notice + original.replace(old, b'i.image.nonMaxSuppression(e,c,a,.5,m)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = build_bundle()
    if args.check:
        if TARGET.read_bytes() != result:
            raise SystemExit('FAIL: 浏览器检测库与可复现 NMS 补丁不一致。')
        print('PASS: COCO-SSD NMS 补丁与固定上游文件逐字节重建一致。')
    else:
        TARGET.write_bytes(result)
        print(f'生成 {PATCH_ID}：{len(result)} bytes, sha256={hashlib.sha256(result).hexdigest()}')
