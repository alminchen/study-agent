import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolCall } from "./toolCallGuard.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Guard 允许注册表里的 4 个工具", () => {
  for (const name of ["getWeather", "getCurrentTime", "searchDocs", "draft_message"]) {
    assert.equal(validateToolCall(name, "{}").allowed, true, name);
  }
});

test("Guard 拒绝未注册工具", () => {
  const result = validateToolCall("deleteAllFiles", "{}");
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /白名单/);
});

test("Guard 保持参数长度和 JSON 校验行为不变", () => {
  const oversized = "x".repeat(2049);
  assert.equal(validateToolCall("getWeather", oversized).allowed, false);
  assert.equal(validateToolCall("getWeather", "{bad").allowed, false);
  assert.equal(validateToolCall("getWeather", "{}").allowed, true);
});

test("Guard 不再维护独立工具名单", async () => {
  const source = await readFile(
    path.join(root, "server/guard/toolCallGuard.ts"),
    "utf8",
  );
  for (const name of ["getWeather", "getCurrentTime", "searchDocs", "draft_message"]) {
    assert.equal(source.includes(name), false, name);
  }
  assert.equal(source.includes("ALLOWED_TOOLS"), false);
  assert.equal(source.includes("listToolNames()"), true);
});
