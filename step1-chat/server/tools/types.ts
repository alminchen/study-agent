import type { ZodType } from "zod";

/**
 * 发给模型的 tools 项（OpenAI 兼容格式）。
 * 只描述「能调什么、参数长什么样」，不含本地执行逻辑。
 */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };
  };
}

/**
 * 本地工具的完整形状：schema 在 schemas/，run 在 methods/，由 index.ts 粘合。
 * arguments 进 run 时仍是字符串（接口原样），由各工具自己 JSON.parse。
 */
export interface ToolDefinition {
  name: string;
  schema: ToolSchema;
  run: (rawArguments: string) => unknown | Promise<unknown>;
}

export const TOOL_TAGS = ["realtime", "kb", "action"] as const;
export type ToolTag = (typeof TOOL_TAGS)[number];
export type ToolRisk = "read" | "confirm";

export interface ToolModuleMcp {
  expose: boolean;
  /**
   * MCP 入参 schema（zod raw shape）。
   * MCP 协议要求参数用 zod 描述，和发给模型的 JSON Schema 不是同一种格式，
   * 所以这里单独声明；缺省视为「无参数」，注册时会补空 shape。
   */
  inputSchema?: Record<string, ZodType>;
}

export interface ToolModule extends ToolDefinition {
  tags: readonly ToolTag[];
  risk: ToolRisk;
  includeInDefaultChat?: boolean;
  mcp?: ToolModuleMcp;
}
