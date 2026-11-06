import assert from "node:assert/strict";
import test from "node:test";
import {
  findTool,
  listToolNames,
  toolsWithMcp,
  toolSchemas,
  toolSchemasForChat,
  isToolRequiringConfirm,
} from "./index.js";
import { getWeatherTool } from "./schemas/weather.js";
import { getCurrentTimeTool } from "./schemas/time.js";
import { searchDocsTool } from "./schemas/searchDocs.js";
import { draftMessageTool } from "./schemas/draftMessage.js";

const expectedSchemaByName = new Map([
  ["draft_message", draftMessageTool],
  ["getCurrentTime", getCurrentTimeTool],
  ["getWeather", getWeatherTool],
  ["searchDocs", searchDocsTool],
]);

test("注册表顺序和 schema 身份与迁移前一致", () => {
  assert.deepEqual(listToolNames(), ["draft_message", "getCurrentTime", "getWeather", "searchDocs"]);
  for (const [name, schema] of expectedSchemaByName) {
    assert.equal(findTool(name)?.schema, schema);
  }
  assert.deepEqual(toolSchemas, [...expectedSchemaByName.values()]);
});

test("Chat schema 四种组合与行为基线一致", () => {
  const names = (includeSearchDocs: boolean, includeConfirmTools = false) =>
    toolSchemasForChat(includeSearchDocs, includeConfirmTools)
      .map((schema) => schema.function.name);

  assert.deepEqual(names(false), ["getCurrentTime", "getWeather"]);
  assert.deepEqual(names(true), ["getCurrentTime", "getWeather", "searchDocs"]);
  assert.deepEqual(names(false, true), ["draft_message", "getCurrentTime", "getWeather"]);
  assert.deepEqual(names(true, true), ["draft_message", "getCurrentTime", "getWeather", "searchDocs"]);
});

test("确认名单动态性与 risk 字段一致", () => {
  assert.equal(isToolRequiringConfirm("draft_message"), true);
  assert.equal(isToolRequiringConfirm("getWeather"), false);
  assert.equal(isToolRequiringConfirm("getCurrentTime"), false);
  assert.equal(isToolRequiringConfirm("searchDocs"), false);
});

test("每个工具模块携带统一的 ToolModule 元数据", async () => {
  const expectations = new Map([
    ["getWeather", { tags: ["realtime"], risk: "read", includeInDefaultChat: true, mcpExposes: true }],
    ["getCurrentTime", { tags: ["realtime"], risk: "read", includeInDefaultChat: true, mcpExposes: true }],
    ["searchDocs", { tags: ["kb"], risk: "read", includeInDefaultChat: false, mcpExposes: true }],
    ["draft_message", { tags: ["action"], risk: "confirm", includeInDefaultChat: true, mcpExposes: false }],
  ]);

  for (const [name, expectation] of expectations) {
    const module = await import(`./modules/${name}/index.js`);
    assert.equal(module.tool.name, name);
    assert.deepEqual(module.tool.tags, expectation.tags);
    assert.equal(module.tool.risk, expectation.risk);
    assert.equal(module.tool.includeInDefaultChat, expectation.includeInDefaultChat);
    assert.equal(module.tool.mcp?.expose ?? false, expectation.mcpExposes);
  }
});

test("MCP 派生集合与改造前一致", () => {
  assert.deepEqual(toolsWithMcp().map((tool) => tool.name), [
    "getCurrentTime",
    "getWeather",
    "searchDocs",
  ]);
});
