# 开放词汇慢车道 · LVIS 评测与延迟预算的预先固定协议

写于 2026-11-10，**在读取任何 LVIS 标注、计算任何精度、做任何延迟测量之前**。此前只做过：在 lvisdataset.org 核对许可；通过 Hugging Face 模型 API 读取候选 ONNX 文件的名称、大小和提交号（没有下载权重）；读取 npm 元数据确认 transformers.js 版本。变更须在本文件追加附录，不覆盖原文。

## 问题

“视频与图片分析”的两个检测器（D-FINE-N、SSDLite）只认 COCO 80 类。物业最常见的通道与客梯隐患——推车、纸箱、周转箱、垃圾桶、梯子——不在其中：0.5.0 的“物品遗留（代理）”在 MEVA 测试半 6 个标注全部漏报，主要原因是被放下的物品多为箱子，不是 COCO 类别。本协议回答：一个**按图片由访客点击才加载**的开放词汇检测器（固定提示词）在公开标注上对这些类别的精确率与召回是多少，单线程 WASM 下一张图要多久，是否值得上线。

## 许可与来源（2026-11-10 核对）

- **LVIS v1**：<https://www.lvisdataset.org/dataset> 写明 “The LVIS annotations along with this website are licensed under a Creative Commons Attribution 4.0 License. All LVIS dataset images come from the COCO dataset”。标注 CC BY 4.0；图片按 COCO 使用条款（各自 Flickr 许可），只在 GitHub Actions 运行器上逐张下载、只用于评测、不随仓库发布，运行器结束即删除。同页注明 LVIS val 除 COCO 2017 val 外还含 COCO 2017 train 的图片。
- **模型**（上游许可均为 Apache-2.0，HF API 读取）：`google/owlv2-base-patch16-ensemble`（提交 `cfd3195b`）、`google/owlvit-base-patch32`（`cbc355fb`）、`IDEA-Research/grounding-dino-tiny`（`a2bb814d`）。浏览器用的 ONNX 导出：`Xenova/owlv2-base-patch16-ensemble`（`3e255bc9`）、`Xenova/owlvit-base-patch32`（`b75f4e52`）、`onnx-community/grounding-dino-tiny-ONNX`（`ff690b0a`，Apache-2.0）。导出文件沿用上游许可。
- **运行时**：transformers.js 4.3.2（Apache-2.0，2026-10-27 发布），其固定的 ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0（MIT）。权重从 Hugging Face 按上面的提交号加载，不占 GitHub Pages 流量。
- **不纳入**：LLMDet-tiny 与 MM-Grounding-DINO tiny（HF 上没有维护中的 ONNX 导出，只有来源未核实、零下载的第三方仓库）；OmDet-Turbo（transformers.js 不支持，只有非官方导出）；YOLOE、YOLO-World（AGPL-3.0、GPL-3.0）；Grounding DINO 1.5/1.6、DINO-X（需要 API 密钥）。

## 第 1 阶段：大小与单线程延迟（不看任何标签）

| 编号 | 模型 | 文件（字节） | 预处理 |
| --- | --- | --- | --- |
| A-q8 | OWLv2 B/16 ensemble | `onnx/model_quantized.onnx`（155,312,754） | 补边成正方形后缩放到 960×960 |
| A-q4 | 同上 | `onnx/model_q4.onnx`（193,982,426） | 同上 |
| B-q8 | Grounding DINO tiny | `onnx/model_quantized.onnx`（203,824,675） | 处理器默认：短边 800、长边 ≤ 1333 |
| C-q8 | OWL-ViT B/32（2022，同一家族的低算力对照） | `onnx/model_quantized.onnx`（155,431,700） | 直接缩放到 768×768 |
| C-q4 | 同上 | `onnx/model_q4.onnx`（191,730,057） | 同上 |

fp32 文件均超过 600 MB，排除；fp16 / q4f16 面向 WebGPU，而本项目上线路径是 WASM（Actions 运行器没有 GPU，WebGPU 无法验证），不纳入。

