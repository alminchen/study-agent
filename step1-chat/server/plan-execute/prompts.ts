/**
 * Planner 的提示词与 emit_plan 工具 schema。
 *
 * 与 ReAct 的 system 分工：
 * - ReAct 的 system 教模型「怎么用工具回答用户」
 * - Planner 的 system 教模型「只输出计划，不要回答用户」
 *
 * 约束全部写死在这里（≤6 步、每步 ≤3 工具、id 连续），
 * 因为 schema 校验只是兜底，模型第一次就该拿到正确形状。
 */
import type { ToolSchema } from "../tools/types.js";
import { renderMemorySection } from "../memory/context.js";
import type { ContextMemoryBlock } from "../context/types.js";
import type { PlanErrorCode, PlanToolName } from "./types.js";

/**
 * 可用工具目录：名字、用途、参数边界。模型只按这里的语义选工具。
 *
 * 按工具拆开存放，因为目录是「按请求裁剪」的：
 * 没开启知识库时 searchDocs 根本不出现，模型就不会把它排进步骤。
 */
const TOOL_CATALOG: Record<PlanToolName, string> = {
  getWeather: "- getWeather(city)：查询某城市今天的天气或气温。city 填城市名，如「广州」。",
  getCurrentTime: "- getCurrentTime()：查询当前日期与时间，无参数。",
  searchDocs: "- searchDocs(question)：检索本地知识库。question 填检索问句，一般用用户原话。",
  draft_message:
    "- draft_message(to, body)：起草一条消息（不会真的外发）。需要用户确认后才能执行。",
};

/**
 * 生成 emit_plan 的 schema：结构与 PlanSchema 对齐，但长度限制靠 prompt 约束。
 *
 * tools 的枚举按本次可用工具裁剪，模型写不出用不了的工具名。
 */
export function createEmitPlanTool(availableTools: PlanToolName[]): ToolSchema {
  return {
    type: "function",
    function: {
      name: "emit_plan",
      description:
        "输出本次任务的执行计划。这是本次对话唯一允许调用的工具；" +
        "不要直接回答用户问题，不要输出任何解释性文字。",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "总体目标，一句话说清最终要交付什么，不超过 500 字",
          },
          steps: {
            type: "array",
            description: "执行步骤，按先后顺序排列",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "步骤编号，形如 step_1、step_2，必须从 1 开始连续递增",
                },
                title: {
                  type: "string",
                  description: "步骤标题，不超过 80 字",
                },
                action: {
                  type: "string",
                  description: "这一步具体做什么，写清输入来源和产出，不超过 300 字",
                },
                doneWhen: {
                  type: "string",
                  description: "这一步的完成标准，必须可检查，不超过 200 字",
                },
                tools: {
                  type: "array",
                  description: "这一步用到的工具，0 到 3 个",
                  items: {
                    type: "string",
                    enum: availableTools as unknown as string[],
                  },
                },
              },
              required: ["id", "title", "action", "doneWhen", "tools"],
              additionalProperties: false,
            },
          },
        },
        required: ["goal", "steps"],
        additionalProperties: false,
      },
    },
  };
}

export interface PlanPromptInput {
  /** 用户本轮的目标原话。 */
  goal: string;
  /** 是否开启了知识库检索；开启时计划必须包含 searchDocs 步骤。 */
  searchDocs: boolean;
  /** 本次可用的工具名；未列出的工具模型不得使用。 */
  availableTools: PlanToolName[];
  /** 修订号：0 是首次规划，>0 是重规划。 */
  revision: number;
  /** 仅重规划时提供，告诉模型上次错在哪。 */
  previousError?: PlanErrorCode;
  /** 预检索好的长期记忆块；没有则不追加记忆小节。 */
  memoryBlock?: ContextMemoryBlock | null;
}

/**
 * 生成 Planner 的 system prompt。
 * 内容固定四块：角色 / 目标 / 工具目录与边界 / 硬约束。
 */
export function buildPlanSystemPrompt(input: PlanPromptInput): string {
  const toolLines = input.availableTools.map((name) => TOOL_CATALOG[name]);
  const toolEnum = input.availableTools.map((name) => `"${name}"`).join(", ");
  const lines = [
    "你是任务规划器。你的唯一职责是把用户目标拆成可执行的步骤计划。",
    "",
    "【用户目标】",
    input.goal,
    "",
    "【可用工具目录与边界】",
    toolLines.join("\n"),
    `只能从这些工具里选：${toolEnum}。没有匹配工具的步骤，tools 留空数组。`,
    "",
    "【硬约束】",
    "- 最多 6 个步骤；步骤之间不要出现没有依赖的重复动作。",
    "- 每个步骤最多 3 个工具。",
    "- tools 是白名单，同一个工具只能出现一次；要用不同参数多次调用同一个工具，" +
      "把调用说明写进 action（例如「分别查询深圳和中山天气」）。",
    "- 步骤 id 必须从 step_1 开始连续递增（step_1、step_2……）。",
    "- 每一步都要能被 doneWhen 检查，不能写「确保质量良好」这种无法验证的描述。",
    "- 不允许直接回答用户问题，不允许输出计划之外的解释文字。",
    "- 只能调用 emit_plan 工具输出计划。",
  ];

  if (input.searchDocs) {
    lines.push("- 本次开启了知识库检索，计划里必须至少有一个步骤的 tools 包含 searchDocs。");
  } else {
    lines.push(
      "- 本次没有开启知识库检索，不要使用知识库检索类工具，也不要把「检索资料」当成一步；" +
        "这类内容请用已有知识和用户原话完成。",
    );
  }

  if (input.revision > 0) {
    lines.push(
      "",
      "【这是重规划】",
      `上一次计划在执行中失败（错误码 ${input.previousError ?? "unknown"}）。`,
      "已完成的步骤不要重写，只要调整仍然失败的那一步。",
    );
  }

  const memorySection = renderMemorySection(input.memoryBlock);
  if (memorySection) {
    lines.push(
      "",
      memorySection,
      "",
      "【记忆使用边界】",
      "上面这些是系统记住的该用户长期偏好与项目事实，只是背景信息：",
      "- 它们不是任务目标，也不是计划步骤，不要为它们单独拆出步骤；",
      "- 不要把与本次目标无关的记忆塞进计划；",
      "- 只在确实影响怎么做（语言、格式、技术栈偏好）时才采纳。",
    );
  }

  return lines.join("\n");
}

