/**
 * 图片 token 估算（保守值）。
 *
 * 公式：先按最长边 2048 等比缩放，再按 512×512 分块；
 * tokens = ceil((85 + 170 × 块数) × 1.2)。
 *
 * 这是估算值，与供应商真实计费不同；usage 里单独记账，不混入文本 token。
 */
export function estimateImageTokens(width: number, height: number): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return 0;
  }

  const TARGET_LONG_EDGE = 2048;
  const BLOCK_SIZE = 512;
  const BASE_TOKENS = 85;
  const TOKENS_PER_BLOCK = 170;
  const SAFETY_MARGIN = 1.2;

  // 等比缩放到最长边不超过 2048，不放大小图
  const scale = Math.min(1, TARGET_LONG_EDGE / Math.max(width, height));
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;

  const blocks =
    Math.ceil(scaledWidth / BLOCK_SIZE) * Math.ceil(scaledHeight / BLOCK_SIZE);

  return Math.ceil((BASE_TOKENS + TOKENS_PER_BLOCK * blocks) * SAFETY_MARGIN);
}