**预算（写于测量前）**
- 下载：单个模型文件 ≤ 210 MB。没有许可干净、可在浏览器运行、又小于 100 MB 的开放词汇检测器，这是超出组合项目“约 100 MB”惯例的理由；点击前页面写明大小。
- 延迟：GitHub Actions `ubuntu-latest`，Playwright 1.62.1 的 Chromium，transformers.js WASM，`numThreads = 1`（GitHub Pages 没有跨源隔离，网页实际就是单线程）；权重由运行器本地提供，下载时间不计。输入为确定性伪随机噪声图，三种尺寸 1280×720、1024×768、720×1280，每种先预热 1 次、再计时 10 次，共 30 次。计时是端到端：从图片 Blob 解码、预处理、推理到后处理。**P95 ≤ 20 秒/张**；模型初始化（创建会话，不含下载）≤ 60 秒。
- 超出任一预算的配置直接淘汰，**不计算其精度**。

## 第 2 阶段：LVIS v1 val 上的精确率与召回

**类别**（按 LVIS v1 名称精确匹配；任何一个名称不存在则作业失败）：`cart`、`handcart`、`shopping_cart`、`box`、`carton`、`crate`、`trash_can`、`barrel`、`ladder`、`fire_extinguisher`、`cone`。LVIS 没有 `pallet`，托盘不纳入。作业记录每类的 id、频率档和 LVIS 定义。

**固定提示词**（不调）：LVIS 名称把下划线换成空格；唯一例外 `cone` 用 “traffic cone”（与其 LVIS 定义一致；若定义不是交通锥，在附录记录并仍用 “traffic cone”）。OWL 系列每类一条查询；Grounding DINO 用小写、句点分隔的一串：`cart. handcart. shopping cart. box. carton. crate. trash can. barrel. ladder. fire extinguisher. traffic cone.`

**后处理**（网页与评测同一模块 `web/open-vocab.mjs`）
- OWL 系列：每个图块一个框；分数 = 11 条查询 sigmoid 的最大值，类别取最大者。OWLv2 的框相对补边后的正方形，按长边还原；OWL-ViT 的框相对拉伸后的图，按宽高还原。
- Grounding DINO：每个查询对每个类别的分数 = 该类别词元位置上 sigmoid 的最大值；查询的分数与类别取各类别中最大者。
- 然后每类 NMS（IoU 0.5），再跨类别丢弃与已保留框 IoU ≥ 0.9 的框（同 D-FINE 的 `dedupe090`）。评测保存分数 ≥ 0.05 的前 100 个框；网页在工作点阈值上最多显示 50 个。

**划分**（与标签无关）：键 = sha256(`estateguard-ovd-2026-11-10:` + 图片 id) 的十六进制；首位 0–7 为**开发半**，8–f 为**测试半**。

**子集**：每半、每类，把正例图（含该类标注）按键排序取前 40 张，把负例图（该类在 `neg_category_ids` 中）按键排序取前 40 张；所有被选中图片的并集就是这一半的图片表。每张图只推理一次（11 条提示词同时给）。

**匹配（LVIS 联邦标注）**：对类别 c 与图片 i——
- i 含 c 的标注：按分数从高到低与 c 的真值贪心一对一匹配，IoU ≥ 0.5 为 TP；未匹配的检测计 FP，除非 c 在 i 的 `not_exhaustive_category_ids` 中（此时忽略）；
- c 在 i 的 `neg_category_ids` 中：c 的全部检测计 FP；
- 其余情况（c 在 i 上未核实）：c 的检测忽略。
所以每类都在这一半**全部**被核实过的图片上计分，不只是为它选的 40 + 40 张。

**指标**（阈值 t 下）：每类 TP、FP、精确率（附 Wilson 95% 区间）、召回（TP / 这一半所选正例图上该类真值数）、每 100 张负例图的 FP 数；所选类别合并的精确率与召回。精确率依赖正负例比例（这里由 40 / 40 的上限决定），每 100 张负例图 FP 不依赖比例，两者都报。

