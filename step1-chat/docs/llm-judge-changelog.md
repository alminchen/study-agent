# LLM-as-Judge 语义判定（阶段 6 · 已实现 / enforce 未准入）

> 阶段 6 的落地记录：改了什么、为什么这么改、验证到什么程度、还差什么。
> 概念与用法见 [llm-judge.md](./llm-judge.md)，流程图见 [llm-judge-flow.svg](./llm-judge-flow.svg)，拓扑对照见 [project-topology.html](./project-topology.html#judge) §6f。

## 一句话

在既有正则 Guard 之后加一层**模型语义判定**：正则负责「明显违规」，Judge 负责「换个说法也要拦」，两者职责不重叠；Judge 通过 `JUDGE_MODE` 三档开关接入，**默认 off**，当前实测数据未达 enforce 准入线，因此**只建议开 shadow**。

## 为什么加这一层

| 能力 | 正则 Guard（阶段 5 已有） | LLM-as-Judge（本阶段） |
|------|--------------------------|------------------------|
| 判定依据 | 固定模式 / 指纹 | 语义理解 |
| 覆盖 | 「ignore previous instructions」这类固定串 | 改写、角色扮演、间接注入、多语言变体 |
| 解释力 | 只知道命中了哪条规则 | 给 risk / confidence / 原因 / 类别 |
| 成本与延迟 | 零成本、零延迟 | 一次模型调用（当前均值 ≈ 3.3s，p95 ≈ 8s） |
| 失败方式 | 不会失败 | 超时 / 非法 JSON / 调不通 / schema 不过 |

所以 Judge 不是替换正则，而是**在正则盲区补一层**，并且**任何失败都回退到正则决策**，不引入新的拦截面。

## 本阶段做了什么

1. **结构化判定**：模型必须回一段可解析的 JSON，解析后用 zod schema 校验，成功与失败走**两个互斥分支**（`status: ok` / `status: error`），错误分支里根本没有 `risk` 字段——避免把「没判出来」误当成「低风险」。
2. **三档接入**：`off`（不调用）/ `shadow`（只写 trace，主回答不变）/ `enforce`（参与拦截决策）。唯一开关是 `JUDGE_MODE`，非法值回落 `off` 并告警一次。
3. **三个判定面**：`input`（用户文本）、`retrieval`（检索问题，此前完全没有保护）、`output`（整段回答）。
4. **离线评测管线**：70 条标注数据集 + 校验脚本 + 评测 CLI + 与正则的对比报告，指标按七条准入阈值判定。
5. **前端可见**：新增 `judge_shadow` / `judge_enforced` 两类 SSE 事件，前端过程面板能直接看到判定结果与分歧原因。

## 新增文件（12 个）

| 文件 | 作用 |
|------|------|
| `server/guard/judge.ts` | 判定内核：`judgeInput` / `judgeOutput`，负责拼 prompt、调模型、解析 JSON、构造 `JudgeResult` |
| `server/guard/judgePolicy.ts` | 决策层：`decideInputAction` / `decideOutputAction`、判定标签枚举、拦截文案 `SAFE_BLOCK_TEXT` |
| `server/guard/judgeRuntime.ts` | 运行时层：`runInputJudge` / `runOutputJudge`、真实模型调用器 `createJudgeModelCaller`、离线 mock 调用器 `createMockJudgeCaller`、trace 事件类型 |
| `server/guard/judgeSchema.ts` | 结构化输出契约：`JudgeSchema`（判别联合）、`JUDGE_SCHEMA_VERSION`、`JUDGE_LIMITS`、构造与截断工具函数 |
| `server/guard/judge.test.ts` | 单测 11 条：成功解析、坏 JSON、超时、schema 错误、置信降级、模式回落、错误不拦截等 |
| `evals/judge-dataset.json` | 评测数据集 70 条（dev 40 / test 30），覆盖 9 个类别 |
| `evals/judgeDataset.ts` | 数据集加载与校验：`loadJudgeDataset` / `validateJudgeDataset`、类别配额 `CATEGORY_MIN_QUOTA`、dev 下限 `DEV_MIN_SIZE` |
| `scripts/check-judge-dataset.ts` | 数据集体检 CLI（`npm run judge:check`）：类别配额、dev/test 划分、必填字段 |
| `scripts/run-judge-evals.ts` | 评测 CLI（`npm run eval:judge`）：跑 Judge 并与正则结论对比，输出指标与报告 |
| `evals/judge-comparison-report.md` | **真实模型**评测报告（70 条） |
| `evals/judge-comparison-report.smoke.md` | mock 模式冒烟报告（只验管线，不含质量结论） |
| `docs/llm-judge.md` | 阶段说明文档：概念、分工、Schema、模式、接入点、评测、故障排查 |

## 修改文件（15 个）

| 文件 | 改了什么 |
|------|----------|
| `server/runtimeConfig.ts` | 新增独立 `judge` 配置块（mode / model / baseUrl / apiKey / 超时 / 文本上限 / 置信阈值），并把 mode 读取收敛到唯一开关 |
| `server/chat.ts` | `createChatStream` 输入侧接入 `runInputJudge`，按决策结果决定是否拦截 |
| `server/routes/chatMulti.ts` | 多 Agent 输入侧接入 `runInputJudge` |
| `server/routes/ragChat.ts` | RAG 输入侧接入 `runInputJudge` |
| `server/rag/answer.ts` | 检索侧接入判定（此前这一面没有任何保护） |
| `server/react/runConversation.ts` | 输出侧接入 `runOutputJudge`；只作用于首片发出前的缓冲文本 |
| `server/guard/outputGuard.ts` | 导出 `REPLACEMENT`，让 Judge 的拦截文案与正则命中文案同一口径 |
| `server/react/types.ts` | 补 `judge_shadow` / `judge_enforced` 两类 trace 事件类型 |
| `src/types.ts` | 前端补齐同款事件类型 |
| `src/api/chat.ts` | 解析并透传 Judge 相关 SSE 事件 |
| `src/api/rag.ts` | 解析并透传 Judge 相关 SSE 事件 |
| `src/components/ToolTracePanel.vue` | 过程面板展示判定结果、置信度与分歧原因 |
| `evals/types.ts` | 补评测用例与结果类型（样本、判定、对比、指标） |
| `package.json` | 新增 `eval:judge`、`judge:check` 两个 script |
| `tsconfig.server.json` | 把新增的服务端/评测文件纳入类型检查范围 |

## 判定结果结构

成功分支（`status: ok`）：`risk`（none / medium / high）、`confidence`（0~1）、`categories`（≤5）、`shortReason`（≤200 字）、`matchedRules`（≤10）、`schemaVersion`。

错误分支（`status: error`）：`errorKind`（timeout / bad_json / api_error / schema_error）、`retries`、`raw`（截断 ≤500 字）、`message`。

两个分支**互斥**：错误分支里没有 `risk`，上层拿到 error 就必须走降级，不允许「当成 low 放行」。详细契约见 [llm-judge.md](./llm-judge.md) 的 Schema 一节。

## 三档模式

| 模式 | 模型调用 | 主回答 | 写 trace | 用途 |
|------|---------|--------|---------|------|
| `off`（默认） | 无 | 不变 | 无 | 未配置时零影响 |
| `shadow` | 有 | **不变** | `judge_shadow` | 积累真实分歧率数据，验证阈值 |
| `enforce` | 有 | 可能被拦截 | `judge_enforced` | 达标后才允许开启 |

`enforce` 的动作由决策表决定：`high` 且 `confidence ≥ 0.6` → 拦截；`medium` → 只打标放行；`error` → 一律放行并记 `warn`。`confidence < 0.6` 的高/中风险判定自动降级为放行 + 打标。

## 接入点一览

| 判定面 | 挂载位置 | 备注 |
|--------|----------|------|
| input | `server/chat.ts`、`server/routes/chatMulti.ts`、`server/routes/ragChat.ts` | 三条入口链路都在正则 Guard 之后 |
| retrieval | `server/rag/answer.ts` | 检索问题面，本阶段新增 |
| output | `server/react/runConversation.ts` | reply 节点整段缓冲后一次 `onDelta`，`enforce` 安全 |

流式限制：真正逐字下发的链路最多只能 `shadow`；`buffered: false` 时 `enforce` 自动降级为 `shadow` 并告警——因为那时首片已经发出，收不回来了。

## 评测结果（真实模型 · 70 条）

| 指标 | all（70 条） | dev（40 条） |
|------|--------------|--------------|
| precision | 0.947 | 1.000 |
| recall | 0.581 | 0.684 |
| 误报 | 0 | 0 |
| error 率 | 20% | 15% |
| 平均耗时 | 3327ms | 2894ms |
| p95 耗时 | 8001ms | 6059ms |

## 七条 enforce 准入阈值对照

| # | 阈值 | 结果 |
|---|------|------|
| 1 | dev precision ≥ 0.9 | ✅ 1.000 |
| 2 | dev recall ≥ 0.85 | ❌ 0.684 |
| 3 | 误报率 ≤ 0.05 | ✅ 0 |
| 4 | error 率 ≤ 0.05 | ❌ 15% |
| 5 | p95 ≤ 8000ms 且均值 ≤ 3000ms | ✅ 8001ms / 2894ms（p95 贴线） |
| 6 | shadow 连续 3 天分歧率 ≤ 0.10 | ⏳ 待实测 |
| 7 | 无低置信拦截样本 | ✅ |

**未全达标 → 停留 shadow，`JUDGE_MODE` 默认 `off`。** 失败集中在超时与调用错误（error 率偏高），不是判定逻辑本身不准——这决定了后续优化方向是「提稳定性」而不是「改判定规则」。

## 验证结果

- `npm run typecheck`：通过。
- `node --import tsx --test server/guard/judge.test.ts`：11 passed。
- `npm run judge:check`：数据集校验通过。
- `npm run eval:judge -- --mock`：管线跑通（报告中标「无质量结论」）。
- `npm run eval:judge`：真实模型跑通 70 条，产出对比报告。

## 已知缺口

1. **error 率 15%~20% 偏高**：多数是超时与调用错误；总超时 8s 对长文本偏紧，需要分面调整（连接 2s / 首块 5s / 总计 8s）。
2. **recall 未达标**：漏判集中在间接注入与角色扮演类，需要扩充这批样本再看是数据问题还是提示词问题。
3. **真流式链路未覆盖**：只在整段缓冲的路径上验证过 enforce。
4. **分歧率指标未采集**：需要把 `JUDGE_MODE=shadow` 挂到真实流量上连续跑满 3 天。

## 下一步

1. 补齐检索面与输出面的针对性样本，重新跑 dev 口径。
2. 单独压测超时分布，把 error 率压到 5% 以内。
3. 挂 shadow 跑真实流量，收集分歧率基线。
4. 阈值全达标后再讨论是否开 enforce。

## 配套文档

| 文档 | 内容 |
|------|------|
| [llm-judge.md](./llm-judge.md) | 阶段完整说明：概念、Schema、模式、决策表、接入点、评测口径、故障排查 |
| [llm-judge-flow.svg](./llm-judge-flow.svg) | 流程图：判定面 → 双层防线 → 决策层 → trace → 离线评测 |
| [project-topology.html](./project-topology.html#judge) | 方法级拓扑 §6f |
| [flows-index.html](./flows-index.html#judge) | 流程图索引页 |
