# 来源与采用决策

核验日期：2026-10-15。检索围绕 scene-specific video anomaly detection、context structured VAD、open vocabulary VAD、lift bulky items、fire escape obstruction。以下为针对产品问题的选读，不是系统综述；未查询引用次数，未宣称模型性能可迁移到小区。

| 来源 | 证据层级 | 对本项目的作用 | 当前未实现 |
| --- | --- | --- | --- |
| Mumcu, Jones, Cherian, Yilmaz. **Is Video Anomaly Detection Misframed? Evidence from LLM-Based and Multi-Scene Models**, 2026. [arXiv:2605.12725](https://arxiv.org/abs/2605.12725) | 已读官方摘要；预印本 | 提醒异常依赖场景几何与上下文，因此区域和现场语义由用户显式指定 | 未复现作者模型与实验 |
| Kim, Oh, Cavallaro, Mo. **Context-structured Video Anomaly Detection with Large Vision-Language Models**, 2026. [arXiv:2607.19077](https://arxiv.org/abs/2607.19077) | 已读官方摘要；arXiv 注明 AVSS 2026 接收 | 环境、物体、时间分开描述；本项目将检测结果与场景/时间规则分层 | 未实现 CSI-VAD 多分支 VLM |
| Li et al. **Anomize: Better Open Vocabulary Video Anomaly Detection**, CVPR 2025. [arXiv:2503.18094](https://arxiv.org/abs/2503.18094) · [CVF](https://openaccess.thecvf.com/content/CVPR2025/html/Li_Anomize_Better_Open_Vocabulary_Video_Anomaly_Detection_CVPR_2025_paper.html) | 官方摘要与会议元数据；CVF 详情抓取受限 | 新类别存在检测与分类混淆，不能把 COCO 类别当成物业行为标签 | 未实现开放词汇异常分类 |
| Park, Kim, Kim. **Anomaly-Guided Observation and Two-Level Semantic Feedback for Training-Free Video Anomaly Analysis**, 2026. [arXiv:2610.16324](https://arxiv.org/abs/2610.16324) | 已读官方摘要；2026-10-12 预印本 | 未来可对高分片段做有目标的二次视觉核查；先保留可追溯帧引用 | 未运行论文模型，未使用其基准数字作为本项目结果 |
| [TensorFlow.js COCO-SSD 官方说明](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) | 已读随包 README 与 API；实际模型已下载运行 | 选用成熟、可自托管的轻量基线，输入浏览器媒体，输出类别/框/分数 | 没有宣称它是最新 SOTA 或已适配社区领域 |
| [香港机电工程署：负责人员资源](https://www.emsd.gov.hk/en/lifts_and_escalators_safety/responsible_persons_corner/index.html) | 官方索引检索；详情抓取超时 | 电梯与大件搬运的领域资料入口；具体规则必须由场地确认 | 未据此自动判断违法、载重或维修责任 |
| [香港消防处：Fire Escape](https://www.hkfsd.gov.hk/eng/education/cep_edu/cep/cep_3skill_index/cep_3skill_escape/fire_escape.html) | 已读官方页面 | 保持逃生通道畅通的领域背景，支持优先核查通道线索 | 非法律合规引擎，未将通用规则视为各地法规 |

上面的“采用”是工程设计推断，不是原论文为本产品背书。没有引用未观看的访谈或讲座，也没有声称开展了真实用户访谈。

## 下轮研究必须回答的问题

先在有许可的社区素材上量化错误：固定摄像头下有哪些 COCO 缺失类别？大件遮挡、人车交叉和夜间照明造成多少漏检？区域规则每小时误报多少？再决定是否引入领域检测器或时序模型。

若研究蒸馏或量化，应固定相同数据划分和推理硬件，比较模型大小、P50/P95 延迟、每小时误报与事件召回；训练/验证/测试按视频和场地隔离。当前尚未执行这些实验。

## 2026-10-16 · 模型资源加载的工程依据

核验 [TensorFlow.js 4.22.0官方API](https://js.tensorflow.org/api/4.22.0/#io.http) 中 `io.http`、`loadGraphModel` 的IOHandler及自定义fetch接口，并检查本站固定版本的COCO-SSD 2.2.3加载与预热实现。证据层级为官方API全文对应条目、随包源代码和本项目真实浏览器运行。采用IO路由接入可取消、带校验的资源读取，保留原检测器及预热流程；没有引入新算法、替换模型或用论文指标宣传效果。

缓存只节省重复资源读取，不省去新页面的模型初始化。加载统计分别记录网络读取、缓存读取、初始化和逐帧推理；Chrome受控网络/存储故障检查不能代替全部移动设备与真实弱网测试。

## 2026-10-16 · 检测分数与重叠框抑制的工程依据

核验 [COCO-SSD 2.2.3 官方版本源码](https://raw.githubusercontent.com/tensorflow/tfjs-models/coco-ssd-v2.2.3/coco-ssd/src/index.ts) 的 `infer` 实现及 [TensorFlow.js 4.22.0 NMS 接口](https://js.tensorflow.org/api/4.22.0/#image.nonMaxSuppression)。证据层级为已读官方函数全文、固定版本发布文件与本项目真实推理对照。原函数把同一个 `minScore` 传入两个含义不同的阈值；本地实测提高分数至 0.95 后，校车出现重叠度约 0.9496 的两框，进一步产生两条候选。

采用最小补丁固定 NMS IoU=0.5，保留默认行为、原模型和类别处理，分数继续由用户设定。选择依据是已定位的参数错误和可重复错例，无需新增算法或数据下载。限制：NMS 仍可能误抑制真实重叠目标；单张公开图片与合成多目标图仅验证这个故障，不能推导社区场景召回率或每小时误报收益。

## 2026-10-17 · 冻结编码器迁移、风险可控分流与现场自适应

核验方式：下列 arXiv 条目已读官方摘要页（作者、版本日期）；CNR-EXT 论文核对了数据主页的引用与 DOI 跳转，未读全文。本项目只实现了下表“已实现”列，没有复现任何论文的实验或数字。

| 来源 | 证据层级 | 已实现 | 未做 |
| --- | --- | --- | --- |
| Oquab 等，**DINOv2: Learning Robust Visual Features without Supervision**，[arXiv:2304.07193](https://arxiv.org/abs/2304.07193)；权重 [facebook/dinov2-small](https://huggingface.co/facebook/dinov2-small)（Apache-2.0） | 官方摘要与模型卡 | ViT-S/14 冻结特征；CLS 与图块均值拼接后训练线性分类头；int8 ONNX 在浏览器单线程运行 | 未微调编码器；未评估更大模型或 224/518 输入 |
| Guo、Pleiss、Sun、Weinberger，**On Calibration of Modern Neural Networks**，ICML 2017，[arXiv:1706.04599](https://arxiv.org/abs/1706.04599) | 官方摘要 | 在 A 验证集拟合单一温度 | 未比较其他校准方法 |
| Angelopoulos、Bates、Candès、Jordan、Lei，**Learn then Test**，[arXiv:2110.01052](https://arxiv.org/abs/2110.01052)（v5，2022-09） | 官方摘要 | 三态分流阈值的有限样本选择：Clopper–Pearson 上界 + Bonferroni | 未用固定序列或更强的检验；保证只在可交换数据上成立 |
| Li、Grandvalet、Davoine，**Explicit Inductive Bias for Transfer Learning with Convolutional Networks**，ICML 2018，[arXiv:1802.01483](https://arxiv.org/abs/1802.01483) | 官方摘要 | 分类头向源权重的 L2 约束（L2-SP 思路），用于新相机少样本自适应 | 未对编码器做 L2-SP 微调 |
| Amato、Carrara、Falchi、Gennaro、Meghini、Vairo，**Deep learning for decentralized parking lot occupancy detection**，ESWA 72 (2017) 327–334，[doi:10.1016/j.eswa.2016.10.055](https://doi.org/10.1016/j.eswa.2016.10.055) | 数据主页引用 | 使用其公开 CNR-EXT 数据作保留测试 | 未复现论文的 mAlexNet 或其报告指标 |

采用理由：物业现场标注少、相机多，工业上常用“冻结通用编码器 + 轻量头 + 现场少量标注”的方式快速上线；分流阈值必须带置信度保证，才能决定哪些车位可以不看。本项目的实测结果显示，在训练视角上得到的保证换到新视角会失效，需要现场重新校准，见 [PARKING_DATA.md](PARKING_DATA.md)。

## 2026-10-19 · 实时检测 Transformer

| 来源 | 证据层级 | 已实现 | 未做 |
| --- | --- | --- | --- |
| Peng、Li、Wu、Zhang、Sun、Wu，**D-FINE: Redefine Regression Task in DETRs as Fine-grained Distribution Refinement**，[arXiv:2410.13842](https://arxiv.org/abs/2410.13842)（2024-10 预印本；官方仓库未注明会议）；官方实现 [Peterande/D-FINE](https://github.com/Peterande/D-FINE)（Apache-2.0） | 已读 arXiv 摘要页与官方仓库 README/许可 | 用官方 N 版 COCO 权重导出 ONNX，在浏览器单线程运行，与 SSDLite 在 COCO val2017 上同协议比较 | 未训练、未在小区数据微调；未比较 RT-DETRv2、RF-DETR 等（体积 80–108 MB，不适合网页） |

社区转换的 `onnx-community/dfine_n_coco-ONNX` 在本项目冒烟测试中给出明显偏低的分数，与官方 PyTorch 权重不一致；改为自行导出并记录与 PyTorch 的数值差。COCO 是通用照片数据集，论文与本项目的 COCO 数字都不能代表小区监控画面上的检出率。