**与已用 COCO 两半的重叠**：记录每张评测图的来源目录（val2017 或 train2017）；val2017 的图再按 2026-10-19 检测器协议（id 升序，前 2,500 张开发半、后 2,500 张测试半）标出属于哪一半，报告各自数量。这只是说明：慢车道的阈值与类别不影响 D-FINE 的结论。**训练数据暴露**：Grounding DINO 的训练集含 Visual Genome（大量 COCO 图片），OWL 系列的训练细节见各自模型卡；无法排除候选模型见过这些 COCO 图片，LVIS 上的数字对物业监控可能偏乐观。

## 选择规则（只用开发半）

对通过第 1 阶段的每个配置、每个 t ∈ {0.05, 0.10, …, 0.60}：
- 入选类别 S(t) = 开发半上检测数 ≥ 10 且精确率 ≥ 0.50 的类别；
- 可行条件：|S(t)| ≥ 3，且 S(t) 合并精确率 ≥ 0.70；
- 在可行的（配置, t）中取 S(t) 合并 TP 最多者；并列取 P95 延迟更低者，再并列取文件更小者。
- 没有可行组合：慢车道保持隐藏，不跑测试半，只报告开发半数字。

选定的配置、阈值与类别集合在测试前提交（`web/data/open-vocab/config.json` 与本文附录），提交号写入报告。

## 测试半与上线规则（写于评测前）

测试半只在冻结配置上跑一次。慢车道上线，当且仅当：
1. 第 1 阶段两项预算都满足；
2. 测试半上，把 S 中精确率 < 0.50（且检测数 ≥ 10）的类别移除后（只移除、不增加），剩余类别 ≥ 3 个，且其合并精确率 ≥ 0.70。

否则网页里的入口保持隐藏，全部数字照常公开。0.70 的依据：D-FINE 在 COCO 测试半上客梯大件 6 类的工作点精确率是 73.4%（附录 3）；慢车道的结果标“未核实”、证据质量更低，但不应比现有大件规则更不可靠。

## 接入规则（写定）

- 慢车道的框标记 `source: "open_vocab"`；画面与列表上每个慢车道框都写“开放词汇检测 · 未核实”；“没有结果不等于安全”保留。
- **指定通道**（`access`）：S 中的 cart、handcart、shopping_cart、box、carton、crate、trash_can、barrel、ladder 的框中心落在区域内，生成 `blocked_access` 候选。
- **客梯**（`lift`）：S 中的 cart、handcart、shopping_cart、box、carton、crate、barrel、ladder，画面占比 ≥ 0.04（与现有大件规则同一阈值），生成 `bulky_load` 候选。
- fire_extinguisher 与 cone 只显示，不生成候选（灭火器在通道里是正常配置）。
- 慢车道候选的证据质量设为 0.3（现有规则 0.4），摘要以“开放词汇检测 · 未核实”开头。
- 只用于单张图片（访客点击后对当前图片运行一次）。视频与事件时间线不接入：每帧数秒的推理放不进现有的 20 帧 / 5 分钟流程。

## MEVA 物品遗留的再评分

在 0.5.0 的同一 16 段测试片段上，用冻结配置每秒 1 帧运行慢车道，把 box、carton、crate、cart、handcart、shopping_cart、trash_can、barrel 的框加入“物品遗留（代理）”的物品类别，其他设置与评分器不变，与 0.5.0 的结果（6 个标注，Pmiss 100%）并列报告。测试半已在 0.5.0 观察过，这次不是盲测；不在上面选任何参数。若单段运行时间使整轮超过运行器 3 小时，改为每 2 秒 1 帧，并在报告中写明。无论测试半是否通过都运行一次，只作说明，不改变网页的时间线。

## 不在本轮

多线程 WASM（需要跨源隔离）、WebGPU、提示词调优、按类别分别设阈值、托盘、真实物业画面上的精度（没有许可干净的标注集）。

## 附录 1 · 2026-11-10，预处理与框坐标的更正（写于任何延迟测量与标注读取之前）

