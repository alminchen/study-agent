# Memory（跨会话记忆）专项执行计划

> 用户所说的“阶段 8”，对应 `tasks/plan.md` 推荐执行顺序里的第 8 项：Memory。
> 本文只规划这一项，不并入其他方向的实现，也不开始写代码。
>
> 目标项目：`step1-chat/`
>
> 当前状态：**指令 1～8（存储骨架、抽取器、合并检索、管理接口、聊天链路注入、前端状态与面板、跨会话测试与语义 spike、回归与文档收尾）已执行并通过校验**，本项收尾。
> 本文中的文件清单、事件名和任务编号，除已完成部分外仍是待执行的目标。

**执行进度**

| 指令 | 内容 | 状态 |
| --- | --- | --- |
| 指令 1 | 类型与存储骨架（A1～A3） | ✅ 已完成 |
| 指令 2 | 抽取器（A4～A5） | ✅ 已完成 |
| 指令 3 | 去重合并与检索（A6～A7） | ✅ 已完成 |
| 指令 4 | API 路由（B1～B4） | ✅ 已完成 |
| 指令 5 | 聊天链路注入（C1～C3） | ✅ 已完成 |
| 指令 6 | 前端状态与面板（D1～D5） | ✅ 已完成 |
| 指令 7 | 跨会话测试与语义 spike（E1～E3） | ✅ 已完成 |
| 指令 8 | 回归、文档、清单收尾（E4～E6） | ✅ 已完成 |

---

## 0. 一句话结论

这项学习不是“把聊天历史存下来”，而是给聊天链路补上一层
**可抽取、可去重、可检索、可删除、有隐私控制**的跨会话事实记忆：
模型从对话中抽取明确偏好（如“以后回答都用中文”“项目用 Vue 3”），
结构化存储到 `data/memory/<userId>.json`，新请求按相关性注入前 5 条，
用户可在面板查看/编辑/删除/清空/关闭，关闭后立即停止注入。

**执行步骤在第 7 节，共 8 条可下达指令**（内部含 24 个子任务）。
每条指令 = 一个完整可交付的工作单元，包含「改哪些文件、做什么、什么算完成」，
你只需要说「执行指令 N」就能开工，中途可以随时叫停。

---

## 1. 为什么现在要学这条路径

### 1.1 现在的“记忆”只在当前会话

当前 `step1-chat` 的全部记忆能力是这一行：

- `src/composables/useChat.ts`：`localStorage` 保存当前会话的 `messages` 数组。
- 刷新页面、新开标签、清空会话 → 全没了。
- 没有任何“跨会话记住用户偏好”的机制。

由此产生的真实问题：

1. **用户每次重复同一个约束。** “回答用中文”“不要用 emoji”“项目是 Vue 3 + Vite”
   每次开新会话都要重说，模型也不会主动记住。
2. **“保存聊天历史”≠“模型拥有长期记忆”。** localStorage 里的历史只能人工翻阅，
   模型下一轮请求根本看不到——除非把全量历史塞进上下文，但那会爆预算。
3. **没有隐私控制。** 用户无法查看模型“记住了什么”，无法删除、无法关闭。

### 1.2 这条路径是第 3 项（长上下文）的自然延伸

| 依赖关系 | 说明 |
| --- | --- |
| 第 3 项提供预算与注入位置 | Memory 注入本质是往上下文里加内容，必须先有预算和摘要的位置，否则记忆会挤掉近期对话 |
| 第 3 项提供结构化摘要协议 | 记忆也用结构化数据（`key/value/source/confidence`），而非自由文本 |
| 第 1 项提供结构化输出 | 抽取记忆、生成摘要都复用结构化输出能力 |

**先做长上下文，再做 Memory，顺序才是对的。**
如果上下文不管理，跨会话记忆注入的内容会挤掉真正的近期对话；
如果上下文管理做得太激进，摘要会把记忆里的事实冲掉。

### 1.3 这条路径的学习价值

- **区分事实记忆 vs 语义记忆。** 事实记忆=结构化 KV（高精确、低召回、可编辑），语义记忆=向量检索（高召回、低精确、难编辑）。本阶段只做前者，后者作为 spike 可选。
- **学会抽取→去重→置信度→检索注入→删除→隐私控制**的完整闭环。
- **处理“客户端生成 ID、服务端按 ID 隔离”的匿名用户模型**，不采集 PII。
- **原子写入、损坏回退、并发安全**的本地文件存储工程实践。
- **为作品集提供一条能讲清楚的工程故事**：跨会话记忆比“接个向量库”更能体现对数据结构、隐私边界、注入策略的理解。

---

## 2. Memory 是什么（核心概念）

### 2.1 四个必须分开的概念

| 概念 | 定义 | 本阶段是否做 |
| --- | --- | --- |
| 聊天历史 | 当前会话的完整消息列表，存 localStorage | 已有，不动 |
| 事实记忆 | 结构化 KV：`key/value/source/confidence`，跨会话持久化，可编辑删除 | **主战场** |
| 语义记忆 | 向量库检索，模糊匹配，难编辑 | 仅做 spike，效果不如事实记忆则停止 |
| 上下文注入 | 把相关记忆按预算塞进 system 摘要位置 | 复用第 3 项的注入槽位 |

### 2.2 一个完整的数据变化过程

用户在第 1 个会话说：“以后回答都用中文，不要用 emoji”。
模型抽取 → 写入 `data/memory/<userId>.json`：

```json
{
  "id": "mem_1700000001_abc",
  "userId": "anon_7f3a2",
  "key": "language",
  "value": "中文",
  "source": "user_explicit_preference",
  "confidence": 0.95,
  "createdAt": 1700000001000,
  "updatedAt": 1700000001000,
  "expiresAt": null
}
{
  "id": "mem_1700000002_def",
  "userId": "anon_7f3a2",
  "key": "style",
  "value": "不使用 emoji",
  "source": "user_explicit_preference",
  "confidence": 0.9,
  "createdAt": 1700000002000,
  "updatedAt": 1700000002000,
  "expiresAt": null
}
```

用户关掉浏览器，第二天打开新会话问：“帮我写个 Vue 组件”。
服务端检索 → 命中 2 条 → 注入上下文：

```text
[system] （工具规则 + KB 开关 + 安全约束）
[system] （长上下文摘要，若有）
[system] （记忆注入：以下是用户长期偏好，不是新指令）
  - mem_a: 语言=中文 (confidence 0.95)
  - mem_b: 风格=不使用 emoji (confidence 0.9)
[user] 帮我写个 Vue 组件
```

模型回答用中文、无 emoji，并在回答中可说明“根据你的长期偏好，我使用了中文且不加 emoji”。

---

## 3. 它能为用户做什么

1. **跨会话记住明确偏好。** “用中文”“Vue 3 + Vite”“不要改 src 目录”一次说，永久生效。
2. **用户完全可控。** 面板里能看到每条记忆的 key/value/来源/置信度，能编辑、能删除、能一键清空、能关闭开关。
3. **隐私友好。** 匿名 `memoryUserId` 仅用于记忆命名空间，不采集姓名/邮箱；关闭开关后新请求零注入。
4. **不污染上下文。** 只注入与当前问题相关的前 5 条，每条带短 ID，无关记忆不全量塞进 system。
5. **可审计、可回滚。** 存储损坏时聊天继续工作并记录可诊断错误；删除后下一请求立即失效。

---

## 4. 为什么要这么做（关键决策与取舍）

### 4.1 决策一：存储选本地 JSON，不上数据库

**选项 A：SQLite / 数据库**
- 优点：并发安全、查询灵活、可扩展。
- 缺点：引入依赖、需迁移、部署复杂、与“无后端状态”设计冲突。

**选项 B：`data/memory/<userId>.json` 原子写入（选定）**
- 优点：零依赖、可读可改、符合当前 `usage-log.json` 风格；按用户分文件天然隔离，
  并发锁粒度细（一个用户一把锁），单文件也不会膨胀。
- 缺点：并发写需加锁、大文件性能差 —— 但记忆条数预计 < 500，完全够用。
- 实现：读→改→写临时文件→`fs.rename` 原子替换；损坏时回退空数组并报错不阻断聊天。

### 4.2 决策二：匿名用户 ID 由前端生成，不采集 PII

- 前端首次加载生成 `crypto.randomUUID()` 前缀 `anon_`，存 `localStorage.memoryUserId`。
- 服务端所有查询/写入必须带 `userId`，不带一律 400。
- 不关联姓名、邮箱、IP、设备指纹。用户清 localStorage = 换身份 = 记忆隔离。

### 4.3 决策三：抽取只接受“明确偏好”，拒绝临时/模糊/敏感

