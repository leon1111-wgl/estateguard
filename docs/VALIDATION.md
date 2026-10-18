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

## 2026-10-16 · 模型加载、取消与公共资源缓存

```bash
node --test tests/*.test.mjs
node scripts/model-loading-check.cjs
node scripts/model-check.cjs
node scripts/critic-check.cjs
python3 scripts/verify_assets.py
python3 scripts/verify_parking.py
```

- 69项JS行为测试通过，其中9项新增加载器检查涵盖流式字节、校验/大小拒绝、腐坏缓存、网络取消/超时、缓存权限/容量/存储超时。缓存getter和存储挂起用例先失败再修复通过。
- 独立Chrome验收8类通过：挂起分片取消、取消后真实重试、500错误后重试、未完成下载时的真实进度、刷新缓存、同长度损坏缓存、禁用CacheStorage、挂起缓存写入取消。原失败场景超过6秒未解锁，修复后受控样本为55ms；缓存写入挂起取消为37ms。这些是本机受控验证，不是所有设备的延迟保证。
- 校车原图实际推理分数0.9916937947，正常规则生成1条需人工核对的候选；取消不会生成候选。迟到请求和缓存写入不覆盖新素材状态。当前页再分析，`reused_in_memory=true`，本轮资源读取及加载/初始化字段为0。
- 新页面冷加载读取20,040,985字节公共资源；同浏览器context刷新后8项均使用已校验CacheStorage，模型/运行脚本请求0次。缓存中只有2个运行脚本、模型结构和5个权重分片，无用户素材或复核内容。只修改一个分片的一个字节后，该分片被重新下载和校验。
- 本地一次冷加载总准备840ms、其中初始化675ms；缓存加载807ms、其中初始化678ms。缓存减少重复下载，但单次差异不足以证明普遍加速，不能据此推算通用加速倍数。完整每次测量保留在报告中。
- `model_loading.load_ms`为总准备耗时，包含其子项`initialization_ms`；`network_bytes`按经网络读取的解码后资源大小计，不是HTTP压缩后线路流量。显式网络读取绕过浏览器HTTP缓存，缓存复用由本项目的校验缓存统计。
- 原模型链路再验证通过：公开图片检测、真实可解码短片7帧、候选送审和人工排除、重复推理张量262→262，无外部请求。原素材快速替换和失败保留回归通过。11项运行资源及12,830项停车数据哈希通过，本轮未修改权重、数据或评测结果。
- 设计师1440px与390px回归无溢出。手机自然点击开始后，原进度行在视口上方；修复后底部反馈区域约y658–719，包含真实读取/缓存摘要，取消按钮y594–627，同屏可操作。未调整原版面框架。

证据：[加载流程验收](validation/model-loading-validation.json)、[界面与自然操作回归](validation/model-loading-ui-validation.json)。网络中断通过控制真实响应模拟；完整离线站点、低端手机各型号与长时间缓存配额竞争仍未验证。

