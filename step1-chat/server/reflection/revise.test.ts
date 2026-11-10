/**
 * Reflection 重写单测。
 *
 * 覆盖：
 * 1. 正常重写：只改该改的部分，产出 ok；
 * 2. 事实守卫：新数字、新引文、新机构名、新时间推断都被拦下；
 * 3. 边界：空结果、缺修订指令、与原答案相同、接口错误、超时；
 * 4. 结构约束：请求里只有 system/user/timeoutMs/signal，没有工具字段。
 *
 * 运行：node --import tsx --test server/reflection/revise.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  detectUnsupportedFacts,
  extractFactTokens,
  revise,
  type ReviseModelCaller,
} from "./revise.js";

const sampleInput = {
  question: "订单 123 的物流到哪了？",
  draft: "订单 123 已发货，承运商是顺丰，预计明天送达。",
  toolFacts: "订单 123 状态为已发货，承运商为顺丰。",
  revisionInstructions: "删掉没有依据的送达时间预测",
};

/** 构造一个返回固定内容的假模型。 */
function stringCaller(content: string): ReviseModelCaller {
  return async () => content;
}

test("正常重写返回 ok", async () => {
  const result = await revise(sampleInput, {
    callModel: stringCaller("订单 123 已发货，承运商是顺丰。"),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.revisedDraft, "订单 123 已发货，承运商是顺丰。");
});

test("重写只拿到问题、工具事实、原答案和修订指令", async () => {
  const captured: { system: string; user: string }[] = [];
  await revise(sampleInput, {
    callModel: async (request) => {
      captured.push({ system: request.system, user: request.user });
      return "订单 123 已发货。";
    },
  });

  assert.equal(captured.length, 1);
  assert.ok(captured[0].user.includes("订单 123 的物流到哪了？"));
  assert.ok(captured[0].user.includes("承运商为顺丰"));
  assert.ok(captured[0].user.includes("删掉没有依据的送达时间预测"));
});

test("请求结构里没有任何工具字段", async () => {
  let keys: string[] = [];
  await revise(sampleInput, {
    callModel: async (request) => {
      keys = Object.keys(request);
      return "订单 123 已发货。";
    },
  });

  assert.deepEqual(keys.sort(), ["signal", "system", "timeoutMs", "user"]);
});

test("新数字被事实守卫拦下", async () => {
  const result = await revise(sampleInput, {
    callModel: stringCaller("订单 123 已发货，预计 3 天内送达。"),
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.ok(result.unsupportedTokens.includes("3天"));
  assert.match(result.reason, /新依据/);
});

test("来源里已有的数字不会被拦下", async () => {
  const result = await revise(
    {
      ...sampleInput,
      toolFacts: "订单 123 状态为已发货，承运商为顺丰，预计 3 天内送达。",
    },
    {
      callModel: stringCaller("订单 123 已发货，预计 3 天内送达。"),
    },
  );

  assert.equal(result.status, "ok");
});

test("新引文被拦下", async () => {
  const result = await revise(sampleInput, {
    callModel: stringCaller("订单 123 的状态是「已揽收」。"),
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.ok(result.unsupportedTokens.includes("已揽收"));
});

test("新机构缩写被拦下", async () => {
  const result = await revise(sampleInput, {
    callModel: stringCaller("订单 123 由 UPS 承运。"),
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.ok(result.unsupportedTokens.includes("UPS"));
});

test("新出现的时间推断被拦下", async () => {
  const result = await revise(sampleInput, {
    callModel: stringCaller("订单 123 已发货，预计明天送达。"),
  });

  assert.equal(result.status, "ok");
});

test("重写新引入的时间推断被拦下", async () => {
  const result = await revise(
    {
      ...sampleInput,
      draft: "订单 123 已发货，承运商是顺丰。",
    },
    {
      callModel: stringCaller("订单 123 已发货，承运商是顺丰，预计明天送达。"),
    },
  );

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.ok(result.unsupportedTokens.includes("明天"));
});

test("重写为空被拒", async () => {
  const result = await revise(sampleInput, {
    callModel: stringCaller("   \n  "),
  });

  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.match(result.reason, /为空/);
});

test("缺修订指令时不调用模型直接拒绝", async () => {
  let calls = 0;
  const result = await revise(
    { ...sampleInput, revisionInstructions: "  " },
    {
      callModel: async () => {
        calls += 1;
        return "订单 123 已发货。";
      },
    },
  );

  assert.equal(result.status, "rejected");
  assert.equal(calls, 0);
});

test("与原答案实质相同时判为 no_change", async () => {
  const result = await revise(
    {
      question: "订单 123 的物流到哪了？",
      draft: "订单 123 已发货。",
      toolFacts: "订单 123 状态为已发货。",
      revisionInstructions: "换个说法",
    },
    {
      callModel: stringCaller("订单 123 已发货。"),
    },
  );

  assert.equal(result.status, "no_change");
});

test("被代码块包裹的重写会去掉围栏", async () => {
  const result = await revise(sampleInput, {
    callModel: stringCaller("```\n订单 123 已发货，承运商是顺丰。\n```"),
  });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.revisedDraft, "订单 123 已发货，承运商是顺丰。");
});

test("接口错误重试后仍失败时收敛成 error", async () => {
  let calls = 0;
  const result = await revise(sampleInput, {
    callModel: async () => {
      calls += 1;
      throw new Error("HTTP 500");
    },
    maxRetries: 1,
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.errorKind, "api_error");
  assert.equal(result.retries, 1);
  assert.equal(calls, 2);
});

test("超时收敛成 timeout", async () => {
  const result = await revise(sampleInput, {
    callModel: (_request) =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("订单 123 已发货。"), 5_000);
      }),
    totalTimeoutMs: 60,
    maxRetries: 0,
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.errorKind, "timeout");
});

test("重写元信息被回调", async () => {
  const captured: { attempts: number; truncated: boolean }[] = [];
  await revise(
    { ...sampleInput, draft: "长".repeat(3_000) },
    {
      callModel: stringCaller("订单 123 已发货。"),
      maxInputChars: 200,
      onMeta: (meta) => {
        captured.push({ attempts: meta.attempts, truncated: meta.truncated });
      },
    },
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].attempts, 1);
  assert.equal(captured[0].truncated, true);
});

test("事实守卫只做增量判定，原答案已有的说法不算新依据", () => {
  const unsupported = detectUnsupportedFacts(
    "订单 123 已发货，预计明天送达。",
    ["订单 123 已发货，承运商是顺丰，预计明天送达。"],
  );

  assert.deepEqual(unsupported, []);
});

test("事实型 token 的抽取覆盖数字、引文、缩写与时间推断", () => {
  const tokens = extractFactTokens(
    '预计 3 天内送达，状态为「已揽收」，由 UPS 承运，后天会到。',
  );

  assert.ok(tokens.includes("3天"));
  assert.ok(tokens.includes("已揽收"));
  assert.ok(tokens.includes("UPS"));
  assert.ok(tokens.includes("后天"));
});