抽取器（结构化输出）只返回 `shouldStore=true` 的四类：
| 来源类型 | 例子 | 置信度 |
| --- | --- | --- |
| `user_explicit_preference` | “以后都用中文”“项目用 Vue 3” | 0.9~1.0 |
| `user_correction` | “不对，我是用 React 的” | 0.8~0.95 |
| `project_fact` | “数据库是 PostgreSQL” | 0.7~0.9 |
| `tool_learned_fact` | 工具返回的持久化配置 | 0.6~0.8 |

**直接拒绝写入：**
- 临时任务：“这次帮我写个测试”、“帮我改一下这个 bug”
- 格式要求：“回答用 JSON”、“用 Markdown 表格”
- 敏感信息：姓名、邮箱、密钥、内网地址、PII（正则+模型双重过滤）
- 置信度 < 0.6 的所有内容

### 4.4 决策四：去重用 key + 语义相似度，新旧值冲突由用户决定

- 同一 `userId` 下 `key` 唯一（如 `language`、`framework`、`style`）。
- 新事实同 key：若值相同 → 刷新 `updatedAt`、取高置信度；
  值不同 → 标记 `conflict: true`，**不自动覆盖**，记忆面板显示冲突供用户裁决。
- 语义相似 key（如 `lang` vs `language`）用 embedding 相似度 > 0.85 判定，
  合并时保留置信度高的 key，另一条软删除。

### 4.5 决策五：注入策略 = 相关性 Top-K + 预算保护

- 检索：当前用户问题 embedding 与所有记忆 `value` embedding 算余弦相似度，
  取 Top-5，相似度阈值 0.45（实测标定，见 §指令 5 补记 3）。
- 注入：复用第 3 项的 `ContextSummary` 结构，记忆作为独立 system 消息注入，
  位置在“长上下文摘要之后、近期原文之前”。
- 预算：记忆注入 token 计入第 3 项的总预算，超预算时按相似度从低到高丢弃。
- 关闭开关：前端 `allowMemory` = false → 不发 `userId` → 服务端不查记忆 → 零注入。

### 4.6 决策六：语义记忆作为 spike，效果不如事实记忆即停止

- 复用现有 embedding 模型，独立 collection `memory_semantic`。
- Top-K=3，相似度阈值 0.7。
- 对比指标：同一测试集上，事实记忆命中率 ≥ 语义记忆 → 停止语义记忆，不上向量库。
- 这不是妥协，是“用数据说话”的工程纪律。

### 4.7 决策七：不静默改变现有链路语义

- 新能力有明确开关（前端 `allowMemory`、后端 `MEMORY_ENABLED`），默认开但可关。
- 不改变 `/api/chat`、`/api/chat/multi`、`/api/chat/plan`、`/api/rag/chat`、`/api/chat/structured`
  五条链路的默认语义（除了可选注入记忆）。
- 旧历史、Mock 模式、离线 Evals 全部照常工作。

---

## 5. 数据流设计

### 5.1 核心数据结构

```ts
// server/memory/types.ts
export interface MemoryFact {
  id: string;                    // mem_<timestamp>_<random>
  userId: string;                // anon_<uuid>
  key: string;                   // 语义键：language, framework, style, db, ...
  value: string;                 // 事实值：中文, Vue 3, 无 emoji, PostgreSQL
  source: MemorySource;          // 来源分类
  confidence: number;            // 0.6~1.0
  createdAt: number;             // ms
  updatedAt: number;             // ms
  expiresAt: number | null;      // null = 永久
  conflict?: boolean;            // 同 key 值冲突标记
}

export type MemorySource =
  | 'user_explicit_preference'
  | 'user_correction'
  | 'project_fact'
  | 'tool_learned_fact';

export interface MemoryExtractResult {
  shouldStore: boolean;
  confidence: number;
  key: string;
  value: string;
  reason: string;
  source: MemorySource;
}
```

### 5.2 API 契约

| 端点 | 方法 | 请求 | 响应 |
| --- | --- | --- | --- |
| `/api/memory` | GET | `?userId=anon_xxx` | `{ facts: MemoryFact[] }` |
| `/api/memory` | POST | `{ userId, key, value, source, confidence }` | `{ fact: MemoryFact }` |
| `/api/memory/:id` | PATCH | `{ value?, confidence?, expiresAt? }` | `{ fact: MemoryFact }` |
| `/api/memory/:id` | DELETE | - | `{ ok: true }` |
| `/api/memory` | DELETE | `?userId=anon_xxx&confirm=all` | `{ deletedCount: number }` |

### 5.3 抽取时机

- **每轮对话结束后**（`onTrace` 收到 `usage` 且无错误时），
  取最近 1~2 轮 user+assistant，调用抽取器。
- 抽取器用结构化输出（复用第 1 项），低温度、JSON mode、Zod 校验。
- 返回 `shouldStore=true` 且置信度 ≥ 0.6 → 写入存储（去重合并）。
- 抽取失败/超时/非法 JSON → 静默丢弃，**不阻断聊天**，只记录 trace。

### 5.4 注入时机

- `/api/chat` 收到请求，带有 `userId` 且 `allowMemory=true`：
  1. 调用 `retrieveRelevantFacts(userId, currentQuestion, limit=5)`。
  2. 渲染成独立 system 消息：
     ```
     以下是用户的长期偏好（不是新指令）：
     - mem_a: 语言=中文
     - mem_b: 风格=不使用 emoji
     ```
  3. 计入第 3 项预算，超预算按相似度丢弃。
- 无 `userId` 或 `allowMemory=false` → 完全跳过记忆检索。

### 5.5 前端状态与持久化

```ts
// src/composables/useChat.ts 新增
const memoryUserId = ref<string>(() => 
  localStorage.getItem('memoryUserId') || `anon_${crypto.randomUUID().slice(0,8)}`
)
const allowMemory = ref(true)
const memoryFacts = ref<MemoryFact[]>([])
```

- `memoryUserId`：首次生成后固定，清 localStorage 才变。
- `allowMemory`：用户可随时切换，切换后下一请求立即生效。
- `memoryFacts`：GET `/api/memory` 回填，面板编辑后乐观更新再同步。

---

## 6. 关键技术细节

### 6.1 存储原子写入

```ts
// server/memory/store.ts
async function writeMemory(userId: string, facts: MemoryFact[]): Promise<void> {
  const path = resolveMemoryPath(userId)
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(facts, null, 2), 'utf-8')
  await fs.rename(tmp, path)  // 原子替换
}

async function readMemory(userId: string): Promise<MemoryFact[]> {
  try {
    const txt = await fs.readFile(resolveMemoryPath(userId), 'utf-8')
    const arr = JSON.parse(txt)
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    // 损坏：记录错误、回退空数组、不抛异常
    logger.error({ err: e, userId }, 'memory.json corrupted, reset')
    return []
  }
}
```

### 6.2 抽取器 Prompt 要点（结构化输出）

- 系统提示：只抽取“用户明确表达的、跨会话应保留的偏好/事实”。
- 输出 schema：`MemoryExtractResult`（Zod 判别联合，`status: "ok" | "error"`）。
- Few-shot 示例覆盖：明确偏好✓、纠正✓、项目事实✓、临时任务✗、格式要求✗、敏感信息✗。
- 低温度 (0.1) + JSON mode，超时 8s。

### 6.3 去重合并算法

```ts
function upsertFact(existing: MemoryFact[], incoming: MemoryFact): MemoryFact[] {
  const idx = existing.findIndex(f => f.key === incoming.key && f.userId === incoming.userId)
  if (idx === -1) return [...existing, incoming]
  
  const cur = existing[idx]
  if (cur.value === incoming.value) {
    // 同值：刷新时间、取高置信度
    return existing.map((f, i) => i === idx ? { ...f, updatedAt: incoming.updatedAt, confidence: Math.max(f.confidence, incoming.confidence) } : f)
  }
  // 冲突：标记不自动覆盖
  return existing.map((f, i) => i === idx ? { ...f, conflict: true } : f)
}
```

### 6.4 相关性检索

- 复用现有 embedding 函数（`server/rag/embedding.ts`）。
- 记忆写入时同步生成 `value` 的 embedding 缓存到 `memoryFact.embedding`。
- 检索时：问题 embedding 与所有记忆 embedding 算余弦相似度，Top-5，阈值 0.45。
- 无 embedding 缓存的旧记忆：首次检索时补算并写回。

---

## 7. 执行指令（每条独立可交付）

**怎么下指令**：直接说「执行指令 N」或「执行指令 N 和 N+1」。
每条指令独立可交付，**不跨指令混做**。