## 2026-10-16 · 检测分数与 NMS 分离

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/patch_coco_ssd.py --check
python3 scripts/verify_assets.py
node scripts/detection-threshold-check.cjs
node scripts/model-check.cjs
node scripts/model-loading-check.cjs
```

- 72 项 JS 测试、6 项 Python 标注检查通过。新增 3 项使用真实 TensorFlow NMS 和受控图输出张量，隔离检查重复框、适度重叠目标和分数筛选；旧版为 2 红/1 绿，补丁后全绿。这些受控张量不充当实际模型效果证据。
- 独立浏览器 7 项真实推理验收通过，页面异常和跨站请求为 0。原版与补丁的默认 0.5 输出按类别、框坐标、分数逐项对照，容差 1e-6；0.95 下同一校车重复框与候选从 2 变为 1。0.1 保留低分人员/远车，升高分数只删除结果；没有固定低分候选必须只有一条。
- 合成图由同一 CC0 校车照片的两个相离副本组成，真实推理仍产生 2 辆车、2 条候选。图片与合成排布用于特定故障回归，不代表真实多车召回率。
- 导出记录分数、IoU=0.5、补丁标识、最多 50 框、每秒 1 帧/最多 20 帧、实际片段起点。原短视频回归另验证 offset=2 秒时首帧为 2 秒，候选绝对时间比原素材起始时间晚 2 秒。图片实际 offset 为 0。
- 同浏览器预置旧哈希脚本缓存后，重新加载只重新获取 1 次新脚本，0.95 推理为单车单候选。返回缺少补丁标识的旧清单时，在模型加载前明确失败；素材、规则与操作控件保留，恢复当前资源后直接重试成功。原版默认对照使用独立 context 受控替换运行脚本与对应哈希，模型权重与公开图片仍为真实文件。
- 旧的 8 类下载/缓存故障验收再次通过；原校车分数仍为 0.9916937947，视频实际处理 7 帧，重复推理张量 262→262。补丁与固定上游逐字节重建一致；11 项资产校验通过，权重没有变化。
- 独立设计师检查 1440px 与390px 实际截图，无横向溢出。说明与分数字段有无障碍关联；高分候选送入复核后仍要求人工核实，排除后退出待办。没有更改 CSS、导航或版面。

证据：[原故障基线](validation/detection-threshold-baseline.json)、[版本混用失败基线](validation/detection-mixed-deployment-baseline.json)、[修复后验收](validation/detection-threshold-validation.json)、[界面回归](validation/detection-threshold-ui-validation.json)。未做新的社区领域评测、训练或量化；素材时间/区域沿用问题另记在 BACKLOG。

## 2026-10-16 · 素材现场确认与失败替换保留

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s tests/training -p 'test_*.py'
python3 scripts/verify_assets.py
python3 scripts/verify_parking.py
node scripts/media-context-check.cjs
node scripts/model-check.cjs
node scripts/model-loading-check.cjs
node scripts/detection-threshold-check.cjs
```

- 79 项 JS、6 项标注 QA、4 项训练基础检查通过。新增 7 项覆盖未知时间、日历/时区、素材版本、确认失效、明确复用及尺寸变化；对象模式的未知时间旧行为先失败后通过。训练检查用于回归基础实现，本轮没有重新训练模型。
- 独立真实 Chrome 新流程 10/10 通过，页面异常及跨站请求为 0。基线先复现旧来源/时间/ROI/片段起点继承与坏图清报告；修复后同尺寸图片和视频均先清空，手动复用仍要求新时间和重新核对。
- 导出记录当前来源、原始宽高与本地确认。换入同尺寸镜像图后，素材提交版本 1→2；手工测试时间 2026-10-16 09:20（UTC+8）产生 01:20Z 候选。另一条 08:15 流程实际送审，页面显示对应来源与当地日期时间。确认是人工操作记录，不是媒体元数据认证。
- 原图与双倍原始分辨率都显示为 960×640，仍拒绝沿用旧 ROI；640×960 竖图也恢复整幅。ROI 摘要显示当前范围。纯物体模式 `started_at:null`，真实检测到校车且候选为 0。
- 损坏 JPEG 显示中文错误，来源、确认、完成报告和导出逐项不变。受控延迟 `Image.decode()` 的成功与失败两种完成顺序均不能覆盖较新素材。加载未完成时可继续选文件，分析/编辑/送审/导出暂停，避免处理旧结果。
- 真实解码的合成短片在 offset=2 时采样 `[2,3]` 秒，候选开始比人工输入时间晚 2 秒；下一短片 offset=0、时间为空。合成短片来自公开照片重复画面，仅证明采样与时间绑定，不证明持续停留或真实行为精度。
- 原 `model-check` 通过图片检测、7 帧视频、送审排除、offset=2 导出与 offset=999 拒绝；张量 262→262。加载故障 8/8、阈值回归 7/7 通过；11 项资源、12,830 项公开数据哈希及全部 6,413 条停车测试预测重算通过，旧模型和评测结果保留。
- 独立设计师在 1440px 与 390px 重走未知时间物体检测、换素材、沿用、缺时间/确认报错、填写到秒的时间、真实分析、导出及送审。两端无横向溢出；遗漏日期聚焦 `vision-start`，遗漏确认聚焦复选框，手机错误提示与开始按钮同屏。确认后表单状态和底部提示一致，原红色错误已清除；原导航、字体、版面保留，仅增加必要控件样式。两端 09:30:25 测试输入均形成 01:30:25Z 的单车候选，送审原图可见。

