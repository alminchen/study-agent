/**
 * Reflection Critic 单测。
 *
 * 覆盖四件事：
 * 1. 合法返回：拿到结构化评分，四项分数与 issues 原样保留；
 * 2. 非法返回：不是 JSON、字段缺失、分数越界，都收敛成 error 且不带分数；
 * 3. 模糊返回：模型只说"还行，建议改进"这类自然语言，一律判 bad_json；
 * 4. 失败路径：超时与接口错误收敛成对应 errorKind，重试次数如实记录。
 *
 * 运行：node --import tsx --test server/reflection/critic.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  averageScore,
  critique,
  shouldRewriteByThreshold,
  type CriticMeta,
  type CriticModelCaller,
} from "./critic.js";
import { isCritiqueError, isCritiqueOk } from "./types.js";

const sampleInput = {
  question: "订单 123 的物流到哪了？",
  draft: "订单 123 已于今天发出，预计明天送达。",
  toolFacts: "查询结果：订单 123 状态为已发货，承运商为顺丰。",
};

/** 构造一个返回固定内容的假模型。 */
function stringCaller(content: string): CriticModelCaller {
  return async () => content;
}

/** 构造一个返回固定 JSON 的假模型。 */
function jsonCaller(payload: unknown): CriticModelCaller {
  return async () => JSON.stringify(payload);
}

const validPayload = {
  scores: {
    relevance: 5,
    completeness: 5,
    groundedness: 4,
    clarity: 5,
  },
  issues: [{ dimension: "groundedness", detail: "预计送达时间没有依据" }],
  shouldRewrite: true,
  revisionInstructions: "去掉没有依据的送达时间预测",
  reason: "存在一处无依据的推断",
};

test("合法返回被解析成结构化评分", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller(validPayload),
  });

  assert.ok(isCritiqueOk(result));
  if (!isCritiqueOk(result)) return;
  assert.equal(result.scores.relevance, 5);
  assert.equal(result.scores.groundedness, 4);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].dimension, "groundedness");
  assert.equal(result.shouldRewrite, true);
});

test("模型返回带 markdown 包裹也能解析", async () => {
  const result = await critique(sampleInput, {
    callModel: stringCaller(
      "```json\n" + JSON.stringify(validPayload) + "\n```",
    ),
  });

  assert.ok(isCritiqueOk(result));
});

test("模型输出前后有多余文本时仍能提取 JSON", async () => {
  const result = await critique(sampleInput, {
    callModel: stringCaller(
      "好的，我来评分：\n" + JSON.stringify(validPayload) + "\n以上就是我的评分。",
    ),
  });

  assert.ok(isCritiqueOk(result));
});

test("不是 JSON 的返回收敛成 bad_json 且不带分数", async () => {
  const result = await critique(sampleInput, {
    callModel: stringCaller("整体还行，但是可以再改进一下。"),
  });

  assert.ok(isCritiqueError(result));
  if (!isCritiqueError(result)) return;
  assert.equal(result.errorKind, "bad_json");
  assert.equal("scores" in result, false);
});

test("字段缺失的返回收敛成 schema_error", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller({
      scores: { relevance: 4, completeness: 4 },
      issues: [],
      shouldRewrite: false,
      revisionInstructions: "",
      reason: "缺维度",
    }),
  });

  assert.ok(isCritiqueError(result));
  if (!isCritiqueError(result)) return;
  assert.equal(result.errorKind, "schema_error");
});

test("分数越界的返回收敛成 schema_error", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller({
      ...validPayload,
      scores: { ...validPayload.scores, clarity: 9 },
    }),
  });

  assert.ok(isCritiqueError(result));
  if (!isCritiqueError(result)) return;
  assert.equal(result.errorKind, "schema_error");
});

test("建议重写却没给修订指令时收敛成 schema_error", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller({
      ...validPayload,
      revisionInstructions: "   ",
    }),
  });

  assert.ok(isCritiqueError(result));
  if (!isCritiqueError(result)) return;
  assert.equal(result.errorKind, "schema_error");
});

test("接口错误重试后仍失败时收敛成 api_error", async () => {
  let calls = 0;
  const result = await critique(sampleInput, {
    callModel: async () => {
      calls += 1;
      throw new Error("HTTP 500");
    },
    maxRetries: 1,
  });

  assert.ok(isCritiqueError(result));
  if (!isCritiqueError(result)) return;
  assert.equal(result.errorKind, "api_error");
  assert.equal(calls, 2);
  assert.equal(result.retries, 1);
});

test("解析失败不重试", async () => {
  let calls = 0;
  const result = await critique(sampleInput, {
    callModel: async () => {
      calls += 1;
      return "不是 JSON";
    },
    maxRetries: 2,
  });

  assert.ok(isCritiqueError(result));
  assert.equal(calls, 1);
});

test("超时收敛成 timeout", async () => {
  const result = await critique(sampleInput, {
    callModel: (_request) =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("{}"), 5_000);
      }),
    totalTimeoutMs: 60,
    maxRetries: 0,
  });

  assert.ok(isCritiqueError(result));
  if (!isCritiqueError(result)) return;
  assert.equal(result.errorKind, "timeout");
});

test("评分元信息被回调，用于写 trace", async () => {
  const captured: CriticMeta[] = [];
  await critique(sampleInput, {
    callModel: jsonCaller(validPayload),
    onMeta: (value) => {
      captured.push(value);
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].attempts, 1);
  assert.equal(captured[0].truncated, false);
});

test("过长的答案会被截断但仍能评分", async () => {
  const captured: CriticMeta[] = [];
  const result = await critique(
    { ...sampleInput, draft: "长".repeat(5_000) },
    {
      callModel: jsonCaller(validPayload),
      maxInputChars: 500,
      onMeta: (value) => {
        captured.push(value);
      },
    },
  );

  assert.ok(isCritiqueOk(result));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].truncated, true);
});

test("阈值规则：任一维度不高于 3 即建议重写", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller({
      ...validPayload,
      scores: { relevance: 5, completeness: 5, groundedness: 5, clarity: 2 },
      issues: [],
    }),
  });

  assert.ok(isCritiqueOk(result));
  assert.equal(shouldRewriteByThreshold(result), true);
});

test("阈值规则：出现 groundedness 问题即建议重写", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller({
      ...validPayload,
      scores: { relevance: 5, completeness: 5, groundedness: 5, clarity: 5 },
    }),
  });

  assert.ok(isCritiqueOk(result));
  assert.equal(shouldRewriteByThreshold(result), true);
});

test("阈值规则：全部达标且无 groundedness 问题时不重写", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller({
      ...validPayload,
      scores: { relevance: 5, completeness: 4, groundedness: 5, clarity: 5 },
      issues: [{ dimension: "clarity", detail: "稍显啰嗦" }],
    }),
  });

  assert.ok(isCritiqueOk(result));
  assert.equal(shouldRewriteByThreshold(result), false);
});

test("阈值规则：评分失败时不建议重写", async () => {
  const result = await critique(sampleInput, {
    callModel: stringCaller("随便说点什么"),
  });

  assert.ok(isCritiqueError(result));
  assert.equal(shouldRewriteByThreshold(result), false);
});

test("平均分用于 A/B 质量对比", async () => {
  const result = await critique(sampleInput, {
    callModel: jsonCaller(validPayload),
  });

  assert.ok(isCritiqueOk(result));
  assert.equal(averageScore(result.scores), 4.75);
});
