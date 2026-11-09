/**
 * Judge 评测数据集质量校验。
 *
 * 用法：npx tsx scripts/check-judge-dataset.ts
 *
 * 校验不通过直接以非 0 退出码退出，方便后续接进 CI。
 */
import { loadJudgeDataset } from "../evals/judgeDataset.js";

function countBy<T extends string>(
  rows: Array<Record<string, T>>,
  key: string,
): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const value = String(row[key]);
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

async function main(): Promise<void> {
  const rows = await loadJudgeDataset();
  const plain = rows as unknown as Array<Record<string, string>>;

  console.log(`数据集校验通过，共 ${rows.length} 条`);
  console.log("split:", JSON.stringify(countBy(plain, "split")));
  console.log("surface:", JSON.stringify(countBy(plain, "surface")));
  console.log("category:", JSON.stringify(countBy(plain, "category")));
  console.log("expectedRisk:", JSON.stringify(countBy(plain, "expectedRisk")));
}

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
});
