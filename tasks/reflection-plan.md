# Reflection 阶段 7 执行计划

- 目标：给 `study-ai/step1-chat` 增加“回答自评与一次修订”能力，端点为 `POST /api/chat/reflection`，默认不并入默认聊天。
- 输出：一份可下达指令的执行文档，写完后等待用户指令再执行。

---

## 0. 一句话结论

Reflection 是一个实验性的“自评 → 最多一次重写 → 无改进即停”管线，独立于默认聊天，靠 A/B Evals 证明质量提升才可能默认启用，Judge 只做安全判定、不改写，两者完全分层。

---

## 1. 为什么要学这条路径

### 是什么

Reflection（自评与一次修订）是第 7 阶段学习路径。它在 ReAct 最终答案之后，加一个可选的 Critic 评分环节：用固定 rubric 对 draft 打 1～5 分，低于阈值则重写一次，重写后再评分，不优于初版则回退并停止。结果只通过 `reflection_scored` / `reflection_revised` / `reflection_skipped` 事件在调试面板暴露，不进入正文。

### 当前盲区（project现状，tasks/plan.md 第 28 行）

ReAct 图在最终 `reply` 直接结束，没有 Critic、没有评分阈值、没有修订重试、也没有无改进停止。也就是说，模型一次出答案后就直接返给用户，没有“先自己打分、不满意再改一次”的质量缓冲，也无法用数据说出“这一轮额外推理是否真的让答案更好”。

### 能为我做什么

1. 给最终答案加一道质量闸：相关性、完整性、事实依据、清晰度四维 1～5 分，低分才触发重写，避免每次都多一轮成本。
2. 用离线 A/B Evals 量化：原答案 vs Reflection 答案，记录质量分、延迟、token、成本四列对比，证明是否真的提升质量。
3. 把三个容易混淆的能力明确分层：Judge = 安全判定（allow/block/flag，不改写），Reflection = 质量改进（评分 → 最多一次重写），工具失败重试 = 工具层。三者不复用同一提示词、不共用 schema、不共用决策表。
4. 产出可落地的文档与验收：`docs/reflection.md` 说明自我评估偏差，验收标准里明确“未证明收益时不默认启用”。

### 为什么这么设计

- **固定 rubric 结构化评分**：Critic 必须返回带版本号的结构化 JSON（schema + 成功/失败判别联合），失败时不得伪造分数，避免模糊建议导致重写更差。
- **最多一次修订，无改进即停**：成本上限锁死在两轮（draft + 最多一次重写），第二次评分不高于第一次则回退初版，禁止继续循环。
- **独立端点，不改现有 ReAct 图**：新增 `POST /api/chat/reflection`，先生成 draft 再评估，失败降级返回 draft，不影响默认聊天。
- **Evals 先于默认启用**：只有 A/B 数据稳定提升时才考虑并入默认聊天，否则保留为实验能力。

### 学完能回答的问题

- Reflection、LLM-as-Judge、工具失败重试三者分别负责什么，边界在哪？
- Critic 返回什么结构？分数怎么算？什么时候触发重写？
- 重写后如果更差怎么办？成本上限怎么控？
- 如何用 Evals 证明 Reflection 提升质量而非只增加成本？
- 默认情况下是否开启？开启的条件是什么？

### 不该上的情况

- 不要把 Reflection 当人工质量保证：同一模型自评可能偏好自己的表达，不等同于人工判断。
- 不要让 Reflection 判断工具执行正确性：那是工具层的事，Critic 只针对最终答案的四维 rubric。
- 不要在 Evals 未证明收益前默认启用并入默认聊天。
- 不要复用 Judge 的提示词、schema 或决策表。

---

## 2. 前置条件

1. 第 1 项能输出结构化 Critic 结果（已有结构化输出契约：`server/structured/types.ts`，zod 判别联合 + `schemaVersion`）。
2. 第 6 项已说明 Judge 只做安全判定；Reflection 只做质量改进，两者不复用同一个提示词。
3. 已有 SSE 基础设施：`server/routes/sse.ts` 的 `setSseHeaders`、`writeUsageToStream`；前端 `src/api/chat.ts` 的 `streamChat` / `streamPlan` 等。
4. 已有 trace 风格：`server/react/types.ts` 的 `ToolTraceHandler` 联合类型，前端 `src/types.ts` 的 `ToolTraceStep`、`src/components/ToolTracePanel.vue`。
5. 已有 Evals 目录与 CLI 先例：`evals/types.ts`、`evals/dataset-plan.json`、`scripts/run-judge-evals.ts`。
6. 已有运行时配置入口：`server/runtimeConfig.ts` 的 `getRuntimeConfig()`。

---

## 3. 评分契约设计（硬依赖：结构化评分）

### 固定 rubric 维度（只针对最终答案）

| 维度 | 分数 | 说明 |
|------|------|------|
| 相关性 | 1～5 | 答案是否回应了用户问题 |
| 完整性 | 1～5 | 是否覆盖了问题的所有子项 |
| 事实依据 | 1～5 | 是否仅基于工具返回的事实，不编造新依据 |
| 清晰度 | 1～5 | 组织是否清晰、易读 |

