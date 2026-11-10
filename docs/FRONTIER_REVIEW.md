# 前沿评估 · 2026-11-08（2026-11-10 补充 0.5.0、0.6.0）

本文记录 0.4.0 迭代前对 8 个候选的核查与取舍；0.5.0、0.6.0 的选择与“大公司在生产中怎样用”见文末几节。来源只用论文、官方文档和官方仓库，日期为首次公开日期；只看过摘要或仓库说明的地方会写明。“大公司在生产中怎样用”一节另用了两篇注明出处和日期的媒体报道（海康威视、大华），其中的产品说法都是厂商自述。

## 判断标准

- **访客能否看到差别**：公开站点在访客自己的浏览器里运行模型。GitHub Pages 不能设置 COOP/COEP，所以 WebAssembly 只能单线程运行。检测器的预算沿用 [检测器协议](validation/detector-upgrade-protocol.md)：单线程端到端 P95 ≤ 500 ms/张。
- **能否按现有规则测量**：更换检测器或编码器之前，必须先在协议里追加附录，再计算任何精度。检测器用 COCO val2017 按图片编号切开的开发半 / 测试半，并始终报告逐类精确率（合并指标曾两次掩盖大件类别的精度下降）。车位编码器需要一份没有用过的保留数据。所有打分只在 GitHub Actions 中运行，不在开发者本机推理。
- **许可**：项目是 MIT 许可，模型权重随站点分发，因此权重许可必须允许再分发。

## 结论一览

| # | 候选 | 来源（日期） | 结论 |
| --- | --- | --- | --- |
| 1 | RF-DETR | Robinson 等，arXiv:2511.09554（2025-11），ICLR 2026 | 暂不采用；是下一轮检测器的首选候选 |
| 2 | DEIM / DEIMv2 | Huang 等，arXiv:2412.04234（2024-12，CVPR 2025）；arXiv:2509.20787（2025-09） | 暂不采用 |
| 3 | YOLO26 | Ultralytics 文档（2025-09/10） | 不采用：AGPL-3.0 |
| 4 | 开放词表检测（YOLOE、OWLv2、Grounding DINO） | arXiv:2503.07465（2025-03）；arXiv:2306.09683（2023-06，NeurIPS 2023）；arXiv:2303.05499（2023-03） | 0.4.0 不采用；0.6.0 已用 LVIS 按协议评测，未达到上线门槛（见“0.6.0”一节） |
| 5 | SAM 3 | Meta，arXiv:2511.16719（2025-11） | 不采用 |
| 6 | DINOv3 作为车位编码器 | Siméoni 等，arXiv:2508.10104（2025-08） | 不采用：没有剩余的保留数据，许可变化 |
| 7 | ONNX Runtime Web 的 WebGPU 执行提供器 | onnxruntime.ai 文档 | 本轮不上线；改做能力检测与退回 |
| 8 | 漂移下的风险控制（ACI、风险控制、e-detector、CUSUM） | arXiv:2106.00170（2021，NeurIPS）；arXiv:2208.02814（2022，ICLR 2024）；arXiv:2203.03532（2022） | 已在 PKLot 轮按预登记评估：保留现行规则；采用按侧重新校准 |

另一项不采用：在页面里加入“打字提问”或浏览器端大语言模型（见文末）。

## 1. RF-DETR

- **是什么**：Roboflow 的实时检测 Transformer。它用 DINOv2 骨干，并用权重共享的神经架构搜索得到一组精度与延迟的折中。ICLR 2026 摘要报告，nano 版在 COCO 上 AP 48.0，比延迟相近的 D-FINE-N 高 5.3。仓库写明，核心包和标为 Apache 的模型使用 Apache-2.0；XL / 2XL 等 Plus 组件使用 PML 1.0。
- **为什么本轮不采用**：论文的延迟是 GPU 上的数字，本站在单线程 WASM 上运行。现默认的 D-FINE-N 在参考机上 P95 为 252 ms，RF-DETR-N 的 ViT 骨干能否守住 500 ms 预算，必须先实测。按协议，换检测器需要新附录、COCO 开发半 / 测试半评测（含客梯规则 6 个大件类别的逐类精确率），以及导出 ONNX 并核对与 PyTorch 的一致性。这些在本轮预算内做不完，做一半不能上线。
- **下一轮怎么做**：先在协议里追加附录 4，写定候选文件、输入尺寸与默认规则；在 Actions 中用随机输入测单线程延迟（不看标签）；延迟合格后，再在 Actions 中跑 COCO 评测。nano 权重的许可需在选定提交时再核对一次。

