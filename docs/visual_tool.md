# SoM 感知模块（`src/som/`）

> 这里描述的是 SoM **感知子模块**。「Visual Tool」作为「胖工具 / UI 图 graph walker / 本地 server」的整体设计见 [design.md](./design.md)——本文档的 SoM 是它的**感知引擎**（建图时识别控件、走图失败时重新定位）。

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
`GroundingSource.detect(): Promise<UiElement[]>`，计划接两类来源并组合：

1. **无障碍树 / DOM 边界框**（精确、无 ML 依赖）：桌面用 AT-SPI（Rust 核心经 napi-rs 暴露），浏览器用 Playwright DOM。
2. **ML 视觉检测**（OmniParser 风格，onnxruntime）：兜底识别无障碍树覆盖不到的自绘控件。

先无障碍树/DOM，拿不到的再上 ML，两者结果合并去重后交给 `annotate`。
