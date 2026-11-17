# Map-Reduce 摘要：超限兜底执行计划

> **状态：已归档（2026-11-17）· 暂不执行。**
> 评估结论：实际会话大部分达不到单次摘要上限，本兜底机制暂无触发场景，
> 因此归档保留设计，不排入执行队列。后续若真实会话出现超限截断问题再启用。

> 前置：`long-context-management-plan.md`（长上下文已落地）。
> 本文档**只规划，不实现**。后续按「指令 1～N」逐条执行，一次一条，
> 每条做完必须满足该条的完成判定才进入下一条。
>
> **定位变化**：Map-Reduce 不再是「可切换的第二种策略」，而是
> **单次摘要的超限兜底**——平时走原路径零额外成本，
> 只在 dropped 超出单次上限、原路径会触发 `clampTranscript` 截断时，才走分块。
>
> **评估依据**：实际会话中大部分请求达不到单次上限，
> 完整的「策略切换 + 环境变量」机制是过度设计，因此砍掉；
> 只保留兜底分支，避免为极端情况引入常态复杂度。
>
> **边界红线**：执行过程**不自行调用真实模型**做质量评测。
> 所有测试与自验一律在 stub / mock 模式下进行；
> 真实模型的对比实验由用户显式发起，未跑则如实写「未运行」。

---

## 0. 一句话结论

单次摘要 `summarizeDroppedMessages` 的已知边界：dropped messages 很多时，
转写文本会超出 `TRANSCRIPT_MAX_CHARS`，触发 `clampTranscript` 截断，
中间部分信息**静默丢失**。

本计划加一条**兜底分支**：在调用单次摘要前估算 token，
**未超上限 → 走原路径，行为逐字不变**；
**超上限 → 走 Map-Reduce 分块**（按消息边界切成 K 块，逐块摘要再合并），
让早期事实不再因为截断而丢失。

不需要策略类型、不需要环境变量、不需要默认切换——
触发条件就是「单次上限不够用」这一个客观事实。

**执行步骤在第 5 节，共 4 条可下达指令**。每条指令 = 一个完整可交付的工作单元。
你只需要说「执行指令 N」就能开工。

---

## 1. 为什么要这么做

### 1.1 功能概念

Map-Reduce 是「分而治之」的摘要手法，用在长文本上分两步：

- **Map**：把一长串 dropped messages 按 token 预算切成 K 个小块，
  每块**单独调一次** LLM，输出该块的结构化摘要。
  因为每块都很小，**不需要截断**，块内信息是完整的。
- **Reduce**：把 K 份块结果按 `sourceMessageIndex` 归并成一份，
  facts 按 key 去重、其余按 text 去重，再与 `previousSummary` 合并，
  最终产出与现有 `ContextSummary` **完全一致**的结构。

### 1.2 为什么做成「超限兜底」而不是「可切换策略」

原计划的定位是「加一个 `SummaryStrategy` 类型 + 环境变量切换，默认 `single`」。
评估后放弃，理由：

1. **常态收益为零**。实际会话大部分达不到单次上限，
   完整策略机制平时永远不会走到 Map-Reduce 分支，但代码和单测都要维护。
2. **常态成本不为零**。策略切换会让每次摘要都多一次判断、多一条调用路径，
   排查问题时也要多想一层「这次走的是哪条」。
3. **触发条件本来是客观的**。「dropped 超上限」不是用户偏好，
   没必要做成运行时配置项，写成内部兜底即可。

改成兜底后的差别：

| 维度 | 原计划（可切换策略） | 新计划（超限兜底） |
| --- | --- | --- |
| 触发方式 | 环境变量 `CONTEXT_SUMMARY_STRATEGY` | dropped 估算 token 超单次上限 |
| 默认路径 | `single`，需用户主动切换 | 原路径，**逐字不变** |
| 常态额外成本 | 一次分支判断 + 调用路径分流 | 无（未超限直接走原路径） |
| 新增类型 | `SummaryStrategy` + 分发函数 | 无新类型 |
| 配置面 | 环境变量 + 非法值回退 | 一两个常量 |
| 适合场景 | 想做对比实验 | 单次不够用时兜底 |

### 1.3 为什么现在做

单次摘要的截断边界在 `long-context.md` 已记载，但当时没有落地兜底。
现在长上下文链路已经稳定，加这条兜底是**补齐已知短板**，
而不是新增功能——影响面小、可独立验证。

---

## 2. 这么做的好处

### 2.1 功能上的好处

1. **解决截断边界**。超限时不再触发 `clampTranscript` 丢中间，
   早期事实通过分块被完整送入模型。
2. **平时零额外成本**。未超限的请求走原路径，调用次数、token、耗时都不变。
3. **只在需要时变贵**。超限的请求才会多出 K 次调用，
   用「偶尔变贵」换「不静默丢信息」，代价和收益对齐。