## 2. DEIM / DEIMv2

- **是什么**：DEIM 改进了 DETR 类检测器的训练匹配，用来加快收敛，可直接用于 D-FINE。DEIMv2 把 DINOv3 特征接入实时检测器。论文报告 DEIMv2-S 用 9.7M 参数达到 50.9 AP，超轻的 Pico 版用 1.5M 参数达到 38.5 AP。
- **为什么不采用**：较大的 DEIMv2 用 DINOv3 骨干，会带来第 6 条的许可问题；超轻版用剪枝的 HGNetv2，AP 低于现默认的 D-FINE-N（测试半 AP 42.0）。DEIM 本身是训练方法，本项目不训练检测器。本轮没有核对这两个仓库的许可证。

## 3. YOLO26

- **是什么**：Ultralytics 2025 年秋发布的 YOLO，主打端到端、无需 NMS 的推理和边缘部署。
- **为什么不采用**：Ultralytics 的模型以 AGPL-3.0 或商业企业许可提供。权重随本站分发，AGPL 的要求与项目的 MIT 许可不一致；采用还需要另一套导出与评测路径。即使精度更高，许可也先排除了它。

## 4. 开放词表检测：YOLOE、OWLv2、Grounding DINO

- **动机**：COCO 没有纸箱、搬运柜体、推车、垃圾袋。[模型卡](MODEL_CARD.md) 写明，这些物体可能完全漏检。用文字提示检测是直接的补法。
- **来源**：YOLOE 把文字、视觉和无提示三种方式放进一个 YOLO 式网络，无提示模式依赖内置的 4,585 类词表（arXiv:2503.07465，ICCV 2025）。OWLv2 用自训练扩大开放词表检测数据，L/14 版把 LVIS 稀有类 AP 从 31.2% 提到 44.6%（NeurIPS 2023）。Grounding DINO 用 Swin 骨干加 BERT 文本编码器（arXiv:2303.05499）；官方代码标为 Apache-2.0（本轮没有逐字核对许可文件）。
- **为什么不采用**：
  - 协议要求逐类精确率，而项目没有带这些类别标注、许可清楚的小区或客梯图片。没有它，就无法说明新增类别的误检是多少，开放词表的“能检出”就无从核实。
  - CLIP / SigLIP / Swin + BERT 级别的模型远超单线程 WASM 的延迟预算和合理的首次下载量。
  - YOLOE 经 Ultralytics 分发时同样是 AGPL-3.0；THU-MIG 仓库的许可本轮没有核对。
- **什么会改变结论**：一份有授权、带这些类别框标注的小区画面集。到那时先比较一个能在浏览器运行的小模型。

## 5. SAM 3

- **是什么**：Meta 的“按概念分割”模型，可以用名词短语或示例框提示，同时开放了 SA-Co 基准（arXiv:2511.16719）。
- **为什么不采用**：许可是 Meta 自定的 SAM License，检查点需申请访问；模型卡说明主要面向研究。体量远超浏览器预算。本项目的复核也不需要像素级掩膜，人工看的是原画面和框。

## 6. DINOv3 作为车位编码器

- **是什么**：DINOv3 自监督视觉基础模型，从 ViT-7B 蒸馏出 ViT-S 到 ViT-H+ 等小模型；ViT-S 约 21M 参数（arXiv:2508.10104）。Hugging Face 模型卡的许可是 DINOv3 License（自定，需同意条款后下载），不是现用 DINOv2 的 Apache-2.0。
- **为什么不采用**：
  - **没有可用的保留数据**：CNR-EXT 在 2026-10-17 已用作测试，PKLot 在 2026-10-20 也已用作测试，两者现在都算已观察。按 [迁移协议](validation/parking-transfer-protocol.md)，换编码器必须在新的保留数据上证明。
  - **提升空间小**：冻结的 DINOv2-small 线性探针在 PKLot 上平衡正确率已达 98.95%。剩下的风险主要来自漂移和现场阈值，换编码器解决不了。
  - **许可**：从 Apache-2.0 换成需同意条款的自定许可，需单独决定。

