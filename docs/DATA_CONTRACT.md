# 输入、导出与数据质量

## 原始观察批次

JSON，版本 1。最多 5 MiB、10,000 条记录。见 `data/demo.json`。导入原子执行，任一记录错误时不替换现有工作区。

```json
{
  "schema_version": 1,
  "name": "A栋早班",
  "provenance": "本地模型候选，尚未人工核实",
  "observations": [{
    "id": "obs-001", "camera": "lift-a", "zone": "A栋客梯", "track": "track-1",
    "category": "bulky_load",
    "start": "2026-10-15T08:00:00+08:00", "end": "2026-10-15T08:00:10+08:00",
    "score": 0.82, "quality": 0.4,
    "summary": "识别到行李箱，需核对场景与搬运许可。",
    "evidence": ["clip.mp4 @ 0.00s"], "move_permit": false
  }]
}
```

- `id` 必须唯一；`camera`、`zone`、`track` 非空。track 仅为来源侧匿名目标编号，不是住户身份。
- 八类事件键：bulky_load、door_obstruction、lift_impact、illegal_parking、blocked_access、wrong_way、waste_dumping、waste_overflow。
- `stable_segment_id` 可选，仅用于 `illegal_parking`，须为 1–100 字的非空字符串。来源应在同一轨迹的全部区域访问中为各稳定段分配不同标识；同摄像头、区域、轨迹和类别下，不同标识以及有/无标识的观察分开合并。它不替换 `track`，随工作区导出恢复保留。旧输入不含该字段时维持原合并语义；标识不是停车事实或来源认证。
- 时间需含时区，真实日历日期，结束晚于开始，每个区间最长 24 小时。界面统一显示 UTC+8 和日期。
- score、quality 是 [0,1] 的有限数值。quality 由来源提供，不默认是校准过的质量模型分数。
- 浏览器视觉模块输出 quality=0.4，作为保守的人工复核标记。单图时间窗为 1ms 格式占位，不代表持续行为。视频区间由稀疏采样估计，不作为连续停留证明。
- move_permit 是布尔值。这里只表示来源声明，不具备真实预约数据库验证。只影响大件规则。
- evidence 是本地引用标签，不自动请求 URL 或打开远程素材。最多 20 条引用；完整检测报告可包含所有帧。 单条须为非空字符串，最多 512 个 UTF-16 码元（JavaScript `length`）；为完整文件名与 ` @ 采样秒数s` 留出空间，不截断、替换或规范化原文。其他字段及批次/工作区总字节上限不变。旧短引用仍可恢复；包含超过 240 码元引用的新交班文件需要新版页面，旧版读取器可能拒绝，应先刷新到新版本。此标签不是媒体校验或真实性证明。

## 工作区

`format: estateguard-workspace`、`version: 1`；包含 batch、policy、decisions、audit。最多 32 MiB、50,000 条审查记录。导出不重复存储可重算事件；恢复时重新计算，并校验决策与审查历史一致。

2026-10-24 起，新事件同起点观察按 ID 的 UTF-16 码元顺序确定 `event:<观察ID>`，不使用本地语言排序。ID 保留原字符串，不拆分冒号、不裁剪空白或归一化 Unicode。旧版版本 1 文件若有人工历史，只接受对应事件**最早时刻成员**的编号；最早时刻按时间戳解析后的同一瞬间判断，针对每个合并后的时间分段，不能借用其他相机、区域、轨迹、类别或停车稳定段的观察。一个事件只允许一个历史编号；后续观察冒名、未知编号、多个历史编号冲突或 decisions 与 audit 不一致均拒绝。

新版保留合法旧编号及全部人工记录，继续保存沿用该编号；没有历史的事件使用稳定编号。不会新增持久字段或修改输入批次。规则重置清空历史后也恢复稳定编号。模块调用方若需要恢复人工记录，应使用 `buildWorkspaceEvents(workspace)`，不能用纯规则 `buildEvents(batch, policy)` 的新编号直接查旧 decisions。该兼容面向新版读取旧交班，不保证旧程序读取所有新导出，也不证明历史或素材真实性。

历史可编辑 JSON，不是防篡改审计系统。没有用户认证和不可否认性。浏览器内草稿跨事件切换保留；未保存草稿阻止导出以免遗漏。记录仅在当前标签页，导出是持久化方式。

批次可包含 `analysis_id`（可选，1–100 字的非空字符串）。本地检测使用随机 UUID 标记一次分析，并随工作区原样导出、恢复；旧批次缺少此字段仍可使用。只有同一标识和完整批次均一致才复用已有复核；仅事件 ID、轨迹或分数一致不够。JSON 键序变化会保守地按替换处理，不做模糊内容匹配。

## 检测报告

`format: estateguard-detections`；包含模型/运行库版本、后端、来源文件元数据、阈值、区域、场景参数、逐帧检测框、匿名轨迹、规则候选与实际耗时。它是视觉模块的可复查原始输出；用「送入事件复核」产生兼容的观察批次。

2026-10-23 起保留 `version: 1` 与原 `complete` 布尔值，并增加 `outcome`：`completed`、`stopped` 或 `failed`。只有 `completed` 的 `complete` 为 `true`；其余状态的 `candidates` 为空，不允许送审。`metrics.planned_frame_count` 是本次计划采样数，`metrics.frame_count` 与 `frames.length` 只统计成功帧；平均推理耗时也只使用这些帧。旧报告没有 `outcome` 时，不能仅凭 `complete:false` 推断中断原因。

