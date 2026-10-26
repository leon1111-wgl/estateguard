# 验证记录 · 2026-10-15

## 2026-10-26 晚间 · 撤回车位编辑后正常交班

已发布 `585074b` 的[正式红基线](validation/parking-draft-baseline.json)为 2/4：真正跨车位草稿保护与正常恢复通过，但新备注输入再清空、已保存结论和备注改出再改回，都会被“未保存的车位草稿”阻止导出，且触发离开保护。原代码每次输入无条件保存草稿并设置 `changed=true`，没有与已保存记录比较。基线真实运行 MLP32，首快照 53 张，无模型或产品状态替换。

修复后[专项 8/8](validation/parking-draft-validation.json)：空值/纯空白撤回不生成记录；已保存结论和备注撤回后原文与时间不变；其他车位真实草稿仍阻挡导出；已经保存但未导出的工作仍触发恢复确认和离开保护；撤回已导出内容不再误弹确认；旧交班 CRLF/CR 与首尾空白只在比较时对齐，导出原文不变；内部空格/空行仍算真实修改；坏导入和空理由保存失败保留草稿。新页面恢复人工记录与位置，预测数仍为 0，不把导入分数当本次模型输出。

[独立代码边界 6/6](validation/parking-draft-independent-validation.json)另验撤回、旧记录原文、已保存未导出保护、跨车位原始草稿、内部空白与失败保存；[独立界面回归 24/24](validation/parking-draft-ui-validation.json)使用桌面 1440px 与手机 390px 的实际截图，检查导出、原图/输入 DOM、焦点与布局。手机另补拍实际可见的结论、备注与光标截图，设计师与主代理均查看；补拍不重复计数。产品仅修改车位输入监听，不重绘表单、修改 HTML 或 CSS，也不改显式保存的时间语义。

```bash
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-draft-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-review-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-handover-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
```

浏览器使用已有 `PLAYWRIGHT_MODULE`、`CHROME_PATH`；新专项以 `PARKING_DRAFT_REPORT` 指定输出名称，可直接换 `ESTATEGUARD_URL` 验证线上页面，不拦截产品源码。实际 MLP32 的 53 个分数在编辑前后逐项相同，与既有 Python 记录最大差 `4.44e-16`。原车位复核 9/9、交班恢复 14/14、JS 146/146、26 个模型资源哈希通过。人工备注与旧交班内容是流程夹具，离开保护通过可取消的 `beforeunload` 事件检查，没有把这等同于所有浏览器的原生关闭弹窗验证。

首次找茬脚本用不存在的 `#parking-review` 定位截图导致中断，已单独保留，不计入产品失败；更正为 `.parking-review` 后冻结完整红报告，再修改产品。独立代码检查也有一次新页面初始导出等待超时，后续独立专项与 5/5 连续新页面导出对照均通过，原因未确定；保留诊断，不据此改产品或放宽草稿断言。

限制：本轮没有新训练、权重或准确率变化。真正草稿仍须逐条保存或改回原值后才能导出；没有自动保存、跨会话草稿恢复或多人同步。CI、远程提交与线上文件/流程另外核对。

## 2026-10-26 · 本地车位图片可以取消并保留成功结果

从已发布 `52bdabb` 复现：[正式红基线 0/2](validation/parking-upload-baseline.json)。首次 DINOv2 下载期间没有本地取消入口，交班恢复却要求先停止；坏 JPEG 替换清空成功图片、文件名和分数，只留下英文解码错误。等待真实资源放行后实际得到 DINOv2 输出，不使用伪造模型返回。

修复后[专项 7/7](validation/parking-upload-validation.json)：首次下载取消后恢复交班；真实 DINOv2 重试；坏图/错误类型保留同一结果 DOM 与 URL；MLP32 成功替换后才回收旧 URL；真实计算返回被受控延迟时保持互斥、允许人工复核，取消待计算结束才解锁；再次重试保留人工记录；公开快照分析中禁止并发上传，停止保留已完成的真实结果。空 `change` 是明确构造的边界，不当作原生文件选择器取消的证据。本地进度不再覆盖交班恢复失败提示。

独立代码审查还在初版修复中发现[核心配置等待无法取消](validation/parking-upload-core-baseline.json)：控制挂起核心 JSON，点击取消后仍锁住文件、模型、快照与播放按钮。补充取消共享请求的本地等待后，[核心专项 3/3](validation/parking-upload-core-validation.json)通过：请求尚未放行即可解除本地任务；迟到成功不写回已取消图片；立即新上传仍持有自己的锁；迟到 503 不覆盖取消状态，下一次上传可重新读取配置并完成真实 MLP32 推理。[独立事务补充 5/5](validation/parking-upload-transaction-validation.json)核对取消解码、空变更、旧 URL 回收、真实 DINOv2 重试与公开快照分数/人工结论隔离。

[独立界面回归 32/32](validation/parking-upload-ui-validation.json)检查 1440px / 390px 的进度、取消、重试、中文坏图提示、长文件名和复核导出。22 项在最终 JavaScript 上完成，另 10 项在局部禁用态 CSS 加入后检查核心配置取消与布局，报告分别记录两组。使用原按钮、工具条和消息样式，只为本地上传的禁用标签加既有禁用态；导航、字体和布局保持。设计师与主代理查看了实际截图，未见横向溢出；截图留在本地 `artifacts/parking-upload-designer-*`，公开报告只记录相对位置。

```bash
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-upload-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-upload-core-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-handover-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-error-audit-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/model-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
```

使用已有 `PLAYWRIGHT_MODULE` / `CHROME_PATH` 浏览器依赖。上传专项用 `PARKING_UPLOAD_REPORT` 指定报告名；核心专项用 `ESTATEGUARD_ARTIFACT_DIR` 指定目录。在线专项从被测站获取编码器源码，仅注入真实计算返回的等待，不把本地产品模块当线上版本；核心专项不拦截产品脚本。延迟、损坏 JPEG、HTTP 503 与人工备注都是明确测试条件，不是公开数据损坏率或现场观察。