## 7. ONNX Runtime Web 的 WebGPU 执行提供器

- **是什么**：ORT Web 可以把执行提供器从 `wasm` 换成 `webgpu`，需要改用 `onnxruntime-web/webgpu` 构建。官方文档建议：很轻的模型继续用 WASM，较重的模型再用 WebGPU。
- **为什么本轮不上线**：
  - 要换一个更大的运行库构建。
  - 要另做 GPU 与 WASM 结果的一致性核对；现有检查的分数一致性上限是 1e-6。
  - Actions 的运行器没有 GPU，无法拿出真实的 WebGPU 运行证据。按发布规则，没有验证的功能不能上线。
  - D-FINE-N 单线程 WASM 已在 500 ms 预算内。
- **本轮改做的事**：核查中发现，打包的 ORT 只有 SIMD 版 WASM。不支持 WebAssembly SIMD 的浏览器（旧版 Safari、iOS 锁定模式或被策略关闭 WebAssembly）以前要先下载约 28 MiB，才看到一条难懂的运行库错误。现在页面先做能力检测：D-FINE-N 与 DINOv2 在这种浏览器上不可选，改用 TensorFlow.js 上的 SSDLite / MobileNetV2，并说明原因。`capability-fallback-check` 在真实浏览器中验证这条路径。
- **什么会改变结论**：有 GPU 的自托管运行器，或能证明结果一致、并给出真实速度的浏览器运行记录。

## 8. 漂移下的风险控制

- **来源**：
  - 自适应共形推断 ACI（Gibbs、Candès，NeurIPS 2021）在分布变化下保证长期平均覆盖率，不依赖可交换性，但每一步都需要知道真实结果。
  - 共形风险控制（Angelopoulos 等，arXiv:2208.02814，ICLR 2024）把保证推广到一般的单调损失，但前提仍是可交换。
  - e-detector（Shin、Ramdas、Rinaldo，arXiv:2203.03532，本项目只核对了摘要）与 CUSUM（Page 1954）用于序贯检测变化点。
- **已做的评估**：2026-10-20 的 PKLot 轮按 [协议附录 7–7.2](validation/parking-transfer-protocol.md) 事先登记了 CUSUM、混合备择 CUSUM、7 日窗口和当日暂停，只用合成数据校准告警界限并选主挑战规则。结论：在误撤销不比现行累积检验多的约束下，没有规则把漂移期间的危害降到现行规则的 0.9 倍以下，所以页面继续用现行规则。PKLot 保留数据里几乎没有漂移，R0–R4 结果完全相同。瓶颈是每天的抽检量和同一天车位之间的相关，而不是检验统计量。
- **采用**：撤销后按侧重新校准（附录 7.3，2026-10-21 经用户确认）。页面只重检被撤销的一侧，另一侧的阈值与抽检监控不受影响，与回放一致。本次发布把它并入 main；它的浏览器检查第一次在 CI 上完整运行（见 `CHANGELOG.md`）。
- **不采用 ACI**：页面上只有约 10% 的自动判定会被抽检，看得到人工结论；ACI 每一步都要真实结果，与这里的反馈方式不符。

## 不加“打字提问”或浏览器端大语言模型

这个演示里，访客自己的输入是照片或短视频，已经由真实模型在访客浏览器里免费回答：D-FINE-N / SSDLite 检测，DINOv2 / MobileNetV2 / MLP32 车位占用。打字提问只能回答文档内容，帮不了访客要做的事。其他作品集项目里，浏览器端大语言模型在真实运行中失败，也几乎提不了分。因此本轮没有加文字层，也没有为文字层写盲测集。

## 0.5.0 · 视频事件时间线（2026-11-10）

