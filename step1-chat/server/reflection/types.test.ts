/**
 * Reflection 评分契约单测。
 *
 * 覆盖三件事：
 * 1. Schema 契约：成功样本能序列化/反序列化，失败样本不带 scores；
 * 2. 边界：分数越界、维度缺失、建议重写却没给指令，都必须被拒；
 * 3. 失败路径：构造失败结果时不伪造分数。
 *
 * 运行：node --import tsx --test server/reflection/types.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CritiqueSchema,
  buildCritiqueError,
  buildCritiqueOk,
  isCritiqueError,
  isCritiqueOk,
  truncateCritiqueRaw,
} from "./types.js";

const validScores = {
  relevance: 4,
  completeness: 3,
  groundedness: 5,
  clarity: 4,
};

test("成功样本可以序列化并反序列化", () => {
  const ok = buildCritiqueOk({
    scores: validScores,
    issues: [{ dimension: "completeness", detail: "漏了子问题 B" }],
    shouldRewrite: true,
    revisionInstructions: "补齐子问题 B",
    reason: "完整性不足",
  });

  const parsed = CritiqueSchema.parse(JSON.parse(JSON.stringify(ok)));
  assert.equal(parsed.status, "ok");
  assert.ok(isCritiqueOk(parsed));
  if (!isCritiqueOk(parsed)) return;
  assert.equal(parsed.scores.completeness, 3);
  assert.equal(parsed.issues.length, 1);
});

test("失败样本不带任何分数字段", () => {
  const error = buildCritiqueError("bad_json", {
    raw: "not json",
    message: "解析失败",
  });

  const parsed = CritiqueSchema.parse(JSON.parse(JSON.stringify(error)));
  assert.equal(parsed.status, "error");
  assert.ok(isCritiqueError(parsed));
  assert.equal("scores" in parsed, false);
});

test("分数越界被拒绝", () => {
  const result = CritiqueSchema.safeParse({
    status: "ok",
    schemaVersion: "reflection.v1",
    scores: { ...validScores, relevance: 9 },
    issues: [],
    shouldRewrite: false,
    revisionInstructions: "",
    reason: "越界",
  });
  assert.equal(result.success, false);
});

test("维度缺失被拒绝", () => {
  const result = CritiqueSchema.safeParse({
    status: "ok",
    schemaVersion: "reflection.v1",
    scores: { relevance: 4, completeness: 3, groundedness: 5 },
    issues: [],
    shouldRewrite: false,
    revisionInstructions: "",
    reason: "缺维度",
  });
  assert.equal(result.success, false);
});

test("建议重写却没有修订指令时被拒绝", () => {
  const result = CritiqueSchema.safeParse({
    status: "ok",
    schemaVersion: "reflection.v1",
    scores: validScores,
    issues: [],
    shouldRewrite: true,
    revisionInstructions: "   ",
    reason: "缺指令",
  });
  assert.equal(result.success, false);
});

test("原始响应会被截断到上限内", () => {
  const raw = "x".repeat(1000);
  const error = buildCritiqueError("api_error", { raw });
  assert.ok(error.raw.length <= 500);
  assert.ok(truncateCritiqueRaw(raw).length <= 500);
});

test("失败结果的重试次数不允许为负", () => {
  const error = buildCritiqueError("timeout", { retries: -3 });
  assert.equal(error.retries, 0);
});