原车位巡检通过，53 个 MLP32 分数与既有 Python 记录最大差 `4.44e-16`；车位交班 14/14、错例审查 8/8、JS 146/146、26 个资源哈希通过。原 SSDLite 图片及 7 帧合成短片实推通过，大巴分数 `0.9916937947`，张量 `262 → 262`。首次模型回归误把 URL 作为位置参数，脚本实际连接默认 8766 而失败；改用文档中的 `ESTATEGUARD_URL` 后通过，未修改产品或测试断言。专项、独立审查无页面异常；正式专项与界面检查无外域请求。

限制：已开始的解码或 WASM 计算仍可能需要等到返回才能完成取消；共享核心配置可在本地任务取消后继续加载。保留结果仅在当前标签页，本地图片不包含在车位交班导出中。没有新增模型训练、改权重或阈值，不能据此声称社区精度或实际效率提高。远程提交、CI 与线上文件和流程另行核验。


## 2026-10-25 晚间 · 车位模型的失败记录各自保留

旧版 `3ba5132` 的[正式红基线 0/2](validation/parking-model-failure-baseline.json)：真实 MLP32 成功分析首个快照 53 个车位；对 DINOv2 的单张原图 fetch 明确注入 HTTP 500，其余 52 张实际推理。切回 MLP32，界面显示“读取失败”但仍有有效分数，导出同时有 53 个结果、0 个未分析和另一模型的失败。MLP32 再分析成功后，DINOv2 仍缺该图，却丢掉错误提示。原图 img 请求保持正常，故障不替换模型、像素或成功结果。

修复后[专项 8/8](validation/parking-model-failure-validation.json)：成功模型与未运行的第三模型不继承错误；两个模型不同样本同时失败仍分别记录；成功重试只清除该模型的失败。当前导出 `failures` 与 `prediction_model` 对应，`failures_by_model` 保留各模型错误，与原图证据读取失败分开。模型切换保留所选车位草稿和人工结论，新页面导入只恢复人工结论与位置，不采用文件分数或失败记录。MLP32 的 53 张分数与既有发布值最大差 `4.44e-16`；DINOv2 重试恢复 53/53。前者是同一公开输入的一致性检查，后者是故障恢复检查，均不是新的盲测准确率。

[独立特征重试复核](validation/parking-feature-retry-validation.json)的 7 个阶段通过；[旧版对照](validation/parking-feature-retry-baseline.json)确认先成功后失败的样本会在现场重置时从 52 项恢复成 53 项，且旧错误仍在。修复后重置保持 52 项，该样本不再计为已分析的校准/自适应证据；实际重新推理成功才恢复 53 项。其他模型的 53 个分数逐项不变。这里保存的一条人工标签是明确的合成流程设置，单日校准没有通过任何自动分流阈值。

[独立界面回归 20/20](validation/parking-model-failure-ui-validation.json)：1440px / 390px 各 10 项。设计师与主代理查看实际截图，正常模型有分数且无错误提示，失败模型保留未分析与重试提示，原图、草稿、保存和导出可用，无横向溢出。保留用户认可的导航、控件、字体和布局，没有修改 HTML 或 CSS。专项与界面检查均无页面异常或外域请求。

```bash
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-model-failure-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-feature-retry-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-error-audit-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/parking-handover-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8768 node scripts/model-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
python3 scripts/verify_parking.py
python scripts/verify_parking_transfer.py
```

浏览器依赖通过 `PLAYWRIGHT_MODULE`、`CHROME_PATH` 指向已有 Playwright 与 Chrome；故障隔离专项用 `PARKING_FAILURE_REPORT` 指定报告文件名；特征重试专项用 `PARKING_EMBEDDING_REPORT` 指定，设置 `PARKING_EMBEDDING_BASELINE=1` 可在本地 Git 含旧提交时载入原模块复现旧问题。原错例审查 8/8、车位交班 14/14、JS 146/146、26 个资源哈希、12,830 个公开数据文件哈希通过。使用带 NumPy 的 Python 环境重算迁移验证：两分类头、B 分数、全部 144,965 张 EXT 的既有分数、27 个快照与抽检回放一致；系统 Python 初次因缺 NumPy 未执行该校验，切换已有依赖环境后通过，未更改数据、阈值或评测协议。原 SSDLite 实际图片与 7 帧合成视频回归通过，大巴分数 `0.9916937947`，重复推理张量 `262 → 262`。

限制：HTTP 500 是明确注入的故障，不是数据集损坏统计；公开停车场图片不是社区违停真值。未训练新模型、改权重或阈值，未测真实部署收益。各模型历史失败只保存在当前标签页并可导出，恢复不自动重放失败状态或推理；实际原图可读性仍需重新检查。CI、远程提交和线上验证另行核对，不能由本地通过代替。

## 2026-10-24 晚间 · 连续复核明确呈现下一个对象

```bash
node --test tests/*.test.mjs
node scripts/review-continuation-check.cjs
node scripts/handoff-navigation-check.cjs
node scripts/review-draft-check.cjs
node scripts/model-check.cjs
python3 scripts/verify_assets.py
```

本轮仍在隔离工作树，服务为 `ESTATEGUARD_URL=http://127.0.0.1:8767`，Playwright 与 Google Chrome 路径通过 `PLAYWRIGHT_MODULE`、`CHROME_PATH` 配置。核对远端 `fe9d034` 和上一轮成功发布后继续，未纳入主目录并行停车研究。