第二轮迭代的方向是多模态与视频。候选来自项目外的研究笔记（2026-11-10），按“访客能否在线试、能否按协议测”排序：

| # | 候选 | 结论 | 理由 |
| --- | --- | --- | --- |
| 1 | 视频事件时间线：检测 → 跟踪 → 区域与停留规则 → 事件段 | **采用** | 不需要新权重或新许可；访客可以用自己的视频试；有公开、CC BY 4.0、带活动起止时间的标注（MEVA）可以按 ActEV 的时间误报指标评分。评测协议写于评分前：[event-timeline-protocol.md](validation/event-timeline-protocol.md)。 |
| 2 | 开放词表“慢车道”（OWLv2 / Grounding DINO，找推车、纸箱） | 不采用（本轮） | 128–204 MB 下载、WASM 上每张数秒；需要先在 LVIS 上确认许可和与 COCO 的重叠，再写协议。MEVA 上被放下的物品 17 个里 14 个标注为 other（不是 COCO 类），物品遗留代理在测试半上全部漏报，这是下一轮最有依据的方向。 |
| 3 | `coi-serviceworker` 打开多线程 WASM | 不采用（本轮） | 页面首次加载会自刷新，COEP 可能挡住跨源资源，需要真实浏览器验证；本轮的瓶颈不是速度：Actions 上单帧 P50 约 0.34 s（4 个页面并行测得），按此推算 5 分钟视频（300 帧）单页约 2 分钟分析完。 |
| 4 | 视觉语言模型在 Actions 上核实告警 | 不采用 | 访客无法在线试；CPU 上 2B–4B 模型速度未测；“模型同意”容易被误读为人工确认。 |
| 5 | 切片推理（SAHI）找远处小车 | 不采用 | 没有找到许可清楚的航拍车辆数据来评测。MEVA 的“远处小人”诊断量化了同一问题，留作下一轮依据。 |

与研究笔记的两处差异：评测级 MEVA 标注里没有 `person_abandons_package` 实例，所以物品遗留规则对 `person_puts_down_object`，并且只称“物品遗留代理”；评测对所有规则用整幅画面作区域，因为 MEVA 摄像头没有独立于标签的门口或禁停区划定。

## 0.6.0 · 开放词汇慢车道（2026-11-10）

第三轮从 0.5.0 测得的缺口出发：COCO 以外的物品（推车、纸箱、周转箱、垃圾桶）完全看不见，物品遗留代理在 MEVA 测试半全部漏报。0.4.0 时不采用开放词表检测的理由是“没有可测的标注数据”，这一轮用 LVIS v1 val（标注 CC BY 4.0，在 lvisdataset.org 核对）补上，并先写协议再测量：[open-vocab-protocol.md](validation/open-vocab-protocol.md)。

| 候选 | 许可 | 结论 | 依据 |
| --- | --- | --- | --- |
| Grounding DINO tiny（`onnx-community/grounding-dino-tiny-ONNX`，q8，204 MB） | Apache-2.0 | **评测未通过，不上线** | 单线程 WASM P95 15.0 秒，在 20 秒预算内；但 LVIS 开发半上没有阈值能让 ≥ 3 个类别的合并精确率达到 70%（最好 58.7%，只有箱子和灭火器两类） |
| OWLv2 B/16 ensemble（`Xenova/…`，q8 / q4） | Apache-2.0 | 不采用 | transformers.js 4.3.2 的 ONNX Runtime Web 缺少 `/class_head/Cast` 所需内核，无法创建会话；换 3.8.1 运行库后 10 分钟内没有加载完成 |
| OWL-ViT B/32（`Xenova/…`，q8 / q4） | Apache-2.0 | 不采用 | 同上 |
| LLMDet-tiny、MM-Grounding-DINO tiny | Apache-2.0 | 不纳入 | Hugging Face 上没有维护中的 ONNX 导出 |
| OmDet-Turbo | Apache-2.0 | 不纳入 | transformers.js 不支持 |
| YOLOE、YOLO-World | AGPL-3.0、GPL-3.0 | 不采用 | 许可 |
| Grounding DINO 1.5/1.6、DINO-X | API | 不采用 | 需要密钥 |

