# 现状架构（代码为准）

> 本文记录 **已经落地** 的架构与契约，对照代码。长期方向（UI 图 graph walker / 胖工具 / DSL）见 [design.md](./design.md)；待定的设计决策见 [decisions.md](./decisions.md)。
> 状态：首版里程碑（骨架 + 循环 + mock）已落地，16 个测试全绿。

## 一句话

agent 跑一个 **observe → think → act** 循环：每步截图 + 取元素 → SoM 画编号框 → 把「标注图 + 元素表 + 工具」交给 LLM → 执行模型挑的 mark 对应的元素。两层可插拔缝：`Platform`（驱动什么目标）+ `CompleteFn`（用什么大脑）。

## 模块图

```
            AgentOptions { platform, complete, task }
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
┌──────────────────┐                ┌────────────────┐
│  agent/loop.ts   │  observe/act   │  llm/*.ts      │
│  runAgent        │◀──────────────▶│  CompleteFn    │  ← 可插拔：今天 anthropic.ts，测试用假 LLM
│  (observe→think→ │   think        │  (唯一大脑出口) │
│   act 循环)       │                └────────────────┘
└────┬─────────────┘
     │ mark → 元素 → centerOf(bounds) → 平台原语
     ▼
┌──────────────────┐   annotate(screenshot, elements)   ┌────────────────┐
│  som/            │◀───────────────────────────────────▶│  platform/     │
│  编号框 + 元素表  │                                      │  Platform 接口  │  ← 可插拔：今天 MockPlatform
│  formatTable     │                                      │  (capture/act) │     未来 Desktop / Browser
└──────────────────┘                                      └────────────────┘
     ▲                                                              │
     │ tools/definitions.ts (click/type/scroll/keypress/done)       │
     │ tools/executor.ts   mark→元素→坐标→Platform 原语              │
     └──────────────────────────────────────────────────────────────┘
```

## 契约边界（精确版）

### `Platform`（`src/platform/types.ts`）— 目标抽象
最底层驱动，坐标导向（贴近真实鼠标键盘）：
- `captureScreen(): Promise<Screenshot>` — PNG，发给 LLM 的图像块。
- `getElements(): Promise<UiElement[]>` — SoM 候选元素。
- `performClick(x,y)` / `performType(text)` / `performScroll(x,y,dir)` / `performKeypress(keys)`。

> ⚠️ **`getElements` vs `GroundingSource.detect` 重叠**：同文件里还有一个**未接线**的 `GroundingSource` 缝，文档说 `getElements` "暂时代替"它。但 node 身份签名（建图地基）本质是 grounding 关切——walker 也要拿元素结构做签名。grounding 最终是留在 Platform 里、还是抽成独立注入件，是 [decisions.md](./decisions.md) 的 D9 待定项。

### `CompleteFn`（`src/llm/types.ts`）— 大脑出口
`(req: CompleteRequest) => Promise<LLMResponse>`，loop 拿它当依赖注入，测试用假 LLM 零成本跑。今天只有 `anthropic.ts` 实现；加 provider = 加一个同签名函数。

### SoM（`src/som/`）— 感知
`annotate(screenshot, elements) → { annotated PNG, table }`。模型说「点 mark 3」，执行器把 mark → 元素 → `centerOf(bounds)` → `Platform.performClick`。详见 [som.md](./som.md)。

### Action / 工具面（`src/tools/`）
工具一律 **mark-only**：`click(mark)` / `type(mark,text)` / `scroll(mark,dir)` / `keypress(keys)` / `done(summary)`。schema 用 Zod 写一次 → 转 JSON Schema 给模型，单一来源不漂移。

### agent loop（`src/agent/loop.ts`）
每步：capture → getElements → annotate → 塞进 history → `complete(...)` → 逐个 `dispatch` tool call → tool_result 塞回 history。`done` 或 maxSteps 或 LLM 报错时停。`TaskResult { status, summary, steps }`。

## 一个 over-claim：loop 现在没有 walker 的位置

`design.md` 曾写 M1 的「按 node 动态注入高层操作」可以靠"现有 loop 的可注入工具定义"实现。**但代码里 `tools` 是硬编码的 `TOOL_DEFS`**（`loop.ts` 里 `complete({ ..., tools: TOOL_DEFS })`），`AgentOptions` 上没有工具注入钩子，loop 也没有 node / walker 概念——每步无状态地重新感知。

要做 M1，loop 契约至少要长出两样之一（见 [decisions.md](./decisions.md) D8）：
1. **工具注入钩子**：`AgentOptions.getTools?(ctx) → ToolDef[]`，按当前 node 动态返回高层操作；
2. 或 **walker 接管 act 阶段**：已知边直接执行，不经过 LLM。

这条要在动 walker 代码之前先在 D8 拍板，否则 M1 的核心能力悬空。
