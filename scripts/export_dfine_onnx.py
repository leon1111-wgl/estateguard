"""Export the official D-FINE-N COCO weights to ONNX for the browser and check parity.
The onnx-community export (commit 380d2839) scored the CC0 school bus at 0.25-0.39 while these
PyTorch weights give 0.96 on the same input, so this project exports its own file.
Usage: python scripts/export_dfine_onnx.py --weights DIR --out web/models/dfine-n/model.onnx
DIR holds ustc-community/dfine-nano-coco at commit 066438d3 (model.safetensors, config.json).
"""
import argparse,hashlib,json,platform
from pathlib import Path
import numpy as np,onnx,onnxruntime as ort,torch,transformers
from PIL import Image
from transformers import DFineForObjectDetection

class Wrapped(torch.nn.Module):
    def __init__(self,model):super().__init__();self.model=model
    def forward(self,pixel_values):
        out=self.model(pixel_values=pixel_values);return out.logits,out.pred_boxes

def bus(root):
    im=Image.open(root/'web/samples/bus.jpg').convert('RGB')
    return (np.asarray(im.resize((640,640),Image.BILINEAR),dtype=np.float32)/255).transpose(2,0,1)[None].copy()

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--weights',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
    root=Path(__file__).resolve().parents[1];torch.manual_seed(0)
    model=DFineForObjectDetection.from_pretrained(args.weights).eval();wrapped=Wrapped(model).eval()
    x=torch.from_numpy(bus(root))
    with torch.no_grad():ref_logits,ref_boxes=wrapped(x)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    torch.onnx.export(wrapped,(x,),str(args.out),input_names=['pixel_values'],output_names=['logits','pred_boxes'],opset_version=17,dynamo=False,do_constant_folding=True)
    onnx.checker.check_model(str(args.out))
    session=ort.InferenceSession(str(args.out),providers=['CPUExecutionProvider'])
    logits,boxes=session.run(None,{'pixel_values':x.numpy()})
    diff=dict(logits=float(np.abs(logits-ref_logits.numpy()).max()),boxes=float(np.abs(boxes-ref_boxes.numpy()).max()))
    p=1/(1+np.exp(-logits[0]));raw=args.out.read_bytes()
    report=dict(source='ustc-community/dfine-nano-coco@066438d3d8f0da137a37b38fdf3368fd4afceced',weights_sha256=hashlib.sha256((args.weights/'model.safetensors').read_bytes()).hexdigest(),
        onnx_sha256=hashlib.sha256(raw).hexdigest(),onnx_bytes=len(raw),opset=17,exporter='torch.onnx.export(dynamo=False)',torch=torch.__version__,transformers=transformers.__version__,onnx=onnx.__version__,onnxruntime=ort.__version__,python=platform.python_version(),
        parity_vs_pytorch_on_bus=diff,bus_score=float(p[:,5].max()),bus_box=[float(v) for v in boxes[0,int(p[:,5].argmax())]])
    assert diff['logits']<1e-3 and diff['boxes']<1e-4,diff
    (args.out.parent/'export.json').write_text(json.dumps(report,indent=1)+'\n');print(json.dumps(report))

if __name__=='__main__':main()
