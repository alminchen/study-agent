# src/ — 前端总览

> 技术栈：Vue 3 + TypeScript + Vite。
>
> 本文里的路径以 `src/` 为根，例如 `api/chat.ts` 即 `src/api/chat.ts`。

## 分层

```text
src/
├── App.vue          页面壳层：模式选择、输入框、面板布局
├── main.ts          应用入口
├── types.ts         前端类型定义（与服务端契约逐字对齐）
├── index.css        全局样式与设计变量
├── api/             HTTP 客户端：SSE 解析与普通 CRUD
├── composables/     聊天状态中枢
├── components/      展示组件
├── rag/             引用切分
└── vision/          图片压缩与快速校验
```

## 职责划分

**壳层只管布局。** `App.vue` 负责模式选择、输入和面板摆放，
不持有聊天状态。所有流式、持久化、结构化状态都在 `useChat` 里。

**状态只有一份。** `composables/useChat.ts` 是唯一的状态中枢，
组件通过 props 拿数据、通过 emit 抛事件，不各自维护副本。

**服务端不知道前端。** 拼 system、跑 ReAct、检索、计 Token 全部在服务端；
前端只负责发请求和渲染事件。

## 目录说明

| 目录 | 职责 | 详细文档 |
| --- | --- | --- |
| `api/` | 5 个 HTTP 客户端：聊天 / 资料 / 记忆 / 模型 / 用量 | 本文件下方 |
| `composables/` | `useChat`：三种模式各自的发流、重试、事件归并 | 本文件下方 |
| `components/` | 8 个展示组件 | 本文件下方 |
| `rag/` | 把回答正文切成文字和 `[n]` 引用 | 本文件下方 |
| `vision/` | 前端图片压缩与快速校验 | `vision/README.md` |

## api/

| 文件 | 职责 |
| --- | --- |
| `api/chat.ts` | 四条流式接口的客户端：`streamChat`（单 / 多 Agent）、`streamPlan`、`streamStructured`、`streamReflection`；另有 `confirmChatTool` 和 `fetchHealth` |
| `api/rag.ts` | `askRag`：资料问答 SSE，解析命中、扩写 meta 和记忆事件 |
| `api/memory.ts` | 记忆 CRUD：列表、改值、软删除、清空 |
| `api/memoryTrace.ts` | 记忆过程事件解析器，四条链路共用一份协议 |
| `api/models.ts` | 拉取模型目录，失败返回 null 由调用方兜底 |
| `api/usage.ts` | 拉取用量汇总，失败返回 null |

**为什么记忆单独一个文件。** 聊天是 SSE 长连接，记忆是普通 CRUD。
混在一起会让「关掉记忆开关后聊天还照常」这件事变得难读。

**为什么记忆事件解析器单独一个文件。** 四条链路发的事件形状完全一致，
各写各的解析迟早漂移出「一条链路漏了 `memory_failed`」这种 bug。
这里只认一份协议。

## composables/

`useChat()` 维护 messages / 流式状态 / ToolTrace / Usage，按模式把 send 和 retry 分流：

| 模式 | 入口 |
| --- | --- |
| 普通对话 | `runStream` → `streamChat`（`/api/chat` 或 `/api/chat/multi`） |
| 资料问答 | `runRag` → `askRag`（`/api/rag/chat`） |
| 结构化输出 | `runStructured` → `streamStructured`（`/api/chat/structured`） |

三条路径共用 `runSseSession` 骨架：开流、占位气泡、逐事件回调、收尾。

## components/

| 组件 | 职责 |
| --- | --- |
| `components/ChatMessageItem.vue` | 单条消息渲染：普通文本、RAG 引用、结构化 block 共用一个容器 |
| `components/ToolTracePanel.vue` | 工具轨迹、防护事件、Reflection 三类事件 |
| `components/PlanTimeline.vue` | 计划步骤与 Re-plan 历史，只读 state 不发请求 |
| `components/RagHitPanel.vue` | 检索命中与扩写 meta 展示 |
| `components/StructuredBlock.vue` | 结构化输出的分块渲染与重试入口 |
| `components/MemoryPanel.vue` | 记忆开关、列表、编辑、删除 |
| `components/UsagePanel.vue` | Token 与成本汇总、上下文压缩提示 |
| `components/ContextCompactionNotice.vue` | 上下文压缩摘要提示，可展开条目 |
| `components/ImageAttachment.vue` | 待发图片缩略图，只吃内存态 |

## rag/

`rag/citations.ts` 把回答正文切成文字段和 `[n]` 引用段。
**只认本次注入 prompt 的编号**：模型瞎写的 `[9]` 会被标成无效引用，
不能当依据用。

## 相关文档

- `README.md`：页面使用、HTTP API、SSE 事件
- `server/README.md`：服务端总览
