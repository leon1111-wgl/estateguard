# DINOv2-small (int8 ONNX)

- 原始模型：[facebook/dinov2-small](https://huggingface.co/facebook/dinov2-small)，Oquab 等，*DINOv2: Learning Robust Visual Features without Supervision*，[arXiv:2304.07193](https://arxiv.org/abs/2304.07193)。许可 Apache-2.0，全文见 `../../vendor/LICENSE-APACHE-2.0.txt`。
- 本文件来自 [onnx-community/dinov2-small](https://huggingface.co/onnx-community/dinov2-small) 提交 `8b1f705a3a7f6f062f6bdd21986c1583d3ef105d` 的 `onnx/model_quantized.onnx`（int8 动态量化），以及同一提交的 `config.json`、`preprocessor_config.json`。本项目未修改字节；哈希见 `web/assets.lock.json`。
- 本项目只把它作为冻结特征提取器使用，未微调。在其输出上训练的车位分类头见 `../parking-dinov2/`。
