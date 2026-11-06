import { readdir } from "node:fs/promises";
import { EOL } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TOOL_TAGS } from "./types.js";
import type { ToolModule, ToolModuleMcp } from "./types.js";

export interface DiscoverOptions {
  rootDir?: string;
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolModuleMcp(value: unknown): value is ToolModuleMcp {
  if (!isRecord(value) || typeof value.expose !== "boolean") {
    return false;
  }
  return value.inputSchema === undefined || isRecord(value.inputSchema);
}

function isToolModule(value: unknown): value is ToolModule {
  if (!isRecord(value)) {
    return false;
  }
  const schema = value.schema;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isRecord(schema) &&
    isRecord(schema.function) &&
    typeof schema.function.name === "string" &&
    typeof value.run === "function" &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => TOOL_TAGS.includes(tag as never)) &&
    new Set(value.tags).size === value.tags.length &&
    (value.risk === "read" || value.risk === "confirm") &&
    (value.mcp === undefined || isToolModuleMcp(value.mcp))
  );
}

function assertConsistent(tool: ToolModule): void {
  if (tool.name !== tool.schema.function.name) {
    throw new Error(
      `工具模块 ${tool.name} 的 name 与 schema.function.name 不一致`,
    );
  }
}

/**
 * 固定目录发现：只扫描 modules/ 下的一级目录，不加载任意路径。
 * 目录名排序保证日志、测试和注册顺序稳定。
 */
export async function discoverTools(options: DiscoverOptions = {}): Promise<ToolModule[]> {
  const rootDir = options.rootDir ?? path.join(import.meta.dirname, "modules");
  const entries = await readdir(rootDir, { withFileTypes: true });
  const moduleDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const tools: ToolModule[] = [];
  for (const moduleDir of moduleDirs) {
    const moduleUrl = pathToFileURL(path.join(rootDir, moduleDir, "index.ts")).href;
    const imported: unknown = await import(moduleUrl);
    if (!isRecord(imported) || !("tool" in imported)) {
      throw new Error(`工具模块 ${moduleDir} 必须导出 tool`);
    }
    const candidate = imported.tool;
    if (!isToolModule(candidate)) {
      throw new Error(
        `工具模块 ${moduleDir} 缺少合法的 name、schema、run、tags 或 risk`,
      );
    }
    assertConsistent(candidate);
    tools.push(candidate);
  }

  const names = tools.map((tool) => tool.name);
  const duplicates = names.filter(
    (name, index) => names.indexOf(name) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(`工具名重复：${[...new Set(duplicates)].join("、")}`);
  }
  options.log?.(
    `[tools] discovered count=${tools.length} tools=${JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        tags: [...tool.tags],
        risk: tool.risk,
        mcp: tool.mcp?.expose === true,
      })),
    )}${EOL}`,
  );
  return tools;
}