4. **零改动接入**。输出仍是标准 `ContextSummary`，
   `buildContext` 与前端持久化链路都不需要任何改动。

### 2.2 工程上的好处

1. **改动面小**。分块、合并是两个纯函数，可以单独单测；
   兜底判断只加在 `summarizeDroppedMessages` 入口，不动 `maybeSummarize` 与 `buildContext`。
2. **无配置面**。不需要环境变量、不需要策略类型、不需要非法值回退逻辑。
3. **可回退**。如果分块结果不理想，把兜底判断改成「仍然走原路径」即可，
   等于临时关掉功能，不动其他代码。
4. **契约清晰**。「未超限 → 原路径；超限 → 分块」是一条可验证的规则，
   单测覆盖三种边界即可：未超限、刚超限、远超限。

### 2.3 学习上的好处

- 训练「**为已知短板加最小兜底**」的判断力：识别什么时候该做、什么时候是过度设计。
- 仍然能回答 `advanced-learning-plan.md` 第 2 项的「对比：Map-Reduce 摘要」子项，
  但结论会**基于实测**：大多数请求用不到 Map-Reduce，所以兜底是合理定位。

---

## 3. 明确不做（防止范围膨胀）

- 不改 `ContextSummary` schema、不改 `buildContext`、不改 `tokenBudget` 内核。
- 不引入 `SummaryStrategy` 类型、不分发、不加环境变量。
- 不实现「递归摘要」「关键信息提取」两种。
- 不引入向量库或持久化摘要历史。
- **不自行调用真实模型做质量评测**。测试与自验在 stub / mock 模式下完成；
  真实模型对比由用户显式发起，未跑则文档中写「未运行」。

---

## 4. 接入方案

### 4.1 触发条件

在 `summarizeDroppedMessages` 入口处估算：

```
droppedTokens = estimateMessagesTokens(droppedMessages)

if (droppedTokens <= SUMMARY_SINGLE_CAP_TOKENS) {
  走原路径（逐字不变）
} else {
  走 Map-Reduce 兜底
}
```

`SUMMARY_SINGLE_CAP_TOKENS`（默认 12000，可调）是单次摘要的舒适上限，
对应转写文本大约在 `TRANSCRIPT_MAX_CHARS` 以内，不会触发截断。
超过这个值就走分块，避免撞到截断。

### 4.2 Map-Reduce 流程

```
输入：droppedMessages + droppedMessageIndices（已确认超限）

  [Map]    按 token 预算把转写切成 K 块（每块 ≤ SUMMARY_BLOCK_TOKEN_CAP）
           按消息边界切，不劈开单条消息
           对每块调一次 LLM，输出该块的 CategoryBuckets

  [Reduce] 按 sourceMessageIndex 归并 K 份结果：
           - facts 按 key 去重（同 key 取新）
           - decisions / unresolved / userConstraints 按 text 去重
           - sourceMessageIndex 校验只留本次范围内的

  [Output] 与 previousSummary 合并（复用 mergeItems / mergeFacts）
           → 返回标准 ContextSummary
```

### 4.3 关键参数

- `SUMMARY_SINGLE_CAP_TOKENS`（默认 12000）：触发兜底的阈值。
- `SUMMARY_BLOCK_TOKEN_CAP`（默认 6000）：每块的 token 上限。
- `SUMMARY_MAX_BLOCKS`（默认 8）：块数上限，防止分太碎导致成本失控。
  超过上限时按比例增大块 token 上限，保证能装下。

### 4.4 失败降级

- 单块摘要失败（超时、非法 JSON、schema 不过）：该块返回空 buckets，
  其余块正常合并，不整体失败。
- 全部块都失败：返回 `null`，调用方回退到裸窗口（与现有失败路径一致）。
- 极端情况下宁可裸窗口，也不假装压缩成功（与现有契约一致）。

---

## 5. 执行步骤

### 指令 1 · 分块与单块摘要内核

**做什么**：实现纯函数 `chunkDroppedMessages`（按 token 预算 + 消息边界切块，
超过 `SUMMARY_MAX_BLOCKS` 时自动放宽块上限）；
实现 `summarizeBlock`（复用现有 `requestSummary` / `normalizeItems`）。

**完成判定**：
- [ ] 块不劈开任何一条消息。
- [ ] 每块估算 token ≤ `SUMMARY_BLOCK_TOKEN_CAP`（允许单条超限，但不拆）。
- [ ] 块数 ≤ `SUMMARY_MAX_BLOCKS`；超上限时自动放宽块 token 上限，不抛错。
- [ ] 每块摘要的 `sourceMessageIndex` 校验只留本块范围。
- [ ] 单测覆盖「空 / 单块 / 多块 / 单条超块上限 / 块数超上限」。
- [ ] 单测与自验**只在 stub 模式**下完成，未发起任何真实模型调用。

