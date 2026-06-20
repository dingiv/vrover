# SoM 感知模块（`src/som/`）

> 这里描述的是 SoM **感知子模块**。「Visual Scout」作为「胖工具 / UI 图 graph walker / 本地 server」的整体设计见 [design.md](./design.md)——本文档的 SoM 是它的**感知引擎**（建图时识别控件、走图失败时重新定位）。

`src/som/` 把一张截图和一组 UI 元素变成模型能用来定位的东西 ——
**带编号红框的标注图 + 编号→元素表**。模型不靠猜像素坐标，而是说「点编号 3」，工具执行层再把编号解析成元素中心坐标。

## 数据流

```
Platform.captureScreen() ──┐
                           ├─▶ annotate() ──▶ SoMResult
Platform.getElements()  ───┘                      │
                                                  ├─ annotated: Screenshot (画了编号框的 PNG，发给模型的 image 块)
                                                  └─ table: SoMElement[]   (mark → 元素描述，作为文本表发给模型)
```

- `annotate(screenshot, elements)`：在每个元素上画红色编号框 + 左上角数字标签，并生成 `1: [button] Login` 这样的表。
- `formatTable(table)`：把表渲染成文本，随标注图一起发给 LLM。
- 工具执行器（`src/tools/executor.ts`）把模型返回的 `mark` → 元素 → `centerOf(bounds)` → `Platform.performClick(x, y)` 等原语。

## 类型

```ts
interface SoMElement { mark: number; element: UiElement; description: string } // 例如 "[button] Login"
interface SoMResult  { annotated: Screenshot; table: SoMElement[] }
```

## 元素从哪来（SoM grounding 来源）

今天 `Platform.getElements()` 直接给出元素（Mock 给的是合成的登录框）。这是预留的扩展缝
`GroundingSource.detect(): Promise<UiElement[]>`。目标形态是**三档感知源，由便宜到贵逐档兜底，结果合并去重**后交给 `annotate`：

1. **无障碍树 / DOM 边界框**（精确、几乎免费）：桌面 AT-SPI（Rust 核心经 napi-rs 暴露），浏览器 Playwright DOM。能拿到就用它，不必看像素。
2. **传统 CV + OCR**（廉价、实时、Scout 内部）：无障碍树覆盖不到时，轮廓 / 连通域 / 边缘检测找控件框 + OCR 取文本标签。开销可压到实时，但**对风格化图标 / 自绘控件脆**——分不清"装饰色块"和"按钮"。
3. **ML 视觉检测**（备选鲁棒档）：OmniParser 风格的检测器，对自绘 / 风格化 UI 鲁棒，能判交互性 / 语义角色；要模型权重 + 推理算力（重一档）。**作为第 2 档拿不准时的备选**，不默认开。

> 三档**输出形态一致**（框 + 标签 → elements）、**都跑在 Scout 本地**、**都不是多模态大模型**。逐档兜底：先 1，拿不到上 2，2 拿不准再上 3，合并去重。详见下方「感知技术分层」与 [decisions.md](./decisions.md) D11。

### 感知技术分层（说明）

| 档 | 技术 | 怎么找控件 | 成本 | 鲁棒性 |
|---|---|---|---|---|
| 1 | 无障碍树 / DOM | 平台直接给 | 免费、精确 | 依赖平台暴露（自绘 / canvas 拿不到）|
| 2 | 传统 CV + OCR | 轮廓 / 连通域 / 边缘 + OCR 读字 | 廉价、实时、无权重 | 对风格化图标 / 自绘控件脆 |
| 3 | ML 视觉检测（OmniParser 类）| 学过"可点的东西长什么样"的检测器 | 要权重 + 算力（ONNX 跑 CPU 接近实时）| 鲁棒，能判交互性 / 语义角色 |

**OmniParser 风格**：微软研究院（MSR）开源的代表性项目，这一类的典型实现。两段——① 检测模型（YOLO 系，海量 UI 截图微调）框出可交互元素；② 描述 / 功能模型给每个框生成"是什么、点了干嘛"（提交按钮 / 搜索图标 / 返回箭头），V2 还关联文字、判可点性。

**onnxruntime**：跨平台模型推理引擎。模型导出成 ONNX 格式后，可在 CPU/GPU 上脱离训练框架高效推理（Node 用 `onnxruntime-node`）。所以"OmniParser 风格 + onnxruntime" = 把检测器权重拿到 Scout 进程里本地推理，不依赖 Python / GPU 服务器。

**关于自训练**：OmniParser 用的是别人预训练的权重；"自训练模型" = 在自己的目标 UI 上微调 / 训练一个这样的检测器，仍属第 3 档。前期用现成权重，后期再议自训练。

> ⚠️ 注意区分：这里的 **ML 视觉检测**是 Scout 本地的**小专用模型**（找控件框），**不是**「视觉模型服务」（VRover 大脑调用的多模态大模型）。两者都涉及"视觉"，但规模 / 角色完全不同。

## UI 描述模型（NodeProfile）— 识别的货币

D1（节点识别）需要一个统一的「UI 描述」作为匹配货币：本模块（Visual Scout 的感知）定义并产出它——`NodeProfile = { nativeId?, imageHash, structuralSig, elements }`；识别器比较它，图存它。详见 [decisions.md](./decisions.md) D1。

这把 SoM 感知的角色从「每步重新标注」升级为「**先识别已知 node（L0 nativeId / L1 图像层 / L2 结构签名），未命中才走 L3 全量感知建新 node**」。`annotate` 只在真正需要给 LLM 看 mark 时（已知 node 低置信、或建新 node）才跑，而不是每步无条件跑。