- [实际原版红基线](validation/review-continuation-baseline.json) 0/2：1440 / 390px 各运行一次默认 D-FINE-N，公开校车图生成 2 个通道候选。排除第一对象后已选中 track-3，队列 2→1，但标题分别在视口上方约 522 / 793px，焦点 BODY；相同素材和空理由框使目标变化不明显。独立设计师另用冻结的 `fe9d034` app/engine 复现，不能靠键盘 Tab 补回阅读上下文。
- [修复后专项](validation/review-continuation-validation.json) 8/8：2 项实际 D-FINE 流程与 6 类明确合成的操作边界。标题恢复至视口顶部约 52px，来源轨迹、状态和风险可见，标题接受程序焦点，Tab 进入附件或复核控件。两个实际候选分别保存不同结论，导出后对象与历史一致。合成边界覆盖同项普通保存、全部事件中结案不定位、下一项独立草稿与附件、空白理由失败、下一项附件加载期间禁止保存及迟到完成不抢焦点、末项空态与键盘导出、已处理筛选中重开。
- [独立代码回归](validation/review-continuation-code-validation.json) 9/9：桌面/手机非首项结案保持原先首个可见项选择规则；场景最后一项清空不跳到其他场景；50,000 条历史达到保存上限时拒绝新增，当前状态不变且重新导出与原始记录一致。图片解码通知延迟、自动换项后立即离开复核页，再完成解码，没有拉回页面、焦点或滚动位置。无页面异常，源文件 SHA 与最终实现一致。
- [独立界面回归](validation/review-continuation-ui-validation.json) 24/24，两宽度各 12 项。设计师与主代理均实际查看下一对象和末项空态截图，标题/轨迹/风险可读，草稿与正确附件保留，Tab 可从空态到交接单导出。无横向溢出、页面异常或外部请求。导航、布局、字体、控件与 CSS 未修改。
- 146 项 JS、26 项资产哈希通过。原候选首次送审定位 8/8、草稿工作流 11/11，均包含真实 D-FINE 调用。原 SSDLite 图片/短视频回归通过：大巴分数 0.9916937947、7 帧视频、重复推理张量数 262→262，无外域请求。检测权重、阈值、规则和数据格式未变。
- 原 `model-check` 首次并行运行在送审后等待复核页可见超时 30 秒；保留 `artifacts/review-continuation-model.log`。仅增加失败时页面状态输出的诊断重跑、随后原脚本原样复跑均完整通过，未再复现，根因尚未确定；未据此猜测修改产品或放宽断言。最终日志为 `artifacts/review-continuation-model-recheck.log`，这次单独失败不算通过。

限制：固定的是保存换项时的阅读交接，不是全站阅读位置恢复，也没有改变下一项的排序策略。标题使用 `tabIndex=-1`，并未新增常规 Tab 停靠点；只验证 Chrome 键盘流程，未做实际读屏软件兼容认证。公开照片、合成区域和时间只验证真实推理与复核链路，本轮没有新增训练、现场违规准确率或效率收益证据。

## 2026-10-24 · 跨浏览器语言交班与旧编号兼容

```bash
node --test tests/*.test.mjs
node scripts/locale-handover-check.cjs
node scripts/model-check.cjs
node scripts/reopened-review-check.cjs
node scripts/candidate-handoff-check.cjs
node scripts/browser-check.cjs
python3 scripts/verify_assets.py
node scripts/evaluate.mjs data/demo.json data/reference.json
```

本轮在隔离工作树运行，静态服务为 `ESTATEGUARD_URL=http://127.0.0.1:8767`；浏览器脚本通过 `PLAYWRIGHT_MODULE` 指向已安装 Playwright，通过 `CHROME_PATH` 指向 Google Chrome。没有更改主目录的并行停车研究。

- [旧版实际 UI 红基线](validation/locale-handover-baseline.json)：版本 `3141160` 的 app/engine，Chrome en-US 与 zh-CN 经页面导入合法合成观察、保存待补证据、下载 JSON，再交给另一语言的浏览器。并列起点的 `中-1` / `a-1` 分别生成不同编号，两方向均拒绝 `Invalid audit event`；不同组、不同起点两个对照通过，合计 2/4。旧版真实下载文件内嵌于新验收脚本，最终回归不依赖本地 artifacts 或旧 Git 历史。
- [修复后专项](validation/locale-handover-validation.json) 9/9：8 类合成身份/交接边界及 1 条真实 D-FINE-N 流程。覆盖新版双向恢复、旧 en/zh 文件分别在两语言恢复并继续保存再交班、无历史批次的稳定编号、不同事件隔离，以及多锚点冲突/非最早成员/未知编号/决策不一致的原子拒绝。失败不弹替换确认，不改变当前草稿、保存历史、附件地址或表单/图片 DOM。
- 默认 D-FINE 实际读取既有许可的公开校车图，大巴分数 0.9651602078，产生 2 个通道规则候选；不同对象保存不同人工结论后跨语言恢复，批次、任务标识、政策、决策和历史逐项一致。模型结果未注入或伪造；区域、来源名和拍摄时间为人工测试设置，不是照片的真实现场标注。导出不包含媒体，恢复后没有擅自复用附件。
- [独立设计师报告](validation/locale-handover-ui-validation.json) 17/17：1440px / 390px 两宽度检查新旧文件、旧编号继续保存、坏文件保留草稿与附件、取消替换和布局；另有真实 D-FINE 桌面到手机交班。设计师和主代理均查看实际恢复、历史与错误截图，无横向溢出、页面异常或外部请求。既有导航、布局、字体、控件、CSS 均未修改。
- 新增 8 项单测先在旧版失败再通过，全部 JS 146/146。包含子进程的 en_US/zh_CN 环境与输入反序、带冒号/空白/组合字符 ID、等时区偏移、不同时间分段和稳定段、旧编号续写、无效历史/容量上限，以及规则重置后回到新编号。26 项资产哈希通过；原合成评测 JSON 与已发布 benchmark 完全一致。
- [独立代码边界](validation/locale-handover-code-validation.json) 6 项检查通过：旧版 72 事件 / 144 条历史恢复与续写、5 类冲突拒绝；10,000 观察 / 50,000 历史可用，增大历史没有增加成员解析次数（本机 Node 观察，不是手机性能承诺）。另在[真实 Chrome 两语言](validation/locale-handover-order-validation.json)验证同起点跨组最终排序和 4 向旧文件恢复，原编号、成员、历史和人工结论不串联，无页面异常。
- 原真实 SSDLite 回归通过：图片大巴分数 0.9916937947、合成短视频 7 帧、重复推理张量数 262→262；原人工重开 6/6、候选交接 10/10、browser-check 通过。相关专项页面错误与跨站请求为 0。

限制：这是新版读取旧版本 1 文件的兼容修复，不保证旧程序读取所有新导出；历史可编辑，不是签名认证。固定编号不提供跨批次去重、多人合并或可信媒体绑定。本轮未更改模型训练、权重、分数门槛或行为规则，未产生社区精度或部署收益证据；Chrome 之外的浏览器尚未专项测试。关闭当前事件后下一项标题可能在屏外的阅读问题仍单独列在 BACKLOG。

