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

真实物业视频上的领域精度、每小时误报与事故/损坏减少；长期多日运行；移动端各型号推理速度；多人共享权限；生产后端；专项行为模型训练、蒸馏和量化。
