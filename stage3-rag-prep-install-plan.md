# 阶段 3 前期准备：安装与动手清单

> 只针对第三阶段（可解释 RAG）。  
> 依据：`stage3-rag-execution-plan.md`  
> 用途：正式按执行计划学/写代码之前，把环境和材料准备好。  
> **不是总路线，也不是阶段 1/2/4 的计划。**

---

## 现在就要做（还没开始写 RAG 代码）

### 1. 概念（零安装）

- [ ] 读完 `stage3-rag-execution-plan.md`
- [ ] 读完 `stage3-rag-notes.md` 里 RAG / 切片 / 入库相关节
- [ ] 能口述：文档 → 切分 → 向量化 → 检索 → 注入 → 生成
- [ ] 能说明：为什么不能整篇塞进 `messages`，为什么要带来源

### 2. 练习材料（本地文件）

- [ ] 准备 1～2 篇结构清楚的 Markdown（有标题、段落）
- [ ] 至少 1 篇偏长（方便测二次切分），可用 `stage3-rag-notes.md`
- [ ] 草稿 10 个测试问题：5 个文中有答案、3 个需综合、2 个文中没有

### 3. 项目载体（复用现有，不新开阶段）

在已有的阶段 1/2 项目 `step1-chat` 上做阶段 3，先确认还能跑：

```bash
cd step1-chat
npm install
npm run dev
```

- [ ] 页面能对话即可
- [ ] 阶段 2 的天气/时间工具先别和 RAG 焊在一起（RAG 后面单独目录/接口）

### 4. 目录预留（只建壳，不装大依赖）

```text
step1-chat/
  server/rag/      # 阶段 3 代码放这里（不要放进 server/tools/）
  docs-sample/     # 练习用 Markdown
  test/            # 以后放测试题
  scripts/         # 以后放入库/检索脚本
  .chroma/         # 以后放向量数据（加入 gitignore）
```

`.gitignore` 建议加上：`.chroma/`、`models/`、模型缓存目录。

---

## 进入阶段 3 编码时再装（不要提前一天全装）

按执行计划进度装，装早了只会卡在下载模型上。

| 执行计划进展到 | 再安装 / 再启动 | 命令或动作 |
|---|---|---|
| 第二部分：只做切分 | **不用新包** | 自己写切分，先看见一块块 chunk |
| 第二部分：开始向量化 | Embedding 运行时 | `npm i @huggingface/transformers` |
| 同上 | 中文 embedding 模型 | 首次运行会下载 `bge-large-zh-v1.5`（约 1GB+，慢正常） |
| 第三部分：检索召回 | 向量存储（默认） | 先用纯 JS 自有库落盘，**先不装 Chroma** |
| 第三部分（可选） | Chroma | `npm i chromadb`，另开终端 `npx chroma run --path ./chroma-data` |
| 第六部分：重排 | Reranker | 检索验收过后再装/下载，不要现在装 |
| 第四/五/七部分：注入与生成 | 无新装 | 继续用现有 DeepSeek / 现有 SSE |

说明：

- 执行计划写的「BGE-M3」在总计划里是中文 embedding 方向；本机 Node 落地用 **`bge-large-zh-v1.5`** 更稳。入库和提问必须同一模型。
- Chroma 的 JS 客户端通常要先有服务（`npx chroma run`）。连不上就继续用自有库，不阻塞阶段 3。
- 不要把切片做成阶段 2 那种 Function Calling 工具。

---

## 阶段 3 前期「准备完成」的标准

只满足下面几条，就可以按 `stage3-rag-execution-plan.md` 从第一部分正式往下学：

1. 链路能口述清楚  
2. 练习 Markdown + 测试题草稿已有  
3. `step1-chat` 能跑  
4. `server/rag/` 目录已留好  

**此时还不要求**已经装好 transformers / Chroma / Reranker。那些属于阶段 3 学到对应小节时再装。

---

## 不要在前期做的（仍属阶段 3，但是超前）

- 不要一次装齐 transformers + chromadb + rerank  
- 不要还没切分就下载 embedding  
- 不要一上来搞 PDF  
- 不要改 prompt 冒充检索  
- 不要和阶段 2 工具调用混成一条链路（那是执行计划里「不要急着做」的，不是阶段 4）