## 2026-10-23 晚间 · 人工重开优先于规则分流

旧版 `14fce0d` 中，已有预约大件事件先保存为已排除或已处理，再保存「待复核」与重查理由，JSON 正确保留了两条历史和 `open`，但待办仍为 0、徽标仍为预约例外；导入后仍遗漏。[直接基线](validation/reopened-review-direct-baseline.json)含两种原结案状态。正式最小[红测试 0/1](validation/reopened-review-baseline.json)通过浏览器路由提供该提交的原 `app.mjs`，其余模块未变；不能把最终六项都计成旧版失败数。

修复后[专项 6/6](validation/reopened-review-validation.json)：预约、低分、短观察三类；无人工记录与未保存草稿保持原分流；空白理由保存失败；明确人工待复核进入待办；再次结案退出；JSON 与 Markdown 保留原规则和人工结论。五项为合成状态边界，另一项实际运行 SSDLite 的 7 帧公开图片合成短片，生成 1 个停车候选，再显式调整质量门槛为 0 以覆盖短观察分流路径。该策略只用于测试，不更改产品默认值，也不构成现场风险建议。

真实候选的原 `routing` 仍是 `short_observation`，人工重开后待办为 1，导出恢复的观察、任务标识、结论及历史一致。这验证人机复核流程，不能证明真实停车时长、违停或识别精度。

[独立代码边界 6/6](validation/reopened-review-code-review.json)另检查首次直接保存待复核、多个事件隔离、关闭草稿不提前移出、最新结案优先于旧重开、旧版结构文件恢复；来源、政策、结论、历史深度一致。[独立界面 23/23](validation/reopened-review-ui-validation.json)：1440px 12 项（含真实默认 D-FINE 图片流程），390px 11 项；实际截图经设计师和主代理查看，无横向溢出。D-FINE 校车图实际生成 2 个规则候选，大巴分数 0.9651602；这里只验证推理、复核及导出。专项和界面检查均无页面异常或外域请求，独立代码检查无页面异常。

```bash
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/reopened-review-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/candidate-handoff-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/model-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
```

浏览器依赖配置沿用下文。专项支持 `REOPENED_REVIEW_REPORT` 指定报告名、`REOPENED_REVIEW_ONLY` 按名称筛选；完整验收不设置筛选。可用 `REOPENED_REVIEW_BASELINE=14fce0d` 读取本地 Git 中的原网页模块作对照，报告会标注提交。首次最小脚本恰逢产品修改后运行，其绿结果保留为本地 `artifacts/reopened-review-validation.premature-green.json`，未作为红基线；随后显式提供旧模块才得到正式失败。

原候选交接 10/10（含 2 项真实 D-FINE 流程）、JS 138/138、26 项资产哈希通过；原 `model-check` 实际运行 SSDLite 图片与 7 帧合成视频，张量 262→262，外域请求 0。本轮只改人工待办和徽标判断，没有改检测权重、事件引擎、分组、阈值、导出格式或固定评测数字。

剩余限制：普通保存仍保留当前筛选，重开事件会退出「已处理」视图，可切到待办查看；尚未修复完成一项后自动选中下一项时上下文可能在屏外的问题，见 BACKLOG。关闭前仍须导出，媒体需另行选择。CI 与线上验证单独记录。

## 2026-10-23 · 中途失败保留已完成的检测结果

旧版 `c29c6bc` 正式红基线 1/2：真实 SSDLite 正常完成 7 帧，但第三次推理注入异常后，前两帧已经成功，结果区仍隐藏、导出被禁用。修复后[专项 9/9](validation/partial-analysis-validation.json)；[红基线](validation/partial-analysis-baseline.json)独立保留。错误由测试明确注入，不将其描述为自然发生的坏视频。

- 实际调用 SSDLite，逐框、逐分核对部分 JSON 只含成功帧；失败报告为 `complete:false`、`outcome:failed`，记录阶段与尝试采样时间。手动停止为 `stopped`，没有失败原因；两者都不生成候选。
- 带变化标记的公开图片合成短片使失败帧与成功帧可区分：恢复后的底图指纹和绘制框均对应最后成功帧。指纹只是本次画布比较，不是素材真实性证明。
- 覆盖 seek 失败、首帧失败、模型清单加载失败、取消加载及完整重试；重试后的真实候选送审、保存待补证据、工作区导出/恢复，批次、结论与审查历史一致。零成功帧没有报告，原媒体仍不进入导出。
- [独立 D-FINE 复核 6/6](validation/partial-analysis-code-review.json)：推理失败、seek 失败、停止、非零片段起点、正常完成、首帧失败。[后处理异常 3/3](validation/partial-analysis-postprocess-review.json)：轨迹整理、规则生成，以及推理与轨迹双重失败；成功原始框仍能导出，已失败函数不重复执行。
- [独立界面 16/16](validation/partial-analysis-ui-validation.json)，1440 / 390px 各 8 项；自然视口能看到失败提示和导出操作，无横向溢出，实际截图经设计师和主代理查看。上述专项页面异常和外域请求均为 0。没有改变 HTML、CSS 或既有版面。

```bash
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/partial-analysis-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/model-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/handoff-navigation-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
```

浏览器依赖配置沿用下文。专项支持 `PARTIAL_ANALYSIS_REPORT` 指定报告名、`PARTIAL_ANALYSIS_ONLY` 按检查名称筛选；完整验收不设置筛选。首次运行会用现有 CC0 校车图生成合成视频，需要支持 MP4 MediaRecorder 的 Chrome；固定夹具及源图哈希写入报告。已有夹具可复用，重新生成的视频字节及耗时不保证相同。

原 `model-check` 真实运行图片和 7 帧合成视频，张量 262→262，外域请求 0；原交接定位 8/8（2 项真实 D-FINE、6 项合成状态边界），JS 138/138、26 项资源哈希通过。首次修复后专项 8/9 的一项失败是零帧提示断言漏掉实际文案“尚无已完成采样帧”，报告与控件行为已正确；保留本地诊断 `artifacts/partial-analysis-validation.notice-assertion.json`，修正测试措辞后完整复跑通过。

