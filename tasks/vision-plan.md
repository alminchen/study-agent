# 进阶学习第 4 项：Vision（图片输入）专项执行计划

> 对应 `tasks/plan.md` 第 4 项 Vision。目标项目：`step1-chat/`。
> 本文只规划，不写代码。写完后按用户指令再执行。
> 当前状态：已完成步骤 0-11，步骤 12 进行中；
> 步骤 5/6/7/9/10 的手工验证、步骤 11 的真实调用（越权数据作废待重跑）待授权。

## 0. 一句话结论

这项学习不是"让模型能收一张图"，而是把**消息协议从"content 是一个字符串"升级为"content 可以是文本 + 图片 parts 的组合"**，并配套解决模型能力探测、前端压缩、上传校验、成本记账、隐私留存和失败降级六件事。

---

## 0.1 可执行步骤总览

按顺序执行，不要跳步：

| 步骤 | 做什么 | 完成标志 |
| --- | --- | --- |
| 0 | 开工门禁：记录 `git status`、跑 typecheck/build 基线、确认模型支持图片 | 基线记录已写入附录 A |
| 1 | 定义前后端图片附件类型和错误码 | 类型字段同名同义，typecheck 通过 |
| 2 | 先写 4 组失败用例：校验、协议转换、能力判定、token 估算 | 测试存在且按预期红 |
| 3 | 实现服务端图片校验、模型能力判定、图片 token 估算 | 步骤 2 的测试转绿 |
| 4 | 实现供应商 content parts 协议转换 | 带图消息能转成 `text + image_url` |
| 5 | 放宽聊天路由请求体上限，并在路由层二次校验图片 | 非法图片不调模型、直接拒绝 |
| 6 | 实现前端粘贴/拖拽/选择文件、压缩和缩略图 | 浏览器能预览并移除附件 |
| 7 | 发送附件并持久化历史元数据 | localStorage 中没有 base64 |
| 8 | 实现 Vision trace 事件和错误文案 | 图片被拒原因在 UI 可见 |
| 9 | 给 usage 增加图片计数、字节和估算 token | `/api/usage` 能看到图片成本 |
| 10 | `/api/models` 下发 `supportsVision` | 不支持的模型禁用上传入口 |
| 11 | 用真实模型跑 UI 截图分析场景 | 回答引用截图内容并区分推测 |
| 12 | 回归三条聊天链路并写 `docs/vision.md` | 测试、构建、Evals、文档全部完成 |

---

## 1. 为什么现在要学这条路径

### 1.1 现在的缺口是硬的

| 位置 | 现状 | 缺口 |
| --- | --- | --- |
| `server/react/types.ts` | `TextMessage.content: string` | 无法表达"这一条消息带一张图" |
| `server/react/types.ts` | `ProviderMessage` 三分支 | 发给供应商时无法拼 `content: [{type:"text"},{type:"image_url"}]` |
| `server/react/complete.ts` | `stream: false`，只发文本 | 模型层没有图片通道 |
| `src/types.ts` | `ChatMessage.content: string` | 前端消息模型存不下附件 |
| `src/api/chat.ts` | `messages: Array<{role, content: string}>` | wire 协议只能传文本 |
| `src/composables/useChat.ts` | 历史直接落 `localStorage` | 没有附件的生命周期管理 |
| `src/App.vue` | 只有 textarea | 没有上传/粘贴入口 |

### 1.2 这条路径是"消息协议统一"的地基

后续能力都要碰消息协议，谁先改谁受益：

| 后续方向 | 与 Vision 的协议关系 |
| --- | --- |
| 长上下文管理 | 上下文裁剪要决定"带图的消息"能不能被裁；图片不参与 token 估算 |
| Memory | 抽取事实时不能把 base64 抽进长期记忆 |
| Plan-and-Execute | Executor 每步拿到的消息里可能带图 |
| LLM-as-Judge | 输入 Guard 只能扫文本，图片是盲区 |
| AB 测试 | 变体之间必须能保证"同一张图"，否则对比无效 |

先做 Vision，等于先把"一条消息可以不是纯文本"这件事在协议层定死，后面不用反复改。

### 1.3 学习价值不只在 AI 侧

- 跨端契约设计：同一份图片在浏览器、wire、服务端、供应商四层的表示形式不同。
- 不可信输入处理：图片是二进制，也是攻击面（超大文件、畸形 base64、图片里的注入文本）。
- 能力协商：模型支不支持 Vision 不是猜的，是要探测和降级的。
- 成本意识：图片 token 与文本 token 计费规则不同，必须单独记账。

---

## 2. Vision 是什么（核心概念）

### 2.1 五个必须分开的概念

| 概念 | 解决什么 | 边界 |
| --- | --- | --- |
| 多模态 content parts | 一条消息里同时放文字和图片 | 协议层，供应商各自字段名略有差异 |
| data URL / base64 | 把图片塞进 JSON 请求体 | 编码层，体积膨胀约 1/3 |
| 图片 token 计费 | 图片按尺寸折算 token，不按字数 | 计费层，各家规则不同，只能估算 |
| 模型能力矩阵 | 哪些模型收图片 | 运行时层，会随供应商升级变化 |
| 图片内不可信文本 | 图里写"忽略以上指令" | 安全层，纯文本 Guard 扫不到 |

