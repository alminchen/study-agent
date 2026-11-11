# 阶段 4 Vision（图片输入）变更记录

> 进阶学习第 4 项 Vision。专项执行手册：`tasks/vision-plan.md`。步骤 0-11 已完成；本文作为阶段文件清单与变更记录，供 `docs/flows-index.html` 与 `docs/project-topology.html` 对照索引。

## 目标

把消息协议从 `content: string` 升级为 `content`（保留字符串）+ `attachments`（图片 parts）的组合，并配套完成模型能力判定、前端压缩、前后端双重校验、图片成本记账、能力下发与入口禁用。

核心决策：**不改 `TextMessage.content` 类型**，附件走独立 `attachments` 字段；供应商协议转换由唯一入口 `server/vision/toProviderMessages.ts` 收口，既有按字符串消费 content 的代码零改动。

## 新增文件（14）

| 文件 | 职责 |
|------|------|
| `server/vision/types.ts` | 图片附件类型、错误码、限制常量、校验结果类型 |
| `server/vision/validateImage.ts` | MIME / 字节 / base64 / 像素 / 数量校验（服务端硬校验） |
| `server/vision/validateImage.test.ts` | 校验单测（非法 MIME / 超大 / 非法 base64 / 超像素 / 合法 / 非 user 角色 / 多图拒） |
| `server/vision/toProviderMessages.ts` | 唯一供应商协议转换入口：`attachments` → `image_url` content part |
| `server/vision/toProviderMessages.test.ts` | 转换单测（带图 user → parts；无图保持字符串；assistant/tool 原样透传） |
| `server/vision/capability.ts` | 模型 Vision 能力判定：运行期降级 / 白名单 / env / 启发式 |
| `server/vision/capability.test.ts` | 能力判定单测（白名单 / 启发式 / 不命中 / 运行期降级） |
| `server/vision/estimateImageTokens.ts` | 图片 token 估算（最长边 2048 等比 + 512 分块 + 1.2 余量） |
| `server/vision/estimateImageTokens.test.ts` | 估算单测（分档 / 缩放 / 非法尺寸） |
| `src/vision/compressImage.ts` | 前端 canvas 压缩（最长边 1600px，JPEG 0.85，超限二次降采样） |
| `src/vision/validateImage.ts` | 前端快速校验，与服务端阈值对齐 |
| `src/components/ImageAttachment.vue` | 附件条目：缩略图 + 尺寸 + 移除 |
| `docs/vision.md` | 阶段 4 学习笔记（协议、压缩、计费、能力矩阵、隐私、已知风险、踩坑） |
| `docs/vision-flow.svg` | 阶段 4 细泳道流程图（索引页 0i 引用） |

## 修改文件（13）

| 文件 | 改动 |
|------|------|
| `server/react/types.ts` | 新增 `ImageAttachment`、`TextMessage.attachments`（仅 user 角色允许） |
| `server/react/complete.ts` | 调用 `toProviderMessages` 组装 supplier messages（assistant/tool 零改动） |
| `server/routes/chat.ts` | 附件校验、`vision_attachment` SSE 事件、`accumulator.recordImages` 接线图片成本 |
| `server/routes/chatMulti.ts` | 同上（多 Agent 链路） |
| `server/routes/models.ts` | `ModelOption` 新增 `supportsVision`；每项走 `isVisionCapableModel()` 判定 |
| `server/index.ts` | `/api/chat` 系列单独 `express.json({ limit: "8mb" })`，其余保持 1mb |
| `server/usage/types.ts` | `UsageRecord` / `UsageSnapshot` 新增 `imageCount` / `imageBytes` / `estimatedImageTokens`（均可选） |
| `server/usage/accumulator.ts` | 新增 `recordImages()`；`toSnapshot()` / `toRecord()` 带出图片三字段 |
| `src/types.ts` | `ChatAttachment`、`ChatMessage.attachments`、`ModelOption.supportsVision`；前端 `UsageSnapshot` 同步图片三字段 |
| `src/api/chat.ts` | 请求体透传 `attachments`；四处 `onUsage` 解析补图片三字段（默认 0）；SSE 新增 `vision_attachment` / `vision_rejected` / `vision_unsupported_model` 解析 |
| `src/composables/useChat.ts` | `pickedAttachments` 状态、`addImages`/`removeAttachment`/`clearAttachments`；发完清空；历史只落元数据；`changeModel` 切到不支持 Vision 的模型时自动清附件 |
| `src/App.vue` | 粘贴 / 拖拽 / 选择文件三个入口；附件条；`visionUploadEnabled` 追加模型能力判断；按钮 title 区分禁用原因 |
| `src/components/ChatMessageItem.vue` | 带图消息气泡标记与错误文案映射（`vision_rejected` / `vision_unsupported_model`） |

