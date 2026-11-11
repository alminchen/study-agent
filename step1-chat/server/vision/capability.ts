/**
 * 模型 Vision 能力判定。
 *
 * 能力来源优先级（越靠前越硬）：
 *  1. 运行期降级集合：该模型真实请求被供应商拒绝过，本进程内记为不支持
 *  2. 调用方显式白名单（函数参数）
 *  3. 环境变量 VISION_CAPABLE_MODELS（逗号分隔；显式列了清单就不再走启发式）
 *  4. 模型 id 启发式（gpt-4o / gpt-5 / vision / omni / qwen-vl 等）
 */
const VISION_HEURISTIC_PATTERN = /gpt-4o|gpt-5|vision|omni|qwen.*vl/i;

/** 运行期被供应商拒绝过图片请求的模型；只在本进程内有效。 */
const visionUnsupportedModels = new Set<string>();

export interface VisionCapabilityOptions {
  /** 显式能力白名单；提供了就只信这份清单，不再走环境变量与启发式。 */
  whitelist?: readonly string[];
}

/** 把模型的运行期降级记入进程内集合：带图请求被供应商拒绝后调用。 */
export function markVisionUnsupportedModel(model: string): void {
  const name = model?.trim();
  if (name) visionUnsupportedModels.add(name);
}

export function isVisionCapableModel(
  model: string,
  options: VisionCapabilityOptions = {},
): boolean {
  const name = model?.trim();
  if (!name) return false;

  // 被拒过的模型绝不再发图
  if (visionUnsupportedModels.has(name)) return false;

  if (options.whitelist) {
    return options.whitelist.includes(name);
  }

  const envList = process.env.VISION_CAPABLE_MODELS?.trim();
  if (envList) {
    const ids = envList
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.includes(name);
  }

  return VISION_HEURISTIC_PATTERN.test(name);
}
