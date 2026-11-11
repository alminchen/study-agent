import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateImageTokens } from "./estimateImageTokens.js";

/**
 * 图片 token 估算公式（保守值，乘以安全余量）：
 * 先按最长边 2048 等比缩放，再按 512×512 分块；
 * tokens = ceil((85 + 170 × 块数) × 1.2)。
 */

test("1x1 图片：1 块，含余量", () => {
  assert.equal(estimateImageTokens(1, 1), 306);
});

test("512x512 图片：1 块，含余量", () => {
  assert.equal(estimateImageTokens(512, 512), 306);
});

test("1024x1024 图片：4 块，含余量", () => {
  assert.equal(estimateImageTokens(1024, 1024), 918);
});

test("2048x2048 图片：16 块，含余量", () => {
  assert.equal(estimateImageTokens(2048, 2048), 3366);
});

test("超长边图片先等比缩放到 2048 再分块", () => {
  // 4096x2048 → 缩放到 2048x1024 → 4×2=8 块
  assert.equal(estimateImageTokens(4096, 2048), 1734);
});

test("非法尺寸返回 0，不抛错", () => {
  assert.equal(estimateImageTokens(0, 0), 0);
  assert.equal(estimateImageTokens(-1, 100), 0);
  assert.equal(estimateImageTokens(Number.NaN, 100), 0);
});