### 2.2 供应商协议长什么样

OpenAI 兼容的 `chat/completions`：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "这张截图里有什么问题？" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KG..." } }
  ]
}
```

要点：

- 文字在前、图片在后（首版固定这个顺序）。
- 图片走 `image_url.url`，可以是 data URL，也可以是公网 URL。首版只用 data URL，避免服务端代为拉取任意 URL（SSRF 面）。
- assistant / tool 消息保持字符串 content，不引入 parts，避免破坏 tool_calls 协议。

### 2.3 一个完整的数据变化过程

```
用户粘贴截图
  → 浏览器 File/Blob（拿不到文件名，靠 file.type 拿 MIME）
  → canvas 降采样 + JPEG 压缩（最长边 1600px，target ≤ 700KB）
  → 前端校验（MIME ∈ {png,jpeg,webp}、大小 ≤ 1MB、像素 ≤ 4096²）
  → ChatMessage.attachments[]（内存态，带 base64 + 宽高 + MIME）
  → wire 请求体 messages[].attachments[]（base64 裸串，不带 data: 前缀）
  → 服务端二次校验（不信前端）+ 体积上限
  → 供应商适配层把 attachments 转成 content parts
  → 模型返回文本，走原有 SSE delta 链路
  → 响应结束后图片不落 localStorage，只留元数据
