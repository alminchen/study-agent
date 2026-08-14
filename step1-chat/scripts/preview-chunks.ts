/**
 * 切分预览：打印每块 id / 标题 / 字数 / 前 30 字，用于入库前自测。
 *
 * 用法：npx tsx scripts/preview-chunks.ts [markdown路径]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "../server/rag/chunker.js";

const filePath = path.resolve(
  process.argv[2] ?? "docs-sample/stage3-rag-notes.md",
);
const source = path.basename(filePath);
const markdown = await readFile(filePath, "utf8");
const chunks = chunkMarkdown(markdown, source);

console.log(`source: ${source}`);
console.log(`chars: ${markdown.length}`);
console.log(`chunks: ${chunks.length}`);
console.log(`maxChars=400 overlapRatio=0.15`);
console.log("---");

for (const chunk of chunks) {
  const preview = chunk.text.replace(/\s+/g, " ").slice(0, 30);
  console.log(
    `[${chunk.source}]|[${chunk.seq}] ${chunk.id} | title="${chunk.title}" | len=${chunk.text.length} | ${preview}…`,
  );
}

console.log("---");
console.log("自测清单：");
console.log("1. 单独读每一块，能否看懂");
console.log("2. 标题和正文是否被拆开");
console.log("3. 相邻块交界句是否至少出现在一块里");
console.log("4. 有无空块 / 纯目录 / 页码块");
console.log("5. 是否都有 id / source / title / text / seq");