本轮只验证失败恢复与工作流，未新增模型训练或领域识别精度。公开 CC0 图片与其合成时序不代表真实社区视频；不提供断点续跑、跨会话推理恢复或损坏视频修复。CI、线上资产与线上浏览器结果另行记录，不与本地通过混算。

## 2026-10-22 · 候选交接定位与键盘继续

旧版 `6a0586c` 的手机红基线 0/1：真实 D-FINE-N 生成 2 个候选，送审后标题在视口上方约 345px，焦点落 BODY。[基线](validation/handoff-navigation-baseline.json)与[最终专项](validation/handoff-navigation-validation.json)分别保留。

专项 8/8：2 项实际默认 D-FINE-N 推理（1440 / 390px），6 项合成状态边界。公开 CC0 校车图的大巴分数均为 0.9651602；这不是小区违规准确率。除新交接定位外，还覆盖键盘 Tab、原地重复、取消、无效输入、迟到图片、快速切页、相同 hash 下无附件或坏附件的新交接。页面异常和外部请求为 0。

```bash
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/handoff-navigation-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/candidate-handoff-check.cjs
ESTATEGUARD_URL=http://127.0.0.1:8767 node scripts/browser-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
```

浏览器依赖配置沿用下文。新专项支持 `HANDOFF_NAVIGATION_REPORT` 指定输出文件名、`HANDOFF_NAVIGATION_ONLY` 筛选检查。原候选交接 10/10（含 2 项真实模型流程）、browser-check、JS 138/138、26 项资产哈希通过。

[独立代码边界](validation/handoff-navigation-code-review.json) 8/8；[独立界面回归](validation/handoff-navigation-ui-validation.json) 14/14，无横向溢出，实际桌面/手机截图已查看。只修改新候选成功交接的定位，没有调整 CSS、模型权重或检测规则。

初版扩展专项 5/7，两个失败来自过强的坐标假设：重复提示改变高度后浏览器滚动锚定使 scrollY 变化 20px，但正在编辑的备注视口位置只变约 0.8px；图片插入令备注下移约 217px，但不夺焦点且输入仍可见。保留诊断于本地 `artifacts/handoff-navigation-validation.layout-assertions.json`，最终断言检查阅读锚点、输入可见性、DOM、焦点与新增定位调用，不把媒体自身布局变化记为已修复。独立设计与代码脚本另纠正隐藏页 `innerText` 换行和原生导航焦点假设；产品未因这些脚本问题改变。


## 2026-10-21 晚间 · 候选送审身份与可见队列

- 旧版 `521e1b6` 正式专项 0/1：真实推理后重复送审将审查历史从 1 条清为 0。独立设计师两宽度发现 2 个候选被旧筛选隐藏。
- 修复后专项 10/10：其中 2 项实际运行 D-FINE-N，8 项通过合成候选验证状态边界；不混算为模型识别指标。页面异常和外部请求为 0。
- 独立代码边界 7/7；桌面 1440 / 手机 390 各 10 项，实际截图无溢出。重复送审保留原表单、文本框和图片节点。列表内容可用不等于所有候选行都同时位于当前视口。
- JS 138/138（旧基线 136）；新增任务标识校验的红测试 1 通过 / 1 失败，修复后均通过。26 项资产哈希、原 browser-check、异步替换 9/9、草稿 11/11 通过。

```bash
node scripts/candidate-handoff-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
node scripts/browser-check.cjs
node scripts/workspace-replacement-check.cjs
node scripts/review-draft-check.cjs
node scripts/model-check.cjs
```

SSDLite 原 model-check 首次在点击公开图片后的素材就绪等待处超时（尚未推理）；加入只读请求/页面诊断的副本以及原脚本随后完整复跑均通过，没有修改该脚本或产品加载逻辑。此次未复现超时原因，不能将其归为已修复问题。成功运行实际图片和 7 帧重复图片合成视频，张量 262→262，外部请求 0；原始失败日志保留在本地 artifacts/candidate-handoff-model-check.txt，最终日志在 candidate-handoff-model-check-final.txt。

浏览器配置沿用下文，隔离服务为 `ESTATEGUARD_URL=http://127.0.0.1:8767`；专项支持 `CANDIDATE_HANDOFF_REPORT` 指定报告名。[重复送审红基线](validation/candidate-handoff-baseline.json)、[筛选基线](validation/candidate-handoff-filter-baseline.json)、[最终专项](validation/candidate-handoff-validation.json)、[独立代码复核](validation/candidate-handoff-code-review.json)、[桌面与手机回归](validation/candidate-handoff-ui-validation.json)。


## 2026-10-21 · 复核草稿差异与交班导出

- 原发布 `e473819` 上，空备注输入后清空仍阻止 JSON/Markdown 导出，初始 2 项检查为 1 失败、1 对照通过。首次 trim 比较修复后，另发现 CRLF/CR 导入历史的 2 项失败；两阶段独立保留，不混成同一基线。
- 最终专项 11/11：撤回空值/已保存内容、首尾空白与换行兼容、真实正文/结论/内部空白保护、跨事件隔离、已保存未导出提醒、原历史逐项保留、显式保存兼容、真实模型候选的导出恢复。页面错误和外部请求为 0。
- D-FINE-N 真实读取现有 CC0 图片，样例大巴分数 0.9651602、2 个规则候选；复核保存后导出恢复的 batch/decisions/audit 一致。没有模拟模型分数，也没有将该样例作为领域精度证据。
- 136 项 JS、26 项资产哈希通过；原慢加载回归 9/9、原 browser-check 通过；model-check 实际运行 SSDLite 图片和 7 帧重复图片合成视频，张量 262→262。
- 独立代码审查 4 项通过；设计师 1440 / 390px 各 13 项通过，无横向溢出。标记更新保留表单、附件、焦点与光标；CSS 和固定版面不变。

```bash
node scripts/review-draft-check.cjs
node scripts/workspace-replacement-check.cjs
node scripts/browser-check.cjs
node scripts/model-check.cjs
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
```

浏览器配置沿用下文；本轮隔离服务为 `ESTATEGUARD_URL=http://127.0.0.1:8767`。机器证据：[原版基线](validation/review-draft-baseline.json)、[换行边界基线](validation/review-draft-newlines-baseline.json)、[最终验收](validation/review-draft-validation.json)、[界面回归](validation/review-draft-ui-validation.json)。CI 和线上检查与本地结果分别记录。