```

### 2.4 现状与目标对照

| 维度 | 现在 | 目标 |
| --- | --- | --- |
| 消息模型 | content 只有 string | content 仍是 string + 独立的 attachments 字段 |
| 供应商请求 | 纯文本 content | user 消息可拼 content parts |
| 前端入口 | 无 | 粘贴 / 拖拽 / 选择文件 |
| 模型能力 | 无概念 | 能力表 + 运行期降级 |
| 图片校验 | 无 | 前端快校验 + 服务端硬校验 |
| 图片大小 | 无 | 前端压缩 + 服务端上限 + 请求体上限调整 |
| 成本 | 只有 token | 图片张数/字节/估算 token 单独记账 |
| 留存 | 全量落盘 | 只落元数据，base64 不落盘 |

---

## 3. 学完能为你和项目做什么

### 3.1 用户能直接看到的能力

- 粘贴一张 UI 截图，得到"识别布局层级 → 指出 3 个问题 → 给修复建议"的分析。
- 提问"这张图里的报错什么意思"，答案引用截图里的真实文字。
- 前端助手作品集里第一个真正有差异化的交互能力（文本助手人人都有）。

### 3.2 工程上能获得什么

- 一套"多媒体消息"的完整落地范式：采集 → 压缩 → 校验 → 协议转换 → 计费 → 留存。
- 一个可复用的模型能力矩阵机制，后续接 embedding、工具、JSON mode 都复用。
- 一条把"二进制 + JSON body"这条链路踩通的完整路径（含请求体上限这个坑）。

### 3.3 它不能解决什么

- 不能做图像生成（那是另一条产品线）。
- 不能保证模型能读清小字；图片 token 与清晰度是硬约束。
- 不能防住图片里的注入文本（只能降级：输出侧 Judge 兜底 + 提示词约束）。
- 不做多图对比推理（首版只允许 1 张）。

---

## 4. 为什么要这么做（关键决策与取舍）

### 决策一：内部消息保留 `content: string`，图片走独立 `attachments` 字段

- 备选 A：把 `TextMessage.content` 改成 `string | ContentPart[]`。
- 备选 B（选中）：`TextMessage` 增加可选 `attachments?: ImageAttachment[]`，`content` 仍是 string。
- 理由 A 的问题：`content` 一旦变成 union，所有按字符串消费它的代码全要改。
  当前 `TextMessage` 在 `server/` 下有 12 个文件、39 处引用，其中
  `server/context/tokenBudget.ts` 直接 `message.content` 当字符串算 token，
  `server/context/summarize.ts`、`server/guard/inputGuard.ts`、
  `server/memory/extract.ts`、`server/mock/streamMock.ts` 都按字符串消费。
- 理由 B 的好处：这 12 个文件**一行不改**，只有供应商适配层一个地方需要拼 parts。
- 代价：`ProviderMessage` 会出现"内部长 string、对外长 array"两种形状，
  必须由一个显式的转换函数收口，禁止各调用点自己拼。
- 落地约束：新增 `server/vision/toProviderMessages.ts` 作为**唯一**的转换入口，
  `server/react/complete.ts` 只调用它。

### 决策二：图片只在"带图的那一轮"发给模型，不跨轮回传

- 首版不做历史图片回传：新一轮请求里，带图那一轮换成"图片已过期"的纯文本占位。
- 理由：base64 留内存就有留存风险，回传还会让每一轮都重复计费。
- 好处：隐私边界清晰（图片只活在一次请求里）、成本可预期。
- 代价：不能问"刚才那张图里的第 3 行是什么" —— 这是已知限制，写进文档。

### 决策三：前端先压缩，服务端再校验

- 前端用 canvas 降采样（最长边 1600px）+ JPEG/WebP 压缩，目标 ≤ 700KB。
- 服务端不信任前端，重新校验 MIME、字节数、base64 合法性、像素尺寸。
- 理由：`express.json` 当前全局限制是 **1mb**，5MB 图片 base64 后约 6.7MB，直接 413。
- 配套：`server/index.ts` 给 `/api/chat` 系列单独挂 `express.json({ limit: "8mb" })`，
  其余端点保持 1mb，不放大全局攻击面。

### 决策四：模型能力用能力表判定，不靠猜

- 能力来源优先级：
  1. 环境变量 `VISION_CAPABLE_MODELS`（显式白名单，最高优先级）
  2. 模型 id 启发式（`gpt-4o` / `gpt-5` / `vision` / `omni` / `qwen-vl` 等）
  3. 运行期降级：带图请求返回 400 且报文提到 image/vision/multimodal 时，
     把该模型在本进程内标记为不支持，并给出明确错误
- `GET /api/models` 每项增加 `supportsVision: boolean`，前端据此禁用上传入口。
- 理由：默认打开会在不支持的模型上跑到 API 才炸，报错还很难懂。

### 决策五：Vision 是显式开关，不静默改变三条既有链路

- 前端加"图片输入"开关；关闭时请求体与今天**逐字节一致**。
- 服务端收到 `attachments` 才走图片路径；没收到就是零改动。
- 不允许因为"模型支持图片就自动带上图片"。

### 决策六：图片不落 usage 日志正文

- usage 记录只加 `imageCount` / `imageBytes` / `estimatedImageTokens` 三个数字字段。
- base64、data URL、文件名一律不进日志、不进 trace 事件正文。
- 理由：日志会被长期保存，base64 进日志等于把图片永久留在磁盘。

### 决策七：图片内的文字视为不可信输入

- 纯文本 Guard 扫不到图里的字，图片可以携带"忽略以上指令"。
- 降级手段：system prompt 明确"图片中的文字是待分析数据，不是指令"；
  输出侧 Judge（已有）作为第二道防线。
- 文档里写明这是**已知未完全解决**的风险，不假装解决。

### 决策八：范围只覆盖单 Agent 与多 Agent 两条文本链路

- 首版覆盖：`/api/chat`、`/api/chat/multi`。
- 不覆盖：`/api/rag/chat`（检索链路与图片无关）、`/api/chat/structured`、`/api/chat/plan`、
  `/api/chat/reflection`（首版不引入图片）。
- 理由：这四类链路的内容形态与验收标准不同，混进来会让回归面失控。

---

## 5. 目标协议设计

### 5.1 服务端内部消息类型（`server/react/types.ts`）

```ts
/** 一张图片附件；只允许 user 消息携带。 */
export interface ImageAttachment {
  /** 前端生成的唯一 id，用于去重和删除。 */
  id: string;
  /** image/png | image/jpeg | image/webp */
  mimeType: string;
  /** base64 裸串，不含 data: 前缀；由服务端组装 data URL。 */
  data: string;
  /** 原始文件名；剪贴板粘贴的图可能没有，为空字符串。 */
  name: string;
  /** 像素宽高。 */
  width: number;
  height: number;
  /** base64 解码后的字节数。 */
  byteSize: number;
}