证据：[原故障基线](validation/media-context-baseline.json)、[修复后验收](validation/media-context-validation.json)、[桌面与手机回归](validation/media-context-final-ui.json)。报告不携带媒体；配置目前只能在当前标签页显式沿用，不支持具名预设或检测报告恢复。

## 2026-10-16 · 冻结模型错例审查与原图可用性

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s tests/training -p 'test_*.py'
python3 scripts/audit_parking_errors.py --recompute --output artifacts/parking-error-audit.json
python3 scripts/verify_assets.py
python3 scripts/verify_parking.py
node scripts/parking-error-audit-check.cjs
node scripts/parking-check.cjs
node scripts/parking-critic-check.cjs
node scripts/parking-review-check.cjs
node scripts/model-check.cjs
```

- 全部 84 项 JS、14 项 Python、4 项训练基础检查通过。新增审计测试覆盖阈值边界、相机/车位隔离、错误标签/模型/分数/重复记录拒绝、原始分母、来源导出、全数据计数和真实冻结模型重算。Python 重算测试需现有 NumPy/Pillow；CI 安装依赖后执行，避免静默跳过。
- 全量 6,413 张原始 JPEG 的文件 SHA、解码 RGB SHA 与中心采样输入逐项一致；MLP32 重算分数最大绝对差 0.0（容差 1e-10），分类和分数带归属差异为 0。未训练、调阈值、改标签或替换权重。11 项资源和 12,830 项公开数据文件哈希通过。
- Python 与浏览器纯逻辑分别统计：53 个相机/车位的样本数、占用分母、两类错误、低分漏判及漏判比例逐项一致；1,485 个错例 ID 一致。263 个不确定样本中 127 个错误，区间外 1,358 个错误；B:12 的低分有车报空闲 102 个，空位报占用 0 个。
- 独立新浏览器验收先 0/8，修复后 8/8，无页面错误或跨站请求。全部错误、错误空闲、错误占用、低分错误空闲的下拉与导出数量依次为 1,485、1,134、351、1,037；导出样本 ID、分数、原图路径与 SHA 逐项对照发布文件。错误组合空结果不会显示全局无错。
- 实际选择 B-20150708-1645-52，请求其 PNG 输入并运行模型，浏览器分数 `0.000021880970806291324`，与冻结记录差小于 1e-12。导出仍保留原标注占用、实际模型预测空闲，未生成违规事件。模型输入 404 时保持未分析，离线分数不回填；重试后恢复真实预测。
- 原图 JPEG 404 而模型输入成功时，明确空闲/占用均不能保存；草稿、所选样本与 0/53 已确认数保持。可以保存需补证据，导出独立 `evidence_failures`，推理仍无失败。带查询参数的原图重试再次受控 404，仍无法明确确认；解除故障后原图 150px 成功显示，可确认占用，原分数不变。
- 旧 `parking-check` 全过，`parking-critic-check` 6/6、`parking-review-check` 9/9。旧复核脚本发现新增原图也使用车位 `data-sample-id`，导致选择器命中两个元素；产品改用独立证据属性后，原测试不变全部通过。保存/恢复、跨快照隔离、失败停止回放保留。
- 原 `model-check` 的 COCO 图片分数 `0.9916937947`，实际视频 7 帧，张量 262→262；非零片段起点与越界拒绝继续通过。它只是原通用链路回归，不是车位模型或违规行为精度。

- 独立界面设计师完成 1440px/390px 实际截图回归；选择错例后，当前车位进入网格滚动窗口，手机复核卡顶部 16px。展开车位分布表曾造成页面宽 513px，增加局部最小宽度约束后，页面宽 390px、表格容器宽 324px、内容宽 480px，仅在表内横滚。导出 B:12 的 102 张低分错例后，切到错误占用的空组合，旧“已导出”提示会重置；两端定向复查及独立 8 项验收均通过。保留既有视觉框架。

证据：[原失败基线](validation/parking-error-audit-baseline.json)、[原图缺失仍能确认的基线](validation/parking-photo-baseline.json)、[独立端到端验收](validation/parking-error-audit-validation.json)、[全量冻结重算及分布](validation/parking-error-audit.json)、[桌面与手机回归](validation/parking-error-audit-ui-validation.json)。受控网络故障用于复现失败恢复，公开历史图片用于实际推理；没有接入真实物业监控。

## 2026-10-17 · 冻结编码器迁移、CNR-EXT 保留测试与风险分流

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s tests/training -p 'test_*.py'
python3 scripts/verify_assets.py
python3 scripts/verify_parking.py
python3 scripts/verify_parking_transfer.py
node scripts/parking-transfer-check.cjs
node scripts/parking-check.cjs && node scripts/parking-review-check.cjs && node scripts/parking-critic-check.cjs && node scripts/parking-error-audit-check.cjs
node scripts/model-check.cjs && node scripts/model-loading-check.cjs && node scripts/detection-threshold-check.cjs && node scripts/media-context-check.cjs && node scripts/critic-check.cjs && node scripts/browser-check.cjs
```

