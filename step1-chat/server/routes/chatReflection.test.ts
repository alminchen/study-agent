/**
 * Reflection 决策流水线的单测。
 *
 * 只测 runReflectionPipeline：它是纯函数，评分与重写都靠注入，
 * 不碰网络也不起 HTTP server。路由层（校验 / SSE / draft 生成）靠
 * 手测与 Evals 覆盖。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CritiqueInput } from "../../server/reflection/critic.js";
import type { ReviseInput } from "../../server/reflection/revise.js";
import {
  buildCritiqueError,
  buildCritiqueOk,
  type Critique,
  type CritiqueScores,
} from "../../server/reflection/types.js";
import {
  runReflectionPipeline,
  resolveReflectionMode,
  type ReflectionEvent,
} from "./chatReflection.js";

const HIGH_SCORES: CritiqueScores = {
  relevance: 5,
  completeness: 5,
  groundedness: 5,
  clarity: 5,
};

const LOW_SCORES: CritiqueScores = {
  relevance: 2,
  completeness: 2,
  groundedness: 2,
  clarity: 2,
};

const MID_SCORES: CritiqueScores = {
  relevance: 3,
  completeness: 3,
  groundedness: 3,
  clarity: 3,
};

function okCritique(
  scores: CritiqueScores,
  shouldRewrite: boolean,
): Critique {
  return buildCritiqueOk({
    scores,
    issues: shouldRewrite
      ? [{ dimension: "completeness", detail: "漏了第二问" }]
      : [],
    shouldRewrite,
    revisionInstructions: shouldRewrite ? "补上第二问" : "",
    reason: "测试用评分",
  });
}

function collect() {
  const events: ReflectionEvent[] = [];
  return {
    events,
    onEvent: (event: ReflectionEvent) => {
      events.push(event);
    },
    skipReasons: () =>
      events
        .filter((event): event is Extract<ReflectionEvent, { type: "reflection_skipped" }> =>
          event.type === "reflection_skipped",
        )
        .map((event) => event.reason),
    kinds: () => events.map((event) => event.type),
  };
}

test("Mock 模式跳过整个 Reflection，保留初版答案", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    mockMode: true,
    critique: async () => okCritique(HIGH_SCORES, false),
    revise: async () => {
      throw new Error("Mock 模式不应该调用重写");
    },
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.deepEqual(sink.skipReasons(), ["mock_mode"]);
});

test("评分失败时保留初版答案并给出失败原因", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async () => buildCritiqueError("api_error", { message: "挂了" }),
    revise: async () => {
      throw new Error("评分失败时不应该调用重写");
    },
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.equal(result.initial?.status, "error");
  assert.deepEqual(sink.skipReasons(), ["critique_failed"]);
});

test("分数都高于阈值时不重写", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async () => okCritique(HIGH_SCORES, false),
    revise: async () => {
      throw new Error("不需要重写");
    },
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.equal(result.revisedDraft, null);
  assert.deepEqual(sink.skipReasons(), ["no_rewrite_needed"]);
  assert.deepEqual(sink.kinds(), ["reflection_scored", "reflection_skipped"]);
});

test("enforce 模式下修订稿分数更高才替换正文", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async (input: CritiqueInput) =>
      input.draft === "初版"
        ? okCritique(LOW_SCORES, true)
        : okCritique(HIGH_SCORES, false),
    revise: async (_input: ReviseInput) => ({
      status: "ok",
      revisedDraft: "修订版",
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "修订版");
  assert.equal(result.revisedDraft, "修订版");

  const revised = sink.events.find((event) => event.type === "reflection_revised");
  assert.ok(revised && revised.type === "reflection_revised");
  assert.equal(revised.adopted, true);
  assert.equal(revised.improved, true);
  assert.equal(revised.beforeAverage, 2);
  assert.equal(revised.afterAverage, 5);
  // 采纳了就没什么好跳过的。
  assert.deepEqual(sink.skipReasons(), []);
});

test("shadow 模式只报告不改正文", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "shadow",
    critique: async (input: CritiqueInput) =>
      input.draft === "初版"
        ? okCritique(LOW_SCORES, true)
        : okCritique(HIGH_SCORES, false),
    revise: async (_input: ReviseInput) => ({
      status: "ok",
      revisedDraft: "修订版",
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.equal(result.revisedDraft, "修订版");

  const revised = sink.events.find((event) => event.type === "reflection_revised");
  assert.ok(revised && revised.type === "reflection_revised");
  assert.equal(revised.adopted, false);
  assert.equal(revised.improved, true);
  assert.deepEqual(sink.skipReasons(), ["shadow_mode"]);
});

test("修订稿分数没提升时回退初版", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async (input: CritiqueInput) =>
      input.draft === "初版"
        ? okCritique(MID_SCORES, true)
        : okCritique(LOW_SCORES, false),
    revise: async (_input: ReviseInput) => ({
      status: "ok",
      revisedDraft: "修订版",
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  const revised = sink.events.find((event) => event.type === "reflection_revised");
  assert.ok(revised && revised.type === "reflection_revised");
  assert.equal(revised.adopted, false);
  assert.equal(revised.improved, false);
  assert.deepEqual(sink.skipReasons(), ["no_improvement"]);
});

test("重写作废（引入无依据事实）时保留初版", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async () => okCritique(LOW_SCORES, true),
    revise: async (_input: ReviseInput) => ({
      status: "rejected",
      revisedDraft: "编了个新数字",
      reason: "重写引入了工具事实之外的新依据",
      unsupportedTokens: ["3天"],
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.equal(result.revisedDraft, null);
  assert.deepEqual(sink.skipReasons(), ["revise_rejected"]);
});

test("重写与初版实质相同时不再重评", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async () => okCritique(LOW_SCORES, true),
    revise: async (_input: ReviseInput) => ({
      status: "no_change",
      revisedDraft: "初版",
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.equal(result.revised, null);
  assert.deepEqual(sink.skipReasons(), ["revise_no_change"]);
});

test("重写调用失败时保留初版", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async () => okCritique(LOW_SCORES, true),
    revise: async (_input: ReviseInput) => ({
      status: "error",
      errorKind: "timeout",
      retries: 1,
      raw: "",
      message: "超时",
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.deepEqual(sink.skipReasons(), ["revise_failed"]);
});

test("修订稿重评失败时回退初版", async () => {
  const sink = collect();
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async (input: CritiqueInput) =>
      input.draft === "初版"
        ? okCritique(LOW_SCORES, true)
        : buildCritiqueError("timeout", { message: "重评超时" }),
    revise: async (_input: ReviseInput) => ({
      status: "ok",
      revisedDraft: "修订版",
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(result.finalDraft, "初版");
  assert.equal(result.revised?.status, "error");
  assert.deepEqual(sink.skipReasons(), ["rescore_failed"]);
});

test("事件顺序：初评 → 重评 → 修订结论", async () => {
  const sink = collect();
  await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "enforce",
    critique: async (input: CritiqueInput) =>
      input.draft === "初版"
        ? okCritique(LOW_SCORES, true)
        : okCritique(HIGH_SCORES, false),
    revise: async (_input: ReviseInput) => ({
      status: "ok",
      revisedDraft: "修订版",
    }),
    onEvent: sink.onEvent,
  });

  assert.deepEqual(sink.kinds(), [
    "reflection_scored",
    "reflection_scored",
    "reflection_revised",
  ]);
});

test("off 模式直接返回初版答案，不调用评分", async () => {
  const sink = collect();
  let critiqueCalled = false;
  const result = await runReflectionPipeline({
    question: "问题",
    draft: "初版",
    mode: "off",
    critique: async (input: CritiqueInput) => {
      critiqueCalled = true;
      return okCritique(LOW_SCORES, true);
    },
    revise: async (_input: ReviseInput) => ({
      status: "ok",
      revisedDraft: "修订版",
    }),
    onEvent: sink.onEvent,
  });

  assert.equal(critiqueCalled, false);
  assert.equal(result.finalDraft, "初版");
  assert.deepEqual(sink.skipReasons(), ["off"]);
});

test("服务端模式是上限：请求不能把 shadow 抬成 enforce", () => {
  assert.equal(resolveReflectionMode("off"), "off");
  assert.equal(resolveReflectionMode("off", "enforce"), "off");
  assert.equal(resolveReflectionMode("shadow"), "shadow");
  assert.equal(resolveReflectionMode("shadow", "enforce"), "shadow");
  assert.equal(resolveReflectionMode("enforce"), "enforce");
  assert.equal(resolveReflectionMode("enforce", "shadow"), "shadow");
});
