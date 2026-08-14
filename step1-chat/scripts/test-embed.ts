/**
 * 向量化自测：同句应高度相似；近义高于无关句。
 *
 * 用法：npx tsx scripts/test-embed.ts
 */
import { cosine, embed, EMBED_DIM } from "../server/rag/embedding.js";

const same = "退款须在到货 7 日内申请，需提供订单号。";
const close = "到货一周内可以退款，要带订单号。";
const unrelated = "今天北京适合出门吗？";

console.log("loading local bge-large-zh-v1.5 (q8) ...");
const [v1, v2, vClose, vUnrelated] = await embed([same, same, close, unrelated]);

const sameScore = cosine(v1, v2);
const closeScore = cosine(v1, vClose);
const farScore = cosine(v1, vUnrelated);

console.log(`dim=${v1.length} (expect ${EMBED_DIM})`);
console.log(`same vs same      = ${sameScore.toFixed(4)}  (expect ~0.99+)`);
console.log(`same vs close     = ${closeScore.toFixed(4)}  (expect high)`);
console.log(`same vs unrelated = ${farScore.toFixed(4)}  (expect lower)`);

if (v1.length !== EMBED_DIM) {
  throw new Error("维度不对");
}
if (sameScore < 0.99) {
  throw new Error(`同句相似度过低: ${sameScore}`);
}
if (closeScore <= farScore) {
  throw new Error(`近义句应高于无关句: close=${closeScore} far=${farScore}`);
}

console.log("OK");
