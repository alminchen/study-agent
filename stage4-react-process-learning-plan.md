# 阶段 4 · ReAct 过程：图结构 + 页面可见（已完成）

> **状态：已完成。**  
> - 现网 `runConversation.ts` 走 LangGraph；`runConversation.forLoop.ts` 保留备份。  
> - `ToolTracePanel` 已能展示：一次天气、天气+时间两次调用、火星 `{ error }`。  
> 人工确认仍放全部计划最后。下面正文保留作复习。  
>
> **说明**：原 `stage4-tool-trace-ui-learning-plan.md` 与 `stage4-langgraph-learning-plan.md`  
> 讲的是同一条 ReAct 逻辑的两面（后端怎么跑 / 前端怎么看见），已合并为本文件。

---

# 阶段 4 · ReAct 过程（图 + 过程面板）

> 前段已完成：会连续执行工具，失败会回填 `{ error }`。  
> 本段只学一件事：**把「问模型 → 调工具 → 再问」说清楚、画清楚，并在页面上按次看清。**  
> 不做：人工确认、新工具、资料问答面板、接管 `/api/rag/chat`。

---

## 1. 介绍：同一条逻辑的两面

ReAct 在服务端是一轮轮循环；在页面上是过程面板。两边对的是同一套事件：

```
askModel ──有 tool_calls──► applyTools ──► 再 askModel …
     │
     └──无 tool_calls──► reply（文字给用户）
```

| 视角 | 学什么 | 代码 |
|------|--------|------|
| **图 / LangGraph** | 状态、节点、边 = 手写 `for` + `if` 的声明式写法 | `runConversation.ts`、`runConversation.forLoop.ts` |
| **过程面板** | 每次调了谁、参数、成功/失败，按次可数 | `applyToolCalls` → SSE → `ToolTracePanel` |

LangGraph **不会**让模型更聪明，也 **不会**自动多出工具；工具仍是 `schemas/` + `methods/`。  
过程面板 **不是**另起一套系统，只是把已有 `onTrace` 对齐多步 ReAct。

目标一句话：**能对着图讲清循环；页面上能数出两次工具，失败和成功能区分。**

### LangGraph 是什么（对照用）

它是 **把流程写成图、再按图执行** 的库，不是模型，也不替代 DeepSeek。

手写时：

- `requestCompletion`：问模型  
- `if (!toolCalls?.length)`：出文字并结束  
- 否则 `applyToolCalls`，再进入下一轮  
- `MAX_MODEL_TURNS`：刹车  

LangGraph 拆成：

1. **状态**：`messages`（+ 失败计数、轮次）  
2. **节点**：问模型 / 执行工具 / 出文字  
3. **边**：有 `tool_calls` → 执行工具 → 再问；没有 → 结束  

库负责顺着边跑节点。手写 `for`+`if` 已经是这个运行器；图是把「去哪」画出来，方便以后分支变多时改。

---

## 2. 要学什么、难在哪、坑

### A. 先画出现有循环（图）

**要学什么**

- 节点：问模型、执行工具、把文字交给页面、次数上限停下  
- 边：有 `tool_calls` 走执行；没有走结束；最后一轮还要工具也走结束  
- 能指着 `runConversation.ts` / `applyToolCalls.ts` 说出和图上哪一块对应  

**坑**

- 一上来装库、删掉现有循环重写  
- 把 RAG 检索流程画进这张图  

**怎么算过**

- 能对着现有文件讲完：问 → 做 → 看 → 再问，以及刹车在哪  
- 能说出：库里的边 ≈ `if (!toolCalls?.length) return` 与 `applyToolCalls` 后继续循环  

### B. 过程面板能不能撑住多步

**要学什么**

- 数据通路：`applyToolCalls` 里 `onTrace` → `/api/chat` SSE → `useChat.toolTrace` → `ToolTracePanel`  
- 发送前清空 `toolTrace`，看到的应是**这一句**的过程  

**对着看**

- `server/react/applyToolCalls.ts`  
- `src/composables/useChat.ts` 里 `onTrace`  
- `src/components/ToolTracePanel.vue`  

**坑**

- 没看现有面板就新写一个，和 RAG 命中面板缠在一起  
- 开着「资料问答」去验（那条链路不走工具过程）  

**怎么算过**

- 天气+时间：面板里能数出多次 `tool_call` / `tool_result`  
- 只问北京天气：对应一次天气  

### C. 按「一次调用」成对展示 + 失败可见

**要学什么**

- 第 N 次 = 工具名 + 参数 + 结果成对  
- 结果带 `error` 时不要看起来像成功 JSON；连续失败停跑的那条也要能看见  

**坑**

- 调用和结果对不上号  
- 只在终端有 error，页面当普通结果  
- 和资料问答「资料里没有」做成同一个提示  

**怎么算过**

- 能指出「第 1 次 getWeather，第 2 次 getCurrentTime」  
- `用天气工具查火星今天气温`：过程里能看出天气工具失败  

---

## 3. 怎么开始动手（复习顺序）

1. 口述现有循环的节点和边（先不纠结库）  
2. 用两句把现有面板点开看一遍（天气；天气+时间）  
3. 对照 `runConversation.ts` 与 `runConversation.forLoop.ts`：同一行为，两种写法  
4. 只改前端展示时动 `ToolTracePanel`；服务端 `onTrace` 已有就不要重造  

---

## 4. 测试点

| 测什么 | 用什么 | 过关 |
|--------|--------|------|
| 手写/图行为一致 | `北京今天天气` | 一次 `getWeather` |
| 多步仍在 | 天气+时间 | 两次工具再出文字；面板能数出两次 |
| 失败仍回填 | 用天气工具查火星 | 面板有 `{ error }` |
| 对照能讲清 | 图 + `runConversation.ts` | 能指出「问 / 做 / 结束」 |
| 模式隔离 | 打开资料问答 | 不出现这套工具过程面板 |
| 不清错句 | 连问两句 | 第二句开始时第一句过程被清掉 |

---

## 5. 其他

**本段不做**

- 点允许才执行（人工确认）  
- 用 LangGraph 接管 `/api/rag/chat`  
- 把资料检索画进工具过程面板  
- MCP、Evals、阶段 5 交付页  

**交付**

- 一张与现有循环对应的图（现网已是 LangGraph）  
- 多步工具在页面上按次可数；失败和成功能区分  
- 不和资料问答面板混用  

**相关代码**

- `server/react/runConversation.ts` · `runConversation.forLoop.ts` · `applyToolCalls.ts`  
- `src/components/ToolTracePanel.vue` · `src/composables/useChat.ts`  
- 模块说明：`step1-chat/server/react/README.md`
