# 多 Agent 接入长上下文压缩（代码已完成 / 真实模型实测待补）

> 单 Agent 的「Token 预算分层压缩」此前只接在 `POST /api/chat`。
> 本阶段把它搬到多 Agent 主链路 `POST /api/chat/multi` 的 Worker 上下文上，
> 处理多 Agent 特有的问题：**历史该进哪个节点**。

## 一句话

路由层（`chatMulti`）**压缩一次**历史，把「近期原文层 + 结构化摘要」经 graph options
只下发给 Worker；Supervisor / Aggregate 不注入历史。复用单 Agent 已验证的
`buildContext` + `maybeSummarize` 内核，不改内核、不改记忆注入。

## 为什么只进 Worker

多 Agent 三个节点角色不同：

| 节点 | 角色 | 历史的作用 | 是否注入 |
| --- | --- | --- | --- |
| Supervisor | 把问题路由到领域 Worker | 历史会稀释「这轮问什么」 | ❌ |
| Worker | 真正回答问题，可能调工具 | 历史是回答的事实背景 | ✅ |
| Aggregate | 汇总各 Worker 结果 | 历史不产生新事实 | ❌ |

这延续了记忆的既有口径（`memoryBlock` 只下发给 Worker）。长上下文同理。

## 本阶段做了什么

- **暴露摘要内核**：`maybeSummarize` 与门槛常量从 `chat.ts` 抽到 `context/summarize.ts` 并导出；
  单 Agent 调用点参数逐字不变。
- **Worker 接历史与摘要**：`buildWorkerMessages` 加 `historyMessages` / `contextSummary`，
  顺序 `[system → system(摘要) → system(记忆) → ...历史原文 → user(task)]`；
  无历史/无摘要时输出逐字不变。
- **路由层压缩**：`chatMulti` 取最后一条 user 之前的非空、无附件消息，
  `buildContext`（空 systemPrompt、无 memory）裁历史；有丢弃时生成摘要并用新摘要重建；
  推 `context_compacted` SSE 事件；近期原文层 + 摘要经 graph options 下发。
- **graph 透传**：`MultiAgentGraphOptions` 加 `historyMessages` / `contextSummary`，
  `workersNode` 透传给每个 Worker。
- **前端**：接线经核实已全部就位——`streamChat` 统一发送 `contextSummary`、统一解析
  `context_compacted`；`App.vue` 复用 `ContextCompactionNotice` 显示「已压缩 X 轮」。

## 改动文件

| 文件 | 改动 | 类型 |
| --- | --- | --- |
| `server/context/summarize.ts` | 新增导出 `maybeSummarize` + 两个门槛常量 | 复用内核 |
| `server/chat.ts` | 删除私有 `maybeSummarize`，改导入 | 复用内核 |
| `server/multi-agent/workers/types.ts` | `WorkerContext` 加 `historyMessages?` / `contextSummary?` | 类型 |
| `server/multi-agent/workers/memoryPrompt.ts` | `buildWorkerMessages` 加两参数、调整组装顺序 | 核心 |
| `server/multi-agent/workers/memoryPrompt.test.ts` | 新增三态单测 | 测试 |
| `server/multi-agent/workers/{general,kb,realtime,action}Worker.ts` | 调用点透传新参数 | 接线 |
| `server/multi-agent/graph.ts` | options 加两字段，`workersNode` 透传 | 核心 |
| `server/routes/chatMulti.ts` | 新增「步骤 3.6 长上下文压缩」 | 核心 |
| `docs/long-context.md`、`README.md` | 更新生效范围与能力表 | 文档 |

## SSE 事件

| 事件 | 触发 | 载荷 |
| --- | --- | --- |
| `context_compacted` | 历史超预算且真的丢掉内容 | `compactedRounds` / `originalTokens` / `compactedTokens` / `summaryTokens` / `degraded` / `summary` |

与单 Agent 同名同形状，前端共用同一解析与提示。

## 回归结果

| 项 | 结果 |
| --- | --- |
| 服务端 `tsc -p tsconfig.server.json --noEmit` | 通过（改动文件零错误） |
| `memoryPrompt.test.ts` 三态单测 | 3/3 通过 |
| 全仓 `*.test.ts` 单测 | 171/171 通过 |
| `npm run build` | 卡在 `useChat.ts` 的 `_loadModelOptions` 既有告警（与本阶段无关） |
| `npm run test:chains` | 需起服务（tsx IPC 管道），沙箱内 EPERM 未跑 |

## 失败路径

- **摘要失败**（超时 / 非法 JSON / schema 不过）：`maybeSummarize` 返回 null，
  `degraded: true`，Worker 回退「只有近期原文的裸窗口」，照常执行。
- **无 API Key / Mock 模式**：跳过摘要生成，不推 `context_compacted`，零额外网络往返。
- **首轮 / 无历史**：`rawHistory` 为空，跳过整段压缩，零开销。
- **图片不跨轮**：带附件的历史消息不进 `rawHistory`（与单 Agent 清洗口径一致）。

## 已知边界 / 后续优化

- multi 服务端当前**每轮独立压缩**，暂不消费前端上传的旧摘要 `previousSummary`。
  前端请求体仍带 `contextSummary`，跨轮增量摘要可作后续优化。
- 真实模型功能验收需 `LLM_API_KEY` 且 `MOCK_MODE != 1`；多 Agent 不支持 Mock，
  因此本阶段功能验证在单测层面完成压缩管线。