页面里的慢车道代码已写好并由浏览器检查覆盖（用评测配置强制运行），但只有在新的协议下通过评测才会出现。下一轮可用的依据：LVIS 测试半至今未被读取；开发半显示的失败模式是子词共享（`carton` = `cart` + `##on`）、整体分数偏低（垃圾桶、桶、锥桶没有 ≥ 0.15 的框）和小目标。

## 大公司在生产中怎样用（What large companies run in production · 2026-11-10 核对）

下列来源均在 2026-11-10 重新打开核对；只写来源原文说到的内容，产品效果数字都是厂商自述，没有独立审计。

| 厂商与产品 | 来源（日期） | 生产中做什么 |
| --- | --- | --- |
| NVIDIA Metropolis 视频搜索与摘要蓝图（VSS） | [GitHub 公开仓库](https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization)，Apache-2.0（2026-11-10 查阅，仓库没有发布日期） | 实时检测与跟踪（`rt-cv`），再由行为分析把元数据整理成“trajectories, incidents, and verified alerts”；告警验证流程在感知与行为分析之后用视觉语言模型核实，以减少误报；智能体通过 MCP 访问视频分析数据和事件记录。需要 GPU，参考部署为两张 RTX PRO 6000。 |
| 海康威视 观澜大模型 | [界面新闻，2026-04-20](https://www.jiemian.com/article/14276505.html) | 2023 年发布；在其底座上做安全生产、公共安全等行业垂直模型；“文搜”系列存储产品对亿级视频做自然语言秒级检索；采用“大小模型结合”、边域云融合的架构。 |
| 大华股份 星汉大模型 2.0 | [中华网，2025-04-03](https://m.tech.china.com/articles/20250403/202504031656983.html) | V 系列提升小目标与小概率事件检测；M 系列做“文搜视频”等跨模态检索，识别翻越护栏等复杂行为；L 系列拆解任务、生成分析报告；在三者之上构建调用工具的行业智能体。 |
| 阿里云 AnalyticDB for MySQL「IPC 摄像头视频关键事件提取与检索」 | [产品文档](https://help.aliyun.com/zh/analyticdb/analyticdb-for-mysql/video-event-extraction-and-retrieval)；[2026 发布说明](https://help.aliyun.com/en/analyticdb/analyticdb-for-mysql/product-overview/2026)（2026-04 新功能，邀测） | 先用 SSIM 变化检测跳过静止画面，把连续变化切成带起止时间的事件段并过滤闪烁、抖动和短暂遮挡；每段抽关键帧（短边约 480 像素）交视觉大模型写描述，向量入库后用自然语言检索；示例场景是家庭安防。 |
| NVIDIA TAO 工具包 · Grounding DINO（0.6.0 补充） | [TAO 7.3.0 文档 · Grounding DINO](https://docs.nvidia.com/tao/tao-toolkit/latest/text/cv_finetuning/pytorch/object_detection/grounding_dino.html)（2026-11-10 查阅） | 文档原文称 Grounding DINO 是“an open vocabulary object-detection model included in the TAO”，提供 train、evaluate、inference、export、quantize 五个任务，用客户自己的 ODVG / COCO 数据微调。研究笔记里“商用检查点”一说本次没有在该页核实到，不引用。 |
| 大华股份 星汉大模型 2.0 · M 系列（0.6.0 补充） | [中华网，2025-04-03](https://m.tech.china.com/articles/20250403/202504031656983.html)（转述 2024 年报） | V 系列称“小目标检测性能与小概率事件精准度大幅提升”；M 系列称可“通过图文提示，无需定制开发即可实现新功能”。均为厂商自述，没有公开数字。 |

**共同做法**：便宜的感知层（检测、跟踪或变化检测）先把长视频切成带起止时间的事件段和关键帧，后面的大模型只看这些段，用来核实、描述或检索。分层的原因是成本：没有人让大模型逐帧看完整段监控。

**本次迭代对应哪一层，哪里刻意不同**
- 0.5.0 的事件时间线对应第一层：检测 → 跟踪 → 区域与停留规则 → 带起止时间的事件段和关键帧，并可导出 JSON 交给后续环节。页面上写了一行带来源的说明（NVIDIA VSS）。
- **不同之处**：没有视觉语言模型核实或描述（在访客浏览器或 Actions CPU 上做不到可验证的质量，见研究笔记 C.4 候选 4）；没有向量检索；规模是一段 5 分钟以内的视频、每秒 1 帧，而不是多路实时流；模型只识别 COCO 80 类。所有数字来自公开的 MEVA 数据，不来自任何小区现场。
- 与阿里云方案的一个具体区别：它按画面变化抽帧，本项目按固定 1 帧/秒抽帧。固定频率让评测与页面完全一致、可复现，代价是短于 1 秒的动作可能落在两帧之间。
- **0.6.0 对应哪一层**：用文字提示扩展检测类别（TAO 的 Grounding DINO、大华 M 系列的“图文提示”），放在现有检测之后、只由访客点击触发。**不同之处**：不微调、只用固定提示词；在访客浏览器的单线程 WASM 上运行，而不是 GPU；最重要的是先在公开标注上量逐类精确率——厂商没有公开这类数字，而本项目量出来的结果不够好，所以没有上线。

## 参考

- Gupta、Dollár、Girshick，*LVIS: A Dataset for Large Vocabulary Instance Segmentation*，CVPR 2019。https://www.lvisdataset.org/ （标注 CC BY 4.0，2026-11-10 核对）
- NVIDIA TAO Toolkit 7.3.0，*Grounding DINO*。https://docs.nvidia.com/tao/tao-toolkit/latest/text/cv_finetuning/pytorch/object_detection/grounding_dino.html

- Robinson 等，*RF-DETR: Neural Architecture Search for Real-Time Detection Transformers*，arXiv:2511.09554，ICLR 2026。https://arxiv.org/abs/2511.09554 ；仓库 https://github.com/roboflow/rf-detr
- Huang 等，*DEIM: DETR with Improved Matching for Fast Convergence*，arXiv:2412.04234，CVPR 2025。https://arxiv.org/abs/2412.04234
- Huang 等，*Real-Time Object Detection Meets DINOv3*（DEIMv2），arXiv:2509.20787。https://arxiv.org/abs/2509.20787
- Ultralytics YOLO26 文档与许可说明。https://docs.ultralytics.com/
- Wang 等，*YOLOE: Real-Time Seeing Anything*，arXiv:2503.07465，ICCV 2025。https://arxiv.org/abs/2503.07465
- Minderer、Gritsenko、Houlsby，*Scaling Open-Vocabulary Object Detection*，NeurIPS 2023，arXiv:2306.09683。https://arxiv.org/abs/2306.09683
- Liu 等，*Grounding DINO*，arXiv:2303.05499。https://arxiv.org/abs/2303.05499
- Meta，*SAM 3: Segment Anything with Concepts*，arXiv:2511.16719。https://arxiv.org/abs/2511.16719 ；仓库 https://github.com/facebookresearch/sam3
- Siméoni 等，*DINOv3*，arXiv:2508.10104。https://arxiv.org/abs/2508.10104 ；模型卡 https://huggingface.co/facebook/dinov3-vits16-pretrain-lvd1689m
- ONNX Runtime，*Using the WebGPU Execution Provider*。https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- Gibbs、Candès，*Adaptive Conformal Inference Under Distribution Shift*，NeurIPS 2021，arXiv:2106.00170。https://arxiv.org/abs/2106.00170
- Angelopoulos、Bates、Fisch、Lei、Schuster，*Conformal Risk Control*，ICLR 2024，arXiv:2208.02814。https://arxiv.org/abs/2208.02814
- Shin、Ramdas、Rinaldo，*E-detectors: a nonparametric framework for sequential change detection*，arXiv:2203.03532。https://arxiv.org/abs/2203.03532
- Almeida 等，*PKLot – A robust dataset for parking lot classification*，Expert Systems with Applications 42(11):4937–4949，2015。https://web.inf.ufpr.br/vri/databases/parking-lot-database/
