# Reflection 学习笔记与运维说明

> 这份文档是阶段 7（Reflection）的沉淀稿：写给下一个接手这块的人。
> 读完应该能回答四个问题——它是什么、为什么要做自我评估、与 Judge 怎么分层、怎么开、坏了怎么降级。
>
> 文中的代码路径都是应用工作区内的**两级相对路径**（目录/文件）：
> `reflection/critic.ts` 指服务端 reflection 目录下的 `critic.ts`；
> `runtimeConfig.ts` 指服务端根目录下的配置文件。

---

## 1. 一句话

Reflection 是「让模型给自己的最终答案再打一次分、按分数重写一次」的质量改进层：
输入一个已经生成的 draft，输出一个**结构化评分**（相关性 / 完整性 / 事实依据 / 清晰度）与修订指令，
分数不达标时最多重写一次，**不调工具、不做安全判定**。

当前状态：**代码已就位，`REFLECTION_MODE` 默认 `off`**，
离线 A/B 报告目前只有 mock 数据，**没有真实收益结论**，因此不并入默认聊天链路。

---

## 2. 它解决什么问题

### 2.1 当前盲区

仓库里已有两条守卫链路，但都不是"答案好不好"的守卫：

- **正则 Guard**：输入 / 输出的关键词与指纹匹配，做安全拦截，不评价内容质量。
- **LLM-as-Judge**：语义级安全判定，回答"这段话安不安全"，仍然不评价"答得好不好"。

于是缺的一块是：**模型在完全没有危险内容的情况下，把一个含糊、漏项、没有依据的答案讲得很顺**。
这类错误不会触发任何守卫，也不会让用户立刻察觉——它只是"没那么好用"。
Reflection 补的就是这一块。

### 2.2 自我评估偏差：为什么不能只信模型自评

"让模型反思自己的答案"听起来自然，但直接采信模型的自评有三个已知陷阱：

| 偏差 | 表现 | 后果 |
| --- | --- | --- |
| 自我偏好（self-preference） | 评委更偏好与自己措辞、节奏、风格相近的输出 | 流畅自信但空泛的答案系统性高分 |
| 长度 / 结构偏好 | 更长、更有条理、排版更花哨的答案在四个维度上普遍得高分 | 与事实是否正确无关的虚高 |
| 自夸倾向（self-enhancement） | 评自己时在"清晰度""完整性"上很难扣分 | 扣分迟疑，低分难触发 |

所以本阶段的实现做了两件事，把"模型自评"从**裁决者**降级为**信号源**：

1. **固定 rubric，不让模型自由评价**：只打四个固定维度（各 1~5 整数），
   模型无法选择"换个角度批评一下"这种自我放水方式。
2. **阈值由代码判定，不由模型自述**：模型输出里的 `shouldRewrite` 只是参考，
   真正决定是否重写的是 `critic.ts` 里的阈值规则——
   **四维任一 ≤ 3，或存在事实依据（groundedness）问题，才触发重写**。
   模型说"不用改"不阻止重写，模型说"要改"也不能越过阈值自己改写。

### 2.3 分数的边界

四维分数是**触发信号**，不是验收指标：

- 不进正文（前端只在调试面板展示 rubric，不让用户看到"你的答案 3 分"）；
- 不参与安全判定（高风险内容由 Judge / 正则负责，与分数无关）；
- 不跨模型可比（不同模型的"4 分"含义不同），因此只用于同一模型内的前后对比；
- 不替代事实校验——真正的编造由 `revise.ts` 的事实守卫兜底：
  重写只允许使用**工具返回的事实 + 原问题 + 原答案 + 修订指令**，
  新出现的事实型 token 找不到来源时，重写被作废、回退初版。

---

## 3. 与 Judge 的分层

Judge 与 Reflection 都用模型，都拿模型输出当输入，但**目的、动作、失败策略完全不同**，因此必须分层，不能互相替代。

| 维度 | LLM-as-Judge | Reflection |
| --- | --- | --- |
| 目的 | 安全判定：这内容危不危险 | 质量改进：这答案答得好不好 |
| 输入 | 用户输入 / 模型输出 | 用户问题 + 工具事实 + draft |
| 输出 | 风险等级 + 置信度 + 分类 + 一句话理由 | 四维分数 + issues + 修订指令 |
| 是否改写答案 | **否**，只给建议，是否替换交调用方 | **是**（shadow 模式除外），最多重写一次 |
| 是否能调工具 | 否 | **否**，只能读取已发生的事实 |
| 触发条件 | 风险等级 + 置信度阈值 | 四维任一 ≤ 3，或存在事实依据问题 |
| 失败策略 | 降级回正则 Guard，不阻塞主链路 | 返回 draft，推 `reflection_skipped` |
| 能否进正文 | 否 | 否（rubric 只在调试面板） |
| 模式开关 | `JUDGE_MODE` | `REFLECTION_MODE` |

### 为什么必须分层

