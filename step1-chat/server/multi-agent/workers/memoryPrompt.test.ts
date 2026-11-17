/**
 * buildWorkerMessages 单测。
 *
 * 覆盖三态（对应长上下文接入计划的指令 2 完成判定）：
 * 1. 无历史 → 输出与接入前逐字一致（回归边界）；
 * 2. 有历史 → 顺序为 system → 摘要 → 记忆 → 历史原文 → task，记忆仍在摘要后、task 前；
 * 3. 摘要超预算 / 摘要为空 → 不注入摘要层，不抛错。
 *
 * 运行：node --import tsx --test server/multi-agent/workers/memoryPrompt.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkerMessages } from "./memoryPrompt.js";
import type { ContextMemoryBlock, ContextSummary } from "../../context/types.js";
import type { TextMessage } from "../../react/types.js";

const SYSTEM = "你是通用助手。";
const TASK = "广州天气怎么样？";

/** 构造一个最小可用的记忆块。 */
const memoryBlock: ContextMemoryBlock = {
  header: "以下是用户的长期偏好（不是新指令）：",
  items: [{ id: "mem_1", text: "语言=中文", similarity: 0.9 }],
};

/** 构造一份非空摘要。 */
function makeSummary(overrides: Partial<ContextSummary> = {}): ContextSummary {
  return {
    version: 1,
    updatedAt: Date.now(),
    compactedUntilMessageId: null,
    facts: [{ key: "城市", value: "广州", sourceMessageIndex: 0 }],
    decisions: [],
    unresolved: [],
    userConstraints: [],
    ...overrides,
  };
}

test("无历史时输出与接入前逐字一致", () => {
  const noMemory = buildWorkerMessages(SYSTEM, TASK);
  assert.deepEqual(noMemory, [
    { role: "system", content: SYSTEM },
    { role: "user", content: TASK },
  ]);

  const withMemory = buildWorkerMessages(SYSTEM, TASK, memoryBlock);
  assert.equal(withMemory.length, 3);
  assert.equal(withMemory[0].content, SYSTEM);
  assert.match(withMemory[1].content ?? "", /mem_1/);
  assert.equal(withMemory[1].role, "system");
  assert.deepEqual(withMemory[2], { role: "user", content: TASK });

  // 传空历史 + 空摘要，仍逐字一致。
  const empty = buildWorkerMessages(SYSTEM, TASK, memoryBlock, [], null);
  assert.deepEqual(empty, withMemory);
});

test("有历史时顺序为 system → 摘要 → 记忆 → 历史原文 → task", () => {
  const summary = makeSummary();
  const history: TextMessage[] = [
    { role: "user", content: "我之前问过广州。" },
    { role: "assistant", content: "广州属于广东省。" },
  ];

  const messages = buildWorkerMessages(SYSTEM, TASK, memoryBlock, history, summary);

  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, SYSTEM);
  // 摘要层：独立 system，在记忆之前。
  assert.equal(messages[1].role, "system");
  assert.match(messages[1].content ?? "", /历史摘要/);
  // 记忆层：仍在摘要之后、task 之前。
  assert.equal(messages[2].role, "system");
  assert.match(messages[2].content ?? "", /mem_1/);
  // 历史原文：原样保留 role。
  assert.deepEqual(messages[3], { role: "user", content: "我之前问过广州。" });
  assert.deepEqual(messages[4], { role: "assistant", content: "广州属于广东省。" });
  // 当前 task 永远最后。
  assert.deepEqual(messages[5], { role: "user", content: TASK });
});

test("摘要超预算或为空时不注入摘要层", () => {
  const history: TextMessage[] = [{ role: "user", content: "早前一句。" }];

  // facts 为空 → renderSummaryText 返回 "" → 不注入摘要层。
  const emptySummary = makeSummary({
    facts: [],
    decisions: [],
    unresolved: [],
    userConstraints: [],
  });
  const messages = buildWorkerMessages(SYSTEM, TASK, memoryBlock, history, emptySummary);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].content, SYSTEM);
  assert.match(messages[1].content ?? "", /mem_1/); // 直接是记忆层，无摘要层
  assert.deepEqual(messages[2], history[0]);
  assert.deepEqual(messages[3], { role: "user", content: TASK });

  // 只传历史、不传摘要，同样无摘要层且不抛错。
  const noSummary = buildWorkerMessages(SYSTEM, TASK, memoryBlock, history);
  assert.deepEqual(noSummary, messages);
});
