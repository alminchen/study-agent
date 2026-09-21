# 阶段 5 · Token 统计与成本控制

> 当前只写阶段 5 的**Token / 成本**知识点，不展开部署、交付页全量、人工确认。  
> 这课接在多 Agent 编排之后最顺：你已经会 ReAct、多 Agent、Tracing、Evals；下一步是**知道每次请求花了多少 token、估算多少钱**。

载体：`step1-chat` 的三条 LLM 链路：`/api/chat`、`/api/chat/multi`、`/api/rag/chat`。

**说明**：FastAPI + Docker 部署已后置跳过；Token/成本本课在本地 Express 上完成即可。

---

## 1. 介绍基础知识点

Token 可以先理解成：**模型计费的最小单位**，不是「一个字」那么简单。

Tracing 回答的是「这一次发生了什么、哪一步慢」。  
Evals 回答的是「这一类问题现在还对不对」。  
**Token/成本** 回答的是「这一次（或这一类）花了多少钱、贵在哪」。

| 方式 | 回答什么 | 局限 |
|------|----------|------|
| 平台账单 | 本月总共花了多少 | 看不到单次请求、看不到哪条链路贵 |
| LangSmith trace | 每次 LLM span 的耗时 | 默认不帮你算钱、不汇总成「用户一问的总成本」 |
| **Token 统计（本课）** | 一次用户提问 → 几次 LLM 调用 → 合计 token → 估算 USD | 单价需手工配置；流式接口通常无 usage |

一句话：

- **Tracing** = 飞行记录仪（排错）
- **Evals** = 回归考卷（行为对不对）
- **Token/成本** = 小票（这次服务收你多少钱）

### 核心概念（先记这五个）

1. **Token**  
   子词片段。中文常 1 字 ≈ 1~2 token；英文 1 词 ≈ 1~4 token。  
   同一句话，模型不同、tokenizer 不同，token 数也可能不同。

2. **usage（用量）**  
   OpenAI 兼容接口在**非流式** `chat/completions` 响应里常返回：

   ```json
   {
     "usage": {
       "prompt_tokens": 512,
       "completion_tokens": 128,
       "total_tokens": 640
     }
   }
   ```

   - `prompt_tokens`：输入（system + 历史 + 工具回填）
   - `completion_tokens`：模型生成
   - `total_tokens`：两者之和

3. **一次用户请求 ≠ 一次 LLM 调用**  
   这是本课最容易搞混的点：

   | 链路 | 用户发 1 条消息，内部可能调几次 LLM |
   |------|-------------------------------------|
   | 单 Agent ReAct | 1~5 次（每轮 tool call 后再 askModel） |
   | 多 Agent | Supervisor + N 个 Worker（各自 mini ReAct）+ Aggregate |
   | RAG | 0 或 1 次（检索判空则不调模型） |

4. **请求级累加（Accumulator）**  
   一次 HTTP 请求内，把多次 LLM 的 usage 加总，得到「用户这一问的总 token」。

5. **成本估算（Estimate）**  
   不是平台真实扣款，而是按模型单价估算：

   ```
   cost ≈ (prompt_tokens × 输入单价 + completion_tokens × 输出单价) / 1_000_000
   ```

   单价单位通常是 **USD / 1M tokens**，以各平台官网为准。

### 和你项目的对应关系

```
用户发一条消息
  │
  ├─ /api/chat（单 Agent）
  │    └─ runConversation
  │         ├─ askModel turn=1  → usage₁
  │         ├─ askModel turn=2  → usage₂
  │         └─ askModel turn=3  → usage₃
  │         合计 → SSE usage 事件 + 写入 store
  │
  ├─ /api/chat/multi（多 Agent）
  │    └─ graph
  │         ├─ supervisorRoute     → usageₛ
  │         ├─ realtimeWorker      → usageᵣ（可能多轮）
  │         ├─ kbWorker              → usageₖ
  │         └─ aggregate             → usageₐ（单 Worker 成功时可能跳过）
  │         合计 → SSE usage 事件 + 写入 store
  │
  └─ /api/rag/chat（资料问答）
       └─ answerFromDocs
            └─ completeRagMessages → usage（empty 时为 0）
            合计 → JSON 字段 usage + 写入 store
```

需要改动的 LLM 封装层（动手时再写代码）：

| 文件 | 职责 |
|------|------|
| `server/react/complete.ts` | 单 Agent 每次 askModel |
| `server/multi-agent/llm.ts` | Supervisor / Worker / Aggregate 共用 |
| `server/rag/complete.ts` | 资料问答一次生成 |

建议新增模块（动手时再建）：