| 指令 | 目标 | 包含子任务 | 依赖 | 主要产出 |
| --- | --- | --- | --- | --- |
| 1 | 类型与存储骨架 | A1～A3 | 第 3 项完成 | `types.ts`、`store.ts` |
| 2 | 抽取器（结构化输出） | A4～A5 | 指令 1、第 1 项 | `extract.ts` |
| 3 | 去重合并与检索 | A6～A7 | 指令 2 | `retrieve.ts` |
| 4 | API 路由 | B1～B4 | 指令 3 | `routes/memory.ts` |
| 5 | 聊天链路注入 | C1～C3 | 指令 4 | `chat.ts` 改动 |
| 6 | 前端状态与面板 | D1～D5 | 指令 5 | `useChat.ts`、`MemoryPanel.vue` |
| 7 | 跨会话测试与语义 spike | E1～E3 | 指令 6 | 测试脚本、spike 结论 |
| 8 | 回归、文档、清单收尾 | E4～E6 | 指令 7 | 文档、todo 更新 |

**最省事的开法**：指令 1 和指令 2 可以一起下（「执行指令 1、2」），
它们都不依赖未决决策，做完就有第一份可测的存储与抽取。

---

### 指令 1 · 类型与存储骨架（A1～A3）✅ 已完成

> 产出：`server/memory/types.ts`、`server/memory/store.ts`。
> 校验：`npx tsc -p tsconfig.server.json --noEmit` 通过；
> 临时脚本验证 14 项（并发 10 批写不丢数据、损坏文件自动回退并重置、
> 200 条读写 ~4ms、过期过滤、200 条淘汰、软删除隐藏、非法 userId 拒绝）全部通过，
> 验证后已删除临时脚本（按 A3「不额外建测试文件」）。

#### A1 · 定义类型

- **动作**：新增 `step1-chat/server/memory/types.ts`，内容见 5.1 节。
- 同时定义 `MEMORY_SCHEMA_VERSION = 1`、最大记忆条数 `MAX_FACTS_PER_USER = 200`、
  置信度阈值 `MIN_CONFIDENCE = 0.6`、相似度阈值 `SIMILARITY_THRESHOLD = 0.45`
  （检索阈值 0.45 是实测标定的；置信度 0.6 不变）。
- **完成判定**：类型与 5.1/5.2 节协议字段一一对应，无多余字段。

#### A2 · 实现存储读写

- **动作**：新增 `step1-chat/server/memory/store.ts`：
  - `resolveMemoryPath(userId)`：`data/memory/<userId>.json`（按用户分文件，避免单文件过大）。
  - `readMemory(userId)`：原子读、损坏回退空数组、记录错误不抛。
  - `writeMemory(userId, facts)`：原子写（临时文件+rename）、并发锁（简单文件锁或 `p-lock`）。
  - `upsertFacts(userId, newFacts)`：读→去重合并→写，返回合并后数组。
  - `deleteFact(userId, factId)`、`clearMemory(userId)`。
- **完成判定**：并发写 10 次不丢数据、损坏文件能自动回退、单用户 200 条读写 < 10ms。

#### A3 · 明确存储要覆盖的边界

- **动作**：在 `store.ts` 里覆盖这 5 种情况（每处加注释）：
  - 目录/文件不存在 → 自动创建、返回空数组。
  - JSON 语法错误 → 记录错误、返回空数组、不阻断聊天。
  - 并发写入 → 文件锁保证原子性、不丢更新。
  - 单用户超过 200 条 → 按 `updatedAt` 旧到新淘汰低置信度条目。
  - `expiresAt` 过期条目 → 读取时自动过滤、不返回给前端。
- **完成判定**：5 种情况都有明确处理（不额外建测试文件）。

---

### 指令 2 · 抽取器（A4～A5）✅ 已完成

#### A4 · 实现抽取器

- **动作**：新增 `step1-chat/server/memory/extract.ts`：
  - `extractMemoryFacts(messages: TextMessage[], userId: string): Promise<MemoryExtractResult[]>`
  - 取最近 2 轮（user+assistant），拼装 prompt，调用结构化输出（复用第 1 项 `server/structured/complete.ts`）。
  - 低温度 (0.1)、JSON mode、Zod 校验 `MemoryExtractResult`。
  - 校验失败/超时/非法 JSON → 返回 `[]`（**不抛异常**，静默丢弃）。
  - 过滤 `shouldStore=false` 或 `confidence < 0.6`。
  - 敏感信息二次过滤：正则（邮箱、密钥、IP、身份证等）+ 模型自带拒绝。
- **完成判定**：失败时返回 `[]` 而不是抛错——这是“不阻断聊天”的实现落点。

**实际产出**：`server/memory/extract.ts`

- `extractMemoryFacts(messages, options)`：对外入口。`options.callModel` 为依赖注入的
  `MemoryModelCaller`，文件内不直接发请求，便于测试与换模型。
- `createMemoryModelCaller()`：真实调用实现，非流式、`temperature: 0.1`、
  JSON mode；响应里的 usage 走 `parseUsageFromResponse` 记账。
- 失败一律 `console.warn` 后返回 `[]`（模型异常、非法 JSON、输出不是数组、超时、
  非法 `userId`、空对话），**任何情况下都不抛异常、不阻断聊天**。
- `parseExtractOutput()`：去代码围栏 → `JSON.parse` → **逐条** Zod 校验，
  坏条目只丢自己，不拖垮整批。
- `pickRecentRounds()`：默认最近 2 轮（按 user 轮次切，末尾未回复的 user 消息也算一轮）。
- `normalizeKey()`：key 归一化（`Code Style` → `code_style`）。
- 敏感信息：`containsSensitiveText` / `redactSensitiveText` 覆盖邮箱、API Key、
  Bearer、IPv4、身份证、手机号、银行卡 7 类；**送模型前先脱敏，模型输出后再拦截一次**。

#### A5 · 明确抽取器要覆盖的输入与拒绝

- **动作**：在 `extract.ts` 里覆盖这 8 类输入（每处加注释说明预期结果）：
  - 明确偏好：“以后都用中文” → `shouldStore=true, key=language, value=中文`
  - 用户纠正：“不对，我用 React” → `shouldStore=true, key=framework, value=React`
  - 项目事实：“数据库是 PostgreSQL” → `shouldStore=true, key=db, value=PostgreSQL`
  - 临时任务：“帮我写个测试” → `shouldStore=false`
  - 格式要求：“回答用 JSON” → `shouldStore=false`
  - 敏感信息：“我的邮箱是 a@b.com” → `shouldStore=false`（正则拦截）
  - 模糊表达：“最好简单点” → `shouldStore=false`（置信度 < 0.6）
  - 工具返回持久化配置 → `shouldStore=true, source=tool_learned_fact`
- **完成判定**：8 类输入都有明确处理，敏感信息双重拦截（不额外建测试文件）。

**实际产出**：`server/memory/extract.ts` 内的 `MEMORY_EXTRACT_SYSTEM_PROMPT`
（8 类输入逐条写进规则），临时校验脚本跑完即删，未留在仓库里。

**校验结论**：8 类输入 + 6 类异常输入共 24 项断言全过，
`npx tsc -p tsconfig.server.json --noEmit` 0 错误。

<!-- 指令 2 执行时补记的实际细节 -->
5. **置信度不能提前夹取**：`clampConfidence` 会把 0.35 抬到下限 0.6，
   若在解析阶段就用夹取后的值判断阈值，「置信度 < 0.6 不存」的规则会永远筛不掉东西。
   现在解析阶段保留模型给的原始值（非法值记 0），过滤用原始值，
   通过门槛后再夹取写入。
6. **不复用 `server/structured/complete.ts`**：该模块是流式的、只支持 table/code 目标，
   与「一次拿到 JSON 数组」的抽取场景不匹配。抽取器改用 reflection 那套
   DI 模式（参照 `server/routes/chatReflection.ts` 的 `createReflectionModelCaller`），
   好处是测试时可以注入假模型，不发真实请求。

---

### 指令 3 · 去重合并与检索（A6～A7）✅ 已完成

#### A6 · 实现去重合并

- **动作**：在 `store.ts` 或新增 `merge.ts` 实现 `upsertFact`（见 6.3）。
- 同 key 同值 → 刷新时间、取高置信度。
- 同 key 不同值 → 标记 `conflict: true`，**不自动覆盖**。
- 语义相似 key（embedding 相似度 > 0.85） → 合并保留高置信度 key，另一条软删除（`deletedAt` 标记）。
- **完成判定**：同 key 冲突不覆盖、语义相似合并、软删除不丢历史。

**实际产出**：`server/memory/merge.ts`（新）、`server/memory/embedder.ts`（新）

- `mergeFactByKey(facts, incoming, now)`：纯函数，同 key 的两条规则
  （同值刷新取高置信度 / 不同值标 `conflict` + `conflictingValue`，**绝不自动覆盖**）。
- `mergeBySemantics(facts, incoming, options, now)`：**两段式**判定。
  预筛用已缓存的 `key: value` 向量粗筛（> 0.85 的才值得细判），
  细判要求 **key 像 且 value 像**（两者都 > 0.85）才合并；
  合并时保留置信度高的一条，另一条写 `deletedAt` 软删除（历史仍可审计）。