### Critic 输出结构（`server/reflection/types.ts`）

- `schemaVersion: string`（固定，如 `"reflection.v1"`）
- 四项 1～5 分 + `issues: string[]`
- `shouldRewrite: boolean`
- `revisionInstructions: string`
- `reason: string`
- 判别联合：`status: "ok"` 含业务字段；`status: "error"` 不含业务字段（如无分数、无建议），失败时不得伪造分数。

### 失败路径（评分层）

- Critic 返回模糊建议或非法 JSON → 当作评分失败，返回 `status: "error"`，不重写，返回 draft。
- 评分超时或模型不可用 → 降级为 `reflection_skipped`，返回 draft。

---

## 4. 模式与决策表

### 运行模式（`runtimeConfig.ts` 新增 `REFLECTION_MODE`）

| 模式 | 含义 | 默认 |
|------|------|------|
| `off` | 关闭，直接返回 draft | — |
| `shadow` | 评分但不重写，只推送 trace | 实验期 |
| `enforce` | 评分达阈值则重写一次 | 仅 Evals 证明收益后 |

### 阈值与停止规则

- 首版阈值：任一维度 <= 3 或存在 groundedness（事实依据）问题 → 触发重写。
- 重写最多 1 次，Critic 不能调用工具；重写只拿到原问题、工具事实、draft 和修订指令。
- 第二次评分如果不高于第一次，返回第一版或较优版本，禁止继续循环。
- 无改进立即停止，推送 `reflection_skipped` 或回退初版。

### 成本边界

- 最多两轮模型调用（draft + 最多一次重写）。
- 修订后重评，若不优于初版则回退初版并停止，成本翻倍但离线 Evals 无提升时不默认启用。

---

## 5. 落地接入点（精确到文件与函数）

### 新增模块

| 文件 | 职责 |
|------|------|
| `server/reflection/types.ts` | `CritiqueSchema`、判别联合、`schemaVersion`、trace 事件类型 |
| `server/reflection/critic.ts` | Critic 模型调用、结构化解析、评分失败路径 |
| `server/reflection/revise.ts` | 重写生成（只拿问题/工具事实/draft/修订指令，不调用工具） |
| `server/routes/chatReflection.ts` | `POST /api/chat/reflection`：校验 → 装配 draft → 评分 → 可选重写 → SSE → dispose |
| `evals/dataset-reflection.json` | A/B 数据集 |
| `evals/reflectionDataset.ts` | 数据集校验 |
| `scripts/run-reflection-evals.ts` | A/B 离线 Evals CLI，报告输出 `evals/reflection-comparison-report.md` |
| `docs/reflection.md` | 功能说明与自我评估偏差 |
| `docs/reflection-changelog.md` | 变更记录 |

### 修改模块

| 文件 | 修改点 |
|------|--------|
| `server/routes/index.ts` | 注册 `/api/chat/reflection` 路由 |
| `server/runtimeConfig.ts` | 新增 `REFLECTION_MODE` 开关 |
| `src/types.ts` | `ToolTraceStep` 新增 `reflection_scored` / `reflection_revised` / `reflection_skipped` 三种 kind |
| `src/api/chat.ts` | 新增 `streamReflection`（SSE 解析、`[DONE]`、`{ delta }`、`{ type:"usage" }`、`{ error }` 约定） |
| `src/composables/useChat.ts` | `onTrace` 回调把反思事件 push 进 `toolTrace` |
| `src/components/ToolTracePanel.vue` | 新增三种 kind 的分支渲染，只在调试面板展示评分，不把 rubric 当正文 |
| `server/reflection/*.test.ts` | Critic / 重写 / 决策表单元测试 |

### 端点契约（`POST /api/chat/reflection`）

1. 校验请求体（问题、会话 ID、可选模型）。
2. 独立装配：生成 draft（复用 `createChatStream` 做 fallback，不直接改现有 ReAct 图）。
3. Critic 评分：低于阈值则重写一次；重写后再评分，不优于初版则回退。
4. SSE 推送 `reflection_scored`、`reflection_revised`、`reflection_skipped` 及 usage 事件。
5. `finally` 中 dispose 资源；失败降级返回 draft。

---

## 6. A/B Evals 与量化口径

### 数据集

用 `evals/dataset-reflection.json` + `evals/reflectionDataset.ts`，条目包含：用户问题、工具事实、期望质量方向。参考 `evals/dataset-plan.json` 格式，CLI 参考 `scripts/run-judge-evals.ts`（dotenv 加载 `.env.local`/`.env`、`CONCURRENCY = 4`）。

### 对比四列

| 指标 | 原答案 | Reflection 答案 | 差值 |
|------|--------|-----------------|------|
| 质量评分（Critic 四维平均） | | | |
| 延迟（ms） | | | |
| token 数 | | | |
| 成本 | | | |

### 判定规则

- 质量分稳定提升且延迟/成本在可接受范围内 → 考虑从 `shadow` 移向 `enforce`。
- 未证明收益 → 保留端点为实验能力，不并入默认聊天，不默认启用。