1. **判错代价不同**：Judge 误判会挡掉正常请求，Reflection 误判只是多花一轮模型调用或改差一次答案。
   两者混在一层，会用"质量"的标准去拦人，或者用"安全"的标准去改写。
2. **一个判、一个改**：Judge 的产物是"证据"，Reflection 的产物是"新文本"。
   如果让一个模型同时负责判定安全并重写，重写会倾向于"把话说圆"，反而削弱安全信号。
3. **降级方向相反**：Judge 失败时降级到更严的规则（正则）；Reflection 失败时降级到更弱的行为（原 draft）。
   一个失败就变严、一个失败就变松，语义天然相反，混在一起无法推理。
4. **时序不同**：Judge 要求在字节发出之前完成判定（不能"先发再判"），
   Reflection 则作用于已经成型的 draft，两者作用在不同阶段。

> Judge 的完整说明见 `docs/llm-judge.md`。一句话对照：
> **Judge 决定"要不要拦"，Reflection 决定"要不要改"；两者都不改业务语义之外的东西。**

---

## 4. 三档模式与默认不启用条件

### 4.1 模式

`runtimeConfig.ts` 新增 `REFLECTION_MODE`，取值非法时回落 `off` 并打警告，不抛错、不阻塞启动。

| 模式 | 含义 | 适用阶段 |
| --- | --- | --- |
| `off` | 关闭，直接返回 draft | 默认 |
| `shadow` | 只评分、不重写，只推送 trace 事件 | 实验期唯一推荐 |
| `enforce` | 评分达阈值则重写一次 | 仅 A/B 证明收益后 |

服务端语义是**上限**：请求只能把模式往下调（`off` / `shadow`），不能往上抬。
`resolveReflectionMode` 负责这条约束。

### 4.2 为什么默认是 off

1. **收益未被证明**：离线 A/B 报告 `evals/reflection-comparison-report.md` 目前基于 mock 数据，
   没有真实质量结论（详见第 7 节）。没数据就不该开。
2. **成本与延迟翻倍**：一轮评分 + 一轮重写 + 一轮重评 = 最多三次额外模型往返，
   交互式场景的延迟敏感度远高于质量收益。
3. **误重写会污染正确答案**：阈值规则是保守的，但自我评估偏差意味着分数本身有噪声；
   在噪声下重写一个好答案，比不改更差。
4. **默认聊天链路未接入**：Reflection 目前是独立端点 `POST /api/chat/reflection`，
   不在默认 ReAct 图里，不影响存量行为。

### 4.3 enforce 的准入条件

必须同时满足（当前**均未满足**）：

- 真实模型（非 mock）A/B 数据集上，四维平均分稳定提升，且提升幅度大于评测本身的波动区间；
- 延迟与 token 成本增量在产品可接受范围内；
- 编造事实率不上升（重写引入的新事实必须全部可溯源到工具事实）；
- `revise_rejected` / `no_improvement` 占比在可接受范围（说明重写路径本身稳定）；
- shadow 期线上 trace 观察无异常。

**未证明收益时不默认启用**：达不到就停在 `shadow`，保留端点作为实验能力，不并入默认聊天。

**切换方式**：`export REFLECTION_MODE=shadow` 后重启服务即可，配置每次请求都会重新读环境变量，不带缓存。

---

## 5. 文件地图

| 文件 | 职责 |
| --- | --- |
| `reflection/types.ts` | `CritiqueSchema`、判别联合、`schemaVersion`、trace 事件类型 |
| `reflection/critic.ts` | Critic 模型调用、结构化解析、评分失败路径、阈值规则 |
| `reflection/revise.ts` | 重写生成（只拿问题 / 工具事实 / draft / 修订指令）、事实守卫 |
| `routes/chatReflection.ts` | `POST /api/chat/reflection`：校验 → 装配 draft → 评分 → 可选重写 → SSE → dispose |
| `reflectionDataset.ts` | A/B 数据集校验 |
| `run-reflection-evals.ts` | A/B 离线 Evals CLI，输出 `evals/reflection-comparison-report.md` |
| `src/types.ts` | `ToolTraceStep` 新增三种 kind |
| `api/chat.ts` | 新增 `streamReflection`（SSE 解析） |
| `composables/useChat.ts` | `onTrace` 回调把反思事件 push 进 `toolTrace` |
| `ToolTracePanel.vue` | 三种 kind 的渲染分支，rubric 不入正文 |

### 关键契约

- `schemaVersion` 固定为 `reflection.v1`；
- `Critique` 是判别联合：`status: "ok"` 含业务字段（`scores` / `issues` / `shouldRewrite` / `revisionInstructions` / `reason`），
  `status: "error"` **不含任何分数**，失败时不得伪造分数；
- `scores` 四维均为 1~5 整数：`relevance` / `completeness` / `groundedness` / `clarity`；
- 重写上限 1 次，第二次评分不高于第一次则回退初版，不允许继续循环。

---

## 6. 端点与事件契约

