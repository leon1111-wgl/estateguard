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

## 标注 QA

`scripts/audit_annotations.py` 输入数组，字段为 video_id、track、start_s、end_s、label、annotator、split。label 支持上述八类及 normal，split 为 train、validation、test。

检查无效区间、精确重复、同一视频出现在不同划分、同轨迹不同标注者在时间 IoU ≥0.5 时的标签分歧。多标签事件可能合理，分歧只是裁决候选；不以多数票自动改写。此工具不计算标注准确率，不代替盲审金标准。
