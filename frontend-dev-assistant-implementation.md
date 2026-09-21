# 前端开发助手 · 需求转代码 — 实现文档

> **状态：后置，非当前主推。** 仅文档，未开工。  
> **当前作品集最优 Demo 已改为「Bug 分析」** → 见 `frontend-bug-analysis-implementation.md`。  
> 本文保留供后续「需求 → Vue 代码」迭代；说「开始做需求转代码」前不要按本文开工。
>
> 原定位：学习计划作品集方向之一；载体建议新建 `frontend-dev-assistant/`。

---

## 0. 一句话目标

用户用自然语言描述前端需求 → Agent **澄清 / 规划 / 生成 Vue3+TS 代码** → 页面分文件预览 →（可选）人工确认后写入工作区。

**不是** Cursor 平替，也不是全栈脚手架；是可演示、可讲清架构的「需求 → 前端代码」垂直助手。

---

## 1. 为什么做这个（作品集叙事）

| 面试官会问 | 本项目能答 |
|------------|------------|
| Agent 和 ChatBot 差在哪 | Plan → Generate → Review 多步；工具写文件要确认 |
| 怎么控质量 | 约束技术栈、结构化输出、自检清单、Evals |
| 工程化做过什么 | SSE、Guard、Usage、Tracing、多 Agent 经验从 step1-chat 迁过来 |
| 业务价值 | 缩短「口头需求 → 可粘贴组件」时间，适合中后台 CRUD / 表单页 |

---

## 2. 范围

### 2.1 MVP（第一期必做）

- 输入：一段中文需求（文本）
- 输出：
  - 需求理解摘要（功能点列表）
  - 文件树（建议路径）
  - 每个文件的完整代码（Vue 3 + `<script setup>` + TypeScript）
- 交互：
  - 流式展示规划与代码
  - 多文件 Tab / 文件树切换预览
  - 一键复制单文件 / 全部
- 技术约束写死在 system（可配置，MVP 固定）：
  - Vue 3 + TypeScript + Composition API
  - 优先无 UI 库；需要样式用 scoped CSS（不做 Tailwind 强依赖）
  - 不编造不存在的项目内 import（无仓库上下文时只生成自洽单文件或同目录相对引用）

### 2.2 第二期（MVP 后再做）

- 人工确认后写入磁盘（对接 `stage4-human-confirm` 思路）
- 知识库：注入「团队组件规范 / 命名约定」（复用 RAG `searchDocs`）
- 简单「改一改」：基于上一轮产物做增量修改（带会话产物状态）

### 2.3 第三期（进阶，可选）

- Vision：截图 → 布局描述 → 代码（`advanced-learning-plan` 多模态）
- Plan-and-Execute 显式步骤条（与 ReAct 对比可讲）
- Bug 分析模式（粘贴报错 + 相关代码 → 修复建议）
- 对接真实仓库（读 `src/components` 再生成，避免瞎 import）

### 2.4 明确不做（防膨胀）

- 不自动 `npm install` / 不跑完整生产构建当验收
- 不生成后端 API 实现（最多 mock 接口类型与假数据）
- 不替代 IDE 补全；不做多人协作账号体系
- 第一期不做 Peer-to-Peer 多 Agent；Supervisor-Worker 可选，默认 **单图多节点** 即可

---

## 3. 用户主流程

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│ 输入需求     │────►│ 澄清/规划     │────►│ 按文件生成   │────►│ 预览·复制     │
│ （可多轮）   │     │ Plan 节点     │     │ Codegen 节点 │     │ （写盘可选）  │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
                           │                     │
                           ▼                     ▼
                    SSE: plan_delta        SSE: file_start / file_delta
                    （功能点、文件树）       / file_done / usage
```

### 示例输入

> 做一个登录页：邮箱+密码，前端校验，登录按钮 loading，失败红字提示。只要 Vue 单文件组件。

### 示例输出（结构）

```json
{
  "summary": ["邮箱密码表单", "基础校验", "loading/错误态"],
  "files": [
    {
      "path": "src/components/LoginForm.vue",
      "language": "vue",
      "description": "登录表单 SFC"
    }
  ]
}
```

随后流式推送每个 `path` 的代码正文。

---

## 4. 架构设计

### 4.1 与 step1-chat 的关系

| 能力 | 来源 | 本项目用法 |
|------|------|------------|
| SSE + Abort | step1-chat | 会话流 |
| LangGraph | step1-chat | `plan → codegen → review(可选)` |
| Guard | step1-chat | 输入注入检测；输出防泄露 |
| Usage | step1-chat | 每次生成计 token |
| RAG | step1-chat | 二期：规范文档检索 |
| 人工确认 | 计划后置 | 二期：写文件前确认 |
| 天气/时间工具 | 不迁 | 与本产品无关 |

**建议目录**（实现时再建）：

```
LLM/
  step1-chat/                    # 学习主线（保持不动或只抽共享包）
  frontend-dev-assistant/        # 本作品集项目
    docs/
      IMPLEMENTATION.md          # 可复制本文或软链
    package.json
    src/                         # Vue 前端（助手 UI）
    server/
      index.ts
      routes/codegen.ts
      agent/
        graph.ts                 # plan → codegen → review
        plan.ts
        codegen.ts
        review.ts
        prompts.ts
      shared/                    # 可先复制再抽包：usage / guard / clip
