"""Verify every vendored model/runtime/sample asset against the tracked lock."""
from pathlib import Path
import hashlib,json,math
root=Path(__file__).resolve().parents[1]/'web'
lock=json.loads((root/'assets.lock.json').read_text())
for asset in lock['files']:
    content=(root/asset['path']).read_bytes()
    assert len(content)==asset['bytes'],f"Truncated asset: {asset['path']}"
    assert hashlib.sha256(content).hexdigest()==asset['sha256'],f"Changed asset: {asset['path']}"
model_dir=root/'models/ssdlite_mobilenet_v2'
model=json.loads((model_dir/'model.json').read_text())
expected=sum(math.prod(w['shape'])*{'float32':4,'int32':4,'bool':1,'uint8':1,'uint16':2}[w.get('quantization',{}).get('dtype',w['dtype'])] for g in model['weightsManifest'] for w in g['weights'])
actual=sum((model_dir/p).stat().st_size for g in model['weightsManifest'] for p in g['paths'])
assert actual==expected,(actual,expected)
print(f"PASS: {len(lock['files'])} asset hashes; {actual:,} model weight bytes match tensor manifest.")
