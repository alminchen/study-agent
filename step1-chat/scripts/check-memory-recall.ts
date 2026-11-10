/**
 * 记忆检索召回校验（可复跑）。
 *
 * 存在的理由：`SIMILARITY_THRESHOLD` 这个数字必须能被复现，
 * 否则以后谁想调它，都只能靠感觉拍脑袋。
 *
 * 这个脚本做的事：
 *   1. 用**真实**的本地 bge-large-zh-v1.5 算向量（不造假 embedder）
 *   2. 事实文本用产品里同一个函数 `memoryEmbeddingText` 生成（不自己拼字符串）
 *   3. 断言：相关对必须召回，无关对必须不召回
 *
 * 用法：`node --import tsx scripts/check-memory-recall.ts`
 * 退出码非 0 = 阈值与事实文本形式不再匹配，需要重新标定。
 *
 * 属于：进阶学习第 8 项 · Memory（指令 5 的第 3 项修复配套）
 */

import assert from "node:assert/strict";
import { embed, cosine } from "../server/rag/embedding.js";
import { SIMILARITY_THRESHOLD, memoryEmbeddingText } from "../server/memory/types.js";

/** [问题, 记忆的 key, 记忆的 value, 是否相关] */
const CASES: Array<[string, string, string, boolean]> = [
  // ---- 相关对：问的是记忆里记着的事 ----
  ["以后都用中文回答", "语言", "中文", true],
  ["回答风格偏好", "风格", "回答风格偏好", true],
  ["不要用 emoji", "风格", "不使用 emoji", true],
  ["这个项目用什么框架", "框架", "Vue 3 + Vite", true],
  ["以后回答请简洁一点", "风格", "回答要简洁", true],
  ["用 TypeScript 还是 JavaScript", "语言", "TypeScript", true],
  ["我的邮箱是什么", "邮箱", "zhang@example.com", true],
  ["测试用什么跑", "测试框架", "vitest", true],
  ["帮我看下这个 bug", "调试偏好", "先看日志再猜", true],
  ["以后都用 TypeScript 写", "语言", "TypeScript", true],
  // ---- 无关对：问的和记忆没关系，召回了就是噪音 ----
  ["今天天气怎么样", "语言", "中文", false],
  ["帮我写个爬虫", "语言", "中文", false],
  ["讲个笑话", "风格", "不使用 emoji", false],
  ["现在几点", "语言", "中文", false],
  ["帮我订张机票", "框架", "Vue 3 + Vite", false],
  ["翻译成英文", "语言", "中文", false],
  ["这个函数为什么报错", "测试框架", "vitest", false],
];

const queries = [...new Set(CASES.map(([query]) => query))];
const queryVectors = await embed(queries);
const queryIndex = new Map(queries.map((query, index) => [query, index]));

// 事实文本必须和写入时一模一样，否则测出来的相似度不是产品真实行为。
const factTexts = CASES.map(([, key, value]) => memoryEmbeddingText({ key, value }));
const factVectors = await embed(factTexts);

console.log(`检索阈值 SIMILARITY_THRESHOLD = ${SIMILARITY_THRESHOLD}\n`);

const failures: string[] = [];
const relevantScores: number[] = [];
const irrelevantScores: number[] = [];

CASES.forEach(([query, key, value, isRelevant], index) => {
  const similarity = cosine(
    queryVectors[queryIndex.get(query) as number],
    factVectors[index],
  );
  const recalled = similarity >= SIMILARITY_THRESHOLD;
  const correct = recalled === isRelevant;
  if (!correct) failures.push(`「${query}」↔「${factTexts[index]}」相似度 ${similarity.toFixed(3)}`);
  (isRelevant ? relevantScores : irrelevantScores).push(similarity);
  console.log(
    `${correct ? "ok  " : "FAIL"} ${similarity.toFixed(3)} ${recalled ? "召回" : "丢弃"}  ` +
      `「${query}」↔「${factTexts[index]}」`,
  );
});

const minRelevant = Math.min(...relevantScores);
const maxIrrelevant = Math.max(...irrelevantScores);

console.log(`\n相关对 最低相似度 = ${minRelevant.toFixed(3)}`);
console.log(`无关对 最高相似度 = ${maxIrrelevant.toFixed(3)}`);
console.log(`分离间隔 = ${(minRelevant - maxIrrelevant).toFixed(3)}`);

if (failures.length > 0) {
  console.error(`\n召回校验失败 ${failures.length} 条：`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\n阈值需要重新标定：别急着改数字，先看事实文本形式是不是变了。");
  process.exit(1);
}

assert.ok(minRelevant > maxIrrelevant, "相关对与无关对必须可分离");
console.log("\n召回校验通过。");
