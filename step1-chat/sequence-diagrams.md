# step1-chat · 模块时序图（mermaid 源码）

> **不想看源码、想直接看图？** 打开 `diagrams/index.html`（浏览器即可，无需任何渲染器），
> 或逐个打开 `diagrams/*.svg`。本 `.md` 是 mermaid 源码：
> 在 VS Code（Markdown Preview Mermaid Support）或 GitHub 上直接渲染；也可粘贴到 https://mermaid.live 编辑。
> 终端可直接阅读的 ASCII 版由 `scripts/gen-seq-diagrams.mjs` 生成，SVG 版由 `scripts/render-seq-svg.mjs` 生成。

## 图 1 · 架构与数据边界

```mermaid
flowchart LR
  subgraph WEB["浏览器 · Vue 3"]
    UI["App.vue + useChat"]
    SC["streamChat 解析 SSE"]
    AR["askRag 收 JSON"]
  end
  subgraph SRV["Express · server/"]
    C["/api/chat"]
    R["/api/rag/chat"]
    RG["server/rag/ 流水线"]
    TK["tools/ 天气 · 时间"]
  end
  subgraph LOC["本地资源"]
    EM["bge-large-zh 句向量"]
    RR["bge-reranker 重排"]
    ST[".chroma/my_notes.json"]
  end
  LLM["DeepSeek · OpenAI 兼容"]
  UI --> SC
  UI --> AR
  SC -- "POST · SSE" --> C
  AR -- "POST · JSON" --> R
  C --> TK
  C --> LLM
  R --> RG
  RG --> EM
  RG --> ST
  RG --> RR
  RG --> LLM
```

两条链路共用前端状态与 Express，但接口、协议、system 与历史存储完全隔离；本地模型与向量库只服务资料链路。

## 图 2 · 链路 A：普通对话（SSE + 工具调用）

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant UC as useChat.ts
  participant SC as api/chat.ts
  participant EX as Express /api/chat
  participant CC as createChatStream
  participant TK as tools/ 天气·时间
  participant LLM as LLM DeepSeek

  U->>UC: send("北京今天适合出门吗？")
  UC->>UC: 追加 user 消息，写入 localStorage
  UC->>SC: streamChat({messages, model, signal})
  SC->>EX: fetch POST /api/chat（保持连接）
  EX->>CC: createChatStream(options)
  CC->>CC: clipMessages：保留最近 8 条 + system
  alt MOCK_MODE=1 或没有 API Key
    CC->>SC: onDelta：每 4 字 + 24ms 模拟流式
    Note over CC: 不请求 LLM、不调用任何工具
  else API 模式（两次请求）
    CC->>LLM: 第 1 轮 chat/completions（tools + stream:false）
    LLM-->>CC: tool_calls: [getWeather]
    CC->>TK: runToolCall(参数) 执行本地函数
    TK-->>CC: 天气结果 {city, temperature, ...}
    CC->>CC: 回填 role:"tool" 消息
    CC->>LLM: 第 2 轮 chat/completions（带工具结果）
    LLM-->>CC: 最终回答文本
  end
  CC-->>EX: onDelta / onTrace
  EX-->>SC: data: {"delta":...} 逐帧 + data: [DONE]
  SC->>UC: onDelta(delta) 追加
  UC-->>U: 增量渲染
