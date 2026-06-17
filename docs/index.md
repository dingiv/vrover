# Visual Rover (VRover)

VRover 是一个面向 GUI 操作场景的视觉 AI agent：用 **Set-of-Mark (SoM)** 让模型「看见并定位」UI 元素，通过统一的 `Platform` 抽象驱动桌面或浏览器完成自动化任务。

> 📐 长期架构构想（Visual Tool 胖工具 / UI 图 graph walker / 本地 server / DSL / 人类脚本）见 **[design.md](./design.md)**。

## 架构

```
agent loop（observe → think → act）
   ├─ observe: Platform.captureScreen() + Platform.getElements() → SoM.annotate()  （带编号框的图 + 元素表）
   ├─ think:   LLM（默认 Anthropic；可插拔）
   └─ act:     工具执行器：mark → 元素 → 中心坐标 → Platform 原语（click / type / scroll / keypress）
```

核心设计：**action 用 SoM「编号(mark)」引用元素，而非裸坐标**。这让模型只挑编号，定位精度交给真实的元素边界框；`Platform` 保持坐标导向，贴合真实鼠标键盘。

- `Platform` —— 统一接口，今天只有 `MockPlatform`（合成的登录界面）。未来 `DesktopPlatform`（Rust 经 napi-rs：xcap/enigo/AT-SPI）、`BrowserPlatform`（Playwright）各一份实现。
- `llm/` —— 今天单家 Anthropic 直连；所有 SDK 调用集中在 `llm/anthropic.ts`，日后加 provider 只需加一个同签名函数。
- `som/` —— 视觉工具，见 [visual_tool.md](./visual_tool.md)。元素来源最终要无障碍树/DOM + ML 视觉结合。

## 当前状态（首版里程碑：骨架 + 循环 + mock）

- ✅ TypeScript 项目骨架（pnpm + ESM + 严格模式）、vitest、tsx
- ✅ `Platform` / `SoM` / `Action` / agent loop 核心抽象与契约
- ✅ `MockPlatform`：合成 1280×800 登录界面，真实 PNG 渲染 + 命中测试 + 登录状态机
- ✅ SoM 标注流水线（@napi-rs/canvas 画编号框）
- ✅ Anthropic 适配器（视觉 + tool use）+ 可注入的 `complete` 接口（测试用假 LLM，零 API 成本）
- ✅ 16 个单测/集成测试全绿，`tsc --noEmit` 通过

## 快速开始

```bash
pnpm install
cp .env.example .env          # 填入 ANTHROPIC_API_KEY
pnpm test                     # 单测 + 注入假 LLM 的 loop 集成测试（无需 key）
pnpm dev                      # 跑 examples/mock-run.ts：agent 对合成登录界面完成登录
```

## 目录

```
src/
  agent/      runAgent 主循环、TaskResult
  platform/   Platform 接口、MockPlatform
  som/        SoM 标注 + 元素表
  llm/        anthropic.ts（唯一 LLM 出口）+ 协议类型
  tools/      工具定义（click/type/scroll/keypress/done）+ mark→坐标 执行器
examples/     mock-run.ts 演示
test/         vitest
```

## 路线图

主线是 [design.md](./design.md) 里的 **Visual Tool = UI 图 graph walker** 方向（M1：图模型 + DSL + 多屏 mock 上的 walker）。下面是底层待补的能力：

- Rust 原生平台层（napi-rs）+ 真实桌面（注意 xcap/Wayland 捕获的复杂度）
- Playwright 浏览器平台
- SoM 的 ML 视觉 grounding（onnxruntime）
- LLM 抽象层（多 provider）