- 102 项 JS（不含工作区中另一轮未提交的 evidence-media 测试）、14 项 Python、10 项训练测试通过。新增测试覆盖：两个线性头在真实特征上的浏览器/Python 分数（差 ≤1e-12）、L2-SP 自适应逐步一致（≤1e-9）、Learn then Test 阈值与 Clopper–Pearson 上界、车位·日计数在全部 B 上与 Python 一致、DINOv2 预处理与池化、模型切换时汇总与筛选使用分流状态。
- 资源：21 项模型/运行库/样本哈希（新增 DINOv2 int8 ONNX 与配置、ONNX Runtime Web 1.30.0 三个文件与 MIT 许可、两个线性头）通过。`verify_parking_transfer.py` 从发布文件重算 B 与全部 144,965 张 EXT 的 MLP32 与两个头指标，核对分类头/编码器哈希、默认模型规则，并按固定规则重推 27 个 EXT 子集快照。
- 特征可复现：网页模块重新提取的 12,584 张 MobileNetV2 特征与首次提取 SHA-256 相同；DINOv2 1 个与 4 个并行页面、普通导入与校验后导入的 ORT 结果逐位相同。
- 新浏览器验收（[报告](validation/parking-transfer-validation.json)）：编码器在 B 与 EXT 样本上与离线特征最大差 0；默认 DINOv2，B 首个快照页面与离线校准分数差 1.2e-15，未校准时 53 个车位全部送人工；12 条人工结论自适应后 25 个分数变化，清除后恢复原分数；B 单日数据校准被拒绝；修改已用结论与导入复核文件都会清除现场设置；C2 三个日期 27 个车位·日在 5% 目标下不通过；C8 EXT 快照三种模型与发布分数差 ≤5e-7（6 位有效数字）；上传单图、评测页 6 张表、390px 页面无横向滚动、无页面错误与跨站请求。
- 原有检查：`model-check`（校车 0.99169，7 帧，张量 262→262）、`model-loading-check` 8/8、`detection-threshold-check` 7/7、`media-context-check` 10/10、`critic-check`、`browser-check`、`parking-check`（MLP32 浏览器与 Python 差 4.4e-16）、`parking-review-check` 9/9、`parking-critic-check`、`parking-error-audit-check` 8/8 通过。旧车位检查改为先显式选择 MLP32，断言未放宽；`parking-review-check` 的首个用例两次在 15 秒内未等到分析完成（一次在 load avg 24 满载时，一次紧接重负载的迁移检查之后）；随后单独连续 3 次均 9/9，孤立复现 6 次 MLP32 快照分析均在 0.3 秒内完成。根因未定位，记为偶发，后续若再现需记录当时的页面消息与网络请求。
- 独立找茬与界面设计代理分别在 1440px/390px 实际操作，发现的问题见 IMPROVEMENT_LOG；修复后复核。

未验证：其他小区或夜间画面、低端手机上的 DINOv2 单线程耗时、长期运行中的阈值漂移处理。

