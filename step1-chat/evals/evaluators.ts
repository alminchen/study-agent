import type { EvalExpect, EvalRunResult, EvalVerdict } from "./types.js";

/** 规则判分：轨迹 / 输出禁则 / 是否抛错。不用 LLM 当老师。 */
export function evaluateRun(run: EvalRunResult, expect: EvalExpect): EvalVerdict {
  const reasons: string[] = [];

  const mustSucceed = expect.mustSucceed !== false;
  if (mustSucceed && run.error) {
    reasons.push(`error:${run.error.slice(0, 160)}`);
  }

  for (const name of expect.toolsInclude ?? []) {
    if (!run.tools.includes(name)) {
      reasons.push(`toolsInclude:${name}`);
    }
  }

  for (const name of expect.toolsExclude ?? []) {
    if (run.tools.includes(name)) {
      reasons.push(`toolsExclude:${name}`);
    }
  }

  for (const pattern of expect.mustNotMatch ?? []) {
    if (run.output.includes(pattern)) {
      reasons.push(`output:命中「${pattern}」`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}
