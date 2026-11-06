import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverTools } from "./discover.js";

/**
 * 每个用例一个独立目录：用例之间互不污染（否则先建的坏模块会抢先抛错），
 * 并且放在系统临时目录里，不往仓库里落 temp_tools/。
 */
async function setupTempDir(name: string) {
  const dir = path.join(os.tmpdir(), "study-ai-tools-test", name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function createModule(dir: string, moduleName: string, content: string) {
  const moduleDir = path.join(dir, moduleName);
  await fs.mkdir(moduleDir, { recursive: true });
  await fs.writeFile(path.join(moduleDir, "index.ts"), content);
}

test("discoverTools 鲁棒性测试", async (t) => {
  await t.test("合法模块可被正确发现", async () => {
    const root = await setupTempDir("discovery_ok");
    await createModule(root, "test_tool", `
      export const tool = {
        name: "test_tool",
        tags: ["realtime"],
        risk: "read",
        schema: { function: { name: "test_tool", description: "desc", parameters: { type: "object", properties: {} } } },
        run: async () => "ok"
      };
    `);
    const tools = await discoverTools({ rootDir: root });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "test_tool");
  });

  await t.test("缺少 tool 导出应抛出错误", async () => {
    const root = await setupTempDir("discovery_no_export");
    await createModule(root, "bad_module", `export const somethingElse = {};`);
    await assert.rejects(
      async () => await discoverTools({ rootDir: root }),
      { message: /必须导出 tool/ }
    );
  });

  await t.test("非法 risk 字段应抛出错误", async () => {
    const root = await setupTempDir("discovery_bad_risk");
    await createModule(root, "bad_risk", `
      export const tool = {
        name: "bad_risk",
        tags: ["realtime"],
        risk: "invalid",
        schema: { function: { name: "bad_risk", description: "desc", parameters: { type: "object", properties: {} } } },
        run: async () => "ok"
      };
    `);
    await assert.rejects(
      async () => await discoverTools({ rootDir: root }),
      { message: /缺少合法的 name、schema、run、tags 或 risk/ }
    );
  });

  await t.test("重复工具名应抛出错误", async () => {
    const root = await setupTempDir("discovery_duplicate");
    await createModule(root, "dup1", `
      export const tool = {
        name: "duplicate",
        tags: ["realtime"],
        risk: "read",
        schema: { function: { name: "duplicate", description: "desc", parameters: { type: "object", properties: {} } } },
        run: async () => "ok"
      };
    `);
    await createModule(root, "dup2", `
      export const tool = {
        name: "duplicate",
        tags: ["realtime"],
        risk: "read",
        schema: { function: { name: "duplicate", description: "desc", parameters: { type: "object", properties: {} } } },
        run: async () => "ok"
      };
    `);
    await assert.rejects(
      async () => await discoverTools({ rootDir: root }),
      { message: /工具名重复/ }
    );
  });
});
