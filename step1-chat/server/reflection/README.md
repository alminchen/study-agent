# `server/reflection` · 模块说明

> 这是阶段 7（Reflection）的内核目录。读完应该能回答四个问题——
> 这一层负责什么、每个文件干什么、失败时怎么退化、想改评分规则该动哪里。
>
> 阶段整体说明见 `docs/reflection.md`，变更记录见 `docs/reflection-changelog.md`。
> 本文中的路径都是工作区内的**两级相对路径**（目录/文件）。

---

## 1. 这一层的定位

一句话：**给已经生成的答案打一次结构化分，必要时重写一次。**

| 负责 | 不负责 |
| --- | --- |
| 打四维分（相关性 / 完整性 / 事实依据 / 清晰度） | 安全判定（那是 Judge 的事） |
| 判断是否值得重写（阈值规则） | 调用任何工具 |
| 生成一版修订稿并做事实守卫 | 决定是否拦截用户请求 |
| 给出可观测的评分元信息 | 进入默认聊天链路（默认 `off`） |

### 与 Judge 的分层（不可混用）

> **Judge 决定"要不要拦"，Reflection 决定"要不要改"。**

- Judge：只判定、不改写；失败降级到**更严**的规则（正则 Guard）。
- Reflection：只改进、不判定；失败降级到**更弱**的行为（返回初版 draft）。

两个方向的降级语义相反，所以提示词、schema、阈值、代码全部独立，互不复用。

---

## 2. 文件地图

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 评分契约：Schema、判别联合、`schemaVersion`、字段上限、构造与截断工具 |
| `text.ts` | 共用小工具：中间截断、去代码围栏 |
| `critic.ts` | Critic 评分：拼提示词 → 调模型 → 解析 → 判定是否触发重写 |
| `revise.ts` | 重写生成：只拿四样上下文 → 出修订稿 → 事实守卫 |
| `types.test.ts` | 契约层单测：Schema 校验、构造、截断 |
| `critic.test.ts` | Critic 单测：合法 / 非法 / 模糊返回、超时、阈值规则 |
| `revise.test.ts` | 重写单测：四态分支、事实守卫命中与放行 |

端点与接线不在本目录，在 `routes/chatReflection.ts`（`POST /api/chat/reflection`）。

---

## 3. 数据流

```
  问题 + 工具事实 + draft
            │
            ▼
  ┌────────────────────────────┐
  │ critique()   （critic.ts）  │  ← 调模型 → 解析 → Critique
  └────────────────────────────┘
            │  status = error ─────────────► 直接返回 draft（不重写）
            │  status = ok
            ▼
  shouldRewriteByThreshold(scores, issues)
            │  false ────────────────────────► 返回 draft（no_rewrite_needed）
            │  true
            ▼
  ┌────────────────────────────┐
  │ revise()     （revise.ts）  │  ← 调模型（请求中无 tools 字段）
  └────────────────────────────┘
            │  四态：ok / no_change / rejected / error
            │  rejected（事实守卫命中）→ 回退初版
            ▼
  重评（第二次 critique）→ 不优于初版则回退初版（no_improvement）
            │
            ▼
  最终正文 + reflection_scored / reflection_revised / reflection_skipped
```

---

## 4. 关键契约

### 4.1 评分契约（`types.ts`）

- `REFLECTION_SCHEMA_VERSION = "reflection.v1"`：字段语义变化时升级。
- `Critique` 是**判别联合**，用 `status` 分流：
  - `status: "ok"` → 含 `scores` / `issues` / `shouldRewrite` / `revisionInstructions` / `reason`；
  - `status: "error"` → **不含任何分数字段**（失败不是"0 分"，记 0 分会污染指标分母）。
- 四维固定为 `relevance` / `completeness` / `groundedness` / `clarity`，各为 **1~5 整数**，不接受缺项。
- 字段上限（`REFLECTION_LIMITS`）：issues ≤ 10 条、单条 issue ≤ 200 字、
  修订指令 ≤ 2000 字、理由 ≤ 500 字、失败原文 ≤ 500 字——超长一律截断而不是拒绝。
- `shouldRewrite = true` 时 `revisionInstructions` 不允许为空（Schema 级强校验）。

### 4.2 阈值规则（`critic.ts`）

- `REFLECTION_REWRITE_THRESHOLD = 3`；
- 判定函数 `shouldRewriteByThreshold(scores, issues)`：
  **任一维度 ≤ 3，或存在 groundedness 问题** → 触发重写。