## 2026-10-18 · 自动判定抽检与漂移撤销

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m unittest discover -s tests/training -p 'test_*.py'
python3 scripts/verify_assets.py
python3 scripts/verify_parking.py
python3 scripts/verify_parking_transfer.py
python3 scripts/replay_parking_audit.py --labels artifacts/datasets/cnr-ext/CNRPark+EXT.csv
node scripts/parking-transfer-check.cjs
node scripts/parking-check.cjs && node scripts/parking-review-check.cjs && node scripts/parking-critic-check.cjs && node scripts/parking-error-audit-check.cjs
node scripts/model-check.cjs && node scripts/model-loading-check.cjs && node scripts/detection-threshold-check.cjs && node scripts/media-context-check.cjs && node scripts/critic-check.cjs && node scripts/browser-check.cjs
```

- 已提交的 110 项 JS、14 项 Python、16 项训练测试通过；当时本地合计 116 项 JS，另 6 项属于并行开发、尚未接入页面的 evidence-media 测试。新增 8 项 JS（`parking-transfer-audit.test.mjs`）：哈希与 Python 一致（含中文），9 个 EXT 相机在 5% / 10% / 20% 下抽中的车位·日集合与 Python 逐项相同、嵌套且总比例接近 10%；CP 下界与 Python、闭式解一致；5% 目标下主规则与 x ≥ 4.94 + 0.0724n 在 n ≤ 400 内完全等价；C7、C8 的真实 20% 抽检序列在两种规则下的计数、证据值与撤销位置与 Python 相同；未核对按无错计、同一车位·日只计一次；合成数据 p = α 时误撤销 ≤ 3.5%；发布的回放复现基线 185 / 2,553。新增 6 项 Python：哈希定义、CP 下界、按出错次数分配水平与二项尾概率等价、主规则边界与误撤销、监视器计数、回放循环 f = 0 时等于 `routing_report` 且撤销从下一快照生效。
- `replay_parking_audit.py` 先用发布的 6 位有效数字分数复现附录 3/4 的全部 54 组阈值与不抽检基线（阈值与 9 项计数逐项相同，否则停止），再回放；标签与官方 `CNRPark+EXT.csv`（SHA-256 `26416454…a470dc8`）144,965 行全部一致，核对后删除下载文件。合成数据比较重跑后与附录 5 表格一致。`verify_parking_transfer.py` 现在整份重算回放并与发布 JSON 逐项比对。
- 浏览器验收（[报告](validation/parking-transfer-validation.json)）新增 C6 流程：分析 3 个快照后，为 116 个未抽中车位·日填入人工结论（验收脚本用数据集标签代填），5% 目标下占用侧通过（≥ 0.85）；9 个抽中车位·日显示「抽检」、隐藏模型概率、计入“含抽检”、在导出中 `audit=true` 且送人工，导出的抽检样本与按哈希独立计算的一致；在抽检筛选下“保存并继续”停留在抽检车位，快照内抽检全部确认后停在原车位并提示；勾选数据集标注时盲审车位不显示“一致/错判”；前 5 个保存为“错误”不撤销，第 6 个时证据值 64 ≥ 40 撤销占用侧，导出保存全部 9 个抽检及结论（撤销侧计数取自撤销记录），该侧不再自动判定，详情对阈值之间的车位也说明已撤销；6 条全部改回不恢复阈值；切换风险目标后撤销记录仍在，MobileNetV2 也受限制；切到 MLP32 时抽检筛选复位；导出后在新页面恢复、重新分析并校准，撤销记录被读入且旧证据不能重新通过阈值；390px 无横向滚动。原有的编码器对齐、默认全部送人工、自适应、单日拒绝、修改与导入作废、C2 三日不通过、C8 三模型分数对齐、上传、评测页（现 8 张表）与手机检查全部保持通过。独立找茬/界面代理的 12 项发现与复验时的 3 项次要问题见 IMPROVEMENT_LOG，修正后重新运行。
- 原有检查：`parking-check`、`parking-critic-check`、`parking-review-check` 9/9、`parking-error-audit-check` 8/8、`model-check`（校车 0.99169，7 帧，张量 262→262）、`model-loading-check` 8/8、`detection-threshold-check` 7/7、`media-context-check` 10/10、`critic-check`、`browser-check` 通过。工作区里另一轮未提交、尚未接入页面的 `event-media-check` 失败 2/2（`web/evidence-media.mjs` 未被任何页面导入），与本轮无关，未改动。

未验证：真实部署中抽检员的判断质量、撤销后重新校准的回放、其他停车场与夜间画面的漂移形态。


## 2026-10-18 · 事件复核附件的原子替换

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
node scripts/event-media-check.cjs
node scripts/model-check.cjs
node scripts/browser-check.cjs
node scripts/critic-check.cjs
```

