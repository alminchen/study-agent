# Reflection 自我评估与重写（阶段 7 · 已实现 / enforce 未准入）

> 配套说明见 `docs/reflection.md`。本文件只记录"改了什么、为什么、验证到哪一步"。

## 一句话

在 Judge（安全判定）之外新增一条**独立的质量改进链路**：
对已生成的 draft 打四维结构化分数，低于阈值就重写一次，
产出 `reflection_scored` / `reflection_revised` / `reflection_skipped` 三类 trace 事件，
以 `REFLECTION_MODE` 三档开关控制，**默认 `off`**。

## 为什么加这一层

阶段 6 之后仓库里的守卫全是"安全向"的：正则 Guard 和 LLM-as-Judge 都不评价答案质量。
缺的一块是**不含任何危险内容、但答得含糊、漏项、没依据**的情况——
没有任何守卫会拦，用户只能自己感觉到"没那么好用"。

这一层刻意**不复用** Judge 的结构，原因是判错代价与降级方向相反（详见 `docs/reflection.md` 第 3 节）：
Judge 误判会挡人，Reflection 误判只是多花一轮调用；Judge 失败要变严，Reflection 失败要变松。

## 本阶段做了什么

1. 定义评分契约：四维固定 rubric（相关性 / 完整性 / 事实依据 / 清晰度，各 1~5 整数），
   `Critique` 判别联合，`status: "error"` 时**不得含分数**；
2. 实现 Critic：模型调用 + 结构化解析 + 失败路径，阈值规则由代码判定而非模型自述；
3. 实现重写：只拿问题 / 工具事实 / draft / 修订指令，不调工具，并加事实守卫；
4. 新增端点 `POST /api/chat/reflection`，串联校验 → draft → 评分 → 可选重写 → SSE → dispose；
5. 注册路由与 `REFLECTION_MODE` 配置（`off` / `shadow` / `enforce`）；
6. 前端 trace 接入三种 kind，rubric 只在调试面板展示；
7. A/B evals 数据集与 CLI，产出四列对比报告（当前为 mock 数据）。

## 新增文件

| 文件 | 作用 |
| --- | --- |
| `reflection/types.ts` | `CritiqueSchema`、判别联合、`schemaVersion: "reflection.v1"`、事件类型 |
| `reflection/critic.ts` | Critic 调用、解析、失败路径、阈值规则 |
| `reflection/revise.ts` | 重写生成 + 事实守卫 |
| `routes/chatReflection.ts` | `POST /api/chat/reflection` 端点与 SSE |
| `reflectionDataset.ts` | 数据集校验 |
| `dataset-reflection.json` | A/B 数据集 |
| `run-reflection-evals.ts` | 离线 A/B CLI |
| `docs/reflection.md` | 功能说明（自我评估偏差 / Judge 分层 / 默认不启用条件） |
| `docs/reflection-changelog.md` | 本文件 |

## 修改文件

| 文件 | 修改点 |
| --- | --- |
| `routes/index.ts` | 注册 `/api/chat/reflection` |
| `runtimeConfig.ts` | 新增 `REFLECTION_MODE`，非法值回落 `off`；服务端语义为上限 |
| `src/types.ts` | `ToolTraceStep` 新增 `reflection_scored` / `reflection_revised` / `reflection_skipped` |
| `api/chat.ts` | 新增 `streamReflection`（SSE 解析） |
| `composables/useChat.ts` | `onTrace` push 反思事件 |
| `ToolTracePanel.vue` | 三种 kind 渲染分支 |
| `usage/accumulator.ts` | `UsageSource` 增加 `critic` / `revise` |
| `tsconfig.server.json` | 纳入 evals CLI 脚本 |

## 评分契约

| 维度 | 字段 | 分数 |
| --- | --- | --- |
| 相关性 | `relevance` | 1~5 |
| 完整性 | `completeness` | 1~5 |
| 事实依据 | `groundedness` | 1~5 |
| 清晰度 | `clarity` | 1~5 |

阈值：任一维 ≤ 3，或存在 groundedness 问题 → 触发重写（最多 1 次）。
重写后重评不优于初版则回退初版并停止。

## 三档模式

| 模式 | 行为 |
| --- | --- |
| `off` | 直接返回 draft（默认） |
| `shadow` | 评分但不重写，只推 trace |
| `enforce` | 达阈值则重写一次 |

请求只能把模式往下调，不能往上抬。

## 接入点一览

- 端点：`POST /api/chat/reflection`
- 事件：`reflection_scored`（`stage: initial | revised`）、`reflection_revised`（`adopted` / `improved`）、`reflection_skipped`（`reason`）
- skip 原因：`off` / `mock_mode` / `critique_failed` / `no_rewrite_needed` / `revise_failed` / `revise_rejected` / `revise_no_change` / `rescore_failed` / `no_improvement` / `shadow_mode`
- 用量标签：`critic` / `revise`

## 评测结果（mock · 8 条）

- 触发重写 6/8；重写被采纳 6/8；预期一致 75%
- 报告：`evals/reflection-comparison-report.md`（**顶部有 mock 无质量结论横幅**）

这次只验证链路与统计口径可用，**不构成质量收益证据**。

## 验证结果

- `tsc -p tsconfig.server.json --noEmit` 通过
- `npx tsx scripts/run-reflection-evals.ts` 跑通并产出报告
- 端点可访问，开关可切换，三类事件均可推送

## 已知缺口

1. `reflection/*.test.ts` 单测尚未补齐（步骤 9）
2. 真实模型 A/B 尚未跑，四列对比仍是 mock
3. 阈值是硬编码常量，未按题目类型分档、未用评测数据拟合
4. 未接入 plan-execute / multi-agent 路径
5. 重写只拿到裁剪后的工具事实，长检索引用场景可能改错

## 下一步

1. 跑真实模型 A/B，按准入条件核对是否允许 `enforce`
2. 补 `reflection/*.test.ts` 单测
3. shadow 期观察 skip 原因分布与重写采纳率

## 配套文档

- `docs/reflection.md` —— 功能说明与运维口径
- `docs/llm-judge.md` —— 阶段 6：Judge（分层对照）
