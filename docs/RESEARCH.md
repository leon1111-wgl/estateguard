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