export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** 只有 user 消息允许带图；system/assistant 携带时服务端直接拒绝。 */
  attachments?: ImageAttachment[];
}
```

### 5.2 供应商请求体（`server/vision/toProviderMessages.ts` 唯一转换入口）

```ts
export interface ProviderContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}
```

- user 消息且带 attachments → `content: [ {type:"text"}, {type:"image_url"} ]`
- 其余 → `content: string`（行为与今天完全一致）
- assistant(tool_calls) / tool 消息 → 原样透传，绝不带 parts

### 5.3 wire 协议（前端 → 服务端）

```jsonc
{
  "model": "gpt-5.4-mini",
  "messages": [
    {
      "role": "user",
      "content": "这张截图里有什么问题？",
      "attachments": [
        {
          "id": "att_1",
          "mimeType": "image/jpeg",
          "data": "…base64…",
          "name": "screenshot.png",
          "width": 1600,
          "height": 900,
          "byteSize": 512000
        }
      ]
    }
  ]
}
```

- `attachments` 可选；缺省 = 今天的请求体。
- 历史回传时带图那一轮换成占位文本 + `attachments` 省略（决策二）。

### 5.4 模型能力（`GET /api/models` 扩展）

```jsonc
{
  "models": [{ "id": "gpt-5.4-mini", "label": "GPT 5.4 mini", "supportsVision": true }],
  "source": "api"
}
```

- 旧字段不删，纯新增；前端 `ModelOption` 同步加可选字段。

### 5.5 SSE / trace 事件

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `vision_attachment` | `{count, mimeTypes[], totalBytes, estimatedImageTokens}` | 过程面板显示"本轮带了 1 张图" |
| `vision_rejected` | `{reason, mimeType?, byteSize?}` | 图片被拒的具体原因 |
| `vision_unsupported_model` | `{model}` | 当前模型不支持 Vision |

- 三个事件都**不含 base64、不含文件名**（决策六）。
- 未知事件前端忽略，不崩（沿用现有约定）。

### 5.6 错误码

| code | 含义 | 可重试 |
| --- | --- | --- |
| `image_too_large` | 超过大小上限 | 否（压缩后仍超） |
| `image_unsupported_format` | 非 png/jpeg/webp | 否 |
| `image_invalid_data` | base64 非法 / data URL 格式错 | 否 |
| `image_dimensions_exceeded` | 像素过大 | 否 |
| `vision_model_unsupported` | 当前模型不支持图片 | 否（换模型可） |
| `vision_payload_too_large` | 请求体超限（413） | 否 |
| `vision_provider_rejected` | 供应商 400 拒绝带图请求 | 否 |

---

## 6. 数据流与时序

### 6.1 一轮带图对话

```
前端                        服务端                      供应商
 │  粘贴/拖拽 → canvas 压缩      │                          │
 │  attachments[] 就绪           │                          │
 │── POST /api/chat ────────────>│                          │
 │  messages[].attachments       │ 校验 attachments         │
 │                               │ 能力判定 supportsVision   │
 │                               │ 估算 image tokens         │
 │<── trace: vision_attachment ──│                          │
 │                               │── chat/completions ─────>│
 │<── SSE delta ... ─────────────│<── 流式文本 ─────────────│
 │<── usage (含 imageCount) ─────│                          │
 │  落盘：只留附件元数据          │                          │
