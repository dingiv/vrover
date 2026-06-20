# Visual Rover (VRover)

VRover 是一个面向 GUI 操作场景的视觉 AI agent：用 **Set-of-Mark (SoM)** 让模型「看见并定位」UI 元素，通过统一的 `Platform` 抽象驱动桌面或浏览器完成自动化任务。

> 📐 文档导航：[architecture.md](./architecture.md) 现状架构（代码为准） · [scout-server.md](./scout-server.md) Visual Scout server · [design.md](./design.md) 长期构想 · [decisions.md](./decisions.md) 设计决策（含节点身份方案） · [som.md](./som.md) SoM 感知模块。

## 架构

```
agent loop（observe → think → act）
   ├─ observe: Platform.captureScreen() + Platform.getElements() → SoM.annotate()  （带编号框的图 + 元素表）
   ├─ think:   LLM（默认 Anthropic；可插拔）
   └─ act:     工具执行器：mark → 元素 → 中心坐标 → Platform 原语（click / type / scroll / keypress）
```

核心设计：**action 用 SoM「编号(mark)」引用元素，而非裸坐标**。这让模型只挑编号，定位精度交给真实的元素边界框；`Platform` 保持坐标导向，贴合真实鼠标键盘。

- `@vrover/platform` —— 统一 `Platform` 接口：今天 `MockPlatform` / `MultiScreenPlatform`（合成登录界面）。未来 `DesktopPlatform`（Rust 经 napi-rs：xcap/enigo/AT-SPI）、`BrowserPlatform`（Playwright）各一份实现。
- `@vrover/llm` —— 今天单家 Anthropic 直连；所有 SDK 调用集中在此，日后加 provider 只需加一个同签名函数。
- `@vrover/som` —— 视觉工具，见 [som.md](./som.md)。元素来源最终要无障碍树/DOM + 传统 CV/OCR 结合。

> 契约细节（`Platform` / `CompleteFn` / SoM / 工具面 / loop）见 [architecture.md](./architecture.md)；包结构与依赖图见下方「目录」。

## 当前状态

- ✅ **TypeScript monorepo**（pnpm workspace，`packages/*`，8 个包，依赖图无环）。开发用 source-resolving exports——tsx/vitest 直读 TS，无需 build；`pnpm build` 经 TS project references 产出各包 `dist/`。
- ✅ **核心抽象与循环**：`Platform` / `SoM` / `Action` / agent loop（observe→think→act）；`MockPlatform` + `MultiScreenPlatform`（合成登录/主页，真实 PNG + 命中测试）。
- ✅ **LLM 出口**：Anthropic 适配器（视觉 + tool use）+ 可注入 `complete`（测试用假 LLM，零 key）；`loadConfig` 折进 `@vrover/llm`。
- ✅ **Visual Scout = 独立 TCP server**（D4/D10）：自定义二进制协议；握手建会话，每会话独立 `Platform` 终端（截屏器 + 键鼠）+ walker 占位。见 [scout-server.md](./scout-server.md)。
- ✅ **客户端 SDK**（`@vrover/scout-client`）：面向第三方的薄 JS API，**只依赖协议**；`RemotePlatform`（`@vrover/agent`）是项目内唯一消费它的地方，故 SDK 对第三方独立。
- ✅ **预留 Rust 缝**：`NativeLayer` + `DesktopPlatform` stub，等真桌面 capture / CV-OCR 时用 napi-rs 填。
- ✅ **43 个测试全绿**（含端到端组件拆分：agent 经 TCP 把 server 后端登录跑通、会话隔离、SDK 登录），`tsc --noEmit` 通过。

## 快速开始

```bash
pnpm install
cp .env.example .env          # 填入 ANTHROPIC_API_KEY
pnpm test                     # 单测 + 注入假 LLM 的 loop 集成测试（无需 key）
pnpm dev                      # 跑 examples/mock-run.ts：agent 对合成登录界面完成登录
pnpm scout                    # 起 Visual Scout TCP server（无需 key，自定义二进制协议）
pnpm scout:run                # 起 server + 大脑经 RemotePlatform 驱动它（需 key）
pnpm scout:client             # 起 server + 用 ScoutClient SDK 脚本驱动登录（无需 key）
```

## 目录

pnpm monorepo（`packages/*` 每个子目录一个 workspace 包）：

```
packages/
  scout-protocol/  线协议（二进制帧 + 消息 + UiElement/Bounds）——client 与 server 共享契约（leaf）
  scout-client/    ScoutClient SDK（仅依赖 scout-protocol，面向第三方开发人员）
  scout/           Visual Scout TCP server（server/session/grounding/walker/graph-map）
  platform/        Platform 接口 + Mock/MultiScreen/Desktop + 类型（UiElement/Bounds 来自 scout-protocol）
  som/             SoM 标注 + 元素表
  llm/             anthropic.ts + 协议类型 + loadConfig
  tools/           工具定义（click/type/scroll/keypress/done）+ mark→坐标 执行器
  agent/           runAgent 主循环、TaskResult、RemotePlatform（大脑；唯一消费 scout-client）
examples/     mock-run.ts / scout-server.ts / scout-run.ts / scout-client.ts
test/         vitest
```

依赖图（无环）：`scout-protocol`(leaf) ← {`scout-client`, `platform`}；`platform` ← {`som`, `tools`, `scout`, `agent`}；`agent` ← 消费 `scout-client`。

## 路线图

主线是 [design.md](./design.md) 里的 **Visual Scout = UI 图 graph walker** 方向。Visual Scout 现已是**独立 TCP server**（见 [scout-server.md](./scout-server.md)），当前对外提供 UI 操作 + grounding（①④）；接下来在其上叠 **graph map + walker**（②③，含节点身份 D1、DSL D2、`go_back`、按 node 动态注入高层操作）。底层待补的能力：

- graph map + walker（D10 ②③）—— Scout server 内的下一层
- Rust 原生平台层（napi-rs，填 `NativeLayer`）+ 真实桌面（注意 xcap/Wayland 捕获的复杂度）
- Playwright 浏览器平台
- SoM 的传统 CV/OCR grounding（实时感知，插进 `GroundingSource`）
- LLM 抽象层（多 provider）
