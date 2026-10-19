# D-FINE-N（COCO，fp32 ONNX，本项目导出）

- 方法：Peng、Li、Wu、Zhang、Sun、Wu，*D-FINE: Redefine Regression Task in DETRs as Fine-grained Distribution Refinement*，[arXiv:2410.13842](https://arxiv.org/abs/2410.13842)（2024-10 预印本）。官方实现 [Peterande/D-FINE](https://github.com/Peterande/D-FINE)，Apache-2.0。
- 权重：[ustc-community/dfine-nano-coco](https://huggingface.co/ustc-community/dfine-nano-coco) 提交 `066438d3d8f0da137a37b38fdf3368fd4afceced`（Apache-2.0，仅在 COCO 上训练；不是官方提示可能受 Objects365 条款约束的 obj365 预训练版本）。`config.json`、`preprocessor_config.json` 为同一提交原文件。
- `model.onnx` 由本项目 `scripts/export_dfine_onnx.py` 用上述权重导出（PyTorch 2.14.1、Transformers 5.20.1、opset 17），属于 Apache-2.0 衍生文件；未训练或修改权重。导出时在 CC0 校车图上与 PyTorch 输出核对，详见 `export.json`。
- 未采用 `onnx-community/dfine_n_coco-ONNX`：其 fp32 `model.onnx` 在同一张图、同一预处理下大巴分数只有 0.25（换其他输入约定最多 0.39，int8 版最多 0.48），而官方 PyTorch 权重为 0.96，判断为转换缺陷。
- 输入 640×640、像素 /255；输出 300 个查询 × 80 类 sigmoid 分数与归一化框。哈希见 `web/assets.lock.json`。
