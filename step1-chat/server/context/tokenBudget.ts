/**
 * token 预算与保守估算器。
 *
 * 估算口径必须与 `scripts/baseline-context.ts` 里的基线估算器**完全一致**：
 * CJK 字符 × 1.0 + 非 CJK 字符 ÷ 4，每条消息再加 4 的角色/分隔开销。
 * 两边一旦不一致，指令 1 量出来的基线数据和线上预算就没法互相印证。
 *
 * 这层是纯函数，不做 IO、不读环境变量、不含全局可变状态。
 */
import type { TextMessage } from "../react/types.js";

/**
 * CJK 字符判定：日文假名、汉字、兼容汉字、全角标点都算「一个字符约一个 token」。
 * 不带 /g 修饰符，`test` 不会残留 lastIndex 状态，可以安全复用。
 */
const CJK_PATTERN = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** 每条消息的角色/分隔固定开销。 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * 安全系数：估算值 × 1.15 ≤ 预算 才算放得下。
 * 估算器对代码块、JSON 这类「符号密度高」的内容会偏低，
 * 1.15 的余量就是留给这类偏差的（失败路径：中英混排导致估算偏低）。
 */
export const TOKEN_SAFETY_FACTOR = 1.15;

/** 预算下限：窗口再小，也要留一点空间装最近的对话。 */
export const MIN_BUDGET_TOKENS = 1024;

/** 缺省上下文窗口。目标模型官方窗口 65536，这里取 64000 作为保守值。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 64000;

/** 缺省预算比例：只用一个窗口的一半，剩下的留给输出和模型自身的余量。 */
export const DEFAULT_BUDGET_RATIO = 0.5;

/** 判断一个字符是不是 CJK。 */
export function isCjkCharacter(char: string): boolean {
  return CJK_PATTERN.test(char);
}

/**
 * 估算一段文本的 token 数。
 *
 * 口径：CJK 字符数 + 非 CJK 字符数 ÷ 4。
 * 返回值允许是小数（基线脚本按同口径打印小数位），这里保持一致不做取整。
 *
 * 这个函数要覆盖的 6 类输入（B3），每类的处理方式如下：
 *
 * 1. **纯中文长串**：每个汉字算 1 token。中文 tokenizer 通常一个汉字一个 token，
 *    这是估算里最准的一类，误差主要来自生僻字与多字词合并。
 * 2. **纯英文长串**：每个字符算 0.25 token。主流 tokenizer 对英文按词切分，
 *    平均 4 个字符左右一个 token，÷ 4 是常用近似；长英文通常略低估，
 *    由 1.15 安全系数兜底。
 * 3. **中英混排**：两类字符分别计数再相加。混排里标点、emoji、空格都归入「非 CJK」，
 *    会被略微高估一点——高估比低估安全（宁可少注入，不要超窗口）。
 * 4. **含代码块**：缩进、括号、分号、引号全是 ASCII，按 ÷ 4 计。
 *    实际 tokenizer 会把 `=>`、`();` 这类符号串单独切一个 token，
 *    所以代码块的真实开销通常比估算高 10%～20%，这是安全系数存在的主要原因。
 * 5. **含 JSON 工具结果**：同样以 ASCII 为主（键名、引号、逗号、数字），
 *    按 ÷ 4 估算；但 JSON 的标点密度远高于自然语言，真实 token 数更高。
 *    这里不做特殊处理，靠 1.15 覆盖——把工具结果估得更准需要接真实 tokenizer，
 *    属于本阶段之外的成本，不划算。
 * 6. **空字符串与单条超长消息**：空串估 0 token（只算 4 的消息开销）；
 *    单条超长消息不在这里处理，由 buildContext 负责截断，
 *    估算器只保证「估得准」，不做预算决策。
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjkCharacter(char)) cjk += 1;
    else other += 1;
  }
  return cjk + other / 4;
}

/** 估算单条消息的 token 数：正文估算 + 角色/分隔开销。 */
export function estimateMessageTokens(message: TextMessage): number {
  return estimateTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** 估算一组消息的 token 总数。 */
export function estimateMessagesTokens(messages: TextMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** 给估算值套上安全系数，用于和预算比较。 */
export function applySafetyFactor(estimatedTokens: number): number {
  return estimatedTokens * TOKEN_SAFETY_FACTOR;
}

/** 判断一组估算 token 能不能塞进预算（含安全系数）。 */
export function fitsWithinBudget(estimatedTokens: number, budgetTokens: number): boolean {
  return applySafetyFactor(estimatedTokens) <= budgetTokens;
}

/**
 * 按「窗口 × 比例」算出实际预算，并夹在 [MIN_BUDGET_TOKENS, contextWindow] 内。
 * 比例超过 1 时按 1 算（不允许预算超过窗口本身）。
 */
export function resolveBudgetTokens(
  contextWindow: number = DEFAULT_CONTEXT_WINDOW_TOKENS,
  ratio: number = DEFAULT_BUDGET_RATIO,
): number {
  const safeWindow = Math.max(1, Math.floor(contextWindow));
  const safeRatio = Math.min(1, Math.max(0, ratio));
  const raw = safeWindow * safeRatio;
  const clamped = Math.min(safeWindow, Math.max(MIN_BUDGET_TOKENS, raw));
  return Math.floor(clamped);
}
