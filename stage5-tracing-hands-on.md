# 阶段 5 · 第二课 · Tracing 动手计划

> 接 `stage5-tracing-learning-plan.md`。在 `step1-chat` 里接入 LangSmith，**不改**前端过程面板。

## 0. 前置

`.env.local` 已配置（Workspace 由 Key 决定，Project 自定名）：

```env
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=lsv2_...        # 勿提交 git
LANGCHAIN_PROJECT=step1-chat-dev  # 不必叫 Workspace 1
```

注册说明见学习计划 **§6 LangSmith 注册与注意事项**。

## 1. 代码改了什么

| 文件 | 作用 |
|------|------|
| `server/tracing/langsmith.ts` | `traceable` 包装：根 trace、askModel、tool |
| `server/react/runConversation.ts` | 整次对话 `chat-request`；每轮 `askModel` |
| `server/react/applyToolCalls.ts` | 每个工具 `tool` span |

### Span 树（LangSmith 里应看到）

```
chat-request          (chain)  ← 一次用户问句
  ├─ askModel         (llm)    turn=1
  ├─ tool             (tool)   getWeather …
  ├─ askModel         (llm)    turn=2
  └─ …
```

### 和 ToolTracePanel 的分工

| | ToolTracePanel | LangSmith |
|--|----------------|-----------|
| 谁看 | 用户 / 演示 | 开发者 |
| 范围 | 当前一句 | 历史可检索 |
| 内容 | tool_call / result | 含 turn、耗时、LLM 是否出 tool_calls |

## 2. 本地跑

```bash
# 终端 1：确保 .env.local 会被加载（server/index.ts 已 dotenv）
npm run dev:server

# 终端 2：发一条聊天
curl -s -N -X POST http://127.0.0.1:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"现在几点"}],"searchDocs":false}'
```

或打开页面 `http://127.0.0.1:5173` 普通对话里问一句。

## 3. 在 LangSmith 里验收

1. 打开 [smith.langchain.com](https://smith.langchain.com)
2. 左侧 **Projects** → 选 `step1-chat-dev`（第一次有 trace 后会出现）
3. 打开最新一条 run，应看到：
   - 根节点 `chat-request`
   - 子节点 `askModel`（`turn`、`has_tool_calls` 等 metadata）
   - 若调了工具，还有 `tool` 子节点（`tool_name`、`is_error`）

**建议再测两句：**

| 问句 | 期望 trace |
|------|------------|
| 现在几点 | askModel → tool(getCurrentTime) → askModel |
| 广州的天气，顺便查查几点了 | 两次 tool + 多轮 askModel |

## 4. 关掉 Tracing

`.env.local` 里设 `LANGCHAIN_TRACING_V2=false` 或删掉该行，重启 server。  
代码走原路径，不上报 LangSmith。

## 5. 本课验收清单

- [ ] Projects 里能看到 `step1-chat-dev`
- [ ] 一条 trace 里有 `chat-request` → `askModel` →（可选）`tool`
- [ ] 能说出和 ToolTracePanel 的区别
- [ ] 关闭 `LANGCHAIN_TRACING_V2` 后聊天仍正常

## 6. 下一课

**Evals**：固定问句 + 规则判分（见 `stage5-evals-learning-plan.md`）。  
RAG 独立 span、`/api/rag/chat` trace 名 — Tracing 课可选，Evals 本课不测资料问答入口。
