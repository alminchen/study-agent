# evals/ — 评测数据集与判分

## 这个目录在干什么

回答「改完之后到底变好了还是变差了」。评测由三部分组成：
**数据集**（考题）、**判分器**（评分规则）、**执行脚本**（在 `scripts/` 里）。

## 文件说明

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 共享类型：考题结构、期望项、运行结果、判定结果 |
| `evaluators.ts` | 规则判分：轨迹 / 输出禁则 / 是否抛错，**不用 LLM 当老师** |
| `judgeDataset.ts` | 加载并校验 Judge 数据集 |
| `reflectionDataset.ts` | 加载并校验 Reflection 数据集 |
| `dataset.json` | 单 Agent 评测集 |
| `dataset-multi.json` | 多 Agent 评测集 |
| `dataset-plan.json` | Plan 评测集（22 条） |
| `judge-dataset.json` | LLM-as-Judge 评测集 |
| `dataset-reflection.json` | Reflection 评测集 |

## 两套判分体系

| | 规则判分 | LLM-as-Judge |
| --- | --- | --- |
| 在哪 | `evaluators.ts` | `judgeDataset.ts` + `scripts/run-judge-evals.ts` |
| 怎么看 | 固定问句 + 规则（必须调了哪个工具、不能出现哪些词、有没有抛错） | 把输入和输出交给一个裁判模型打分 |
| 优点 | 快、便宜、可复现、CI 能跑 | 能判「回答好不好」这种没有标准答案的东西 |
| 缺点 | 只能判形式，判不了质量 | 贵、慢、有裁判自身的偏差 |

**先用规则判分筛掉明显错误，再用 Judge 看质量。** 顺序反了就是在用贵的方式做便宜的事。

## 数据集原则

> 校验失败直接抛错退出，不静默跳过。

数据集是所有指标的唯一分母，一条坏样本就足以让 precision / recall 失去意义。
静默跳过坏样本等于在指标里掺水。

Reflection 数据集只描述「问题 + 事实 + 预期」，**不预置答案**：
初版答案由基线链路真实生成，反思链路拿同一份初版去改，
两边比的是同一件事，差异只来自反思本身。

## 报告

评测跑完会落到 `evals/` 下的 Markdown 报告：

| 报告 | 内容 |
| --- | --- |
| `judge-comparison-report.md` | Judge 在不同数据集上的表现对比 |
| `judge-comparison-report.smoke.md` | 冒烟版（样本量小，跑得快） |
| `reflection-comparison-report.md` | 反思到底帮不帮得上忙，代价是多少 |

## 相关文档

- `scripts/README.md`：评测脚本用法
- `docs/reflection.md`：反思的评测口径与当前状态
- `docs/llm-judge.md`：判定的评测口径与准入条件