- 全部 116 项 JS、14 项 Python 通过。本轮 6 项状态测试验证旧证据保留、迟到成功释放、迟到失败隔离、不同事件独立、工作区同 ID 重置和多个候选共享文件的最后引用释放。
- [独立旧版复现](validation/event-media-baseline.json)和[旧版 0/2 回归](validation/event-media-baseline-tests.json)保留；[修复后 10/10](validation/event-media-validation.json)使用真实 Chrome 解码与真实 COCO 推理，页面错误、跨站请求均为 0。并发用例只延迟原生 decode 已返回的结果，不伪造像素或模型结果。
- 损坏 JPEG、MP4 均保持旧文件地址可读、预览节点、草稿与处理状态。有效 MP4 的失败替换还保持播放位置。读取期间保存按钮禁用，直接派发表单提交也不能产生历史记录；完成后可继续保存。
- 原生图片解码成功和失败迟到均不能覆盖最新选择；切换事件、重置工作区后，即便事件 ID 相同也不会串附件。第一次坏图没有伪造预览，同文件再次选择执行第二次实际解码，随后正常文件恢复。
- 真实 COCO 校车分数 0.9916937947，1 个候选送审后显示 960×640 原图；人工结论与理由导出、恢复正确，JSON 不含 blob 地址、媒体内容或后加的本地文件名。恢复后就地提示未载入本地证据。短片由公开 CC0 图片重复编码，只验证播放与附件流程，不代表行为识别测试。
- 原模型浏览器回归通过：实际 7 帧、张量 262→262、片段起点 2 秒与越界拒绝；旧 browser-check 与 critic-check 通过。model-check 增加等待新附件解码完成再检查送审画面，原检测和复核断言保持。
- [独立桌面与手机报告](validation/event-media-ui-validation.json)：1440px、390px 均无横向溢出；长文件名、就地失败提示、读取禁用及跨事件返回保持批准布局。截图保存在本地 artifacts/workspace-evidence-ui-final-*，已逐张审查。

额外独立[真实解码超时检查](validation/event-media-timeout.json)：实测 10,032 ms 后提示失败、原画面与草稿保持，挂起新地址已释放；迟到完成不会提交，后续重试成功，页面错误 0。

未验证：整个视频后续帧是否损坏、媒体与事件事实对应、跨会话可信媒体归档。附件超时限制 10 秒，失败可重新选择；不把这些工程检查作为领域检测精度。

发布前接续核验：上一轮抽检提交 a8cbad4 尚未推送，本轮独立重新运行 16 项训练检查、模型资源校验和全部迁移/抽检回放重算，并完整执行 parking-transfer-check。真实编码器前向、C6 抽检撤销、导出恢复及三模型 EXT 对照均通过，无页面错误或跨站请求；未修改其模型或抽检规则。独立报告保存在 artifacts/review-a8cbad4/parking-transfer-validation.json。


发布校验的补充说明：Linux 首次失败后，通过[严格诊断运行](https://github.com/leon1111-wgl/estateguard/actions/runs/39095950159)定位 CP 统计数值差，最大 7.9447e-13。比较器只允许明确路径下 CP statistic 的绝对误差 1e-12，且两个值在目标 alpha 同一侧；所有离散结果、阈值、SPRT 统计值与其他报告字段严格一致。完整报告的 elapsed_seconds 是本机运行耗时，检查类型与有限值，不要求两次耗时相同。回归测试保留真实 Linux 数值对，同时篡改计数、阈值、撤销时间/位置、类型、数组和非有限数，验证仍能阻止发布。原保存结果与模型文件均保持不变。

比较器修复的本机验证：新增 10 项回归先失败后通过，完整 Python 检查 24/24；重新运行 verify_parking_transfer.py，通过全部 144,965 张 EXT 分数、54 组阈值与完整抽检回放。最终部署仍须由 Linux CI 对同一提交验证。