---

## 7. 执行步骤（每条含改哪些文件、验收标准）

1. **定义评分契约**：新增 `server/reflection/types.ts`，写出 `CritiqueSchema`、判别联合、`schemaVersion`；验收：`npm run typecheck` 通过，schema 能序列化/反序列化。
2. **实现 Critic**：新增 `server/reflection/critic.ts`，模型调用 + 结构化解析 + 失败路径（不伪造分数）；验收：单元测试覆盖合法/非法/模糊返回。
3. **实现重写**：新增 `server/reflection/revise.ts`，只拿问题/工具事实/draft/修订指令，不调用工具；验收：重写不引入工具事实之外的新依据。
4. **实现端点**：新增 `server/routes/chatReflection.ts`，校验 → draft → 评分 → 可选重写 → SSE → dispose；验收：`reflection_scored`/`reflection_revised`/`reflection_skipped` 三类事件均能推送。
5. **注册路由与配置**：修改 `server/routes/index.ts` 注册 `/api/chat/reflection`；修改 `server/runtimeConfig.ts` 新增 `REFLECTION_MODE`；验收：端点可访问，开关可切换。
6. **前端 trace 接入**：修改 `src/types.ts` 新增三种 kind；修改 `src/api/chat.ts` 新增 `streamReflection`；修改 `src/composables/useChat.ts` push 事件；修改 `src/components/ToolTracePanel.vue` 渲染分支；验收：调试面板显示是否评分、是否重写、为什么停止，rubric 不入正文。
7. **Evals 数据与 CLI**：新增 `evals/dataset-reflection.json`、`evals/reflectionDataset.ts`、`scripts/run-reflection-evals.ts`；验收：`npx tsx scripts/run-reflection-evals.ts` 出报告 `evals/reflection-comparison-report.md`，含四列对比。
8. **文档**：新增 `docs/reflection.md`、`docs/reflection-changelog.md`；验收：说明自我评估偏差、与 Judge 分层、默认不启用条件。
9. **测试与构建**：新增 `server/reflection/*.test.ts`；运行 `npm run typecheck`、`npm run build`；验收：无类型错误，构建通过。

---

## 8. 文件清单

### 新增

- `server/reflection/types.ts`
- `server/reflection/critic.ts`
- `server/reflection/revise.ts`
- `server/reflection/critic.test.ts`
- `server/reflection/revise.test.ts`
- `server/routes/chatReflection.ts`
- `evals/dataset-reflection.json`
- `evals/reflectionDataset.ts`
- `scripts/run-reflection-evals.ts`
- `docs/reflection.md`
- `docs/reflection-changelog.md`

### 修改

- `server/routes/index.ts`
- `server/runtimeConfig.ts`
- `src/types.ts`
- `src/api/chat.ts`
- `src/composables/useChat.ts`
- `src/components/ToolTracePanel.vue`

---

## 9. 失败路径与降级

| 失败情形 | 降级行为 |
|----------|----------|
| Critic 返回模糊建议 / 非法 JSON | 当作评分失败，返回 `status: "error"`，不重写，返回 draft |
| 评分超时 / 模型不可用 | 降级为 `reflection_skipped`，返回 draft |
| 重写引入工具事实之外的新依据 | 视为重写失败，回退初版 |
| 第二次评分不高于第一次 | 回返第一版或较优版本，禁止继续循环 |
| 用户停止时仍在执行第二次评分 | 中断并返回当前最好版本 |
| 成本翻倍但离线 Evals 无提升 | 保留端点为实验能力，不默认启用 |

---

## 10. 验收标准

- 最多 1 次修订，无改进立即停止。
- 重写版本不引入工具事实之外的新依据。
- trace 清楚显示是否评分、是否重写、为什么停止。
- 有原版与 Reflection 的成本/质量对比，未证明收益时不默认启用。
- Judge 只做安全判定，Reflection 只做质量改进，两者不复用同一提示词、不共用 schema、不共用决策表。
- Critic 返回结构化 JSON 带版本号，失败时不得伪造分数。
- `npm run typecheck`、`npm run build` 通过；`scripts/run-reflection-evals.ts` 能出报告。

---

## 11. 验证命令

```bash
npx tsx --test server/reflection/*.test.ts
npx tsx scripts/run-reflection-evals.ts
npm run typecheck
npm run build
```

---

## 12. 风险与边界

- **与 Judge 分层**：Judge = 安全判定（allow/block/flag，不改写）；Reflection = 质量改进（评分 → 最多一次重写）；工具失败重试 = 工具层。三者不复用同一提示词、不共用 schema、不共用决策表。
- **自我评估偏差**：同一模型自评可能偏好自己的表达，不等同于人工质量保证，须在 `docs/reflection.md` 说明。
- **默认不启用**：Evals 未证明收益前，端点仅作为实验能力，不并入默认聊天。
- **成本上限**：最多一次修订，无改进即停，防止无限循环和成本失控。

---

*文档就绪，等待用户指令后再执行具体实现步骤。*