## 明确不改（界限）

- `server/clipMessages.ts`、`server/context/*`（tokenBudget / buildContext / summarize）、`server/guard/*`、`server/memory/*`
- `server/react/runConversation.ts`、`applyToolCalls.ts`
- `server/plan-execute/*`、`server/reflection/*`、`server/structured/*`
- `server/routes/chatStructured.ts`、`chatPlan.ts`、`chatReflection.ts`、`ragChat.ts`
  （首版 Vision 不覆盖四条非文本聊天链路）

## 协议变更摘要

- **wire 请求体**：`messages[]` 新增可选 `attachments[]`（`{id, mimeType, data, name, width, height, byteSize}`），缺省与现有请求体逐字节一致。
- **GET /api/models**：每项新增 `supportsVision: boolean`；旧字段不删，纯新增。
- **SSE 事件**：新增 `vision_attachment`（count / mimeTypes / totalBytes / estimatedImageTokens）、`vision_rejected`（原因）、`vision_unsupported_model`（model）；均不含 base64、不含文件名。
- **usage**：`UsageRecord` / `UsageSnapshot` / GET /api/usage recent 记录新增 `imageCount` / `imageBytes` / `estimatedImageTokens`；base64 不进日志正文。

## 实测状态（如实读）

- `npm run typecheck` — ✅ 通过（vue-tsc + server tsc）
- `npm run build` — ✅ 通过（vite build，1827 模块）
  (注：此阶段按用户要求只跑 typecheck，不启动 dev/server)
- `npx tsx --test server/vision/*.test.ts` — 31/31 通过（受限环境用 `node --import=tsx --test` 运行）
- `npm run eval:chat` / `npm run eval:multi` — 未运行（需真实 deepseek 模型调用）
- 端到端真实模型调用（UI 截图分析场景） — **作废**：步骤 11 曾越权调用 `gpt-6-sol`（不在 deepseek 白名单），数据已作废；正式记录待授权重跑
- 浏览器手工点验（粘贴 / 拖拽 / 压缩 / 禁用入口 / base64 不落 localStorage）— 未运行（沙箱不能监听端口，起不了服务 + 开不了浏览器）

## 拓扑对照

- 流程索引：`docs/flows-index.html` 新增 0i Vision 入口 + 第 13/14/15 项文档条目；`docs/flows-index.md` 同步
- 细泳道流程图：`docs/vision-flow.svg`（七个分段：协议升级 → 前端压缩校验 → 服务端硬校验与能力判定 → 供应商协议转换 → usage 图片成本 → 能力下发与入口禁用 → 隐私边界与已知风险）
- 方法级拓扑：`docs/project-topology.html` 新增 §6j Vision（阶段表 + 章节 + SVG 链接）

## 后续待办（需用户指令）

- 授权后用 `deepseek` 模型重跑步骤 11 真实调用，替换作废数据
- 修复 `capability.ts` 启发式漏掉 `gpt-6` / `claude` 等新模型的问题（或配置 `VISION_CAPABLE_MODELS` 白名单）
- 启动服务端做三条链路回归与 `/api/usage` imageCount 手工核对
