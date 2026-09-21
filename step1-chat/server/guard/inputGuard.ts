/**
 * 输入层 Prompt Injection 检测。
 *
 * 设计思路：
 * - 不拦截、不修改用户输入——只做"标记风险等级"
 * - 调用方拿到结果后自行决定：放行 / 降级 / 拒绝
 * - 规则分两档：high（明确的注入意图）、medium（可疑但可能误杀）
 * - 所有规则用正则实现，轻量无依赖，不调外部 API
 */

export type RiskLevel = "none" | "medium" | "high";

export interface GuardResult {
  level: RiskLevel;
  /** 命中的规则 ID，调试用 */
  matchedRules: string[];
}

interface Rule {
  id: string;
  level: "medium" | "high";
  pattern: RegExp;
}

const RULES: Rule[] = [
  // --- HIGH: 明确的注入意图 ---
  {
    id: "ignore_instructions",
    level: "high",
    pattern: /忽略.{0,10}(之前|以上|所有|前面).{0,10}(指令|指示|规则|设定|system)/i,
  },
  {
    id: "ignore_instructions_en",
    level: "high",
    pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?)/i,
  },
  {
    id: "new_role",
    level: "high",
    pattern: /(从现在起|从现在开始|now\s+you\s+are)\s*.{0,20}(你是|扮演|act\s+as|role)/i,
  },
  {
    id: "output_system_prompt",
    level: "high",
    pattern: /(输出|打印|显示|重复|repeat|print|output).{0,15}(system\s*prompt|系统提示|系统消息|系统指令)/i,
  },
  {
    id: "dan_jailbreak",
    level: "high",
    pattern: /\bDAN\b.{0,30}(没有限制|无限制|no\s+restrictions?|do\s+anything)/i,
  },

  // --- MEDIUM: 可疑但可能是正常讨论 ---
  {
    id: "role_play_request",
    level: "medium",
    pattern: /(假装|pretend|simulate).{0,20}(你是|you\s+are|你没有|no\s+rules)/i,
  },
  {
    id: "base64_extract",
    level: "medium",
    pattern: /(base64|编码|encode).{0,20}(system|指令|prompt|第一条消息)/i,
  },
  {
    id: "developer_mode",
    level: "medium",
    pattern: /(开发者模式|developer\s+mode|maintenance\s+mode|调试模式)/i,
  },
];

/**
 * 检测用户输入的注入风险等级。
 * 返回最高命中等级和所有命中规则 ID。
 */
export function detectInjection(input: string): GuardResult {
  const matchedRules: string[] = [];
  let level: RiskLevel = "none";

  for (const rule of RULES) {
    if (rule.pattern.test(input)) {
      matchedRules.push(rule.id);
      if (rule.level === "high") {
        level = "high";
      } else if (level !== "high") {
        level = "medium";
      }
    }
  }

  return { level, matchedRules };
}