| 路径 | 职责 |
|------|------|
| `server/usage/` | 解析 usage、累加、单价、持久化 |
| `GET /api/usage` | 历史汇总 + 最近记录 |
| 前端成本展示 | 本轮消耗 + 历史汇总 |

### 与 Tracing / Evals / ToolTracePanel 的区别

| | ToolTracePanel | Tracing | Evals | Token/成本 |
|--|----------------|---------|-------|------------|
| 谁看 | 用户/演示 | 开发者排错 | 开发者回归 | 开发者/自己控成本 |
| 看什么 | 调了谁 | span 树、耗时 | pass/fail | token 数、估算 USD |
| 粒度 | 当前一句 | 单次请求 | 固定考卷 | 单次请求 + 历史累计 |

三者互补，不重复。

---

## 2. 为啥要学习这个东西

阶段 5 你已经会观测（Tracing）和回归（Evals）。接下来高频问题变成：

- 「广州天气顺便查查几点」为什么比「你好」贵很多？是多调了模型还是 prompt 太长？
- 单 Agent vs 多 Agent，同样问题哪个更省 token？
- 改了 system prompt 变长了，成本涨了多少？
- RAG 空结果不调模型——这条优化到底省了多少次调用？

不学 Token/成本，你会停留在：

- 只知道「感觉 DeepSeek 便宜」，说不出具体数字
- ReAct 多轮、多 Agent 叠加调用，不知道哪条链路是「吞 token 大户」
- 改 prompt / 加 Worker 后，行为 Evals 过了，但成本悄悄翻倍

学了 Token/成本，你可以：

- 每次聊天结束看到「本轮：1234 tokens ≈ $0.0002」
- 对比 `/api/chat` vs `/api/chat/multi` 同一问句的成本差异
- 把「空结果不调 LLM」这类 resilience 优化，用数字证明值得做

---

## 3. 学习这个能干些啥

学完这一课，你至少能做这几件事：

1. **从 API 响应里读出 usage**  
   在 `complete.ts`、`llm.ts`、`rag/complete.ts` 统一解析 `usage` 字段。

2. **实现请求级累加**  
   一次用户提问，无论内部调几次 LLM，都能汇总成一条记录。

3. **按模型估算成本**  
   配置 DeepSeek / 其他模型的 input/output 单价，输出估算 USD（标注「仅供参考」）。

4. **持久化 + 查询**  
   本地 JSON 存历史（学习 demo 够用）；`GET /api/usage` 看累计和最近记录。

5. **前端可见**  
   - 本轮对话结束：SSE 推送 `usage` 事件，底部或面板显示 token/成本  
   - 可选：顶部「成本」入口看历史汇总（与后续「交付页 · 成本页」衔接）

6. **（可选）对比实验**  
   同一问句分别走单 Agent / 多 Agent，记录 token 差异，写进学习笔记。

---

## 4. 这个难点在哪

难点不在「读一个 JSON 字段」，而在**统计口径一致、多次调用不遗漏**。

### 五个常见坑

1. **只统计最后一次 askModel**  
   ReAct 可能 3~5 轮，只记最后一轮会严重低估。必须用 Accumulator 累加整次请求。

2. **多 Agent 漏记 Worker 内部轮次**  
   `realtimeWorker` 自己有 mini ReAct，Supervisor + Aggregate 也各调一次。每条链路都要挂回调。

3. **流式 vs 非流式**  
   流式 `stream: true` 通常**没有**完整 usage（或只在最后一个 chunk）。  
   本项目 LLM 调用目前是非流式，可直接读 `usage`；若以后改流式，要单独设计。

4. **把估算成本当真实账单**  
   平台可能有缓存命中、套餐价、thinking token 单独计费。前端必须标注「估算」。

5. **Mock 模式硬编 token**  
   Mock 没有真实 LLM 响应，usage 应为 0 或不展示，不要伪造数字误导学习。

### 和你前面模块的连接

| 已有模块 | Token 课要接什么 |
|----------|------------------|
| `server/react/complete.ts` | 每次 askModel 解析 usage |
| `server/multi-agent/llm.ts` | Supervisor/Worker/Aggregate 共用，避免重复 fetch 也要统一统计 |
| `server/rag/complete.ts` | 有资料才调模型；empty 时 0 token |
| `server/tracing/langsmith.ts` | Tracing 看耗时；Token 看用量；可在 LangSmith 里对照 span 数量与 llmCalls |
| Evals | Evals 不管钱；但可以用同一批问句对比 token（可选扩展） |

---

## 5. 对工作、薪水有啥影响 / 提升的地方

Token/成本是把 Agent 从「能跑」推进到「能控、能讲清楚 ROI」的能力。

### 对工作内容的提升