失败报告的 `failure` 包含 `stage`（`frame_decode`、`inference`、`tracking` 或 `rules`）、`message` 与 `sample_time_seconds`。帧级失败时间为相对原素材的尝试采样位置，不表示该帧已经完成；非帧级派生失败为 `null`。帧失败后若连轨迹整理也失败，会另记 `tracking_error`，保留 `frames`、将 `tracks` 留空并明确提示；不能把空轨迹理解为未检测到物体。正常完成或手动停止的 `failure` 为 `null`。零成功帧的失败不生成检测报告，加载失败/取消亦不伪造结果。报告不含原始图像、视频或可恢复的推理检查点。

2026-10-16 起的报告在 `params` 中保存实际 `minimum_score`、`nms_iou_threshold`、`postprocess` 补丁标识、`max_detections`、`offset_seconds`、`sample_interval_seconds`、`max_frames`。片段起点为相对原素材的秒数，图片实际为 0；`started_at` 是原素材开始时间，候选绝对时间在此基础上加采样秒数。旧报告缺失这些字段时不得假定当时用了默认值，无法完整重现其检测设置。报告不包含原始媒体，当前也没有从检测报告一键恢复分析设置的入口。

2026-10-19 起增加 `rules_version: vision-rules-v2-stable-dwell`、`tracking_max_gap_seconds: 1.6`、`parking_max_center_distance: 0.06`（片段内归一化检测中心最大两两距离）及 `parking_min_samples: 3`。停车候选只包含达标稳定段的时间、分数与证据，使用 `stable_segment_id` 保持下游分段。旧报告缺少这些字段时不能按新规则解释已有结果；需要原始媒体重新分析。

2026-10-20 起，`params.dwell_seconds` 仅在 `rule: parking` 时为实际使用的 2–19 秒数值，其他规则为 `null`；`params.expected_direction` 仅在 `rule: direction` 时为有效方向，其他规则为 `null`。`null` 表示本次未使用，不表示使用默认值。界面仍保留闲置控件的本页草稿，切回对应规则后重新校验；该草稿不进入本次检测报告。图片的 `offset_seconds` 固定为 0，视频必须满足 `0 ≤ offset_seconds < 素材时长`。旧报告可能携带未生效的停留或方向值，解读时仍须以 `rule` 和媒体类型为准。

素材确认版本增加 `media.width`、`media.height`（原始尺寸）以及 `params.context_confirmed`。顶层 `context_confirmation` 为 `{media_revision, confirmed_at}`，只有规则分析通过当前素材核对时才有值；通用检测为 `null`。`media_revision` 只是本标签页内成功替换素材的计数，不是跨会话文件标识；`confirmed_at` 是勾选时间，不是拍摄时间，也不是受认证的审计凭证。

`params.started_at` 可在通用物体检测中为 `null`，来源和区域名也可为空；此模式始终没有候选。事件规则则要求有效来源、区域名、素材时间与当前确认；日期明确按 UTC+8，精度到秒。换素材不会自动继承日期或文件修改时间。公开校车图的具体拍摄时间未知，如填写日期演示规则，该日期属于人工测试输入，不是公开数据的真实时间标注。

## 车位复核与离线错例清单

车位人工记录使用 `format: estateguard-parking-review`、`version: 1`。`reviews` 按样本 ID 保存人工结论，`samples` 保存本次浏览器实际推理的分数与来源；`failures` 是模型输入读取失败，`evidence_failures` 是复核原图读取失败，后者含 `id`、`image`、`error`。原图失败不清除已计算的模型分数。恢复只采用校验通过的人工结论，不采用导入的预测、完成数或失败状态作为当前结果。记录可编辑，不提供身份认证或防篡改。

错例清单使用独立的 `format: estateguard-parking-error-audit`、`version: 1`，仅作只读分析，不支持恢复为人工复核：

- `prediction_source` 固定为 `published-fixed-model-evaluation`，表示已发布冻结评测。
- `model_sha256`、`predictions_sha256` 分别标识模型与完整逐样本预测文件，`dataset` 保留公开来源和时间说明。
- `filters.type` 为 `all`、`false_free`、`false_occupied` 或 `low_score_false_free`；最后一种为原标注占用且分数 ≤0.35。`filters.slot` 是 `all` 或相机/车位数组的 JSON 字符串，如 `["B","12"]`。
- `matched_count` 等于导出 `samples` 长度。每条含样本 ID、相机/日期/钟面时间/车位、原始 `label`、冻结 `prediction` 和 `score`、错误类型、原图路径及 `source_sha256`。分数未经校准，不是概率承诺。
- `summary` 与 `groups` 保留完整测试集的计数和按车位分布，不随当前筛选缩小分母；`samples` 仅包含当前筛选的错例。没有匹配只意味着当前组合为空。
- 读取时核对完整样本集合、唯一 ID、标签、模型标识、分数范围、阈值分类与正确性标志，并与总评测计数比对。哈希用于版本追溯，不是签名或原始标签正确性的认证。

## 标注 QA

`scripts/audit_annotations.py` 输入数组，字段为 video_id、track、start_s、end_s、label、annotator、split。label 支持上述八类及 normal，split 为 train、validation、test。

检查无效区间、精确重复、同一视频出现在不同划分、同轨迹不同标注者在时间 IoU ≥0.5 时的标签分歧。多标签事件可能合理，分歧只是裁决候选；不以多数票自动改写。此工具不计算标注准确率，不代替盲审金标准。

2026-10-21 起检测报告顶层增加 `analysis_id`。每次实际运行产生新值，送审沿用该值；它仅关联本次报告与送审批次，不证明媒体真实性或真实现场相同。旧报告没有此字段时不推断任务身份，现有导入校验继续兼容旧批次。
