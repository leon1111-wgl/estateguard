# 第三方组件与素材

原创应用代码：MIT，见 LICENSE。

| 资产 | 来源 / 版本 | 许可与用途 |
| --- | --- | --- |
| TensorFlow.js | 4.22.0，https://github.com/tensorflow/tfjs | Apache-2.0，浏览器推理运行库 |
| COCO-SSD 包 | 2.2.3，https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd | Apache-2.0，检测前后处理 |
| SSDLite MobileNet V2 导出权重 | Google TensorFlow.js 官方模型存储：https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json | TensorFlow 官方开源模型分发；Apache-2.0。通用 COCO 预训练，未进行本项目微调 |
| YellowSchoolBus.jpg 缩略图 | Raysonho @ Open Grid Scheduler / Grid Engine，https://commons.wikimedia.org/wiki/File:YellowSchoolBus.jpg | CC0-1.0；用于物体检测测试，非违规证据。2011 年拍摄，960px 缩略图未另作修改 |

Apache-2.0 许可证全文位于 web/vendor/LICENSE-APACHE-2.0.txt。来源、实际文件大小和 SHA-256 位于 web/assets.lock.json。预训练模型并未提供本项目领域性能保证。

项目没有包含完整 COCO 数据集。合成观察、参考事件与场景文本为原创。其他论文和政府指引仅作链接和设计参考，不捆绑全文。

## CNRPark 数据与训练产物

CNRPark 基础子集来自 Amato、Carrara、Falchi、Gennaro、Vairo 的[官方项目](http://cnrpark.it/)，按 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 分发。本站含全部摄像头 B 测试原图、派生 32×32 模型输入、标签、快照索引和完整预测；完整署名、变更与机器可读数据库见 [NOTICE](web/data/parking/NOTICE.md) 和 [训练说明](docs/PARKING_DATA.md)。`web/data/parking/`、`docs/validation/parking-split.csv` 与含样本像素的测试 fixture 按数据许可处理，不受根目录代码 MIT 覆盖。独立训练的项目分类器代码及权重按 MIT 提供；原数据许可及署名保持。

公开数据文件逐个大小和 SHA-256 记录在 `web/data/parking-assets.lock.json`；模型权重记录在 `web/assets.lock.json`。训练依赖 NumPy、Pillow，仅用于开发环境，不打包进浏览器。