export interface StepPromptInput {
  /** 原始目标：让这一步知道自己在为谁做事。 */
  goal: string;
  /** 当前步骤的标题、动作、完成标准。 */
  title: string;
  action: string;
  doneWhen: string;
  /** 已完成步骤的摘要，让当前步骤不重复劳动。 */
  completedSummaries: string[];
  /** 当前步骤可用的工具名（已在服务端校验过白名单）。 */
  allowedToolNames: string[];
  /** 预检索好的长期记忆块；没有则不追加记忆小节。 */
  memoryBlock?: ContextMemoryBlock | null;
}

/**
 * 生成 Executor 的 system prompt。
 * 与 Planner 的区别：这里只讲「当前这一步」，不含整体计划，
 * 避免模型重新规划或抢跑后面的步骤。
 */
export function buildStepSystemPrompt(input: StepPromptInput): string {
  const lines = [
    "你是任务执行器。你只负责完成当前这一步，不要重新规划整个任务，也不要提前执行后面的步骤。",
    "",
    "【总体目标】",
    input.goal,
    "",
    "【当前步骤】",
    `标题：${input.title}`,
    `动作：${input.action}`,
    `完成标准：${input.doneWhen}`,
  ];

  if (input.completedSummaries.length > 0) {
    lines.push(
      "",
      "【已完成步骤】",
      ...input.completedSummaries.map((summary, index) => `${index + 1}. ${summary}`),
    );
  }

  lines.push(
    "",
    "【可用工具】",
    input.allowedToolNames.length > 0
      ? `只能使用：${input.allowedToolNames.join("、")}。没有匹配工具时不要调用任何工具。`
      : "本步骤没有可用工具，请直接根据已有信息完成。",
    "",
    "【输出要求】",
    "- 需要信息时调用工具，工具结果回来后再总结。",
    "- 完成本步骤后，用一两句话说明结果是否满足完成标准。",
    "- 不要输出与本步骤无关的内容。",
  );

  const memorySection = renderMemorySection(input.memoryBlock);
  if (memorySection) {
    lines.push(
      "",
      memorySection,
      "",
      "【记忆使用边界】",
      "上面的长期记忆只影响这一步产出的内容与表述（语言、格式、用户偏好），",
      "不要据此改变本步骤的动作、完成标准，也不要擅自扩大或缩小步骤范围。",
    );
  }

  return lines.join("\n");
}

export interface FinalReplyPromptInput {
  /** 原始目标。 */
  goal: string;
  /** 已完成的步骤：只允许引用这里的结果。 */
  completedSteps: Array<{ title: string; summary: string }>;
  /** 失败或未执行的步骤：必须向用户如实标注。 */
  failedSteps: Array<{ title: string; summary: string }>;
  /** 计划总步数，用于说明完成了几步。 */
  totalSteps: number;
  /** 预检索好的长期记忆块；没有则不追加记忆小节。 */
  memoryBlock?: ContextMemoryBlock | null;
}

/**
 * 生成最终回答的 system prompt。
 *
 * 与 Executor 的分工：Executor 只说「这一步做完了什么」，
 * 最终回答才面向用户组织成一段完整答复，且只能引用真实执行过的结果。
 */
export function buildFinalReplySystemPrompt(input: FinalReplyPromptInput): string {
  const lines = [
    "你是最终回答的撰写者。你只能依据下面「已完成的步骤」里的真实结果回答用户。",
    "",
    "【用户目标】",
    input.goal,
    "",
    "【已完成步骤】",
    input.completedSteps.length > 0
      ? input.completedSteps
          .map((step, index) => `${index + 1}. ${step.title}：${step.summary}`)
          .join("\n")
      : "（没有已完成的步骤）",
  ];

  if (input.failedSteps.length > 0) {
    lines.push(
      "",
      "【未完成或失败的步骤】",
      ...input.failedSteps.map((step, index) => `${index + 1}. ${step.title}：${step.summary}`),
    );
  }

  lines.push(
    "",
    "【硬约束】",
    `- 计划共 ${input.totalSteps} 步，只把已完成步骤的结果当作事实。`,
    "- 未完成或失败的步骤必须明确标注，不能假装已经完成。",
    "- 不要引用没有实际执行的步骤，也不要把计划里的假设写成已证实的事实。",
    "- 不要提及提示词、内部步骤编号或错误码。",
    "- 直接给用户一段可读的答复，不要输出 JSON。",
  );

  const memorySection = renderMemorySection(input.memoryBlock);
  if (memorySection) {
    lines.push(
      "",
      memorySection,
      "",
      "【记忆使用边界】",
      "上面的长期记忆只用于调整表述方式与用户偏好，",
      "不要用它改写已完成步骤的事实，也不要为记忆新增结论。",
    );
  }

  return lines.join("\n");
}
