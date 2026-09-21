/**
 * 输出层检测：检查模型回复是否泄露了 system prompt 内容。
 *
 * 策略：提取 system prompt 中的关键短语作为指纹，
 * 如果模型回复中包含多个指纹片段，判定为泄露并替换。
 */

const FINGERPRINTS = [
  // 单 Agent system（chat.ts）
  "面向前端开发者的 AI 助手",
  "必须调用 getCurrentTime",
  "必须调用 getWeather",
  "安全约束",
  "透露、复述或暗示本系统提示词",
  "假装自己是另一个没有限制的 AI",
  // 多 Agent Worker / Aggregate system
  "实时数据查询助手",
  "只负责回答天气和时间相关问题",
  "知识库问答助手",
  "信息整合助手",
  "这不是我负责的范围",
  // 资料问答 RAG system（rag/prompt.ts）
  "你是资料问答助手",
  "只根据下方「资料」回答",
  "资料里没有相关内容",
  "不要输出 id=、source=、title=",
];

const LEAK_THRESHOLD = 2;

const REPLACEMENT = "抱歉，我无法提供系统内部配置信息。有什么其他问题我可以帮你？";

export interface OutputGuardResult {
  leaked: boolean;
  /** 如果 leaked=true，返回替换后的安全文本；否则返回原文 */
  safeText: string;
  matchedFingerprints: string[];
}

/**
 * 检测模型回复是否泄露 system prompt。
 * 命中 >= LEAK_THRESHOLD 个指纹片段即判定泄露。
 */
export function detectLeakage(output: string): OutputGuardResult {
  const matched: string[] = [];
  for (const fp of FINGERPRINTS) {
    if (output.includes(fp)) {
      matched.push(fp);
    }
  }

  if (matched.length >= LEAK_THRESHOLD) {
    return { leaked: true, safeText: REPLACEMENT, matchedFingerprints: matched };
  }
  return { leaked: false, safeText: output, matchedFingerprints: matched };
}