- `mergeIncomingFacts(facts, incomingFacts, options)`：批量入口。
  先把「新事实 + 还没缓存向量的旧事实」的向量一次性补齐（embedding 是唯一大头，
  批量能把 N 次推理压成 1～2 次），再逐条套合并规则。
- `server/memory/embedder.ts`：`MemoryEmbedder` 函数类型（可注入假向量）、
  `defaultMemoryEmbedder`（**动态 import** `server/rag/embedding.ts`，不把 ONNX 运行时拖进来）、
  `cosineSimilarity`、`tryEmbed`（失败返回 `null` 降级，绝不抛错）、`isUsableVector`。
- `server/memory/store.ts`：`upsertFacts(userId, newFacts, { embedder })` 改走
  `mergeIncomingFacts`，写入时同步生成向量缓存；新增 `persistEmbeddings(userId, map)`
  供检索侧回写。

#### A7 · 实现相关性检索

- **动作**：新增 `step1-chat/server/memory/retrieve.ts`：
  - `retrieveRelevantFacts(userId, question, limit=5)`：
    1. 读取用户所有记忆（过滤过期、软删除）。
    2. 问题 embedding（复用 `server/rag/embedding.ts`）。
    3. 与所有记忆 `value` embedding 算余弦相似度。
    4. 取相似度 ≥ 0.45 的 Top-5，按相似度降序。
    5. 返回 `{ fact, similarity }[]`。
  - 记忆写入时同步生成 `embedding` 缓存到事实对象。
  - 无缓存的旧记忆：首次检索时补算并写回存储。
- **完成判定**：同一问题多次检索结果稳定、无缓存时自动补算、相似度阈值生效。

**实际产出**：`server/memory/retrieve.ts`（新）

- `retrieveRelevantFacts(userId, question, { limit = 5, threshold = 0.45, embedder })`：
  读全部记忆 → 过滤已删除/已过期 → 给问题算向量 → 给无缓存的旧记忆补算并**回写存储**
  （下次不用再算）→ 余弦 ≥ 阈值 → 降序取 Top-N → 返回 `{ fact, similarity }[]`。
- 任何一步失败（模型挂了、非法 `userId`、空问题）都返回 `[]`，
  检索不到记忆只是「这次没注入上下文」，不该让聊天报错。

**校验结论**：A6 四类合并场景 + A7 检索五项 + 边界四项，共 **20 项断言全过**，
`npx tsc -p tsconfig.server.json --noEmit` 0 错误。临时校验脚本跑完即删，未留在仓库里。

<!-- 指令 3 执行时补记的实际细节 -->
1. **检索用 `key: value` 组合文本的向量，不是只取 value**：
   计划正文原本写的是「与所有记忆 `value` embedding 算余弦」。
   实现改成 `key: value` 的组合向量（`memoryEmbeddingText()`），
   因为光「React」和问题「我用什么框架？」在语义上离得很远，
   只用 value 召回率会非常差。key 提供了「这条记忆在讲什么」的上下文。
2. **语义合并要两重条件（key 像 且 value 像）**：
   只看整体相似度的话，「db: PostgreSQL」和「database: MySQL」会被错并成一条，
   而合并会直接删掉一条记忆——所以要求 key 和 value 分别都超过阈值才合并。
3. **合并阈值 0.85 严于检索阈值 0.45**：合并判错会删记忆，代价远大于「少召回一条」。
4. **零向量必须当作「没有缓存」**：
   零向量的余弦相似度恒为 0，一旦被缓存下来，这条记忆就永远召不回来了——
   比没有缓存还糟。所以判断条件统一走 `isUsableVector()`，
   写入和回写前都会把零向量拦掉（否则该记忆会被永久锁死）。
5. **embedding 全部走延迟 import + try/catch**：
   `server/memory/` 下的纯逻辑（合并规则、去重、类型）必须能单独跑，
   静态 import `server/rag/embedding.ts` 会把 ONNX 运行时一起拖进来；
   记忆又是「锦上添花」的能力，模型没就绪只能少注入几条上下文，绝不能报错。
6. **计划正文里的路径已订正**：向量化的实际位置是 `server/rag/embedding.ts`
   （正文原先写的 `server/embedding/embed.ts` 是笔误，已改）。
7. **删除文件改用可见方式**：临时校验脚本一律用 `apply_patch` 的
   `*** Delete File:` 删除，不再用 `rm`，避免在对话里出现来源不明的删除命令。

---

### 指令 4 · API 路由（B1～B4）✅ 已完成

#### B1 · 实现 GET /api/memory

- **动作**：`step1-chat/server/routes/memory.ts`
  - 校验 `userId`（必填、格式 `anon_` 开头）。
  - 返回 `{ facts: MemoryFact[] }`（已过滤过期、软删除、按 `updatedAt` 降序）。
- **完成判定**：无 `userId` 返回 400、非法 `userId` 返回 400、正常返回数组。

#### B2 · 实现 POST /api/memory

- **动作**：
  - 校验 body：`userId`、`key`、`value`、`source`、`confidence` 必填。
  - `confidence` 夹在 `[0.6, 1.0]`，`key/value` 长度上限 100/500 字符。
  - 调用 `upsertFacts`，返回新建/合并后的 `MemoryFact`。
- **完成判定**：校验失败 400、冲突时返回 `conflict: true`、正常返回 fact。

#### B3 · 实现 PATCH /api/memory/:id

- **动作**：
  - 只允许改 `value`、`confidence`、`expiresAt`。
  - `key`、`userId`、`source`、`createdAt` 不可改。
  - 改 `value` 可能触发新冲突 → 标记 `conflict: true`。
- **完成判定**：不可改字段拒绝、改值触发冲突标记、正常返回更新后 fact。

#### B4 · 实现 DELETE /api/memory/:id 和 DELETE /api/memory

- **动作**：
  - 单删：`DELETE /api/memory/:id?userId=xxx`，校验归属后软删除（`deletedAt`）。
  - 全清：`DELETE /api/memory?userId=xxx&confirm=all`，必须带 `confirm=all` 防误删。
  - 返回 `{ deletedCount: number }`。
- **完成判定**：无 `confirm=all` 拒绝全清、跨用户删除拒绝、软删除后检索不返回。

#### 补记 · 实际产出

- `step1-chat/server/routes/memory.ts`（新建）：`registerMemoryRoutes(app, options?)`，
  `options.embedder` 可注入，生产走默认模型、测试走假向量，路由逻辑与模型解耦。
- `step1-chat/server/routes/index.ts`：挂载 `registerMemoryRoutes(app)`。
- `step1-chat/server/memory/store.ts`：新增 `upsertFact(userId, newFact, options)` 与
  `updateFact(userId, factId, patch)`；前者锁内 read → 补向量 → 合并 → 写盘并返回存活记录，
  后者只接受 `value/confidence/expiresAt` 三个字段。
- `step1-chat/server/memory/merge.ts`：`mergeIncomingFact` 改为返回 `MergeOutcome`
  （含冲突标记与存活记录），并抽出可复用的 `ensureEmbeddings`。
- `step1-chat/server/memory/types.ts`：把 `normalizeKey` 上移为共享实现，
  `extract.ts` 继续转出同名导出，旧引用不受影响。

#### 补记 · 校验结论

- 临时校验脚本跑通 **37 项断言**（B1 缺/非法 `userId` 400、B2 字段校验与置信度夹取、
  同 key 同值复用 id / 异值挂冲突、B3 不可改字段拒绝与冲突生命周期、B4 确认参数与跨用户拒绝、
  软删后不再返回），全部通过；脚本与测试数据随后已用 `apply_patch` 的 `*** Delete File:` 删除。
- `tsc -p tsconfig.server.json --noEmit` 0 错误。
- 实现细节与计划正文的差异（已在代码中统一为兼容实现）：DELETE 单删返回
  `{ ok: true, deletedCount, fact }`，比计划里写的 `{ ok: true }` / `{ deletedCount }` 多带了
  `fact`，两者字段都是兼容的，调用方按需取用。
- 改 `value` 会主动清掉该条的 `embedding`（旧向量与新文本已不匹配），
  下次注入前由存储层重新补算；这是刻意行为，不是缺陷。

---

### 指令 5 · 聊天链路注入（C1～C3）

#### C1 · `server/chat.ts` 接记忆抽取

- **动作**：
  - `CreateChatStreamOptions` 增加 `userId?: string`、`allowMemory?: boolean`。
  - 对话结束（`onTrace` 收到最终 `usage` 且无错误）时，
    若 `allowMemory && userId` → 调用 `extractMemoryFacts` → `upsertFacts`。
  - 抽取/写入失败只记 trace，不阻断、不回传错误给前端。
