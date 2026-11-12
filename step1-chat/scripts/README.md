# scripts/ — 本地验证脚本

这个目录里全是**验收和自测脚本**，不是业务代码。它们的共同点是：
用可控的输入跑一遍某条链路，然后把中间结果打印出来给你看。

## 怎么用

所有脚本用 `tsx` 直接跑，不经过构建：

```bash
npx tsx scripts/search.ts "问题"
```

或者用 `package.json` 里的别名（推荐，别记脚本名）：

```bash
npm run rag:search -- "问题"
```

带参数调用 npm script 时必须用 `--` 分隔。

## RAG 基础链路

| 脚本 | 做什么 | 对应 npm script |
| --- | --- | --- |
| `preview-chunks.ts` | 打印每块 id / 标题 / 字数 / 前 30 字 | `rag:preview-chunks` |
| `ingest.ts` | 切分、向量化并替换同来源的旧记录 | `rag:ingest` |
| `test-embed.ts` | 同句应高度相似，近义高于无关句 | `rag:test-embed` |
| `test-store.ts` | 本地 JSON 向量库读写 | `rag:test-store` |
| `search.ts` | 向量召回 → 判空 → 重排 → 打印前后顺序 | `rag:search` |
| `test-retrieve.ts` | 直接命中、近义、资料外问题三类召回验收 | `rag:test-retrieve` |
| `test-empty.ts` | 低分闸门和空命中验收 | `rag:test-empty` |
| `preview-prompt.ts` | 打印实际发给回答模型的 messages | `rag:preview-prompt` |
| `test-prompt.ts` | RAG Prompt 拼接规则验收（不依赖向量库和模型） | `rag:test-prompt` |
| `ask.ts` | 终端里跑完整的检索 → 判空 → 拼 prompt → 调模型 | `rag:ask` |
| `test-rerank.ts` | 对比向量排序与重排后的注入顺序 | `rag:test-rerank` |

## 查询增强

| 脚本 | 做什么 | 对应 npm script |
| --- | --- | --- |
| `rewrite.ts` | 只跑意图 / 扩写，不检索 | `rag:rewrite` |
| `hyde.ts` | 只看 HyDE 假文档，不检索 | `rag:hyde` |
| `compare-enhance.ts` | 同一批黄金问句对照 single / multi / hyde | `rag:compare-enhance` |
| `test-enhance-fallback.ts` | 故障注入 ≥3 种，验收回退和 status 标记 | `rag:test-enhance-fallback` |

## 评测

| 脚本 | 做什么 | 对应 npm script |
| --- | --- | --- |
| `run-evals.ts` | 单 Agent 回归评测：固定问句 + 规则判分 | `eval:chat` |
| `run-evals-multi.ts` | 多 Agent 回归评测：路由与工具判分 | `eval:multi` |
| `run-plan-evals.ts` | Plan 离线 Mock 评测，`--compare` 切真实模型 | `eval:plan` |
| `run-judge-evals.ts` | LLM-as-Judge 离线评测管线 | `eval:judge` |
| `check-judge-dataset.ts` | Judge 数据集质量校验 | `judge:check` |
| `run-reflection-evals.ts` | 同一份初版答案走反思链路对比 | 无 npm 别名 |

## 记忆与长上下文

| 脚本 | 做什么 | 对应 npm script |
| --- | --- | --- |
| `test-memory.ts` | Memory 端到端校验 | `test:memory` |
| `check-memory-recall.ts` | 记忆检索召回校验，验证相似度阈值可复现 | 无 npm 别名 |
| `test-long-context.ts` | 50 轮长会话验收，默认 stub 后端 | `test:long-context` |
| `baseline-context.ts` | 基线：量化「只按条数截断」到底丢了什么 | 无 npm 别名 |
| `test-chat-chains.ts` | 五链路回归，确认记忆改造没波及既有链路 | `test:chains` |

## MCP 与图表

| 脚本 | 做什么 | 对应 npm script |
| --- | --- | --- |
| `mcp-ping.ts` | 起 MCP 子进程，列工具并各调一次 | `mcp:ping` |
| `gen-seq-diagrams.mjs` | 生成终端版 ASCII 时序图 | `diagrams:ascii` |
| `render-seq-svg.mjs` | 把共享数据渲染成 SVG 和图表导航页 | `diagrams` |
| `seq-data.mjs` | ASCII 与 SVG 共用的时序图数据 | — |
| `predawn-bge.sh` | 下载 BGE Embedding ONNX 模型 | `predawn:bge` |
| `predawn-rerank.sh` | 下载 BGE Reranker ONNX 模型 | `predawn:rerank` |

## 三类脚本的区别

- **打印型**（`preview-*`、`search`、`ask`）：不判定对错，只把中间结果摊开给人看。
- **验收型**（`test-*`、`check-*`）：有明确的通过条件，失败会退出码非零。
- **评测型**（`run-evals*`、`run-judge*`）：跑数据集算指标，产出报告。

## 相关文档

- `evals/README.md`：数据集与评测口径
- `README.md`：npm scripts 完整表