- 从「感觉挺费」→「这句 prompt 多 800 input tokens，月活 1 万次要多少」
- 和产品/老板对齐时有数字：单 Agent vs 多 Agent 的性价比
- 优化有优先级：先砍 token 大户（长 system、多轮 ReAct、不必要的 Aggregate）

### 常见岗位场景

- 上线前评估：新功能会不会把 API 账单打爆
- 换模型前：同样 Evals 分数下，哪个模型更便宜
- 线上告警（后置）：单请求 token 超阈值（本课 demo 可先不做）

### 对薪水的间接影响

「成本意识」在 AI 应用岗 JD 里越来越常见。  
会和不会的差别：你是「只会堆功能」，还是「能解释为什么用 Supervisor-Worker 而不是单 Agent」。

---

## 6. 学习顺序与验收

### 建议顺序（先文档、后代码）

**第一部分：建立概念（不写代码，约 30 分钟）**

- [x] 读本文第 1 节，说清 prompt/completion/total 三个字段
- [x] 对照 `runConversation.ts`，数一条「天气+时间」问句大概几次 askModel
- [x] 对照 `graph.ts`，数多 Agent 一条请求几次 callLLM
- [x] 打开一次真实 API 响应（或文档），找到 `usage` 字段长什么样

**第二部分：服务端解析与累加**

- [x] 新建 `server/usage/` 模块（types、parseUsage、accumulator、pricing、store）
- [x] 改造 `complete.ts`、`llm.ts`、`rag/complete.ts` 解析 usage
- [x] 三条 API 入口各创建 Accumulator，请求结束写入 store
- [x] SSE / JSON 返回本轮 `usage` 摘要

**第三部分：查询 API**

- [x] `GET /api/usage` — 累计 token、按 endpoint/model 分组、最近 N 条
- [x] `DELETE /api/usage` — 清空（demo 用，可选）

**第四部分：前端展示**

- [x] 解析 SSE `usage` 事件，本轮对话底部显示 token + 估算成本
- [x] 简单成本汇总 UI（可与后续「交付页 · 成本页」合并）

**第五部分：验证与对比（可选）**

- [x] 同一问句：单 Agent vs 多 Agent，记录 token 差异
- [x] RAG 空结果 vs 有命中，验证 0 token vs 有 token
- [x] Mock 模式验证不展示虚假 usage

### 怎么算「这一课过了」

- [x] 能说清「一次用户请求」和「一次 LLM 调用」的区别
- [x] 普通对话 SSE 结束前收到 `usage`，含 prompt/completion/total/llmCalls
- [x] 多 Agent 一次请求的 usage = Supervisor + Workers + Aggregate 之和
- [x] RAG 空结果 usage 为 0；有命中时有 token
- [x] `GET /api/usage` 返回累计统计
- [x] 前端可见本轮消耗（历史汇总可简化）
- [x] 不把部署、完整成本页、人工确认塞进本课必交付

> **本课已结（学习者确认了解完成）。**

### 本课先不要混

- 不要做生产级计费系统（按用户/租户扣费、发票）
- 不要上 Prometheus/Grafana（知道以后可以接即可）
- 不要把 Embedding/Rerank 本地推理算进 LLM token（可写在「局限」里，后续扩展）
- 不要为了省 token 去改 Evals 行为或跳过必要 LLM 调用

---

## 7. 和其他文档的关系

| 文档 | 关系 |
|------|------|
| `stage5-multi-agent-learning-plan.md` | 上一课（约 80%）：多 Agent 是 token 大户，本课要统计它 |
| `stage5-tracing-learning-plan.md` | Tracing 看耗时；本课看用量 |
| `stage5-evals-learning-plan.md` | Evals 看行为；本课看成本 |
| **`stage5-token-cost-learning-plan.md`** | **本课概念与验收（已结）** |
| **`stage5-token-cost-hands-on.md`** | 本课动手步骤（已结） |
| `learning-plan.md` | 总清单；下一项为交付页 |
| `advanced-learning-plan.md` | 进阶方向；与本课无冲突 |
| 交付页（调试/日志/成本） | 本课做了「成本」最小版，完整页在交付阶段 |

---

## 8. 下一步

1. **交付页**：调试页、日志页、成本页 + eval 数据集（`learning-plan.md` 当前重点）。  
2. **多 Agent**：可选收尾 README / Evals。  
3. 再往后：人工确认 → 工程优化。（FastAPI + Docker 需要时再补）

---

## 9. 局限（学习 demo）

- 单价手工配置，新模型要手动加一行
- 本地 JSON 存储，重启可保留，但不是数据库
- 非流式 LLM 才能稳定读 usage
- 估算成本 ≠ 平台真实账单
- Thinking / reasoning token 是否单独计费，以平台文档为准