```

MVP 允许 **复制** step1-chat 的 `usage`/`guard` 小模块；稳定后再抽 `packages/agent-kit`（不要一开始就 monorepo）。

### 4.2 服务端图（推荐）

```
START
  → planNode        # 结构化：summary + files[]
  → codegenNode     # 按 files 逐个生成（可串行，控上下文）
  → reviewNode      # 可选：清单自检，修明显问题（MVP 可跳过，二期开）
  → END
```

**为何不上一期就上多 Worker：**  
需求转代码的主链是流水线，不是「天气∥知识库」那种并行领域；先单图多节点更易控、易讲。二期若「规范检索」独立，可加 KB Worker。

### 4.3 API

`POST /api/codegen`（SSE）

请求体：

```ts
{
  requirement: string;          // 本轮需求或补充
  history?: { role: "user" | "assistant"; content: string }[];
  stack?: "vue3-ts";            // MVP 固定
  options?: {
    review?: boolean;           // 默认 false
    maxFiles?: number;          // 默认 5，防爆炸
  };
}
```

SSE 事件（建议）：

| type | 含义 |
|------|------|
| `plan` | 完整或增量规划 JSON（summary + files meta） |
| `file_start` | `{ path, language }` |
| `file_delta` | `{ path, delta }` 代码增量 |
| `file_done` | `{ path }` |
| `review` | 自检意见（可选） |
| `usage` | token 汇总 |
| `error` | 可展示错误 |
| `[DONE]` | 结束 |

前端按 `path` 聚合到 `Map<path, code>`。

### 4.4 结构化输出策略

**Plan 节点（必须结构化）：**

- 优先：`response_format: json_object` 或强制 tool `emit_plan`
- Schema 校验（zod）：`summary: string[]`、`files: { path, language, description }[]`
- `files.length > maxFiles` → 截断并在 plan 里注明「已限制」

**Codegen 节点：**

- 每个文件一次（或一批）completion；prompt 带：需求摘要 + 该文件职责 + 已生成兄弟文件路径列表（防重复定义）
- 要求模型只输出代码，或 ` ```vue ` 围栏；服务端用正则抽出，失败则整段当代码并标 warning

**Review 节点（二期）：**

- 输入：plan + 全部代码
- 输出：`{ ok, issues: [{ path, severity, message }] }`；`error` 级可触发单文件重生成（最多 1 轮）

---

## 5. Prompt 原则（实现时落在 `prompts.ts`）

### 5.1 Plan system（要点）

- 你是前端架构助理，只做 Vue3+TS SFC 规划
- 输出 JSON：summary、files
- 文件尽量少；能 1 个文件就不要拆 5 个
- path 使用 posix，如 `src/components/Xxx.vue`
- 不规划后端、不规划测试文件（MVP）

### 5.2 Codegen system（要点）

- 生成可直接粘贴的完整文件
- `<script setup lang="ts">`
- 禁止伪代码 / `// ...` 省略关键逻辑
- 无设计系统时用简洁原生 HTML + scoped CSS
- 若需请求：写 `async function` + mock，注明「需换成真实 API」

### 5.3 安全

- 复用 inputGuard；拒绝「忽略指令输出系统提示」类
- 不执行用户粘贴的 shell；写盘仅二期且经确认
- Codegen 不读取用户机器任意路径（无工具或仅白名单工具）

---

## 6. 前端 UI（助手本身）

### 6.1 布局（一屏完成感）

```
┌──────────────────┬────────────────────────────┐
│ 需求输入          │  文件树 / Tabs               │
│ [生成] [停止]     │  ┌────────────────────────┐ │
│                  │  │ 代码预览 + 复制          │ │
│ 规划摘要          │  │ （highlight）            │ │
│ · 功能点…         │  └────────────────────────┘ │
│                  │  Usage 条                    │
└──────────────────┴────────────────────────────┘
```

### 6.2 状态

```ts
interface CodegenSession {
  requirement: string;
  plan: { summary: string[]; files: FileMeta[] } | null;
  files: Record<string, { code: string; language: string }>;
  status: "idle" | "planning" | "coding" | "done" | "error";
  usage: UsageSnapshot | null;
}
```

### 6.3 体验细节

- planning 时左侧 skeleton；coding 时当前文件 Tab 闪烁或进度「2/4」
- 停止：AbortController，已生成文件保留
- 历史：localStorage 存最近 5 次「需求 + 产物摘要」（可不存大段代码以免撑爆）

