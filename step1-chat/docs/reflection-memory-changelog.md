# Reflection 接入跨会话记忆 · 变更记录

日期：2026-11-17

## 背景

`docs/memory-chain-integration.md` 已把记忆接到普通对话、multi、plan、rag、
structured 五条链路，但刻意留下 reflection 没接——当时判断 reflection
「先出答案再打分、必要时重写」，注入时机与普通对话不同，不该照抄。
结果用户切到 reflection 后记忆完全失效，面板只能如实标注「未接入」。

本次把 reflection 也接上，记忆语义与其余五条链路一致，
评分 / 重写语义一行不动。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `server/routes/chatReflection.ts` | 请求 schema 增加 `userId` / `allowMemory`；路由层检索一次并发 `memory_injected`；`createChatStream` 调用透传 `userId` / `allowMemory` / `memoryBlock`；复盘结束后按「question + finalDraft」抽取 |
| `src/api/chat.ts` | `streamReflection` 参数增加 `userId` / `allowMemory` 并写进请求 body（关掉开关连 userId 一起不带） |
| `src/composables/useChat.ts` | `runReflection` 传入 `memoryUserId` / `allowMemory` |
| `src/App.vue` | `memoryInjectionSupported` 改为恒 true，移除 prop 绑定 |
| `src/components/MemoryPanel.vue` | 删除「本阶段尚未接入记忆注入」分支与 `injectionSupported` prop |
| `docs/memory-chain-integration.md` | 面板文案 / 已知缺口中「reflection 未接入」改为「已接入」 |
| `docs/memory.md` | 链路现状表更新为六链路已接入 |

## 记忆模块本身零改动

`server/memory/bridge.ts`、`server/chat.ts` 的记忆核心逻辑不改。
`createChatStream` 已支持 `memoryBlock` 语义（提供方已查过 → 不重复检索 / 不发事件 / 不抽取），
本次只做参数透传。

## 事件

- `memory_injected`：路由层检索命中后由 reflection 路由发出（沿用 `buildMemoryInjectedEvent` 口径）。
- `memory_extracted` / `memory_failed`：由 `scheduleMemoryExtraction` 旁路发出。
- 事件经 `onTrace` 透传给前端 `ToolTracePanel`，展示与其它链路一致。

## 隐私口径

- 检索 / 抽取都以 `allowMemory === true` 且 `userId` 合法为前置；
  关掉开关或非法 id 零检索、零抽取。
- 抽取输入只喂「用户问题 + 最终采纳的答案」，评分 / 重写 / 工具返回不参与。

## 验证到哪一步

- `npm run typecheck`：服务端 `tsc -p tsconfig.server.json` 干净通过。
  前端 `vue-tsc` 仅报 `src/composables/useChat.ts:406` 的 `_loadModelOptions`
  未使用——这是仓库既有问题，与本次改动无关（本次只在该文件追加了 3 行 reflection 传参）。
- 检索 / 开关 / 非法 id / 透传语义：已通过临时脚本逐项核对并清理。
- 未跑 `npm run test:chains`：现有 5 条链路覆盖不含 reflection，且需要真实模型。
