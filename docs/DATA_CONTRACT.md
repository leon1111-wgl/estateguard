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
- evidence 是本地引用标签，不自动请求 URL 或打开远程素材。最多 20 条引用；完整检测报告可包含所有帧。

## 工作区

`format: estateguard-workspace`、`version: 1`；包含 batch、policy、decisions、audit。最多 32 MiB、50,000 条审查记录。导出不重复存储可重算事件；恢复时重新计算，并校验决策与审查历史一致。

历史可编辑 JSON，不是防篡改审计系统。没有用户认证和不可否认性。浏览器内草稿跨事件切换保留；未保存草稿阻止导出以免遗漏。记录仅在当前标签页，导出是持久化方式。

## 检测报告

`format: estateguard-detections`；包含模型/运行库版本、后端、来源文件元数据、阈值、区域、场景参数、逐帧检测框、匿名轨迹、规则候选与实际耗时。它是视觉模块的可复查原始输出；用「送入事件复核」产生兼容的观察批次。

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
