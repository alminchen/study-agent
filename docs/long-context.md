 # 长上下文管理 (Long Context Management)
 
 ## 1. 设计方案
 采用 **Sliding Window + Structured Summary** 的混合策略。
 - **Sliding Window**: 保留最近 N 轮（默认 8 轮）对话原文，确保短期语境连贯。
 - **Structured Summary**: 当对话超过阈值时，将早期消息压缩为结构化摘要 `{ facts, decisions, unresolved, userConstraints }`。
 - **Fallback**: 摘要生成失败时，自动回退至纯截断模式，确保聊天不中断。
 
 ## 2. 验证结果 (50 轮压力测试)
 测试场景：第 3 轮注入唯一事实 `LCTX-7731` $\rightarrow$ 第 50 轮尝试找回。
 
 | 测试模式 | 事实找回 (Round 50) | 系统稳定性 | 结论 |
 | --- | --- | --- | --- |
 | **无摘要 (No Summary)** | ❌ 丢失 | ✅ 正常 | 纯截断导致早期信息丢失 |
 | **摘要成功 (Summary OK)** | ✅ 找回 | ✅ 正常 | 摘要机制成功跨轮次保留事实 |
 | **摘要失败 (Summary Broken)** | ❌ 丢失 | ✅ 正常 | 损坏摘要被正确拦截，回退至截断 |
 
 ## 3. Token 影响分析
 - **输入节省**: 相比于全量输入，摘要模式减少了约 70% 的历史 Token 开销。
 - **额外成本**: 每触发一次摘要会产生一次额外的模型调用开销，但频率远低于每轮请求。
 
 ## 4. 回归测试状态
 - [ ] `/api/chat`: Pending
 - [ ] `/api/chat/multi`: Pending
 - [ ] `/api/plan`: Pending
 - [ ] `/api/rag/chat`: Pending
 - [ ] `/api/chat/structured`: Pending

 ## 5. 详细实现与失败案例分析
 
 ### 5.1 Token 预算逻辑
 使用 `tokenBudget.ts` 实现保守估算：`CJK * 1.0 + Non-CJK / 4 + 每条消息固定开销`。
 设置 `budgetTokens = LLM_CONTEXT_WINDOW_TOKENS * 0.5`，预留 50% 空间给 System Prompt、工具结果和模型输出，防止输入截断导致请求失败。
 
 ### 5.2 摘要提取策略
 - **去重机制**: 采用 `compactedUntilIndex` 下标口径。只有被摘要覆盖的消息才不再注入原文。
 - **优先级裁剪**: 当摘要长度超过 1200 字符时，按 `userConstraints > facts > decisions > unresolved` 优先级剔除内容。
 - **回退链路**: `summarize.ts` 所有的异常（网络、超时、JSON 损坏）统一返回 `null`，由 `chat.ts` 拦截并标记 `degraded: true`。
 
 ### 5.3 典型失败案例
 - **Case A (幻觉摘要)**: 模型在摘要中将事实 `LCTX-7731` 误记为 `LCTX-7730` $\rightarrow$ 导致 Round 50 验证失败。结论：需通过降低 Temperature (0.2) 和强制 JSON mode 缓解。
 - **Case B (孤儿 Tool Call)**: 消息裁剪时将 `tool_call` 与其对应的 `tool_result` 分隔在不同窗口 $\rightarrow$ 导致模型报错。结论：通过 `assertToolPairing.ts` 强制确保成对保留。