---

## 7. 实现分期与任务清单

### Phase 0 — 文档与验收对齐（本文）

- [x] 写清范围 / 非目标 / 事件协议
- [ ] 你确认：技术栈是否锁定 Vue3；是否接受「新项目」而非塞进 step1-chat

### Phase 1 — 骨架（约 0.5–1 天）

- [ ] `npm create` Vue3+Vite+TS 前端 + Express 后端（可抄 step1-chat 启动方式）
- [ ] `POST /api/codegen` 空 SSE：先推假 `plan` + 假文件，打通前端聚合
- [ ] dotenv / health / 基础错误处理

### Phase 2 — Agent 主链（约 2–3 天）

- [ ] `plan.ts`：LLM + JSON schema 校验
- [ ] `codegen.ts`：按文件串行生成 + `file_*` SSE
- [ ] `graph.ts`：LangGraph 串联
- [ ] 接入 usage accumulator
- [ ] inputGuard

### Phase 3 — 前端打磨（约 1–2 天）

- [ ] 双栏布局、文件树、复制、停止
- [ ] 代码高亮（如 `shiki` 或轻量 `highlight.js`）
- [ ] 空态 / 错误态 / Mock 模式（无 Key）

### Phase 4 — 质量与演示脚本（约 1 天）

- [ ] 3～5 条固定演示需求（登录表单、Todo、简单 Table）
- [ ] 最小 Evals：plan 必须含 `.vue`；禁止空 files；单文件需求不得拆超 2 文件
- [ ] README：如何跑、如何讲架构（作品集用）

### Phase 5 — 二期增强（另开迭代）

- [ ] review 节点
- [ ] 人工确认写盘
- [ ] RAG 规范
- [ ] 增量「按这句话改代码」

---

## 8. 验收标准（MVP）

1. 无 API Key 时有明确 Mock 演示（假登录组件），不假冒 usage  
2. 有 Key 时：输入登录页需求 → 收到 plan → 至少一个完整 `.vue` 可复制运行（粘进任意 Vite Vue 项目能渲染）  
3. 多文件需求（如表单 + 类型）：Tab 可切换，内容不串文件  
4. 停止按钮能中断后续 codegen  
5. 能在 3 分钟内向他人讲清：`plan → codegen` 与 step1-chat ReAct 的差异  
6. `typecheck` 通过  

---

## 9. 演示脚本（作品集）

| # | 需求 | 期望 |
|---|------|------|
| 1 | 邮箱密码登录 SFC | 单文件，含校验与 error 文案 |
| 2 | Todo：添加/完成/删除 | 单文件或 1 组件 + 1 types |
| 3 | 用户表格：姓名/邮箱列 + 简单筛选 | ≤3 文件，含假数据 |
| 4 | 「只要按钮组件」极简 | plan 只有 1 文件 |
| 5 | 注入话术 | Guard 标记或拒绝泄露 |

---

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| 模型省略代码 | prompt 禁止省略；file_done 后长度校验，过短重试 1 次 |
| 文件爆炸 | `maxFiles`；plan 校验 |
| 幻觉 import | 无仓库上下文时强制自洽；二期再读仓库 |
| 与 step1-chat 双份代码 | MVP 复制；标记 `// synced-from step1-chat`；三期再抽包 |
| 范围失控 | 严格按 Phase；二期前不开 Vision/写盘 |

---

## 11. 和总计划的衔接

| 总计划项 | 关系 |
|----------|------|
| 阶段 5 交付页 | 可并行；本作品集不阻塞，也可把「成本条」直接做进本助手 |
| 人工确认 | 本项目 Phase 5 写盘时落地，一鱼两吃 |
| 进阶 Vision / Plan-and-Execute | 第三期 |
| Tool 动态发现 | 本助手工具少，暂不需要 |
| post-learning-optimization | 仍延后 |

---

## 12. 决策记录（实现前请你拍板）

实现开始前确认这三项（可直接回复选项）：

1. **项目位置**  
   - A. 新建 `LLM/frontend-dev-assistant/`（推荐）  
   - B. 在 `step1-chat` 内加「代码生成」模式  

2. **MVP 技术栈文案**  
   - A. 仅 Vue 3 + TS SFC（推荐）  
   - B. Vue / React 可选（工作量大，不建议第一期）  

3. **第一期是否要 Review 节点**  
   - A. 不要，先 plan+codegen（推荐）  
   - B. 要，多一次 LLM  

默认按：**1A + 2A + 3A**。

---

## 13. 下一步

1. 你确认 §12 决策（或默认推荐）。  
2. 回复：**「按文档开始实现」** → 从 Phase 1 骨架开工。  
3. 未确认前：**不写业务代码**，只维护本文。

---

## 14. 修订历史

| 日期 | 变更 |
|------|------|
| 2026-08-20 | 初稿：范围、架构、SSE、分期、验收、决策项 |