读取所固定导出的 `preprocessor_config.json` 与 transformers.js 4.3.2 的图像处理器代码后发现，正文“第 1 阶段”表中的预处理写错了，以实际代码为准：
- transformers.js 的通用图像处理器**先缩放到配置尺寸、再补边**；配置尺寸已是正方形，所以补边不起作用。OWLv2 实际是把整张图**直接拉伸**到 960×960（与 Python 版先补成正方形不同）；OWL-ViT 拉伸到 768×768；Grounding DINO 这个导出的配置是 800×800，也是直接拉伸（不是短边 800、长边 ≤ 1333）。
- 因此三个模型的框都相对**整张拉伸后的图**，统一按原图宽高还原；正文“OWLv2 的框相对补边后的正方形”一句作废。延迟作业对 `samples/bus.jpg` 同时记录本模块的解码结果与库自带后处理的结果，用来核对这一点（不涉及标签）。
- 不改用自写预处理：网页与评测都按库的现有行为运行，这就是访客实际得到的结果。

延迟作业的提前停止（写定）：某配置前 3 次计时都超过预算的 2 倍（40 秒）时停止计时，记为超出预算。

## 附录 2 · 2026-11-10，运行库来源与选择规则的并列处理（写于任何标注读取与精度计算之前）

- **运行库来源**：把 transformers.js 的构建文件提交进仓库时，GitHub 推送保护把其中的类名 `Mistral3ForConditionalGeneration`（恰好 32 个字符）误判为 Mistral API 密钥。没有绕过保护，而是改为：transformers.js 4.3.2 的 `transformers.min.js` 与 ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0 的 `ort-wasm-simd-threaded.asyncify.mjs` / `.wasm` 在访客点击后从 jsDelivr 的固定版本地址下载，页面先核对 SHA-256（写在 `web/open-vocab.mjs`），一致才使用，否则停止。三个文件共 27,502,751 字节，与模型文件一起计入点击前提示的下载量。网页和评测用同一段代码。
- **并列处理**：同一配置在不同阈值下合并 TP 相同时，取合并精确率更高者；之后才比较 P95 延迟与文件大小。

## 附录 3 · 2026-11-10，第 1 阶段追加两个配置（写于这两个配置的任何测量之前，仍未读取任何标注）

第 1 阶段运行 42764887346 中，OWLv2 与 OWL-ViT 的四个文件（A-q8、A-q4、C-q8、C-q4）在 transformers.js 4.3.2 自带的 ONNX Runtime Web 1.31.0-dev WASM 上都无法创建会话：“Could not find an implementation for Cast(13) node with name '/class_head/Cast'”。这是运行库缺少该类型的 Cast 内核，与模型精度无关，按“超出预算”同样处理：淘汰，不计算精度。

为判断这是运行库版本的问题还是模型本身，追加两个配置，**同样的模型文件**换用上一个大版本的运行库：transformers.js 3.8.1（2025-12-02 发布，Apache-2.0），它固定的 ONNX Runtime Web 1.22.0-dev.20250409-89f8206ba4（JSEP 构建，`ort-wasm-simd-threaded.jsep.mjs` / `.wasm` 取自 transformers.js 3.8.1 的发布目录，SHA-256 写在 `web/open-vocab.mjs`）：

| 编号 | 模型 | 文件 | 运行库 |
| --- | --- | --- | --- |
| A3-q8 | OWLv2 B/16 ensemble | `onnx/model_quantized.onnx`（155,312,754） | transformers.js 3.8.1 |
| C3-q8 | OWL-ViT B/32 | `onnx/model_quantized.onnx`（155,431,700） | transformers.js 3.8.1 |

预算、输入、计时方法、提前停止规则都与正文和附录 1 相同；只测 q8（q4 文件更大）。3.8.1 不支持自定义 `fetch`，所以模型下载不能中途取消（运行库下载仍可取消）；若选中它，页面在取消时如实说明。其余选择与上线规则不变：通过第 1 阶段的配置一起进入开发半。
