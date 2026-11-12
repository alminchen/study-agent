# server/rag/queryEnhance/ — 检索前查询增强

> 所属学习阶段：**阶段 3 · 查询增强（单元 2～9）**
> 学习计划文档：`rag-query-intent-rewrite-learning-plan.md`

## 模块职责

在「用户问句」和「拿去 embed 的问句」之间插一层增强：
拆意图、扩写、路由、多路召回、HyDE。**这一层永远不能把整条 RAG 搞挂**——
任何一步失败都回退到原句检索。

## 五个单元

| 单元 | 文件 | 做什么 | 开关 |
| --- | --- | --- | --- |
| 2 | `parseIntent.ts` | 纯规则的意图 + 槽位拆解，不调 LLM | 始终运行 |
| 3 | `rewriteQuery.ts` | 一次 LLM 调用产出 intent / slots / keywords / rewritten | `RAG_QUERY_REWRITE` |
| 4 | `index.ts` | 决定「用哪句话去 embed」，并汇总对外出口 | — |
| 5 | `kbRoute.ts` | 多知识库路由，检索时按 source 硬过滤 | `RAG_KB_ROUTE` / `RAG_KB_ROUTE_FORCE` |
| 6 | `multiQuery.ts` | 多路检索合并，扩大召回面 | `RAG_MULTI_QUERY` |
| 7 | `hyde.ts` | HyDE：先造假文档再 embed，对齐向量空间 | `RAG_HYDE` |

## 统一出口

```ts
resolveQueryForRetrieve(original, options) → { query, meta }
```

**无论开关状态和扩写成败，都保证返回一条可用的 query。**
调用方（`rag/retrieve.ts`）只依赖这个返回值，不要自己再 try/catch `rewriteQuery`。

`meta` 里的 `status` 有三种：`disabled`（开关关闭）、`ok`（扩写成功）、`fallback`（失败回退）。

## 三条硬约束

1. **只理解与扩写，禁止回答用户问题。** 否则 rewritten 变成答案正文，向量更脏。
2. **默认只用当前问句，不塞多轮 history。** 避免「根据上文」污染。
3. **扩写必须上报 usage。** 否则 Token 面板会漏计这一次模型调用。

## 扩写与 HyDE 的区别

| | 扩写 `rewritten` | HyDE `hydeDoc` |
| --- | --- | --- |
| 形态 | 仍是问句 | 假想的资料段落 |
| embed 对象 | 问句 | 假文档 |
| 用途 | 对齐库内术语 | 用「文档对文档」拉近向量空间 |

## 为什么规则层要先跑一遍

`parseIntent` 始终执行，哪怕扩写开关关着。
这样在 `meta` 里永远能看到规则结果，方便做「开 / 关」对照实验，
也能一眼看出规则能力到哪儿就顶不住了——典型是开放域笔记问题（「chunk 怎么切」）。

## 相关文档

- `docs/rag-query-enhance-notes.md`：查询增强笔记
- `server/rag/README.md`：RAG 主链路
- `scripts/README.md`：`rag:rewrite` / `rag:hyde` / `rag:compare-enhance` 等验证脚本
