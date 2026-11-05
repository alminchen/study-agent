/**
 * partial JSON parser 的固定输入集。
 *
 * 每个 fixture 同时声明原始累计文本、预期快照数量和最终是否合法，Mock 回放与
 * parser 验证都从这里取数据，避免出现两套不一致样例。
 */
/** fixture 最终文本应通过还是拒绝 schema。 */
export type FixtureFinalExpectation = "valid" | "invalid";

/** 一段可重复回放的 partial JSON 输入及其预期结果。 */
export interface PartialJsonFixture {
  /** fixture 的稳定 id，测试和 Mock 通过 id 读取同一份文本。 */
  id: string;
  /** 面向开发者的场景说明。 */
  description: string;
  /** 模拟模型累计返回的原始 JSON 文本。 */
  raw: string;
  /** 从空状态一次解析该 raw 时应发送的稳定快照数量。 */
  expectedSnapshotCount: number;
  expectedFinal: FixtureFinalExpectation;
}

export const PARTIAL_JSON_FIXTURES = [
  {
    id: "complete-table",
    description: "完整表格 JSON",
    raw: '{"schemaVersion":1,"block":{"kind":"table","title":"模型对比","columns":["模型","优势"],"rows":[["A","速度快"],["B","能力强"]]}}',
    expectedSnapshotCount: 1,
    expectedFinal: "valid",
  },
  {
    id: "complete-code",
    description: "完整代码 JSON",
    raw: '{"schemaVersion":1,"block":{"kind":"code","title":"常量示例","language":"ts","content":"const answer = 42;"}}',
    expectedSnapshotCount: 1,
    expectedFinal: "valid",
  },
  {
    id: "half-object",
    description: "对象只到一半",
    raw: '{"schemaVersion":1,"block":{"kind":"table","title":"模型对比","columns":["模型","优势"]',
    expectedSnapshotCount: 1,
    expectedFinal: "invalid",
  },
  {
    id: "unterminated-chinese-string",
    description: "字符串中有尚未闭合的双引号和中文",
    raw: '{"schemaVersion":1,"block":{"kind":"code","title":"中文示例","language":"ts","content":"中文内容还没结束',
    expectedSnapshotCount: 0,
    expectedFinal: "invalid",
  },
  {
    id: "escaped-backslashes",
    description: "完整代码字符串中包含反斜杠转义",
    raw: '{"schemaVersion":1,"block":{"kind":"code","title":"路径示例","language":"text","content":"C:\\\\Users\\\\demo"}}',
    expectedSnapshotCount: 1,
    expectedFinal: "valid",
  },
  {
    id: "table-columns-and-first-row",
    description: "表格列完整，第一行也完整",
    raw: '{"schemaVersion":1,"block":{"kind":"table","title":"模型对比","columns":["模型","优势"],"rows":[["A","速度快"]',
    expectedSnapshotCount: 1,
    expectedFinal: "invalid",
  },
  {
    id: "table-last-row-unclosed",
    description: "表格最后一行未闭合",
    raw: '{"schemaVersion":1,"block":{"kind":"table","title":"模型对比","columns":["模型","优势"],"rows":[["A","速度快"],["B","能力强"',
    expectedSnapshotCount: 1,
    expectedFinal: "invalid",
  },
  {
    id: "code-newline-and-backtick",
    description: "完整代码内容包含 JSON 换行转义和反引号",
    raw: '{"schemaVersion":1,"block":{"kind":"code","title":"模板字符串","language":"ts","content":"const value = `hello`;\\nconsole.log(value);"}}',
    expectedSnapshotCount: 1,
    expectedFinal: "valid",
  },
  {
    id: "missing-block-kind",
    description: "缺少 block.kind",
    raw: '{"schemaVersion":1,"block":{"title":"缺少类型","columns":["A"],"rows":[]}}',
    expectedSnapshotCount: 0,
    expectedFinal: "invalid",
  },
  {
    id: "final-column-mismatch",
    description: "最终 JSON 合法，但表格列数与行单元格数不匹配",
    raw: '{"schemaVersion":1,"block":{"kind":"table","title":"错误表格","columns":["模型","优势"],"rows":[["A"]]}}',
    expectedSnapshotCount: 0,
    expectedFinal: "invalid",
  },
] as const satisfies readonly PartialJsonFixture[];

/** 从 fixture 常量推导的合法 id 联合类型。 */
export type PartialJsonFixtureId = (typeof PARTIAL_JSON_FIXTURES)[number]["id"];

/** 按 id 读取 fixture；未知 id 直接抛错，避免 Mock 静默回放错误数据。 */
export function getPartialJsonFixture(id: PartialJsonFixtureId): PartialJsonFixture {
  const fixture = PARTIAL_JSON_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) {
    throw new Error(`Unknown partial JSON fixture: ${id}`);
  }
  return fixture;
}