- 模型输出的 `shouldRewrite` 只是参考，**不作为裁决**：
  模型说"要改"不能越过阈值自己触发重写，模型说"不用改"也不能阻止阈值规则触发。
  这是压制自我评估偏差（自我偏好 / 长度偏好 / 自夸倾向）的核心手段。
- `averageScore(scores)`：四维平均分，用于重评前后比较（重评不优于初版即回退）。

### 4.3 重写契约（`revise.ts`）

- 只拿四样东西：**原问题、工具事实、原答案、修订指令**。不多给任何上下文。
- 模型调用请求里**没有 `tools` / `tool_choice` 字段**——重写阶段从结构上不可能调用工具。
- 输出是**纯文本**（不是结构化对象）：重写没有需要被程序消费的字段。
- 结果是四态：

  | 状态 | 含义 | 后续 |
  | --- | --- | --- |
  | `ok` | 产出了修订稿 | 进入重评 |
  | `no_change` | 与初版无实质差异 | 回退初版 |
  | `rejected` | 事实守卫命中：引入了工具事实之外的新事实 | 作废重写，回退初版 |
  | `error` | 调用层失败 / 超时 | 回退初版 |

- 事实守卫：`detectUnsupportedFacts(text, sources)` + `extractFactTokens(text)`——
  重写里新出现的事实型 token 必须在工具事实或原答案中能找到，否则判定为编造。

### 4.4 模型调用注入（两个模块都一样）

- `critic.ts` 与 `revise.ts` 都不出现 `fetch`，模型调用以函数参数注入
  （`CriticModelCaller` / `ReviseModelCaller`），单测直接注入假模型，不打网络。
- 超时与网络错误最多重试 2 次，整次调用耗时受 `totalTimeoutMs` 约束。
- 超长输入用 `truncateMiddle` 保留首尾、中间截断，避免评分成本失控。

---

## 5. 失败路径

| 失败点 | 处理 | 对外表现 |
| --- | --- | --- |
| 模型返回非法 JSON / 字段缺失 | 收敛为 `status: "error"` | 不重写，返回 draft |
| 评分超时 / 网关报错 | 同上（`errorKind` 区分） | 不重写，返回 draft |
| 阈值未触发 | 不调重写模型 | 返回 draft |
| 重写调用失败 | `ReviseResult = error` | 回退初版 |
| 重写无实质差异 | `no_change` | 回退初版 |
| 事实守卫命中 | `rejected` | 作废重写，回退初版 |
| 重评不优于初版 | — | 回退初版并停止 |

**原则：评分失败 ≠ 答案有问题。** 失败只说明"这次没能评分"，因此不重写、不提示用户、不吞错误。

---

## 6. 想改评分规则时

| 想改什么 | 动哪里 | 连带要改 |
| --- | --- | --- |
| 加一个评分维度 | `types.ts` 的 `ReflectionDimensionSchema` + `CritiqueScoresSchema` | `critic.ts` 提示词与 `shouldRewriteByThreshold`；前端 rubric 展示 |
| 改触发阈值 | `critic.ts` 的 `REFLECTION_REWRITE_THRESHOLD` | 评测报告的对比口径 |
| 放宽字段长度 | `types.ts` 的 `REFLECTION_LIMITS` | 无 |
| 改重写可用上下文 | `revise.ts` 的 `ReviseInput` | 需同步评估事实守卫的来源集合 |
| 调整失败分类 | `types.ts` 的 `ReflectionErrorKindSchema` | 端点的 skip reason 映射 |

改完必须补对应单测（三个 `.test.ts` 已存在），并重跑
`npx tsx scripts/run-reflection-evals.ts` 更新 A/B 报告。

---

## 7. 测试

| 文件 | 覆盖 |
| --- | --- |
| `types.test.ts` | Schema 合法 / 非法 / 上限截断 / 判别联合窄化 / 构造工具 |
| `critic.test.ts` | 合法返回、非法 JSON、模糊返回、超时、阈值规则、平均分 |
| `revise.test.ts` | 四态分支、事实守卫命中与放行 |

端点层另有 `routes/chatReflection.test.ts`（事件顺序、skip 原因、模式回落）。

---

## 8. 相关文档

- `docs/reflection.md` —— 阶段完整说明（自我评估偏差 / 与 Judge 分层 / 默认不启用条件）
- `docs/reflection-changelog.md` —— 阶段变更记录
- `docs/llm-judge.md` —— 阶段 6：Judge（分层对照）
- `evals/reflection-comparison-report.md` —— A/B 报告（当前为 mock，无质量结论）