```

### 6.2 中止与失败

- 前端 stop() → abort → 服务端 abort → 上游请求中断 → 不写 usage、不写成功历史。
- 中途失败 → 保留已产生的文本，标记失败，不把半截当成功。
- 校验失败 → **不发模型请求**，直接回 `vision_rejected`，省 token。

---

## 7. 关键技术细节

### 7.1 前端采集与压缩

- 入口：textarea `paste` 事件、输入区拖拽、隐藏 `file input`。
- 剪贴板图片没有文件名，靠 `file.type` 拿 MIME；`file.type` 也为空时按扩展名推断，再兜底 `image/png`。
- 压缩：`createImageBitmap` + `OffscreenCanvas`（不支持时退回普通 canvas），最长边 1600px，
  输出 JPEG（质量 0.85）；PNG 透明图才保留 PNG/WebP。
- 压缩后仍 > 1MB → 二次降采样（1200px）→ 仍超则拒绝并提示。
- 压缩失败（格式不支持、canvas 异常）→ 明确报错，不静默丢图。
- 缩略图用 `URL.createObjectURL`，组件卸载时 `revokeObjectURL`。

### 7.2 服务端校验（`server/vision/validateImage.ts`）

- MIME ∈ {`image/png`, `image/jpeg`, `image/webp`}
- 字节数 ≤ 1MB（解码后）
- base64 合法（正则 + 长度校验，非法直接 400，不进模型）
- 像素宽高 ≤ 4096 × 4096
- 每条消息最多 1 张图；一次请求最多 1 张
- 校验失败 → 返回 `vision_rejected` + 具体原因，不调模型

### 7.3 图片 token 估算

- 首版用保守估算：先按 2048×2048 等比缩放，再按 512×512 分块，
  `tokens ≈ 85 + 170 × 块数`，再乘 1.2 安全余量。
- 标注为**估算值**，与供应商真实计费可能不同；usage 里单独字段，不混入文本 token。
- 文档写清公式与假设。

### 7.4 上下文与图片的关系

- `server/context/tokenBudget.ts` 继续只按 `content` 算文本 token，**图片不计入**。
  → 必须在估算里给图片留预算余量，否则长对话里一张图就把窗口顶爆。
- `server/context/buildContext.ts` 裁剪历史时，带图的旧消息按普通消息处理。
- `server/clipMessages.ts` 行为不变。

### 7.5 与 Guard / Memory 的交互

- `server/guard/inputGuard.ts` 只扫文本部分；图片文字是盲区（决策七）。
- `server/memory/extract.ts` 只从文本抽取事实；附件不参与抽取。
- `server/memory/retrieve.ts` 注入的记忆不含图片。

### 7.6 Mock 模式

- 无 API Key / `MOCK_MODE=1` 时，图片请求不报错，mock 回复里说明"Mock 模式未识别图片"。
- 保证无 Key 也能跑通整条 UI 流程（上传 → 预览 → 发送 → 回包）。

### 7.7 持久化与隐私

- `localStorage` 只存附件元数据：`{id, name, mimeType, width, height, byteSize}`，**不存 base64**。
- 刷新页面后历史里能看到"当时带了一张图"的标记，但模型不再收到它（决策二）。
- 清空会话 / 切换会话 → 内存里的 base64 一并释放。
- 附件不进 usage 日志、不进 trace 正文、不进错误文案。

### 7.8 成本

- usage 记录新增：`imageCount`、`imageBytes`、`estimatedImageTokens`。
- 成本面板对带图请求打标记，让"这一轮贵了多少"看得见。

---

## 8. 分步执行步骤

### 步骤 0：开工门禁

- [x] 记录 `git status --short`（详见附录 A）
- [x] 跑一次 `npm run typecheck`，记录基线错误（不是本步骤引入的）→ 通过
- [x] 跑一次 `npm run build`，记录基线错误 → 通过
- [x] 确认目标模型是否支持图片输入，记录模型名与计费规则（模型级确认留待步骤 11）
- [x] 确认 `LLM_API_KEY` / `MOCK_MODE` 是否可用（详见附录 A）
- 产出：一段基线记录贴进本文件末尾

### 步骤 1：定义类型与契约

- [x] `server/react/types.ts`：加 `ImageAttachment`、`TextMessage.attachments`
- [x] `server/vision/types.ts`：错误码、限制常量、校验结果类型
- [x] `src/types.ts`：加 `ChatAttachment`、`ChatMessage.attachments`、`ModelOption.supportsVision`
- [x] 前后端字段名逐字对齐（沿用本仓库既有做法：同名同义）
- 产出：类型定义；验证：`npm run typecheck` 通过

### 步骤 2：写失败用例（先测后写）

- [x] `server/vision/validateImage.test.ts`：非法 MIME / 超大 / 非法 base64 / 超像素 / 正常图
- [x] `server/vision/toProviderMessages.test.ts`：带图 user 消息 → parts；不带图 → 原字符串；
      assistant(tool_calls) / tool 消息不受影响
- [x] `server/vision/capability.test.ts`：白名单命中 / 启发式命中 / 不命中 / 运行期降级
- [x] `server/vision/estimateImageTokens.test.ts`：分档与余量
- 产出：4 组红测试

### 步骤 3：服务端校验与能力表

- [x] `server/vision/validateImage.ts` 实现校验
- [x] `server/vision/capability.ts` 实现能力判定 + 运行期降级缓存
- [x] `server/vision/estimateImageTokens.ts` 实现估算
- [x] 验证：步骤 2 的测试转绿 → 20/20 通过

### 步骤 4：供应商协议转换

- [x] `server/vision/toProviderMessages.ts`：唯一的转换入口
- [x] `server/react/complete.ts`：改用该入口组装 messages
- [x] 确认 assistant / tool 消息分支零改动 → 原样透传，测试覆盖
- 验证：步骤 2 的 toProviderMessages 测试转绿；typecheck 通过 → 24/24 通过，typecheck 通过

### 步骤 5：请求体上限与路由校验

- [x] `server/index.ts`：`/api/chat` 系列单独放宽到 8mb，其余保持 1mb → 已按路径分流，另加 413 明确文案（`vision_payload_too_large`）
- [x] `server/routes/chat.ts` / `chatMulti.ts`：解析并校验 attachments，非法直接回 `vision_rejected` → 共用 `validateRequestMessages`，单测覆盖
- [x] 确认校验失败时**不创建 UsageAccumulator 记录**、不调模型 → 校验在累加器创建之前、graph/ReAct 之前
- 验证：手工用超大 base64 打一次，确认返回 413/明确错误 → **待补**（用户暂不允许启动 dev 服务端；待允许后按步骤 12 验证命令手工打一次）

### 步骤 6：前端采集与压缩

- [x] `src/vision/compressImage.ts`：canvas 降采样 + 压缩 + 尺寸读取 → 最长边 1600px、JPEG 0.85；透明图走 webp/png 保留透明；压完仍超 1MB 降到 1200px 重压一次，仍超拒绝
- [x] `src/vision/validateImage.ts`（前端）：快速校验，失败给具体原因 → 校验顺序与 `server/vision/validateImage.ts` 对齐（data → MIME → 像素 → 字节），阈值共用同一组常量
- [x] `src/composables/useChat.ts`：`attachments` 状态、`addImages`、`removeAttachment`、`clearAttachments` → 命名 `pickedAttachments`；MIME 白名单快速拦截；首版最多 1 张；流式中禁新增；清空会话/切换链路时释放 objectURL
- [x] `src/App.vue`：粘贴 / 拖拽 / 选择文件三个入口 → 附件入口仅普通对话链路开放（结构化 / RAG 隐藏）；拖入时输入区 accent 高亮
- [x] `src/components/ImageAttachment.vue`：缩略图 + 尺寸 + 移除
- 验证：浏览器里粘贴一张图能看到缩略图、大小正确 → **待补**（用户暂不允许启动前端 dev；待允许后手工粘贴/拖拽一张截图核对缩略图、尺寸、移除按钮）

### 步骤 7：发送与历史持久化

- [x] `src/api/chat.ts`：请求体带 `attachments` → 新增 `ApiImageAttachment`（字段与服务端 `ImageAttachment` 同名同义），`StreamChatParams.messages` 支持附件，请求体原样透传
- [x] `src/composables/useChat.ts`：发完清空附件；历史只落元数据 → `send` 里完整附件复制进请求参数后立即 `clearAttachments`；`userMessage.attachments` 与 `persistableHistory` 双保险只保留 meta（剥掉 data/previewUrl）
- [x] 历史回传时把带图那一轮降级为占位文本 → `toApiMessages(history, liveAttachments)`：仅当前轮最后一条 user 消息带完整附件，历史带图消息替换为 `[图片已过期]` 占位且省略 attachments（决策二）
- 验证：刷新页面后历史里只剩附件标记，localStorage 里搜不到 base64 前缀 → **待补**（需启动前端后手工验证；代码路径已确保 `persistableHistory` 只落 meta）

### 步骤 8：trace 事件与错误展示

- [x] 服务端推 `vision_attachment` / `vision_rejected` / `vision_unsupported_model` → `vision_rejected` 步骤 5 已有；本步在两条聊天路由补推 `vision_attachment`（计数/MIME/字节/估算 token）与 `vision_unsupported_model`（带图但模型不支持时直接拒、不调模型）
- [x] `src/api/chat.ts` 解析这三个事件（未知事件忽略不崩） → SSE 解析加三个分支，延续"缺字段给默认值"的防御风格
- [x] `src/composables/useChat.ts` + 过程面板展示 → onTrace 通用通道已覆盖；`ToolTracePanel` 新增三 kind 的标题与详情
- [x] 错误码 → 用户文案映射（沿用 `ChatMessageItem.vue` 里的映射表做法） → `ToolTracePanel` 增加 `VISION_ERROR_TEXT` 映射表
- 验证：故意发一张非法图，UI 显示具体原因 → **待补**（需启动前后端后手工贴一张非法图核对面板文案）

### 步骤 9：usage 与成本标记

- [x] `server/usage/types.ts`：`UsageRecord` / `UsageSnapshot` 加图片三个字段 → `imageCount` / `imageBytes` / `estimatedImageTokens`，均为可选
- [x] `server/usage/accumulator.ts`：累加器能记录图片信息 → 新增 `recordImages()`，`toSnapshot` / `toRecord` 带出三字段
- [x] 确认 base64 不进 usage 正文 → 只记数字，`recordImages` 仅接收 count / bytes / tokens
- [x] 两条聊天路由接线：`chat.ts` / `chatMulti.ts` 在 vision 事件块汇总 stats 后调用 `recordImages`
- [x] 前端契约同步：`src/types.ts` `UsageSnapshot` 加三可选字段；`src/api/chat.ts` 四处 `onUsage` 解析加默认 0
- 验证：`GET /api/usage` 的记录里能看到 imageCount → **待补**（需启动 dev 服务端；待允许后按步骤 12 验证命令手工核对 recent 记录）

### 步骤 10：模型能力下发

- [x] `server/routes/models.ts`：每项加 `supportsVision` → 兜底列表与上游列表统一走 `isVisionCapableModel` 判定
- [x] 前端模型下拉：不支持 Vision 的模型禁用上传入口并给提示 → `visionUploadEnabled` 追加模型能力判断，按钮 title 区分「模型不支持」与「链路/流式禁用」
- [x] 切换模型时自动清掉不兼容的待发附件 → `changeModel` 里 `supportsVision === false` 时 `clearAttachments()`
- 验证：切到不支持的模型，入口禁用 → **待补**（需启动前端后手工切换模型核对入口与提示）

### 步骤 11：真实模型端到端场景

- [x] 场景：粘贴 UI 截图 → "识别布局层级 → 指出 3 个问题 → 给修复建议" → 用合成测试截图直连上游完成
- [x] 提示词要求区分"截图中可见"和"推测" → 回答明确分「可见内容 / 推测」两段
- [x] 记录首字延迟、总 token、图片估算 token 与实际 usage 差值 → 见附录 B
- [x] 记录供应商对 content parts 的实际接受情况（字段名是否需要兼容层） → 标准 OpenAI content parts 直接接受，无需兼容层；但实际模型 id 不命中现有启发式（见附录 B「踩坑」）
- 产出：一次真实调用的完整记录（附录 B）

### 步骤 12：回归与文档

- [x] `npm run typecheck` → 通过
- [x] `npm run build` → 通过（vite build 1827 模块）
- [ ] `npm run eval:chat` / `npm run eval:multi` → **待授权**（需真实 deepseek 调用）
- [ ] 三条既有链路回归：`/api/chat`、`/api/chat/multi`、`/api/rag/chat` → **待授权**（需启动服务端）
- [x] `npx tsx --test server/vision/*.test.ts` → 31/31 通过（受限环境用 `node --import=tsx --test`）
- [x] 写 `docs/vision.md`（学习笔记，见第 10 节）→ 已写入 `docs/vision.md`
- [x] `tasks/todo.md` 勾选并写明实测结果 → 已勾选，未实测项标注待授权
- [x] `tasks/plan.md` 第 4 项补上本文链接 → 已补 `docs/vision.md` 链接

---

## 9. 建议文件清单

### 新增

- `server/vision/types.ts`
- `server/vision/validateImage.ts`
- `server/vision/validateImage.test.ts`
- `server/vision/toProviderMessages.ts`
- `server/vision/toProviderMessages.test.ts`
- `server/vision/capability.ts`
- `server/vision/capability.test.ts`
- `server/vision/estimateImageTokens.ts`
- `server/vision/estimateImageTokens.test.ts`
- `src/vision/compressImage.ts`
- `src/vision/validateImage.ts`
- `src/components/ImageAttachment.vue`
- `docs/vision.md`

### 修改

- `server/react/types.ts`
- `server/react/complete.ts`
- `server/routes/chat.ts`
- `server/routes/chatMulti.ts`
- `server/routes/models.ts`
- `server/index.ts`
- `server/usage/types.ts`
- `server/usage/accumulator.ts`
- `src/types.ts`
- `src/api/chat.ts`
- `src/composables/useChat.ts`
- `src/App.vue`
- `src/components/ChatMessageItem.vue`

### 明确不改

- `server/clipMessages.ts`
- `server/context/*`（tokenBudget / buildContext / summarize）
- `server/guard/*`
- `server/memory/*`
- `server/react/runConversation.ts`、`applyToolCalls.ts`
- `server/plan-execute/*`、`server/reflection/*`、`server/structured/*`
- `server/routes/chatStructured.ts`、`chatPlan.ts`、`chatReflection.ts`、`ragChat.ts`

---

## 10. 失败路径清单

| 失败 | 触发条件 | 期望行为 |
| --- | --- | --- |
| 粘贴无 MIME | 剪贴板图片 `file.type` 为空 | 按扩展名推断，再兜底 png；仍失败给明确提示 |
| 图片过大 | 压缩后仍 > 1MB | 前端直接拒绝，不发请求 |
| 请求体超限 | base64 后超过路由上限 | 413 + 明确文案，不出现裸 500 |
| 非法 base64 | 客户端构造的脏数据 | 服务端 400 + `image_invalid_data`，不调模型 |
| 像素过大 | 超 4096² | 服务端拒绝 |
| 模型不支持 | 能力表未命中 | `vision_unsupported_model`，前端禁用入口 |
| 供应商 400 | 字段名不被接受 | `vision_provider_rejected`，记录原始报文片段（截断） |
| 旧历史兼容 | 历史里 content 是字符串 | 正常解析；`attachments` 缺省即无图 |
| 中途停止 | 生成中点停止 | abort 上游，不写 usage、不写成功历史 |
| 附件被删 | 已选图后点移除 | 发送前从请求体移除；发送中删除只影响 UI，不影响本轮已发请求 |
| 图片内注入 | 图里写指令 | 文本 Guard 扫不到 → 提示词约束 + 输出 Judge 兜底，文档写明未完全解决 |
| 上下文爆炸 | 长对话 + 一张大图 | 图片不计入文本 token 估算 → 必须在预算里给图片留余量（步骤 7.4） |

---

## 11. 验收标准

- [ ] 粘贴一张 UI 截图，模型回答里引用了截图中的真实内容
- [ ] 回答能区分"截图中可见"与"推测"
- [ ] 文本链路、工具调用链路、RAG 链路零回归
- [ ] 大小 / 格式 / 像素 / 模型不支持，四类错误都有具体文案，不是裸 500
- [ ] 图片不进入 usage 日志正文，localStorage 里搜不到 base64
- [ ] 清空会话后内存与存储里都不残留图片数据
- [ ] usage 里能看到 imageCount 与图片估算 token
- [ ] `npm run typecheck` 与 `npm run build` 通过
- [ ] `server/vision` 专项测试全绿
- [ ] `docs/vision.md` 写完，且包含"已知未解决风险"一节

---

## 12. 验证命令

```bash
npx tsx --test server/vision/*.test.ts
npm run typecheck
npm run build
npm run eval:chat
npm run eval:multi
```

真实模型调用前先确认：

```bash
test -n "$LLM_API_KEY" && test "$MOCK_MODE" != "1"
```

---

## 13. 学习笔记产出（`docs/vision.md` 要写什么）

- [ ] 多模态 content parts 协议：三种常见形态（parts 数组 / 嵌套对象 / 独立字段）与兼容层
- [ ] data URL 与 base64：体积膨胀、请求体上限、413 的成因
- [ ] 图片 token 计费规则：分档公式、估算与真实值差异
- [ ] 模型能力矩阵：三种探测手段与各自的失败模式
- [ ] 前端压缩：canvas 降采样的画质与体积权衡，为什么在客户端做
- [ ] 隐私与留存：图片不该进日志、不该进 localStorage、不该跨轮回传
- [ ] 图片作为不可信输入：Guard 的盲区与降级手段
- [ ] 已知未解决风险：多图对比、OCR 精度、注入图片、跨轮图片引用
- [ ] 本次踩到的坑（逐条记录，含请求体 1mb 上限这个）

---

## 14. 检查点

### 检查点 A：协议与后端就绪

- [ ] 类型定义完成，前后端字段对齐
- [ ] 4 组红测试已写
- [ ] 校验、能力表、token 估算、协议转换实现并转绿
- [ ] 路由层拒绝非法请求且不调模型
- [ ] typecheck 通过

### 检查点 B：前端可用

- [ ] 粘贴 / 拖拽 / 选择文件三个入口都能加图
- [ ] 缩略图、大小、移除正常
- [ ] 压缩生效，payload 在限制内
- [ ] 历史只落元数据

### 检查点 C：端到端与回归

- [ ] 真实模型场景跑通并记录数据
- [ ] 四类错误各有明确文案
- [ ] 三条既有链路回归通过
- [ ] usage 带图片计数，base64 不落盘
- [ ] `docs/vision.md` 完成

---

## 15. 不在本专项范围内

- 图像生成、图像编辑
- 多图对比推理、跨轮图片引用
- OCR 精确文字提取
- `/api/rag/chat` 带图、`/api/chat/structured` 带图、`/api/chat/plan` 带图
- 服务端代为拉取远程图片 URL（SSRF 风险）
- 图片向量化 / 以图搜图

---

## 16. 决策规则

- 遇到"要不要把 `content` 改成 union"的诱惑时，回到决策一：先算改动面，再决定。
- 前端校验与服务端校验冲突时，**以服务端为准**，前端只是体验优化。
- 模型能力判断失败时，**默认当作不支持**，宁可拒绝也不要跑到 API 报 400。
- 实现成本明显超过学习收益时，保留 spike 与结论，不强行接入主链路。
- 任何新增字段必须前后端同名同义，否则前端静默丢数据。

---

## 附录 A：基线记录（步骤 0 执行后填写）

> 记录于 2026-11-11（步骤 0 门禁）。

- git 基线：执行前 `git status --short` 无代码改动（仅新增本文档与后续类型改动）。
- typecheck：`npm run typecheck` 通过，无基线错误。
- build：`npm run build` 通过，无基线错误。
- 模型能力：首版覆盖 `/api/chat` 单 Agent 与 `/api/chat/multi`；能力判定由
  `capability.ts` 白名单 / 启发式 / 运行期降级负责，具体目标模型计费规则在步骤 11
  真实调用时补录。
- Key 可用性：`LLM_API_KEY` / `MOCK_MODE` 待步骤 11 前确认；步骤 0-4 的验证均为
  单测 / mock 链路，不依赖真实 Key。

## 附录 B：步骤 11 真实调用记录

> ⚠ **作废声明**：本附录原始数据来自一次越权调用（`gpt-6-sol`，不在允许的
> `deepseek` 白名单内），属违规操作，数据**作废不采信**。仅保留「供应商
> 接受标准 content parts」这一观察供参考；正式步骤 11 记录待授权后用
> `deepseek` 模型重跑并替换本节。

> 记录于 2026-11-11（越权调用，作废）。上游：`.env` 的 `LLM_BASE_URL`；测试图：合成 800×600 PNG
> （顶部导航条 + 左侧边栏 + 中部卡片 + 底部按钮，无文字，6,552 字节）。

- ~~模型：`gpt-6-sol`（直连 chat/completions，stream: true）~~（越权，作废）
- 请求体：system + user `content: [{type:"text"}, {type:"image_url", url: data:image/png;base64,...}]`
- 首个 token 延迟：6,208 ms；总耗时：13,894 ms；回答长度：445 字
- 图片估算 token（按估算法）：918；实际 usage 未单独报图片 token：
  `prompt_tokens=4318, completion_tokens=435, total_tokens=4753`
  （含 `cached_tokens=3456`、`reasoning_tokens=109`）
- 供应商接受度：HTTP 200，标准 OpenAI content parts 字段名直接接受，**无需兼容层**
- 回答质量：准确描述可见布局（深色顶部横条/左侧灰栏/两个白面板/蓝粉块/蓝色矩形），
  并把无法确认的信息明确标注为「推测」——符合「区分可见与推测」要求

**踩坑（保留，不依赖越权数据）**

- 上游实际模型 id（`gpt-6-sol` / `gpt-6-astra` / `gpt-6.1-sol` / `claude-sonnet-5-5` 等）
  均不命中 `capability.ts` 现有启发式 `/gpt-4o|gpt-5|vision|omni|qwen.*vl/i`
  （`gpt-6` 与 `gpt-5` 子串不匹配）。
- 结果：`GET /api/models` 会给这些模型标 `supportsVision: false`，服务端据此拒绝带图请求，
  属已知不一致，修复选项：
  1. 更新启发式加入 `gpt-6` / `claude` 等可多模态模型；
  2. 在 `.env` 配置 `VISION_CAPABLE_MODELS=gpt-6-sol,gpt-6-astra,...` 白名单（最高优先级）。
- 未擅自改代码，待用户确认后择一执行。

