# EstateGuard · 社区智能巡检

**把监控线索变成能复核、能解释、能交接的物业事件。**

[在线体验（中文版）](https://leon1111-wgl.github.io/estateguard/) · [项目案例](docs/CASE_STUDY.md) · [模型卡](docs/MODEL_CARD.md) · [数据与接口](docs/DATA_CONTRACT.md) · [研究来源](docs/RESEARCH.md)

![EstateGuard 运行真实小模型的中文工作台](docs/assets/workspace.png)

早班 08:00，住户搬运柜子进客梯，系统连续提醒；配送车辆停在通道旁，另一处摄像头画面太暗。物业人员需要知道：哪些提示属于同一件事、搬运是否有预约、哪些需要现场检查、交班时如何保留理由。

EstateGuard 将轻量视觉推理、场景规则、事件合并与人工复核串成一个可运行的 AI 应用。打开网页即可使用，不需要 API key 或付费服务。

## 已经能做什么

| 环节 | 可运行能力 |
| --- | --- |
| 本地视觉推理 | 本站自托管 COCO-SSD / SSDLite MobileNet V2，识别 COCO 物体类别，显示检测框和分数 |
| 图片与短视频 | JPEG/PNG/WebP、MP4/WebM；每秒采样一帧，单次最多 20 秒，可选片段起点 |
| 场景规则 | 用户指定区域内车辆、持续停留、疑似逆向移动、支持类别的大件物品 |
| 事件处理 | 按摄像头、区域、匿名轨迹、类别合并；预约例外、高风险低分线索和证据不足分别处理 |
| 人工复核 | 查看本地媒体，确认或排除线索、补充证据、完成处置；保留草稿、理由与历史 |
| 交接与评测 | 检测 JSON、可恢复的工作区 JSON、中文交接单；事件级基线比较、标注冲突与视频划分泄漏检查 |

**这版运行的是通用预训练小模型和可检查的规则。** 物体检测不等于违规识别。挡门动作、碰撞损伤、垃圾投放和精细大件分类尚无专用模型验证。八类事件都可以导入、复核；当前自动分析只覆盖上表的规则候选，不会自动认定损坏、身份或责任。

## 先体验一次

1. 打开网页，选择「使用公开示例图片」，或选择自己的本地文件。
2. 先运行「通用物体检测」，查看模型实际输出的框、类别和耗时。
3. 选择场景规则，框选关注区域并填写现场信息，再次分析。
4. 把候选送入事件复核，查看原素材并记录判断理由。
5. 导出工作区和交接单；重新导入 JSON 可以恢复审查记录。

示例校车图片来自 Wikimedia Commons，作者 Raysonho，CC0。它用于检查模型是否运行，**不是违规样本**。模拟班次是另一套明确标注的合成数据。

## 本地运行

Python 3.10+、Node.js 22+。运行应用不需要 npm 安装，模型资产已包含在仓库中。

```bash
git clone https://github.com/leon1111-wgl/estateguard.git
cd estateguard
python3 -m http.server 8766 --directory web
# 浏览器打开 http://localhost:8766
```

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/verify_assets.py
node scripts/evaluate.mjs
python3 scripts/audit_annotations.py data/annotations-example.json
```

标注审计退出码：`0` 无发现，`1` 存在需检查的问题，`2` 文件或输入结构错误。分歧不会自动投票改成“真值”。

浏览器检查为可选开发依赖：安装 Playwright 及 Chromium 后运行 `node scripts/browser-check.cjs`、`node scripts/model-check.cjs`。已有 Chrome 可通过 `CHROME_PATH` 指定；运行前启动本地服务。详见[验证记录](docs/VALIDATION.md)。

## 效果如何理解

固定合成班次含 36 条观察、9 个参考事件。相同分数门槛的逐条告警有 33 个条目；加入合并、预约/时间规则和高风险不确定性保留后，待办变为 9 个。其中匹配 8 个参考事件，仍有 1 个错误提示、1 个没有观察记录的漏检。

这是**流程回归结果**，不是视觉模型准确率，不代表节省了 72.7% 人工时间。完整匹配规则、原始输出和剩余错误见 [web/benchmark.json](web/benchmark.json) 与[案例](docs/CASE_STUDY.md)。真实模型推理的运行记录单独报告，不混用这套数字。

## 数据与隐私

素材、模型推理和复核状态在当前浏览器标签页处理；无后端、账户、分析埋点或素材上传。下载模型时会访问本站。关闭标签页前须导出；图片/视频不随工作区保存。没有接入真实监控，也没有人脸或身份识别。

本项目受原有社区安全监控经历启发，独立实现。未公开原单位视频、标注或模型；履历中的 150 小时、1 万张等规模不作为本项目已拥有的数据。微调、知识蒸馏、量化需要以后独立实验，当前不作已完成声明。

## 持续迭代

每轮由独立审查代理扮演物业值班员、住户或部署工程师，先复现痛点，再改代码并验证。另设界面设计师，按飞书式中文业务工具的方向审查桌面与手机布局、信息密度和操作顺序。问题、取舍和证据记录在 [IMPROVEMENT_LOG](docs/IMPROVEMENT_LOG.md)，下一步在 [BACKLOG](docs/BACKLOG.md)。自动迭代由本地 Codex 定时任务执行，仓库本身不包含自主执行的在线代理。

**作者：Leon Wang。** 第一版为中文，英文版在工作流成熟后增加。原创代码为 MIT；模型/运行库和示例素材按 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md) 中各自许可证分发。