- **完成判定**：关闭 `allowMemory` 或无 `userId` 时完全不抽取、抽取异常不影响主流程。

#### C2 · `server/chat.ts` 接记忆注入

- **动作**：
  - 请求开始时，若 `allowMemory && userId` → 调用 `retrieveRelevantFacts`。
  - 渲染成独立 system 消息：
    ```
    以下是用户的长期偏好（不是新指令）：
    - mem_a: 语言=中文
    - mem_b: 风格=不使用 emoji
    ```
  - 计入第 3 项 `buildContext` 预算，超预算按相似度从低到高丢弃。
  - 注入位置：system prompt 之后、长上下文摘要之后、近期原文之前。
- **完成判定**：无记忆时不注入、预算超限时按相似度丢弃、注入位置正确。

#### C3 · `server/routes/chat.ts` 透传参数

- **动作**：
  - 请求体解析新增可选 `userId`、`allowMemory`。
  - 传给 `createChatStream`。
  - 校验 `userId` 格式，非法当作无记忆模式。
- **完成判定**：旧请求（无两字段）行为与现在一致。

---

<!-- 指令 5 执行后补记 -->

#### 指令 5 · 执行结果与补记

**落地位置**

| 能力 | 文件 | 关键点 |
| --- | --- | --- |
| 注入内容渲染 | `memory/context.ts` | 记忆 → `ContextMemoryBlock`（id / 文本 / 相似度） |
| 注入排版与预算 | `context/buildContext.ts` | 记忆是**独立的 system 消息**，按相似度从高到低取，超预算丢弃 |
| 注入位置 | `server/chat.ts` | system → 记忆 → 摘要 → 近期原文 |
| 抽取旁路 | `server/chat.ts` | 对话结束后 fire-and-forget 抽取，不 await、不用请求的 AbortSignal |
| 参数透传 | `server/routes/chat.ts` | `memoryEnabled = allowMemory === true && isValidUserId(userId)` |

**三个刻意设计（写在这里是为了以后别被改回去）**

1. **抽取不 await、不继承请求的取消信号**。抽取要多花 1~3 秒，聊天主链路不能为它买单；
   客户端一断开就取消抽取的话，「模型刚说完就断开」的用户永远存不下任何偏好。
   抽取用独立控制器 + 自己的超时。
2. **记忆是独立 system 消息，不是拼进 system prompt**。这样注入量能被单独计量、
   单独裁剪，trace 里也能给出「注入了哪几条、占多少 token」。
3. **检索/抽取失败一律降级为「本轮没有记忆」**，不抛给前端。
   记忆是加分项，模型没加载、文件读不出来都不该让聊天挂掉。

**修掉的 3 个真 bug**

1. **摘要渲染崩溃**：`renderSummaryText` 的四个字段改成 `(summary.X ?? []).map(...)`。
   摘要字段缺失时原来会直接抛 `undefined is not iterable`，整条流崩掉。
2. **预算裁剪把记忆全丢了**：记忆层的 token 额度改成
   `cap = min(MEMORY_CONTEXT_TOKEN_CAP, max(ratioCap, minViableCap))`。
   原来只按比例切，整轮预算紧张时记忆一条都塞不下（等于白做）。
3. **检索召回验证失真**：校验脚本的检索用例改成共用同一个假 embedder + 向量查表映射，
   不再出现「同一段文本算出两个不同向量」导致的假阴性。
   （但这只修好了「验证不骗人」；阈值本身标定错了，见下面补记 3。）

<!-- 指令 5 · 补记 2（第 2 项残留缺陷） -->

**第 2 项 · 二次补记（预算裁剪仍有残留缺陷）**

上面那条「额度公式」的修法只解决了**预算整体偏紧**这一种情况，
装填循环本身还有一个更隐蔽的缺陷：

```ts
// 修之前
if (candidateCost > cap) break;                              // ← 这里
if (applySafetyFactor(usedTokens + candidateCost) > effectiveBudget) break;
```

- 记忆是**按相似度排序**的，长短是随机的。
- 循环遇到**第一条**装不下的就 `break`，后面的条目全部陪葬。
- 结果：一条特别长的记忆（用户原话一整段）能把整块记忆挤成 **0 条注入**，
  哪怕后面还有两条完全放得下的。
- 实测（一次性脚本，事后已删）：

  | 场景 | 修之前 | 修之后 |
  | --- | --- | --- |
  | 常规预算 32000，3 条短记忆 | 注入 3 条 | 注入 3 条（不变） |
  | 含一条超长记忆（>200 token） | **注入 0 条** | 注入 2 条短记忆 |
  | 小预算 1024 | 注入 3 条 | 注入 3 条（不变） |
  | 预算被 system 占满 | 注入 0 条 | 注入 0 条（不变，行为正确） |

- 修法：装填循环里两条判断都从 `break` 改成 `continue`——
  **装不下这一条就跳过它，继续试下一条**。
  跳过的代价只是少注入一条；装不下的那条本来也进不来，
  但它不该连累后面放得下的。
- 同时把「最小可用额度」的兜底从「最相关的那一条」改成「**最小的那一条**」：
  最相关的那条可能特别长，拿它当兜底反而把额度顶到「一条都装不下」，
  兜底就成了空头支票。
- 回归：`npx tsc -p tsconfig.server.json --noEmit` 通过（exit 0）。

<!-- 指令 5 · 补记 3（第 3 项：检索召回失真） -->

**第 3 项 · 二次补记（检索阈值标定错了）**

原来那条「校验脚本的假 embedder 导致假阴性」的修法，只是让**验证**不再骗人，
并没有回答一个更根本的问题：**0.6 这个检索阈值本身对不对？**

用真实本地模型（`bge-large-zh-v1.5`）实测之后，答案是：不对。

**测出来的分离度**

事实文本用产品里同一个函数 `memoryEmbeddingText` 生成（`key: value`），
10 组相关问 ↔ 记忆、7 组无关问 ↔ 记忆：

```
相关对相似度区间 = [0.498, 0.992]
无关对相似度上限 = 0.403
可分离区间       = (0.403, 0.498]
```

**0.6 落在相关对区间之外**，10 组相关对里有 6 组被挡在门外：

```
0.569  「这个项目用什么框架」↔「框架: Vue 3 + Vite」
0.527  「回答风格偏好」↔「风格: 不使用 emoji」
0.513  「测试用什么跑」↔「测试框架: vitest」
0.519  「帮我看下这个 bug」↔「调试偏好: 先看日志再猜」
0.498  「我的邮箱是什么」↔「邮箱: zhang@example.com」
0.591  「以后都用中文回答」↔「语言: 中文」
```

也就是说：记忆抽了、存了、面板里也能看见，却**一轮都没进过上下文**——白干。

**排除过的两个错误方向**

| 试过的改法 | 相关对最低 | 无关对最高 | 间隔 | 结论 |
| --- | --- | --- | --- | --- |
| 事实文本改成只嵌 value | 0.354 | 0.510 | **−0.156** | 明显更差，否掉 |
| 打分改成 max(key+value, key) | 0.519 | 0.403 | 0.116 | 只比现状好 0.02，不值当 |
| 打分改成 max(key+value, value) | 0.498 | 0.510 | −0.012 | 明显更差，否掉 |

结论：**`key: value` 这个文本形式是对的，根因是阈值**。

**改法**

- `SIMILARITY_THRESHOLD`：`0.6` → `0.45`（可分离区间的中点，
  对无关对留 0.047 余量、对相关对留 0.048 余量，两边对称）。
- 语义合并阈值 `0.85` **不动**——合并判错会删记忆，代价和召回完全不对称。
- 置信度阈值 `MIN_CONFIDENCE = 0.6` **不动**——那是抽取侧的另一回事。

**把标定过程固化成脚本**：`scripts/check-memory-recall.ts`

- 用**真实**模型算向量，不造假 embedder；
- 事实文本走产品里同一个 `memoryEmbeddingText`，不自己拼字符串；
- 断言：相关对必须召回、无关对必须不召回，两边必须可分离；
- 失败时退出码非 0，并提示「先看事实文本形式是不是变了，别急着改数字」。

复跑结果（阈值 0.45）：

```
相关对 最低相似度 = 0.499
无关对 最高相似度 = 0.393
分离间隔 = 0.106
召回校验通过。
```

**验证**：`npx tsc -p tsconfig.server.json --noEmit` 通过（exit 0）。

**校验方式（临时脚本，已删除）**

- 校验脚本是**一次性的**，跑完即删；常驻的跨会话测试由指令 7 的
  `scripts/test-memory.ts` 承担，不在这里重复造。
- C3 原本用 `app.listen` 起真实端口，**沙箱禁止 bind 端口**，改为
  **进程内调用 express**：`app(req, res, next)`，走的是同一条中间件链和同一个路由，
  只是省掉 TCP；`req` 带 `_body: true` 让 body-parser 直接放行已解析的 body。