线上产品提交 `edfe9ab`：CI / Pages `39532420551` 成功，13 个关键文件与提交逐字节一致。[线上专项报告](validation/review-draft-online-validation.json) 为 11/11，含真实 D-FINE 推理及复核交接恢复。首次运行在异步评测初始化前断言默认模型而失败（10/11），经独立延迟真实响应复现后，只为测试增加等待默认值的条件，再次完整运行通过；未手动选择模型或更改产品。

## 2026-10-20 · 工作区异步替换与复核保留

基线为已发布的 `704f30a`。独立找茬 9 项中 8 项失败，修复并补充附件及模型交接断言后 9/9 通过。读取时序通过延迟真实 `fetch` / `File.text()` 完成来控制；响应被页面消费后的下一任务再检查状态，不替换模型输出。失败读取使用明确的 HTTP 错误夹具。

```bash
node scripts/workspace-replacement-check.cjs
node scripts/model-check.cjs
node scripts/browser-check.cjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/verify_assets.py
```

浏览器配置沿用下文，隔离服务通过 `ESTATEGUARD_URL=http://127.0.0.1:8767` 指定。专项覆盖等待期间草稿/已保存结论、拒绝与同意替换、读取失败、较新导入优先、规则更新使旧示例与旧 JSON 失效、旧错误不盖新提示，以及实际 D-FINE-N 推理→送审→人工保存→导出恢复。页面错误、外部请求均为 0。分数 0.9651602 和 2 个候选是公开校车样例的运行观察，不是社区效果指标。

原模型回归实际运行 SSDLite 图片及 7 帧合成视频，重复推理张量 262→262；136 项 JS 通过，Python 24 项中 23 项通过、1 项跳过，26 项资源哈希通过。独立代码审查另验取消后选导入、JSON 语法错误、结构错误 3 项；设计师 1440 / 390px 各 7 项通过，无横向溢出，原 CSS 与页面控件保持。

机器证据：[旧版失败](validation/workspace-replacement-baseline.json)、[修复验收](validation/workspace-replacement-validation.json)、[界面回归](validation/workspace-replacement-ui-validation.json)。本地检查与后续 CI、线上核验分开记录；没有新增数据、训练或现场部署收益声明。

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

> 2026-10-20 为清除 GitHub 贡献者缓存重建了仓库，此前的 Actions 运行记录随旧仓库转为私有。下文引用的运行在 `validation/ci-runs/` 保存了摘要（运行编号、提交、各任务与步骤的结论）；`validation/event-media-release-diagnostic.json` 里的运行链接同样以这些摘要为准。