### 指令 2 · Reduce 合并

**做什么**：实现 `mergeMapReduceBuckets`，按 `sourceMessageIndex` 归并 K 块结果；
facts 按 key 去重，其余按 text 去重；与 `previousSummary` 合并；
单块失败时降级为空 buckets，不整体失败。

**完成判定**：
- [ ] 输出是标准 `ContextSummary`，`buildContext` 可零改动消费。
- [ ] 重复事实按 key 去重（同 key 取最新值）。
- [ ] 合并后 `compactedUntilIndex` 取所有块最大值。
- [ ] 单块失败不影响其他块，全部失败返回 `null`。
- [ ] 单测覆盖「有重叠 key / 无重叠 / 与 previous 合并 / 单块失败」。

### 指令 3 · 兜底触发接线

**做什么**：在 `summarizeDroppedMessages` 入口加兜底判断：
估算 dropped token ≤ `SUMMARY_SINGLE_CAP_TOKENS` 时走原路径（逐字不变），
超限时走 Map-Reduce；新增常量 `SUMMARY_SINGLE_CAP_TOKENS` / `SUMMARY_BLOCK_TOKEN_CAP` /
`SUMMARY_MAX_BLOCKS`。

**完成判定**：
- [ ] 未超限时行为与现状**逐字一致**（回归边界，stub 模式验证）。
- [ ] 超限时走分块，最终返回标准 `ContextSummary`。
- [ ] `maybeSummarize` 与 `buildContext` **零改动**。
- [ ] 新增常量集中定义，便于调整。
- [ ] typecheck 通过。

### 指令 4 · 验证脚本与文档

**做什么**：新增或扩展现有脚本 `compare-summary-strategies.ts`（仿 `test-long-context.ts`）：
构造一批超限 dropped messages，**在同一输入上**分别跑原路径与兜底路径，
输出对比表（块数 / token / 调用数 / 耗时 / 保留事实数 / 早期事实命中率）；
写 `summary-strategy-comparison.md` 记录结果；
更新 `long-context.md` 策略对比章节，注明 Map-Reduce 现为超限兜底。

**完成判定**：
- [ ] 脚本**stub 模式默认可跑通**，全程不依赖网络、不调用真实模型。
- [ ] 输出字段齐全，两种路径用同一输入。
- [ ] 真实模型后端**默认关闭**，需用户显式传参开启；未跑时脚本与文档**如实写「未运行」**。
- [ ] `long-context.md` 的策略对比章节如实更新（Map-Reduce 定位改为兜底）。
- [ ] `advanced-learning-plan.md` 的 Map-Reduce 对比子项**仅在真实模型实测完成后**更新；
      未实测则保持未勾并注明「stub 已通过，真实模型待跑」。

---

## 6. 风险与回退

| 风险 | 缓解 | 回退 |
| --- | --- | --- |
| K 次 LLM 调用过贵 | `SUMMARY_MAX_BLOCKS=8` 上限；只超限时才走 | 增大 `SUMMARY_SINGLE_CAP_TOKENS` 让兜底更难触发 |
| 分块丢失早期事实 | 每块 `sourceMessageIndex` 校验 + 按消息边界切 | 临时改成「始终走原路径」 |
| 未超限路径被误改 | 回归单测覆盖未超限边界 | 回退改动 |
| 单块摘要失败导致整体失败 | 单块失败降级为空 buckets | 与现有失败路径一致 |
| 对比结论误导 | 同一输入跑两条路径 | 真实模型由用户显式发起，未跑写「未运行」 |
| **私自调用真实模型** | **测试与自验一律 stub；真实模型由用户显式发起** | **发现越权调用立即中止并回退** |

---

## 7. 验收总览

- [ ] 功能：未超限走原路径逐字不变；超限走分块产出标准 `ContextSummary`，
      可被 `buildContext` 消费
- [ ] 失败路径：单块失败降级；全部失败回退裸窗口
- [ ] 测试：分块 / 合并 / 触发判断三组单测 + typecheck（**全部在 stub 模式**）
- [ ] 文档：对比脚本 stub 结果 + `long-context.md` 定位更新 + `advanced-learning-plan` 子项如实标注
- [ ] **合规红线**：整个执行过程未自行发起任何真实模型调用

> 说明：真实模型对比需 `LLM_API_KEY` 且 `MOCK_MODE != 1`，**由用户显式发起**。
> stub 模式证明管线正确，不代表质量结论；质量结论必须以真实模型实测为准
> （未跑则在文档中写「未运行」）。