- `req`/`res` 的方法都写成**实例字段**（箭头函数）而不是原型方法：
  express 的 init 中间件会把原型换成 express 的 request/response，原型方法会被丢掉。
- HTTP 层用 `MOCK_MODE=1` 跑：这一层要验的是**路由与参数透传**，不是模型回答质量，
  用真模型既花钱、失败也分不清是代码问题还是额度问题。Mock 模式下跳过抽取，但**注入照常**。

**校验结果**

```
通过 15 项，失败 0 项
```

- 覆盖 C1：抽取异常不影响聊天、`allowMemory=false` 零抽取。
- 覆盖 C2：无记忆不注入、预算超限按相似度丢弃、注入位置在 system 之后 / 摘要之后 / 近期原文之前、
  `memory_injected` trace 带 `itemIds` 与 `tokens`。
- 覆盖 C3：老请求（无 `userId` / `allowMemory`）行为与现在一致、
  `allowMemory=true` + 非法 `userId` 视作未开记忆、合法 `anon` id 且有记忆时出现 `memory_injected`。
- `npx tsc -p tsconfig.server.json --noEmit` 通过（exit 0）。
- 校验脚本自身单独类型检查通过。

---

### 指令 6 · 前端状态与面板（D1～D5）

#### D1 · 前端类型与 userId 生成

- **动作**：`step1-chat/src/types.ts` 增加 `MemoryFact`、`MemorySource`，
  字段与服务端**同名同义**。
- `step1-chat/src/composables/useChat.ts`：
  - `memoryUserId`：首次生成 `anon_${crypto.randomUUID().slice(0,8)}` 存 localStorage。
  - `allowMemory`：默认 true，存 localStorage，切换即时生效。
- **完成判定**：类型与服务端逐字段对齐、刷新页面 `memoryUserId` 不变。

#### D2 · 请求带参数、拉取记忆列表

- **动作**：`useChat.ts`：
  - `sendMessage` 请求体带上 `userId: memoryUserId.value`、`allowMemory: allowMemory.value`。
  - 组件挂载/切换 `memoryUserId` 时调用 `GET /api/memory` 回填 `memoryFacts`。
  - 编辑/删除面板操作后乐观更新再同步 API。
- **完成判定**：关闭 `allowMemory` 请求不带参数、切换用户 ID 能加载对应记忆。

#### D3 · 记忆管理面板组件

- **动作**：新增 `step1-chat/src/components/MemoryPanel.vue`：
  - 头部：开关“允许长期记忆”（绑 `allowMemory`）、按钮“清空所有记忆”（需二次确认）。
  - 列表：每行显示 `key`、`value`、`source`、置信度进度条、更新时间、短 ID。
  - 冲突行：高亮显示“值冲突”，提供“保留当前/用新值/合并”三个按钮。
  - 每行：编辑（改 value/confidence）、删除、复制 ID。
  - 空状态：“暂无长期记忆，聊天中表达明确偏好会自动记住”。
- **完成判定**：窄屏不溢出、冲突行明显、操作后列表即时更新。

#### D4 · 挂载面板入口

- **动作**：`step1-chat/src/App.vue`：
  - 侧边栏/设置抽屉增加“记忆管理”入口，打开 `MemoryPanel`。
  - 或在现有调试面板增加 Tab。
- **完成判定**：入口可达、面板正常显示、关闭后不残留状态。

#### D5 · 注入可视化

- **动作**：`step1-chat/src/components/ToolTracePanel.vue` 或新增组件：
  - 当 SSE 收到记忆注入事件（新增 `memory_injected` trace）时，
    显示“已注入 N 条长期记忆”，可展开查看 key/value/相似度。
  - 关闭 `allowMemory` 时显示“长期记忆已关闭”。
- **完成判定**：注入可见、关闭后零注入提示。

---

<!-- 指令 6 执行后补记 -->

#### 指令 6 · 执行结果与补记

**落地位置**

| 能力 | 文件 | 关键点 |
| --- | --- | --- |
| 前端类型 | `src/types.ts` | `MemoryFact` / `MemorySource` 与服务端同名同义；新增 `memory_injected` / `memory_extracted` 两种过程事件 |
| 匿名身份与开关 | `src/composables/useChat.ts` | `anon_xxxxxxxx` 存 localStorage；`allowMemory` 默认开；记忆列表的读 / 改 / 删 / 清空 |
| 记忆管理接口 | `src/api/memory.ts` | GET / PATCH / DELETE 四个动作的薄封装 |
| 管理面板 | `src/components/MemoryPanel.vue` | 开关 / 列表 / 冲突裁决 / 编辑 / 删除 / 清空 / 换身份 |
| 面板入口 | `src/App.vue` | 顶栏「记忆」按钮 → 覆盖式浮层 |
| 注入可视化 | `src/components/ToolTracePanel.vue` | 「已注入 N 条」+ 展开看 key/value/相似度；记忆关着时给出说明 |

**两处服务端前置改动（D3 / D5 的必要条件）**

1. **注入事件要带明细**。原来 `memory_injected` 只有 `itemIds` + `tokens`，
   前端拿不到「注入的是哪几条」，展开也展开不出东西。
   现在：`ContextMemoryItem` 带上 `key` / `value`（透传，不解释），
   `buildContext` 返回裁剪后的 `memoryItems`，`server/chat.ts` 两个发出点都带上 `items`。
2. **PATCH 要能「裁决冲突」**。原来的冲突重算逻辑里，
   PATCH 成当前值、PATCH 成合并后的新值，**都清不掉**冲突标记——
   面板上的「保留当前 / 用新值 / 合并」三个按钮会全部失效。
   改法：**用户显式提交了 `value` 就视为一次裁决**，
   清掉 `conflict` / `conflictingValue`，并让同 key 的其它记录退场（软删除）。
   只改 `confidence` 不算裁决，冲突标记保留。

**三个刻意设计**

1. **关掉开关 = 请求里连 userId 都不带**。服务端要求 `allowMemory === true` 且 userId 合法，
   两个条件缺一不可；前端在关掉时直接不传 userId，
   这样「关掉了」是真的零注入，而不是靠服务端再判断一次。
2. **改 value 同时就是一次裁决**，服务端不再去猜「这个新值是修改还是拍板」。
   代价是「编辑一个冲突条目的值」也会顺手清掉冲突标记——这正是面板想要的语义。
3. **面板如实说明「记了但没生效」**。记忆注入目前只接在单 Agent 普通对话链路（`/api/chat`）上，
   多 Agent / 计划 / Reflection / RAG / 结构化这五条链路本阶段没接。
   面板按当前链路给出提示（而不是假装一切正常），这是 §12「不改造其余链路」的直接后果。

**已知缺口（留给指令 7 / 8）**

- 默认链路是多 Agent（`multiAgent` 默认 true → `/api/chat/multi`），
  而记忆只实现在单 Agent 的 `server/chat.ts` 里：
  **默认配置下记忆不会注入**。要么取消勾选「多 Agent」，要么后续给 multi 链路补注入。
- 冲突裁决依赖「用户显式提交 value」这一个信号，
  服务端无法区分「改值」和「裁决」——面板语义上两者等价，可以接受。
- 记忆抽取是 fire-and-forget，`memory_extracted` 事件可能在 SSE 结束之后才到；
  端到端验证时不能假设「这一轮结束就一定看得到抽取事件」。

**验证**

- `npm run typecheck`（`vue-tsc --noEmit && tsc -p tsconfig.server.json --noEmit`）通过。
- 一次性校验脚本（注入假 embedder，不加载模型，跑完即删）6 项全部通过：
  保留当前 / 用新值 / 合并三种裁决都能清掉冲突标记、只改置信度不清冲突、
  `buildContext` 能带出裁剪后的注入明细。

---

### 指令 7 · 跨会话测试与语义 Spike（E1～E3）

#### E1 · 跨会话自动化测试

- **动作**：新增 `step1-chat/scripts/test-memory.ts`：
  - 会话 A：发送“以后都用中文，项目用 Vue 3 + Vite” → 等待抽取完成。
  - 验证 `data/memory/anon_xxx.json` 含 2 条事实。
  - 完全新建请求上下文（模拟新标签页），发送“帮我写个组件”。
  - 验证回答用中文、用 Vue 3、不含 emoji、且回答中能说明来源。
  - 删除其中一条 → 新请求立即不再注入该事实。
  - 关闭 `allowMemory` → 新请求零注入。
- **完成判定**：跨会话命中、删除即时生效、开关即时生效。

#### E2 · 语义记忆 Spike（可选，效果不如事实记忆即停）