- 应用提交 `3a67c8e` 的 [验证与发布工作流](validation/ci-runs/38756970035.json) 成功；主页提交 `439edf8` 的 [发布工作流](https://github.com/leon1111-wgl/leon1111-wgl/actions/runs/38757048656) 成功。
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

发布前接续核验：上一轮抽检提交 e997ce3 尚未推送，本轮独立重新运行 16 项训练检查、模型资源校验和全部迁移/抽检回放重算，并完整执行 parking-transfer-check。真实编码器前向、C6 抽检撤销、导出恢复及三模型 EXT 对照均通过，无页面错误或跨站请求；未修改其模型或抽检规则。独立报告保存在 artifacts/review-e997ce3/parking-transfer-validation.json。


发布校验的补充说明：Linux 首次失败后，通过[严格诊断运行](validation/ci-runs/39095950159.json)定位 CP 统计数值差，最大 7.9447e-13。比较器只允许明确路径下 CP statistic 的绝对误差 1e-12，且两个值在目标 alpha 同一侧；所有离散结果、阈值、SPRT 统计值与其他报告字段严格一致。完整报告的 elapsed_seconds 是本机运行耗时，检查类型与有限值，不要求两次耗时相同。回归测试保留真实 Linux 数值对，同时篡改计数、阈值、撤销时间/位置、类型、数组和非有限数，验证仍能阻止发布。原保存结果与模型文件均保持不变。

比较器修复的本机验证：新增 10 项回归先失败后通过，完整 Python 检查 24/24；重新运行 verify_parking_transfer.py，通过全部 144,965 张 EXT 分数、54 组阈值与完整抽检回放。最终部署仍须由 Linux CI 对同一提交验证。


## 2026-10-18 · 停车交班位置与失败保护

```bash
node --test tests/*.test.mjs
node scripts/parking-handover-check.cjs
node scripts/parking-review-check.cjs
node scripts/parking-critic-check.cjs
node scripts/parking-error-audit-check.cjs
node scripts/parking-transfer-check.cjs
node scripts/model-check.cjs
python3 scripts/verify_assets.py
```

- 全部 121 项 JS 通过，新增 5 项交接校验涵盖精确位置、模型版本、人工与模型筛选、旧格式、跨快照和损坏字段。
- [独立旧版复现](validation/parking-handover-baseline.json)保留 B52/C8 丢失交接位置、回放不停及损坏撤销记录半覆盖的问题，也记录开发中发现的数字日期和冷启动导出问题。
- [真实 Chrome 交接验收](validation/parking-handover-validation.json) 14/14：真实 MLP32 B52 与 MobileNetV2 C8 54 张图片推理、精确恢复、两级旧文件兼容、坏位置/模型/JSON、模型筛选回退、回放停止、推理及本地图片分析中拒绝、迟到文件隔离、已有非空撤销限制和草稿保留、读取期间才开始分析的最终拒绝、人工筛选隐藏车位的解释、冷启动未就绪时禁止导出。页面错误与跨站请求均为 0。
- 新页导入后 `samples.length=0`，没有装入文件中的预测或阈值。B52 的真实低分漏判保留；人工复核的测试输入不作为模型准确率。并发检查只暂停真实文件读取、网络请求或原生图片解码返回，不伪造推理结果。
- 原 `parking-review-check` 9/9、`parking-critic-check`、`parking-error-audit-check` 8/8 通过；通用模型实际运行 7 帧，张量 262→262，校车分数 0.9916937947，0 跨站请求；21 项模型资源哈希校验通过。
- [设计师最终复验](validation/parking-handover-ui-validation.json) 6 个桌面/手机场景通过：1440 / 390px 无横向溢出，B52 完整滚入网格可视区域，页面滚动位置不变；原布局、按钮和复核能力保持。截图位于本地 `artifacts/parking-handover-designer-after-final-*`。

限制：仅验证公开历史快照和手动交接，不验证真实值班员判断质量。没有改训练、模型权重或校准算法；没有共享账号、服务器同步、媒体归档或文件签名。

迁移验收首次在恢复步骤超时（[诊断证据](validation/parking-handover-review-diagnostic.json)）。独立延迟真实第二帧输入后复现：旧等待只检查“当前快照分析完成”前缀，会读取上一帧残留提示，此时分析按钮仍禁用；提前导入被新的忙碌保护正确拒绝。验收脚本现同时等待当前日期时刻匹配且按钮恢复可用，原模型、校准和撤销断言保持不变。此修正属于验收时序，不是放宽产品要求。

强化等待后的[完整迁移回归](validation/parking-handover-transfer-validation.json)通过：真实 DINOv2/MobileNetV2 前向与离线特征对齐、现场自适应与校准、C8 三模型、C6 随机抽检和第六个错误撤销、跨模型限制、导出至新页面恢复后旧证据不能重新启用撤销阈值、上传、8 张评测表和 390px。页面错误、外部请求均为空。独立代码审查最终无阻断。


## 2026-10-19 · 驶入后稳定停留与事件分段

浏览器依赖按本文开头配置，先在 8766 启动静态服务：

```bash
node --test tests/*.test.mjs
node scripts/vision-dwell-check.cjs
node scripts/model-check.cjs
node scripts/media-context-check.cjs
node scripts/critic-check.cjs
node scripts/browser-check.cjs
python3 scripts/verify_assets.py
node scripts/evaluate.mjs
```

- 全部 131 项 JS 通过。新增 10 项验证已保存的真实检测框、先停再离开、两次停稳、缓慢连续移动、往返摆动、ROI 离开重入、丢检、不同轨迹、单图、恰好/不足时长、1.6/1.6001 秒间隙边界、短窗口冲突后恢复、错误片段标识、旧格式与同段重复合并、人工记录及导出恢复。两次各 2 秒的停留送审后仍为两个事件，不会跨过 3 秒宽限期。
- [旧版 2/5 基线](validation/vision-dwell-baseline.json)与[修复后 5/5](validation/vision-dwell-validation.json)使用同一组视频 SHA-256；三段各实际推理 11 帧。驶入停稳从没有候选变为 3–10 秒的一个稳定段，8 个证据采样，分数仅取稳定段最大值；原地静止 1 条、持续移动 0 条。视频摘要不再显示单图占位说明。
- 正式 `vision-dwell-check.cjs` 自行用现有 CC0 图片生成视频，无额外素材下载。视频保留在忽略的 `artifacts/`；设置 `VISION_DWELL_REUSE_FIXTURES=1` 可校验 manifest 哈希后重复使用完全相同的文件。新生成视频编码受浏览器和机器调度影响，保存实际哈希及检测框，不能宣称跨机器逐位相同。
- 真实模型候选送入事件复核、保存需补证据、导出及恢复后，原始观察（含片段标识）、规则、人工结论、审查历史完全一致。JSON 不含媒体；恢复后明确要求另行打开本地证据。页面错误和跨站请求为 0。
- 原模型回归校车分数 0.9916937947、实际 7 帧、张量 262→262；素材上下文 10/10、原 `critic-check`、`browser-check` 通过；21 项模型资产哈希通过。固定合成班次重算与已提交 data/web 输出无差异。
- [独立设计师报告](validation/vision-dwell-ui-validation.json)：1440 / 390px 各真实推理 11 帧后送审、保存、导出；7 秒稳定段与证据一致，无页面溢出，页面错误 0。截图位于本地 `artifacts/rule-review-20261019-designer-after-*`，已由设计师和主代理查看。独立代码审查相关 59 项通过，无阻塞项。

数据边界：现有 CC0 图片是真实公开照片，移动轨迹和测试时间由脚本构造；COCO 推理为真实运行。它们验证规则和交接，不是有人工停车标注的现场评测，不产生训练、违规识别精度或部署收益结论。极慢移动、遮挡、镜头运动与目标串号仍需真实视频验证。

## 2026-10-19 · 检测器升级（D-FINE-N 默认）

```bash
node --test tests/*.test.mjs
python3 scripts/verify_assets.py
python3 scripts/verify_detector_eval.py
node scripts/detector-check.cjs
node scripts/detector-loading-check.cjs
node scripts/model-check.cjs && node scripts/model-loading-check.cjs && node scripts/detection-threshold-check.cjs && node scripts/media-context-check.cjs && node scripts/critic-check.cjs && node scripts/browser-check.cjs && node scripts/event-media-check.cjs
node scripts/parking-transfer-check.cjs && node scripts/parking-check.cjs && node scripts/parking-review-check.cjs && node scripts/parking-error-audit-check.cjs && node scripts/parking-critic-check.cjs
# 重新评测（需本地 COCO val2017，见 scripts/eval-detectors-coco.cjs 与 scripts/eval_coco_detectors.py 文件头）
```

- 126 项 JS、24 项 Python、16 项训练测试通过。新增 D-FINE 单测覆盖类别名/COCO 编号与 COCO-SSD 包逐项一致、query×class top-k、框还原与裁剪、分数下限与排序、输入格式，以及近重复框去重（不同类别同一框只留一个、框内的人员保留）。
- 资源：26 项哈希通过（新增 D-FINE-N 本项目导出的 ONNX、官方配置、NOTICE 与导出记录）。导出脚本在 CC0 校车图上核对 ONNX 与 PyTorch：logits 最大差 1.8e-4、框 7.3e-6，大巴 0.964；浏览器 WASM 0.965。
- COCO 评测：两种检测器都在 Chrome 中调用网页同一模块，对 5,000 张图片逐张推理（D-FINE 8 个单线程页面并行，SSDLite 单页 WebGL），注释从未进入浏览器。D-FINE 开发半 AP 44.3、全量 42.6，与论文报告的 42.8 一致。`verify_detector_eval.py` 复核阈值选择、默认规则与计数自洽（COCO 图片不随仓库发布，CI 无法重算 AP）。
- 延迟：单页、逐张、端到端（读图、缩放、推理、后处理），测试半前 200 张：D-FINE P50 / P95 244 / 252 ms，SSDLite 27 / 38 ms；同为 640×480 的 200 张：246 / 249 与 25 / 28 ms。测量时机器上有其他任务（load avg 6–9）。
- 加载异常回归 `detector-loading-check` 5/5（[报告](validation/detector-loading-validation.json)）：D-FINE 下载卡住时取消 1 秒内恢复控件并可重试；模型 500 报错后重试成功；资源清单无响应时约 30 秒报超时；共享 ONNX 运行库下载中，先发起的页面（车位或分析）取消后，另一页面仍能完成。后两项先在旧实现上复现失败、修复后通过。
- 近重复去重按协议附录 3 用已保存检测复算：测试半 AP 42.0 → 41.3，工作点 12 类召回 / 精确率 54.6% / 86.8% → 54.4% / 87.1%，客梯大件 6 类精确率 72.4% → 73.4%；默认规则重核仍全部满足，`verify_detector_eval.py` 核对该重核。
- 新浏览器验收（[报告](validation/detector-validation.json)）：页面按评测记录默认 D-FINE、分数下限 0.6；未手动改动时切换检测器分数下限随之变化，手动输入的值不被覆盖；选“客梯内的可识别大件”时显示 6 类精确率提醒；CC0 校车上 D-FINE 大巴 0.965、SSDLite 0.992，两框 IoU > 0.8；切换后复用已加载模型、分数下限随检测器恢复；“指定通道内的车辆”规则生成候选；报告记录检测器、后处理与 NMS 设置；评测页两张表；390px 无横向滚动；无页面错误与跨站请求。
- 原有检查固定 `?detector=ssdlite` 后全部通过（`detection-threshold-check` 在一次连续全量运行中于准备阶段等待示例图 30 秒超时，未进入用例；随后单独连续两次 7/7，未见页面错误，根因未定位）：`model-check`（校车 0.99169，7 帧，张量 262→262）、`model-loading-check` 8/8、`detection-threshold-check` 7/7、`media-context-check` 10/10、`critic-check`、`browser-check`、`event-media-check` 10/10；车位 `parking-transfer-check`（ORT 运行时改为共享后，DINOv2 与离线特征最大差仍为 0）、`parking-check`、`parking-review-check` 9/9、`parking-error-audit-check` 8/8、`parking-critic-check`。

- 与 origin/main 的“驶入后稳定停留”提交合并后重跑：136 项 JS 与全部审计、合成数据再生成一致；15 项浏览器检查通过。新的 `vision-dwell-check` 按 SSDLite 写成（断言 CC0 校车短片只有 1 个候选），在 D-FINE 默认下得到 2 个候选——第二个是照片边缘那辆被 D-FINE 检出（约 0.67 分）、SSDLite 漏掉（约 0.17 分）的真实大巴；与其他旧检查一样以 `?detector=ssdlite` 固定后 5/5，断言未改。`detector-check` 在连续全量运行中一次于手机页等待评测记录 30 秒超时，单独重跑通过。

未验证：小区监控、夜间、客梯或鱼眼画面上的检出率与每小时误报；低端手机上单线程 WASM 的耗时；大件类别按类调阈值的效果。


## 2026-10-20 · 分析参数的适用性与草稿保留

```bash
node --test tests/*.test.mjs
node scripts/analysis-parameters-check.cjs
node scripts/model-check.cjs
node scripts/media-context-check.cjs
node scripts/browser-check.cjs
python3 scripts/verify_assets.py
```

浏览器依赖及 8766 静态服务同本文开头。新脚本自行将现有 CC0 校车图编码为静止/移动短片，不下载新素材；动作与测试时间为人工构造，不是现场违规标注。

- [直接旧版复现](validation/analysis-parameters-baseline.json)：默认 D-FINE-N 正常图片检出大巴，空闲置停留值却阻止 objects/access/direction；补回无关值后通道与方向可正常产生候选。[完整红版](validation/analysis-parameters-baseline-tests.json) 1/8 通过、7 项失败；为避免覆盖正在修复的代码，正式红复跑在浏览器路由提供 `6b0a268` 的原 index/vision/media-context 文件，报告带 `injected_baseline`。真实媒体和模型资源保持不变。
- [修复后验收](validation/analysis-parameters-validation.json) 8/8：D-FINE-N 与 SSDLite 均实际推理；空/20 秒闲置草稿不影响图片检测且报告 `null`；切回停车拒绝空、1、20；方向视频忽略空停留值且改变有效方向仍撤销确认；图片通道候选送审、保存需补证据、导出恢复一致；停车保留 2 秒阈值和 1 秒分析起点；推理期间锁定控件，停止后仅恢复适用字段且未完成报告无候选；现场复用不清除新草稿，图片误选停车先提示视频要求。页面错误和跨站请求为 0。
- 早期测试的全局 requestAnimationFrame 暂停会阻塞浏览器等待，属于夹具错误；最终只在真实 SSDLite 推理完成后暂缓返回原结果，验证忙碌和停止，不替换像素、框或分数。完整红报告不混入该超时。
- 136 项 JS、26 项资源哈希通过。原 model-check 的校车分数 0.9916937947，视频 7 帧，张量 262→262；media-context-check 10/10；browser-check 通过。参数适用性使用真实浏览器回归，不为 DOM 分支另加镜像单测。
- [设计师实际桌面与手机报告](validation/analysis-parameters-ui-validation.json)：1440 / 390px，闲置输入禁用且不 required、用途说明可读，空停留草稿仍可完成默认 D-FINE-N 推理与通道送审，切回停车正确聚焦错误输入；字段位置和 CSS 未变，无页面溢出/错误。截图保存在本地 `artifacts/rule-inputs-20261020-designer-after-*` 并已审查。

限制：本次只修复输入与任务流；未改变 D-FINE-N/SSDLite 权重、分数下限、区域、采样、跟踪或候选算法。公开照片和合成运动不能证明小区违规识别质量；闲置草稿不是跨标签页持久化配置。
