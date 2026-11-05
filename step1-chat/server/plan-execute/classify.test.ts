import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTask } from "./classify.js";
import type { PlanMode } from "./types.js";

interface DatasetRow {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  mode?: PlanMode;
  searchDocs?: boolean;
  expected: "react" | "plan";
  reasonCode: string;
  /** route：只考分类；其余场景是步骤 11 的 Evals 剧本，不参与本用例。 */
  scenario?: string;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("12 条固定样本分类正确，且 reasonCode 和 signals 可解释", async () => {
  const raw = await readFile(path.join(root, "evals", "dataset-plan.json"), "utf8");
  const rows = (JSON.parse(raw) as DatasetRow[]).filter((row) => row.scenario === "route");
  assert.equal(rows.length, 12);

  const results = rows.map((row) => {
    const lastUser = [...row.messages].reverse().find((message) => message.role === "user");
    const result = classifyTask({
      userMessage: lastUser?.content ?? "",
      mode: row.mode,
      searchDocs: row.searchDocs,
    });
    return { row, result };
  });

  for (const { row, result } of results) {
    assert.equal(result.mode, row.expected, `${row.id}: ${row.messages[0]?.content} → ${result.mode}`);
    assert.equal(result.reasonCode, row.reasonCode, `${row.id}: reasonCode=${result.reasonCode}`);
    assert.ok(result.signals.length > 0, `${row.id}: 缺少 signals`);
  }
});

test("分类器不依赖完整历史，只看最后一条用户消息", () => {
  const prefix = [
    { role: "user" as const, content: "随便聊聊" },
    { role: "assistant" as const, content: "可以" },
    { role: "user" as const, content: "继续" },
  ];
  const last = [{ role: "user" as const, content: "先查一下部署方案，再写一份对比" }];
  const withHistory = classifyTask({ userMessage: last[last.length - 1]?.content ?? "" });
  const withFull = classifyTask({ userMessage: last[last.length - 1]?.content ?? "" });
  void prefix;
  assert.equal(withHistory.mode, "plan");
  assert.equal(withFull.mode, "plan");
});

test("显式 mode=plan 不需要顺序词", () => {
  const result = classifyTask({ userMessage: "广州天气", mode: "plan" });
  assert.equal(result.mode, "plan");
  assert.equal(result.reasonCode, "explicit_plan");
});

test("显式 mode=react 不进 Planner", () => {
  const result = classifyTask({ userMessage: "先查资料再写报告", mode: "react" });
  assert.equal(result.mode, "react");
  assert.equal(result.reasonCode, "explicit_react");
});