```

tool calling 闭环：决定 → 执行 → 回填 → 再问，全程非流式两次请求；前端每次读到 data 帧就渲染一段。

## 图 3 · 链路 B：资料问答（RAG 流水线）

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant UC as useChat.ts
  participant AR as api/rag.ts
  participant EX as Express /api/rag/chat
  participant AD as answerFromDocs
  participant RV as retrieveForAnswer
  participant EM as bge 句向量
  participant ST as .chroma 向量库
  participant RR as bge 重排器
  participant CP as prompt + complete
  participant LLM as LLM DeepSeek

  U->>UC: send(问已入库笔记的问题)
  UC->>UC: 末条 user 作 question，history 去掉末条
  UC->>AR: askRag({question, history, model, signal})
  AR->>EX: fetch POST /api/rag/chat（JSON）
  EX->>EX: isRagHistoryItem 过滤：只收 user/assistant
  EX->>AD: answerFromDocs(question, safeHistory, signal, model)
  AD->>RV: retrieveForAnswer(question, topK=5)
  RV->>EM: embed([question]) → queryVec
  RV->>ST: search(queryVec, 20) 余弦 Top20
  ST-->>RV: rawHits（向量召回候选）
  RV->>RV: judgeRetrieval：0.6 分数闸门 + 标题对上例外
  alt 判空（不足 0.6 且标题对不上 / 库空）
    RV-->>AD: empty=true, hits=[]
    Note over AD: 不调模型，直接回「资料里没有」
  else 有资料
    RV->>RR: rerankHits(question, rawHits, keep=5)
    RR-->>RV: injected Top5 + rankedAll
  end
  RV-->>AD: judgment{hits, rawHits, topScore}
  AD->>CP: buildRagPrompt → system(规则 + [1][2]…) + 历史 + 问句
  CP->>LLM: chat/completions（无 tools, stream:false）
  LLM-->>CP: 回答文本
  AD->>EX: RagAnswer{answer, calledModel, hits(去向量)}
  EX-->>AR: JSON 响应
  AR-->>UC: data
  UC-->>U: 渲染回答 + RagHitPanel + [n] 引用
```

空结果不消耗模型调用；RagHitView 去掉 1024 维向量再回前端，引用编号只认本次注入的 promptIndex。

## 图 4 · 离线入库 rag:ingest

```mermaid
sequenceDiagram
  autonumber
  participant CLI as scripts/ingest.ts
  participant CK as chunker.ts
  participant EMB as embedding.ts
  participant VS as LocalVectorStore
  participant F as .chroma/my_notes.json

  CLI->>CLI: 读 docs-sample/stage3-rag-notes.md
  CLI->>CK: chunkMarkdown(md, source, maxChars=400, overlap=0.15)
  CK-->>CLI: DocumentChunk[]（带 title / id / seq）
  CLI->>EMB: embed(全部正文) 批量向量化
  EMB-->>CLI: number[1024][]（mean + normalize）
  CLI->>VS: load() 读现有库
  CLI->>VS: replaceSource(source, 新块) 先删旧再写新
  CLI->>VS: save() 整表覆盖写回
  VS-->>F: StoredChunk[]（向量 + 原文 + 来源）
```

同一 source 只允许一份数据：replaceSource 先删旧再写新，禁止直接 push 造成新旧两版并存。

## 图 5 · 状态与生命周期

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant APP as App.vue
  participant UC as useChat.ts
  participant AB as AbortController
  participant LS as localStorage

  U->>APP: Enter 发送
  APP->>UC: send(content)
  UC->>LS: persistCurrentHistory()
  UC->>UC: ragMode ? runRag() : runStream()
  Note over UC: isStreaming=true，发送钮变「停止」
  U->>APP: 点「停止」
  APP->>UC: stop()
  UC->>AB: abort()
  Note over UC: 服务端 res.on('close') 也 abort，空回复填「已停止生成。」
  U->>APP: 重新生成 / 清空 / 切换模式
  APP->>UC: retry / clear / setRagMode
  Note over UC,LS: 两条链路历史分 key 保存，切换互不污染
```

watch([messages, isStreaming, ragMode]) 在非流式时把当前模式的历史写回 localStorage，普通对话与资料问答各一份。

## 图 6 · 单点验证脚本顺序

```mermaid
flowchart LR
  A["predawn:bge\n预下载句向量"]
  B["preview-chunks\n只验切分"]
  C["test-embed\n只验 1024 维"]
  D["ingest\n入库"]
  E["test-store\n只验存储层"]
  F["search · retrieve · empty\n召回 + 判空"]
  G["preview-prompt · test-prompt\n只验拼 prompt"]
  H["ask\n检索→拼→调模型"]
  I["predawn:rerank\n重排"]
  A --> B --> C --> D --> E --> F --> G --> H --> I
```

每条命令只练一个环节，失败只重跑那一条；入库成功 ≠ 检索合格，检索有命中 ≠ 可以注入。