`POST /api/chat/reflection`：

1. 校验请求体（问题、会话 ID、可选模型）；
2. 独立装配 draft（复用 `createChatStream` 做 fallback，不直接改现有 ReAct 图）；
3. Critic 评分：达阈值则重写一次；重写后再评分，不优于初版则回退；
4. SSE 推送 `reflection_scored` / `reflection_revised` / `reflection_skipped` 及 usage 事件；
5. `finally` 中 dispose 资源；失败降级返回 draft。

### 三类 trace 事件

| 事件 | 何时推送 | 载荷要点 |
| --- | --- | --- |
| `reflection_scored` | 评分完成 | `stage: "initial" \| "revised"`、四维分数、issues |
| `reflection_revised` | 重写完成 | `adopted`、`improved`、修订后分数 |
| `reflection_skipped` | 未评分 / 未重写 | `reason`（原因码） |

skip 原因共 10 种：`off` / `mock_mode` / `critique_failed` / `no_rewrite_needed` /
`revise_failed` / `revise_rejected` / `revise_no_change` / `rescore_failed` / `no_improvement` / `shadow_mode`。

调试面板据此显示"是否评分、是否重写、为什么停止"。**rubric 只在调试面板展示，不进入聊天正文。**

### 用量归因

反思相关的模型调用单独打标签（`critic` / `revise`），便于把额外成本从主链路用量里摘出来看。

---

## 7. 评测口径与当前状态

### 四列对比

| 指标 | 原答案 | Reflection 答案 | 差值 |
| --- | --- | --- | --- |
| 质量评分（Critic 四维平均） | | | |
| 延迟（ms） | | | |
| token 数 | | | |
| 成本 | | | |

数据集 `evals/dataset-reflection.json`，条目包含用户问题、工具事实、期望质量方向；
CLI 为 `scripts/run-reflection-evals.ts`（与 Judge evals 一致的并发与配置加载方式）。

### 当前状态

`evals/reflection-comparison-report.md` 目前是 **mock 数据**，报告顶部有"mock 无质量结论"横幅。
这次跑通只验证了**链路与统计口径可用**，不构成任何质量收益证据。

因此第 4.3 节的 enforce 准入条件当前全部未满足，`REFLECTION_MODE` 保持 `off`。

---

## 8. 异常降级策略

Reflection 的失败一律**往弱的方向降级**：返回 draft，不阻断。

| 失败点 | 处理 |
| --- | --- |
| Critic 返回非法 JSON / 模糊建议 | 记为评分失败（`status: "error"`），不重写，返回 draft |
| 评分超时 / 模型不可用 | 降级为 `reflection_skipped`，返回 draft |
| 重写失败 | `reflection_skipped`，返回 draft |
| 重写被事实守卫拦下 | `revise_rejected`，回退初版 |
| 重写与初版无实质差异 | `revise_no_change`，回退初版 |
| 重写后重评未变好 | `no_improvement`，回退初版并停止 |
| 服务未开启 / mock 模式 | `off` / `mock_mode`，直接返回 draft |

核心原则：**评分失败 ≠ 答案有问题**。失败只说明"这次没能评分"，因此不重写、不提示用户、不吞错误。

---

## 9. 已知局限

1. **自我评估偏差无法根除**：固定 rubric 与阈值规则只是压制，不能消除；分数只作触发信号。
2. **重写质量上限受限于原始上下文**：只给问题 / 工具事实 / draft / 修订指令，
   重写拿不到工具原始返回的完整上下文（长检索片段会被裁剪），复杂引用问题容易改错。
3. **阈值是硬编码常量**（首版任一维 ≤ 3），未做按题目类型的分档，也未用评测数据回归拟合。
4. **重写可能放大错误**：模型可能在修"清晰度"时顺手改掉原本正确的数字，事实守卫只能兜住"新出现的事实"，
   改错已有事实的情况存在漏网。
5. **只覆盖最终答案**：不评估中间步骤与工具选择质量，多轮与 plan-execute 路径尚未接入。
6. **真实 A/B 未跑**：当前只有 mock 报告。

## 10. 下一步

1. 用真实模型跑 `scripts/run-reflection-evals.ts`，拿到第一份有意义的四列对比；
2. 按第 4.3 节阈值核对，决定是否从 `shadow` 往 `enforce` 走；
3. shadow 期线上观察 `reflection_skipped` 原因分布与重写采纳率；
4. 补 `reflection/*.test.ts` 单测（Critic 合法 / 非法 / 模糊返回，事实守卫命中）；
5. 若接入主链路，再单独评估 plan-execute 与 multi-agent 路径的接入点。

---

## 相关文档

- `docs/llm-judge.md` —— 阶段 6：语义级安全判定（与本文的分层对照）
- `docs/structured-output.md` —— 结构化输出的解析与失败约定
- `docs/plan-and-execute.md` —— plan-execute 路径说明
- `evals/reflection-comparison-report.md` —— A/B 评测报告（当前为 mock）
