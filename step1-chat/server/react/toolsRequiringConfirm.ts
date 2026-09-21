/**
 * 「哪些工具必须先人工确认再执行」的名单。
 *
 * 设计原则：
 * - 只读 / 可重试（天气、时间、知识库检索）→ 不进名单，模型一要就跑
 * - 有外部副作用或不可轻易撤销（发消息、写文件、扣费…）→ 进名单
 *
 * 学习阶段用假工具 draft_message 练通协议；以后写盘、真发送也挂这里。
 *
 * 消费方：
 * - applyToolCalls：名字在名单内 → 走确认分支
 * - tools/index toolSchemasForChat：对接聊天前先 filter 掉，避免模型调到却无 UI
 */

/** 需确认才能 run 的工具名。增删只改这一处。 */
const REQUIRES_CONFIRM = new Set(["draft_message"]);

/** applyToolCalls / schema 过滤用 */
export function isToolRequiringConfirm(name: string): boolean {
  return REQUIRES_CONFIRM.has(name);
}

/** 调试或文档列举用 */
export function listToolsRequiringConfirm(): string[] {
  return [...REQUIRES_CONFIRM];
}