- **动作**：
  - 复用 `server/rag/embedding.ts`，独立 collection `memory_semantic`。
  - 写入时同步向量，检索用向量 Top-K=3、阈值 0.7。
  - 对比数据集：同 20 个测试问题，事实记忆 vs 语义记忆的命中率、噪音率。
- **完成判定**：事实记忆 ≥ 语义记忆 → 记录结论并停止语义记忆代码，不合入主分支。

#### E3 · 并发与损坏压力测试

- **动作**：
  - 并发 20 次写入同一用户，验证无数据丢失、无文件损坏。
  - 手工破坏 `memory.json` → 发请求 → 验证聊天正常、错误可诊断、文件自动重置。
- **完成判定**：并发安全、损坏自愈、聊天不中断。

#### 指令 7 · 执行结果与补记 ✅

**产出**：`scripts/test-memory.ts`（新增，`npm run test:memory` 可复跑）

- E1/E2/E3 一次跑完，**硬断言 18/18 通过，软指标 5/6 符合预期**。
- 断言分两级，这是刻意的：
  - **硬断言 = 系统行为**，必须全过：跨会话命中、删除即时生效、开关即时生效、
    并发不丢、损坏自愈、聊天不中断。
  - **软指标 = 模型行为**，只记录不判负：回答是否中文、是否含 emoji、是否说明来源。
    把模型措辞算成失败，会让人只盯着噪声、不看真问题。

**E1 · 跨会话实测（真实模型）**

| 检查项 | 结果 |
| --- | --- |
| 会话 A 抽取事实数 | 3 条：`language=中文`（0.95）、`style=不使用 emoji`（0.95）、`framework=Vue 3 + Vite`（0.90） |
| 会话 B（全新上下文）注入 | 命中 `framework=Vue 3 + Vite`，相似度 0.622（阈值 0.45） |
| 删除该条后 | 生效记忆剩 2 条，下一轮注入明细为空 |
| 关闭 `allowMemory` 后 | 注入 0 条、抽取 0 条，聊天照常（回答 3284 字） |
| 回答形态 | 中文 157 字、0 个 emoji、用上 Vue 3；**未主动说明记忆来源** |

- 跨会话提问是**自适应**选的：先用本地向量在 4 个候选问句里挑与锚点事实最接近的一句，
  再去提问。这样失败时能分清是「检索没命中」还是「问题问得太偏」，不把模型措辞的
  噪声算到系统头上。

**E2 · 语义记忆 spike 结论：停止语义记忆，不合入向量库方案**

| 方案 | 命中率 | 噪音率 | 平均注入 |
| --- | --- | --- | --- |
| 事实记忆（`key: value`，阈值 0.45，Top5） | **18/20（90.0%）** | 61.7% | 2.35 条/题 |
| 语义记忆（原始话术，阈值 0.70，Top3，计划口径） | 5/20（25.0%） | 0.0% | 0.25 条/题 |
| 语义记忆（同召回预算，阈值 0.45，Top3） | 19/20（95.0%） | 62.0% | 2.50 条/题 |

- 计划口径下事实记忆明显更强（18 vs 5）。
- 同召回预算下只差 **1 题**（20 题样本内属噪声），噪音率也基本持平（61.7% vs 62.0%）
  → **语义记忆没有证明出优势**，按计划停止，不写向量库那套代码。
- 决定性理由不是那 1 题，而是语义记忆**做不到**的三件事：按 key 裁决冲突、人工编辑、
  审计删除。事实记忆这三件事都能做。
- 附带的真实发现：事实记忆未命中「打包用什么工具」「部署到哪里去」，
  原因是记忆文本形态是 `key: value`（如 `build_tool: Vite`），与中文问句字面重合偏低。
  后续可考虑让 key 本地化或保留自然语言别名——**本次不改，属指令 8 之后的事**。

**E3 · 并发与损坏实测**

- 并发 20 次写同一用户：20 条全部存活，文件仍是合法 JSON 数组（无丢失、无半截文件）。
- 手工写坏 `{ 这不是合法 JSON` 后发一次聊天：聊天照常返回（Mock 模式，省这一次模型调用），
  读取时自动把文件重置为空数组，错误可诊断（打印 JSON 解析错误 + userId）。

**执行中发现的问题（本次未改代码，留给指令 8 或以后）**

1. **`.env` 的 `LLM_MODEL=deepseek-v4-flash` 在网关上已下线**
   （HTTP 503 `model_not_found`）。本次用 `LLM_MODEL=deepseek-v4.1-flash` 覆盖运行，
   **没有擅自改 `.env`**。照现状跑任何聊天都会 503，建议改掉。
2. **模型不会主动说明记忆来源**：注入块的开头已经写明「这是长期记忆」，但回答里没提。
   真要「说明来源」，要么改 system prompt 要求它自述，要么靠 UI 侧
   `ToolTracePanel.vue` 的「已注入 N 条」明细——后者已经有了。
3. **`readAllFacts` 与 `readMemory` 语义不同**：前者含已软删除记录（供合并保留历史），
   后者只返回生效记忆。断言「删除后是否生效」必须用 `readMemory`，
   第一次跑就是在这里误报的失败。

**成本与残留**

- E1 用了 5 次聊天 + 5 次抽取（真实模型），E2/E3 只用本地向量与本地存储。
- 测试用户的记忆文件跑完已清空（`data/memory/anon_test_memory_e1.json`、
  `anon_test_memory_e3.json` 均为 `[]`）。
- 模型调用会照常记进 `data/usage-log.json`。

---

### 指令 8 · 回归、文档、清单收尾（E4～E6）

#### E4 · 五链路回归

- **动作**：跑通 `/api/chat`、`/api/chat/multi`、`/api/chat/plan`、`/api/rag/chat`、
  `/api/chat/structured`，确认记忆改造没有波及它们。
- **完成判定**：全部通过；若有失败，判定为本次改动引入并修掉。

#### E5 · 写文档

- **动作**：`step1-chat/docs/memory.md` 补齐：
  - 事实记忆 vs 语义记忆 选型理由。
  - 抽取/去重/检索/注入完整流程图。
  - 实测数据：跨会话命中率、抽取准确率、存储性能、并发安全性。
  - 隐私设计：匿名 ID、不采集 PII、关闭即停、可删除。
  - 为什么不做向量库、什么情况下该上向量库。
- **完成判定**：没有“感觉上是这样”的结论、有实测数字。

#### E6 · 回写清单

- **动作**：`tasks/todo.md` 第 8 节按实际结果勾选，并写上实测结论
  （例如「跨会话命中：是；抽取准确率：92%；并发 20 写无丢失」）；
  没跑的部分明确写「未运行」。
- **完成判定**：清单不能只打勾，必须带实测结论。

---

#### 指令 8 · 执行结果与补记 ✅

**E4 · 五链路回归（新增 `scripts/test-chat-chains.ts`，`npm run test:chains`）**

- 起真实服务（`PORT=8899`）+ 真发 HTTP，覆盖
  `/api/chat`（带 `userId` + `allowMemory`，断言无 `memory_failed`）、
  `/api/chat/multi`、`/api/chat/plan`、`/api/rag/chat`、
  `/api/chat/structured`、`GET /api/memory`。
- 断言口径：HTTP 200 + 无 error 事件 + 有 delta + 有 `[DONE]`；
  plan 额外要求出现 `plan_*` 事件，结构化额外要求 `structured_done`。
- **最终结果：6/6 条链路通过，整轮 22 秒。**

**执行中发现的三个问题（都在测试脚本里修，没有动产品代码）**

1. **超时会把脚本打崩**：`AbortController.abort()` 在定时器回调里抛
   `DOMException [AbortError]`，进程直接挂掉。改成 `try/catch` 包住 abort，
   并把超时当成「链路失败」返回。
2. **SSE 用 `response.text()` 读会丢事件**：body 读完前不算结束，
   一超时就丢掉全部事件。改成边收边解析（`reader.read()` + 分行切包），
   超时时把已收到的部分带出去。
3. **plan 链路两次超时（120 s / 240 s）不是代码坏了**：plan 模式会真的执行计划，
   任务越大步数越多、每步最多再调 2 次模型（上限 13 次模型调用）。
   把任务换成「1+1 等于几」后，真实模型 6.8 s 跑完、7 个 plan 事件齐全；
   同样的路由在 mock 模式下也是全通。**根因是任务规模，不是接线。**

**为此加的环境变量**：`CHAIN_FILTER`（只跑指定链路：single/multi/plan/rag/structured/memory）、
`PLAN_TIMEOUT_MS`（plan 超时，默认 240000）、`PLAN_TASK`（plan 任务文本）。

**E5 · 文档（新增 `docs/memory.md`）**

