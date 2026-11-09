/**
 * LLM-as-Judge 单测。
 *
 * 覆盖三件事：
 * 1. Schema 契约：成功样本字段完整，失败样本不带 risk；
 * 2. 异常降级：超时 / 非法 JSON / 接口报错 / schema 不合规，都收敛成 error；
 * 3. 时机约束：未缓冲的输出即使在 enforce 模式下也只能降级为 shadow，
    绝不出现「文本已发出再判定要拦」。
 *
 * 运行：node --import tsx --test server/guard/judge.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { judgeOutput, type JudgeModelCaller } from "./judge.js";
import { runOutputJudge, type JudgeTraceEvent } from "./judgeRuntime.js";
import { REPLACEMENT } from "./outputGuard.js";

/** 构造一个返回固定 JSON 的假模型。 */
function jsonCaller(payload: unknown): JudgeModelCaller {
  return async () => JSON.stringify(payload);
}

/** 构造一个高风险判定结果（用于 enforce 分支）。 */
const highRiskPayload = {
  risk: "high",
  confidence: 0.92,
  categories: ["system_leak"],
  shortReason: "输出中包含系统提示词原文",
  matchedRules: ["system_prompt_echo"],
};

/** 临时切换 JUDGE_MODE，测试结束自动还原。 */
async function withJudgeMode<T>(
  mode: "off" | "shadow" | "enforce",
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.JUDGE_MODE;
  process.env.JUDGE_MODE = mode;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.JUDGE_MODE;
    } else {
      process.env.JUDGE_MODE = previous;
    }
  }
}

test("schema 校验：合法输出产出完整 ok 结果", async () => {
  const result = await judgeOutput("一段正常回答", {
    callModel: jsonCaller({
      risk: "none",
      confidence: 0.8,
      categories: ["safe_output"],
      shortReason: "未发现泄露",
      matchedRules: [],
    }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.schemaVersion, 1);
  if (result.status !== "ok") return;
  assert.equal(result.risk, "none");
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.categories, ["safe_output"]);
  assert.equal(result.shortReason, "未发现泄露");
});

test("schema 校验：error 分支不带 risk 字段", async () => {
  const result = await judgeOutput("任意文本", {
    callModel: jsonCaller({ ...highRiskPayload, risk: "critical" }),
  });

  assert.equal(result.status, "error");
  assert.equal("risk" in result, false);
});

test("异常降级：schema 不合规收敛为 schema_error", async () => {
  const result = await judgeOutput("任意文本", {
    callModel: jsonCaller({ ...highRiskPayload, risk: "critical" }),
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.errorKind, "schema_error");
  assert.equal(result.retries, 0);
  assert.ok(result.raw.length > 0);
});

test("异常降级：非法 JSON 收敛为 bad_json", async () => {
  const result = await judgeOutput("任意文本", {
    callModel: async () => "这不是 JSON",
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.errorKind, "bad_json");
});

test("异常降级：模型调用抛错收敛为 api_error", async () => {
  const result = await judgeOutput("任意文本", {
    callModel: async () => {
      throw new Error("HTTP 500");
    },
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.errorKind, "api_error");
});

test("异常降级：超时收敛为 timeout", async () => {
  const result = await judgeOutput("任意文本", {
    callModel: () => new Promise<string>(() => undefined),
    totalTimeoutMs: 60,
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.errorKind, "timeout");
});

test("off 模式：不调用模型、不产出事件", async () => {
  let called = false;
  const events: JudgeTraceEvent[] = [];

  const outcome = await withJudgeMode("off", () =>
    runOutputJudge({
      text: "一段正常回答",
      regexLeaked: false,
      emit: (event) => events.push(event),
      callModel: async () => {
        called = true;
        return JSON.stringify(highRiskPayload);
      },
    }),
  );

  assert.equal(called, false);
  assert.equal(events.length, 0);
  assert.equal(outcome.action, "allow");
});

test("时机约束：未缓冲的输出在 enforce 下只发 shadow 事件", async () => {
  const events: JudgeTraceEvent[] = [];

  const outcome = await withJudgeMode("enforce", () =>
    runOutputJudge({
      text: "一段增量输出",
      regexLeaked: false,
      buffered: false,
      emit: (event) => events.push(event),
      callModel: jsonCaller(highRiskPayload),
    }),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "judge_shadow");
  assert.equal(events[0].surface, "output");
  // 未缓冲时不可能拦住已发出的文本，所以只能放行。
  assert.equal(outcome.action, "allow");
});

test("已缓冲的输出在 enforce 下给出 flag 建议，但不改写答案", async () => {
  const events: JudgeTraceEvent[] = [];

  const outcome = await withJudgeMode("enforce", () =>
    runOutputJudge({
      text: "这里重复了系统提示词……",
      regexLeaked: false,
      buffered: true,
      emit: (event) => events.push(event),
      callModel: jsonCaller(highRiskPayload),
    }),
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, "judge_enforced");
  if (event.type !== "judge_enforced") return;
  assert.equal(event.surface, "output");
  assert.equal(event.action, "flag");

  assert.equal(outcome.action, "flag");
  assert.equal(outcome.leaked, true);
  // 正则未命中时没有 safeText，退回统一口径文案。
  assert.equal(outcome.suggestedSafeText, REPLACEMENT);
});

test("shadow 模式：只记录，不给动作", async () => {
  const events: JudgeTraceEvent[] = [];

  const outcome = await withJudgeMode("shadow", () =>
    runOutputJudge({
      text: "这里重复了系统提示词……",
      regexLeaked: false,
      emit: (event) => events.push(event),
      callModel: jsonCaller(highRiskPayload),
    }),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "judge_shadow");
  assert.equal(outcome.action, "allow");
});

test("enforce 下判定失败回退正则结论，且不产生拦截", async () => {
  const events: JudgeTraceEvent[] = [];

  const outcome = await withJudgeMode("enforce", () =>
    runOutputJudge({
      text: "任意文本",
      regexLeaked: true,
      regexSafeText: REPLACEMENT,
      emit: (event) => events.push(event),
      callModel: async () => {
        throw new Error("HTTP 500");
      },
    }),
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, "judge_enforced");
  if (event.type !== "judge_enforced") return;
  assert.equal(event.label, "judge_error");
  assert.equal(outcome.action, "allow");
  assert.equal(outcome.leaked, true);
});
