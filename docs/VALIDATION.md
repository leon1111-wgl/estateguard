# 验证记录 · 2026-10-15

## 本地自动检查

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/verify_assets.py
python3 scripts/audit_annotations.py data/annotations-example.json
node scripts/evaluate.mjs
```

48 项 JavaScript 行为测试、6 项 Python 标注 QA 测试通过。10 个模型/运行库/样本资产哈希通过，权重字节数与 TensorFlow tensor manifest 一致。合成事件结果可通过 `scripts/make_demo.py` 和 `scripts/evaluate.mjs data/demo.json data/reference.json --write` 再生成。

## 浏览器验证

开发检查使用 Playwright 1.62.1 和本机 Chrome。启动 `python3 -m http.server 8766 --directory web` 后：

```bash
npm install
npx playwright install chromium
node scripts/browser-check.cjs
node scripts/critic-check.cjs
node scripts/model-check.cjs
```

已有浏览器可通过 `CHROME_PATH` 指定可执行文件；`PLAYWRIGHT_MODULE` 可指向已安装包目录；`ESTATEGUARD_URL` 可指向部署根地址（末尾不加 `/`）。

- browser-check：中文桌面/390px、草稿切换、复核、工作区恢复、失败导入不修改原状态、筛选、文本注入、完整日期、本地媒体、规则修改。
- critic-check：预约例外人工升级后进入待办，结案后计数恢复；快速换文件竞态；失败替换保留此前素材。
- model-check：实际小模型读取公开图片，显示框，规则候选送审，人工排除；生成可解码的合成视频并真正推理采样帧；重复推理无持续张量增加；超出视频起点拒绝；没有跨站素材上传。

模型运行数据见 `docs/validation/`。CI 执行 Node/Python/资产/合成再生成检查；浏览器与GPU推理检查目前在本机执行，不能把 CI 绿灯理解为全部硬件兼容。

## 尚未验证

真实物业视频上的领域精度、每小时误报与事故/损坏减少；长期多日运行；移动端各型号推理速度；多人共享权限；生产后端；电梯/垃圾专项行为模型训练、蒸馏和量化。车位占用模型已独立实际训练，见下节。

## 发布核验

- 应用提交 `3a67c8e` 的 [验证与发布工作流](https://github.com/leon1111-wgl/estateguard/actions/runs/38756970035) 成功；主页提交 `439edf8` 的 [发布工作流](https://github.com/leon1111-wgl/leon1111-wgl/actions/runs/38757048656) 成功。
- 应用 HTML、CSS、四个逻辑模块、模型结构，以及个人主页 HTML，共 8 个线上文件与本地字节一致，见 `validation/deployed-assets.json`。
- 在公开 GitHub Pages 地址重新运行真实模型图片/视频验证、送审、排除、张量稳定与手机布局检查，全部通过；见 `validation/deployed-model-validation.json`。个人主页的项目入口在桌面与 390px 下可见且无页面横向溢出。
- 第一次线上模型加载超过 120 秒的测试等待时间；放宽等待并重试后通过。这是已发现的首次使用体验问题，不能由一次较快重试推断所有用户的加载速度。后续须改进下载进度、缓存与弱网恢复。

## 2026-10-16 · 公开数据停车链路

本轮全部58项JavaScript行为测试通过（包含10项新增停车检查）；原有基线仍保留。

- 完整官方归档：36,596,809字节，ZIP CRC通过，12,584个唯一样本；锁定来源SHA-256。
- 实际训练：A相机训练4,284、验证1,275、间隔612；B相机测试6,413。按验证损失选MLP32第39轮；两候选训练日志、全量划分和权重已保存。
- `scripts/verify_parking.py`：核对12,830个公开数据文件哈希、每个测试样本与来源对应、帧/像素跨分区隔离、模型哈希、全部6,413条预测重算的混淆矩阵、复核区和多数类基线。
- Python训练单测4项通过：特征、分组隔离、实际优化和权重往返、漏判计数。原Python标注QA单测6项仍通过。
- 浏览器实测首快照53张图片，模型从图片像素计算；与Python输出最大绝对差 `4.44e-16`。同像素换无标签文件名上传结果一致。所有1,485个测试错例可选。
- `scripts/parking-check.cjs`：已分析与未分析计数、标签对照、草稿保留、人工记录导出恢复、失败恢复原子性、历史回放实际推理、读取失败保持未分析并重试、正常占用不生成违停、桌面/390px布局。
- `scripts/parking-critic-check.cjs`：6项独立找茬回归，包括超过旧8MiB限制的文件往返、24MiB人工记录边界、异步恢复次序、手动分析/播放顺序、错例跨帧跳转、手机点选定位。24MiB人工记录加全部6,413条预测导出27,818,317字节，可恢复；保存超限保留旧记录与草稿。
- 原 `browser-check.cjs`、`critic-check.cjs`、`model-check.cjs` 再次通过。COCO图片分数仍为0.99169，实际视频采样7帧，重复推理张量262→262；属于运行回归，不是停车模型的效果评测。

复现新增检查：

```bash
python3 -m pip install -r requirements-training.txt
python3 -m unittest discover -s tests/training -p 'test_*.py'
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
python3 scripts/verify_parking.py
node scripts/parking-check.cjs
node scripts/parking-critic-check.cjs
```

CI执行JS、Python、模型/数据完整性和合成流程再生成；真实浏览器交互仍在本机验证。推理输出真实不代表领域泛化合格：测试仍有1,134张占用图错报空闲，详见 [PARKING_DATA.md](PARKING_DATA.md)。

## 2026-10-16 · 人工复核完成状态与连续操作

- `node --test tests/*.test.mjs`：60项通过，新增2项先失败后通过，覆盖人工状态独立于模型分数、同车位不同快照隔离、未完成队列循环及全部完成。
- `node scripts/parking-review-check.cjs`：前8项独立浏览器验收先全部失败；追加回放失败保存回归也先复现失败，修复后9项全部通过，无页面错误或外部请求。首快照未复核53项全部待办，模型不确定筛选只有B:35；确认后人工待办52项。B:1模型分数0.028534，人工无法判断后仍进入需补证据。
- 导出/恢复检查保存4条记录，其中2项已确认、1项待复核、1项需补证据；恢复后待办仍51项。故意伪造导出统计为53项完成，恢复仍重新计算为2项完成。人工操作前后的模型分数、原始标签与模型统计逐项相同。
- 空理由保存失败时保留选择、草稿、进度；补理由后只前进一项。回放中人工编辑即暂停，失败保存后等待2.3秒仍保持原时刻、原草稿与0项完成进度。最终53项全部确认时仍停留在08:05快照；下一时刻同一车位独立待复核。
- `node scripts/parking-check.cjs`：公开像素真实推理、失败重试、回放、上传、原有导出恢复与桌面/390px流程通过；首快照53项与Python输出最大差仍为 `4.44e-16`。
- `node scripts/parking-critic-check.cjs`：原6项容量/竞态/播放回归通过。4,100条记录导出8,390,577字节可恢复；24MiB人工记录加当前53项预测导出25,188,924字节可恢复，超限保存/恢复保留原记录和草稿。旧脚本等待保存提示的断言已同步新就地反馈。
- `node scripts/model-check.cjs`：原COCO图片检测分数0.9916938，实际视频采样7帧，重复推理张量262→262，未发出跨站请求。它是原链路运行回归，不是社区行为准确率。
- `python3 scripts/verify_assets.py`、`python3 scripts/verify_parking.py`：11项模型/运行资源及12,830项公开数据哈希通过，全部6,413条测试预测和划分核验通过；本轮未改权重、数据、阈值或性能记录。
- 独立设计师检查1440px和390px截图、六种筛选、六页面导航、正常/失败保存、最后一项和重新打开。无横向溢出或页面错误；手机保存并继续后复核卡顶部约16px，保存反馈位于678–738px，在844px视口内。原CSS完全保留。

机器证据：[人工复核验收](validation/parking-review-validation.json)、[界面回归](validation/parking-review-design-validation.json)。浏览器检查依赖配置沿用上文；未新增数据或训练，改进只涉及人工复核的正确性和可操作性。