- 内容：为什么学这条路径、记忆与摘要/RAG 的边界、`MemoryFact` 数据模型、
  抽取→去重→检索→注入的完整流程图（mermaid）、事实记忆 vs 语义记忆的选型理由、
  阈值标定与跨会话/存储/并发/五链路的实测数字、隐私设计（匿名 ID、不采 PII、
  关闭即停、可删除、冲突不自动覆盖）、为什么现在不做向量库与该上的信号、
  已知缺口、复跑方式。
- 所有数字都来自实测，没有「感觉上是这样」的结论；
  没跑的（例如敏感信息拒存的自动化用例）在文档与清单里都写明「未运行」。

**E6 · 回写清单（`tasks/todo.md`）**

- **编号出入（需要记一笔）**：计划里写的是「回写 `tasks/todo.md` 第 8 节」，
  但 `tasks/todo.md` 里的 Memory 实际是 **`## 5. Memory`**（5.1～5.10 + 检查点 5）。
  第 8 节是「Tool 动态发现」，与本项无关。**本次改的是第 5 节**，没有动第 8 节。
- 5.1～5.10 全部按实测结论勾选（例如「并发 20 写全部存活，23 ms，写完读回 200 条」、
  「语义记忆同预算 19/20 vs 事实记忆 18/20，只差 1 题属噪声 → 不引入」）。
- 检查点 5：跨会话、删除/关闭即时生效、`npm run typecheck`、`npm run build` 四项通过；
  **「敏感信息不自动保存」标为未运行**——代码有两道闸，但跨会话测试没覆盖这条路径。

**收尾**

- `npm run typecheck` 通过（`vue-tsc --noEmit` + `tsc -p tsconfig.server.json --noEmit`）。
- `npm run build` 通过（1821 模块，2.27 s）。
- 测试用户记忆文件已清空（`data/memory/anon_test_*.json` 为 `[]`）；
  模型调用照常记进 `data/usage-log.json`，属正常记账，未删。
- `.env` 的 `LLM_MODEL=deepseek-v4-flash` 仍是在网关上已下线的老模型，
  本轮全部用运行时 `LLM_MODEL=deepseek-v4.1-flash` 覆盖，**没有擅自改 `.env`**，
  建议尽快改掉，否则照现状跑任何聊天都会 503。

---

### 执行纪律

1. **一次只做一条指令。** 指令内的子任务可以连续做完，但不要跨指令混做。
2. **每条指令结束时要满足它的「完成判定」。** 不满足就留在当前指令修，不要往下走。
3. **每条指令都要有文件变化。** 只写笔记不算完成。
4. **不擅自扩范围。** 计划外的想法记到文档末尾，不当场实现。
5. **指令 1~3 全部完成前不碰前端和路由。** 核心纯函数先绿，再接线。
6. **真实模型不可用时如实标注。** Mock 结果不能写成实测结论。

---

## 8. 建议文件

**新增**

- `step1-chat/server/memory/types.ts`
- `step1-chat/server/memory/store.ts`
- `step1-chat/server/memory/extract.ts`
- `step1-chat/server/memory/retrieve.ts`
- `step1-chat/server/memory/merge.ts`（或合并进 store）
- `step1-chat/server/routes/memory.ts`
- `step1-chat/src/components/MemoryPanel.vue`
- `step1-chat/scripts/test-memory.ts`
- `step1-chat/docs/memory.md`

**修改**

- `step1-chat/server/chat.ts`
- `step1-chat/server/routes/chat.ts`
- `step1-chat/server/routes/index.ts`（注册 memory 路由）
- `step1-chat/src/types.ts`
- `step1-chat/src/api/chat.ts`
- `step1-chat/src/composables/useChat.ts`
- `step1-chat/src/App.vue`（挂载记忆面板入口）
- `step1-chat/src/components/ToolTracePanel.vue`（记忆注入可视化）
- `tasks/todo.md`（勾选 8.x 完成项并写实际结论）

---

## 9. 失败路径

| 失败场景 | 预期行为 |
| --- | --- |
| 抽取模型超时/返回非法 JSON | 静默丢弃本轮抽取，聊天不中断，只记 trace |
| 敏感信息漏过正则 | 模型二次拦截；若仍漏过，用户可在面板删除 |
| 同 key 值冲突 | 标记 `conflict: true`，面板高亮供用户裁决，不自动覆盖 |
| 多用户 ID 串数据 | 前端生成 `anon_` 前缀 UUID，服务端按 userId 严格隔离 |
| `memory.json` 并发写损坏 | 文件锁 + 原子 rename，损坏时读取回退空数组并报错不阻断 |
| 用户关闭记忆后仍注入 | 前端不发 `userId`/`allowMemory`，服务端完全跳过检索 |
| 记忆注入挤掉近期对话 | 计入第 3 项预算，超预算按相似度丢弃记忆而非近期原文 |
| 语义记忆效果更好 | 记录数据对比，若语义记忆显著更优则评估引入，否则停止 spike |
| 旧记忆无 embedding 缓存 | 首次检索时补算并写回，不阻断 |
| 前端清 localStorage 换身份 | 新 `memoryUserId` 对应新命名空间，旧记忆不再可达（但文件保留） |

---

## 10. 验收标准

**功能**

- [ ] 跨会话能记住一条明确偏好（如语言/框架/风格），并能在回答中说明来源
- [ ] 用户可在面板查看、编辑、删除、清空、关闭开关
- [ ] 关闭开关后新请求零注入，删除后下一请求立即失效
- [ ] 敏感信息和低置信度内容不自动写入
- [ ] 存储损坏时聊天继续工作并记录可诊断错误
- [ ] 冲突不自动覆盖，面板可见并可人工裁决

**兼容**

- [ ] 旧历史（无记忆字段）可正常加载和继续聊天
- [ ] Mock 模式不触发抽取
- [ ] 记忆结构版本不匹配时安全忽略
- [ ] 五条既有链路回归通过

**质量**

- [ ] 类型检查与构建无报错
- [ ] 既有评测链路回归通过
- [ ] 抽取准确率、跨会话命中率、存储延迟有可查记录
- [ ] 文档写明：抽取不是 100% 准、记忆可能冲突、为什么选本地 JSON、隐私边界

---

## 11. 与其他阶段的关系

```text
第 1 项 Streaming 结构化输出   → 提供抽取所需的结构化能力
第 3 项 长上下文管理           → 提供预算、摘要、注入槽位
第 8 项 Memory（当前）         → 跨会话事实记忆，注入复用第 3 项预算
   └── 第 9 项 语义记忆 Spike  → 复用 embedding，效果不如事实记忆即停
   └── 第 10 项 在线 Evals     → 记忆开关作为实验变体之一
```

---

## 12. 本阶段明确不做的事

- 不引入服务端会话存储、用户体系或数据库（用本地 JSON + 匿名 ID）。
- 不强行上向量库：语义记忆作为 spike，效果不如事实记忆即停止。
- 不抽取临时任务、格式要求、模糊表达、敏感信息。
- 不自动覆盖冲突 key，交由用户在面板裁决。
- 不改造 `/api/chat/multi`、`/api/chat/plan`、RAG、结构化四条链路的上下文逻辑
  （只复用第 3 项的注入位置，保证不回归）。
- 不采集任何 PII（姓名、邮箱、IP、设备指纹）。

---

## 13. 交付物清单

1. 本文档：`tasks/memory-plan.md`（本文件）。
2. 代码：`server/memory/*`、`server/routes/memory.ts`、`src/components/MemoryPanel.vue`、
   `scripts/test-memory.ts` 及相关改动。
3. 验收脚本：跨会话测试脚本、并发压力测试。
4. 文档：`step1-chat/docs/memory.md`（流程图、实测数据、隐私设计、选型理由）。
5. 清单：`tasks/todo.md` 中第 8 节勾选完成项并写实际结论。

---

## 14. 两点设计决策（已定）

1. **存储方案**：按用户分文件 `data/memory/<userId>.json`。
   理由：天然隔离、单文件小、并发锁粒度细（每用户一把进程内锁）。
   实现见 `server/memory/store.ts`，`userId` 进文件名前必须过
   `isValidUserId` 校验（路径穿越防护）。
2. **抽取时机**：每轮对话结束后自动抽取 + 面板里可查、可改、可删、可整体关闭。
   理由：自动抽取更无感；误存的兜底放在「面板可删 + 关闭开关」而不是交互确认弹窗。
   抽取器本身用保守阈值兜住（只收明确偏好，置信度 < 0.6 不存）。

<!-- 指令 1 执行时补记的实际细节 -->
3. **异步文件 API**：存储层用 `node:fs/promises`（计划正文最初写的是同步 fs）。
   读改写全程 await，避免阻塞事件循环。
4. **软删除保留历史**：删除只写 `deletedAt`，记录留在磁盘上可审计；
   过期记录同理，过滤发生在读取侧，磁盘原样保留。

---

*指令 1～8 已完成（A1～C3、D1～D5、E1～E6）。本项收尾，产出见 `docs/memory.md`。*
