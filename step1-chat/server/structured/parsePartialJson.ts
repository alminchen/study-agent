import {
  StructuredSnapshotSchema,
  type StructuredBlock,
  type StructuredSnapshot,
} from "./types.js";

/**
 * 解析模型累计返回的 partial JSON。
 *
 * 这里不用 JSON.parse，因为流式文本可能停在任意位置。parser 会区分：
 * - complete：当前 token 已经有明确结束符。
 * - incomplete：只是文本还没到齐，后续 chunk 仍可能让它合法。
 * - invalid：按 JSON 语法已经不可能恢复。
 *
 * parser 本身不产生 UI 数据，只有“已证明稳定”的字段才会进入 snapshot。
 */

export interface PartialParseState {
  /** 最近一次实际发送给前端的快照版本。 */
  revision: number;
  /** 上一次累计文本长度，用于拦截累计文本倒退。 */
  lastRawLength: number;
  /** 最近一个可渲染快照；后续快照只能在此基础上单调增长。 */
  lastSnapshot: StructuredSnapshot | null;
}

export interface ParseStructuredChunkResult {
  /** 下一次解析必须带上的状态；即使没有新快照也会更新累计文本长度。 */
  state: PartialParseState;
  /** 本次新产生的快照；没有稳定增长时为 null。 */
  nextSnapshot: StructuredSnapshot | null;
  diagnostic: string | null;
}

type ParseStatus = "complete" | "incomplete" | "invalid";

/**
 * partial JSON 的轻量语法树。
 *
 * 未闭合对象和数组也会保留已经解析出的子字段，方便下一次累计更多文本后重建；
 * complete 只表示该 token 自身是否已经闭合，不代表整个根对象已完成。
 */
interface PartialJsonObject {
  kind: "object";
  value: Record<string, PartialJsonValue>;
  complete: boolean;
}

interface PartialJsonArray {
  kind: "array";
  value: PartialJsonValue[];
  complete: boolean;
}

interface PartialJsonString {
  kind: "string";
  value: string;
  complete: boolean;
}

interface PartialJsonNumber {
  kind: "number";
  value: number;
  complete: boolean;
}

interface PartialJsonBoolean {
  kind: "boolean";
  value: boolean;
  complete: boolean;
}

interface PartialJsonNull {
  kind: "null";
  value: null;
  complete: boolean;
}

type PartialJsonValue =
  | PartialJsonObject
  | PartialJsonArray
  | PartialJsonString
  | PartialJsonNumber
  | PartialJsonBoolean
  | PartialJsonNull;

interface ParseValueResult {
  status: ParseStatus;
  value: PartialJsonValue | null;
  nextIndex: number;
}

/** JSON 只允许四种空白字符，不能直接依赖 trim 的 Unicode 行为。 */
function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

/** 返回第一个非空白字符位置；到达文本末尾时返回 source.length。 */
function skipWhitespace(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length && isWhitespace(source[index])) index += 1;
  return index;
}

/**
 * 只有遇到未转义的闭合双引号才把字符串标成 complete。
 * 已经读到的内容会保留，但构建快照时不会使用未闭合字符串。
 */
function parseJsonString(source: string, startIndex: number): ParseValueResult {
  if (source[startIndex] !== '"') {
    return { status: "invalid", value: null, nextIndex: startIndex };
  }

  let value = "";
  let index = startIndex + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      return {
        status: "complete",
        value: { kind: "string", value, complete: true },
        nextIndex: index + 1,
      };
    }
    if (char === "\\") {
      const escape = source[index + 1];
      if (escape === undefined) {
        return {
          status: "incomplete",
          value: { kind: "string", value, complete: false },
          nextIndex: source.length,
        };
      }
      if (escape === "u") {
        const hex = source.slice(index + 2, index + 6);
        if (hex.length < 4) {
          return {
            status: "incomplete",
            value: { kind: "string", value, complete: false },
            nextIndex: source.length,
          };
        }
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { status: "invalid", value: null, nextIndex: index + 6 };
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      const escaped = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      }[escape];
      if (escaped === undefined) {
        return { status: "invalid", value: null, nextIndex: index + 2 };
      }
      value += escaped;
      index += 2;
      continue;
    }
    if (char.charCodeAt(0) < 0x20) {
      return { status: "invalid", value: null, nextIndex: index + 1 };
    }
    value += char;
    index += 1;
  }

  return {
    status: "incomplete",
    value: { kind: "string", value, complete: false },
    nextIndex: source.length,
  };
}

/**
 * 小数点和指数符号本身不构成合法数字。
 * 文本在它们后面结束时属于 incomplete，等待后续数字即可。
 */
/** 解析 JSON number；末尾停在 -、小数点或指数符号时视为 incomplete。 */
function parseJsonNumber(source: string, startIndex: number): ParseValueResult {
  let index = startIndex;
  if (source[index] === "-") index += 1;

  const integerStart = index;
  while (index < source.length && /\d/.test(source[index])) index += 1;
  if (index === integerStart) {
    return { status: "invalid", value: null, nextIndex: index };
  }
  if (source[index] === ".") {
    index += 1;
    const fractionStart = index;
    while (index < source.length && /\d/.test(source[index])) index += 1;
    if (index === fractionStart) {
      return { status: "incomplete", value: null, nextIndex: source.length };
    }
  }
  if (source[index] === "e" || source[index] === "E") {
    index += 1;
    if (source[index] === "+" || source[index] === "-") index += 1;
    const exponentStart = index;
    while (index < source.length && /\d/.test(source[index])) index += 1;
    if (index === exponentStart) {
      return { status: "incomplete", value: null, nextIndex: source.length };
    }
  }

  const raw = source.slice(startIndex, index);
  return {
    status: "complete",
    value: { kind: "number", value: Number(raw), complete: true },
    nextIndex: index,
  };
}

/** 解析 true/false/null，并区分“token 还没打完”和“已经非法”。 */
function parseJsonLiteral(
  source: string,
  startIndex: number,
  token: "true" | "false" | "null",
  value: boolean | null,
): ParseValueResult {
  const remaining = source.slice(startIndex);
  if (token.startsWith(remaining) && remaining.length < token.length) {
    return { status: "incomplete", value: null, nextIndex: source.length };
  }
  if (!source.startsWith(token, startIndex)) {
    return { status: "invalid", value: null, nextIndex: startIndex };
  }

  const parsed: PartialJsonNull | PartialJsonBoolean =
    token === "null"
      ? { kind: "null", value: null, complete: true }
      : { kind: "boolean", value: value === true, complete: true };
  return {
    status: "complete",
    value: parsed,
    nextIndex: startIndex + token.length,
  };
}

/**
 * 数组未闭合时仍返回 incomplete 数组，并保留已经完整解析的元素。
 * completedRows 会进一步过滤掉其中未闭合的行。
 */
function parseJsonArray(source: string, startIndex: number): ParseValueResult {
  const values: PartialJsonValue[] = [];
  let index = skipWhitespace(source, startIndex + 1);
  if (index >= source.length) {
    return {
      status: "incomplete",
      value: { kind: "array", value: values, complete: false },
      nextIndex: index,
    };
  }
  if (source[index] === "]") {
    return {
      status: "complete",
      value: { kind: "array", value: values, complete: true },
      nextIndex: index + 1,
    };
  }

  while (index < source.length) {
    const parsed = parseJsonValue(source, index);
    if (parsed.status === "invalid") {
      return parsed;
    }
    if (parsed.value) values.push(parsed.value);
    index = skipWhitespace(source, parsed.nextIndex);
    if (parsed.status === "incomplete") {
      return {
        status: "incomplete",
        value: { kind: "array", value: values, complete: false },
        nextIndex: index,
      };
    }
    if (index >= source.length) {
      return {
        status: "incomplete",
        value: { kind: "array", value: values, complete: false },
        nextIndex: index,
      };
    }
    if (source[index] === "]") {
      return {
        status: "complete",
        value: { kind: "array", value: values, complete: true },
        nextIndex: index + 1,
      };
    }
    if (source[index] !== ",") {
      return { status: "invalid", value: null, nextIndex: index };
    }
    index = skipWhitespace(source, index + 1);
    if (index >= source.length) {
      return {
        status: "incomplete",
        value: { kind: "array", value: values, complete: false },
        nextIndex: index,
      };
    }
  }

  return {
    status: "incomplete",
    value: { kind: "array", value: values, complete: false },
    nextIndex: index,
  };
}

/**
 * 对象同样允许“外层未闭合，但部分字段已经完整”。
 * 例如 columns 已经闭合、rows 尚未出现时，可以据此生成表格骨架。
 */
function parseJsonObject(source: string, startIndex: number): ParseValueResult {
  const properties: Record<string, PartialJsonValue> = {};
  let index = skipWhitespace(source, startIndex + 1);
  if (index >= source.length) {
    return {
      status: "incomplete",
      value: { kind: "object", value: properties, complete: false },
      nextIndex: index,
    };
  }
  if (source[index] === "}") {
    return {
      status: "complete",
      value: { kind: "object", value: properties, complete: true },
      nextIndex: index + 1,
    };
  }

  while (index < source.length) {
    const key = parseJsonString(source, index);
    if (key.status !== "complete" || key.value?.kind !== "string") {
      return {
        status: key.status,
        value:
          key.status === "incomplete"
            ? { kind: "object", value: properties, complete: false }
            : null,
        nextIndex: key.nextIndex,
      };
    }

    index = skipWhitespace(source, key.nextIndex);
    if (index >= source.length) {
      return {
        status: "incomplete",
        value: { kind: "object", value: properties, complete: false },
        nextIndex: index,
      };
    }
    if (source[index] !== ":") {
      return { status: "invalid", value: null, nextIndex: index };
    }

    index = skipWhitespace(source, index + 1);
    if (index >= source.length) {
      return {
        status: "incomplete",
        value: { kind: "object", value: properties, complete: false },
        nextIndex: index,
      };
    }
    const parsedValue = parseJsonValue(source, index);
    if (parsedValue.status === "invalid") {
      return parsedValue;
    }
    if (parsedValue.value) {
      properties[key.value.value] = parsedValue.value;
    }
    if (parsedValue.status === "incomplete") {
      return {
        status: "incomplete",
        value: { kind: "object", value: properties, complete: false },
        nextIndex: parsedValue.nextIndex,
      };
    }

    index = skipWhitespace(source, parsedValue.nextIndex);
    if (index >= source.length) {
      return {
        status: "incomplete",
        value: { kind: "object", value: properties, complete: false },
        nextIndex: index,
      };
    }
    if (source[index] === "}") {
      return {
        status: "complete",
        value: { kind: "object", value: properties, complete: true },
        nextIndex: index + 1,
      };
    }
    if (source[index] !== ",") {
      return { status: "invalid", value: null, nextIndex: index };
    }
    index = skipWhitespace(source, index + 1);
    if (index >= source.length) {
      return {
        status: "incomplete",
        value: { kind: "object", value: properties, complete: false },
        nextIndex: index,
      };
    }
  }

  return {
    status: "incomplete",
    value: { kind: "object", value: properties, complete: false },
    nextIndex: index,
  };
}

/** 根据首字符分派 JSON 值类型；未知首字符直接判为 invalid。 */
function parseJsonValue(source: string, startIndex: number): ParseValueResult {
  const index = skipWhitespace(source, startIndex);
  if (index >= source.length) {
    return { status: "incomplete", value: null, nextIndex: index };
  }

  const char = source[index];
  if (char === '"') return parseJsonString(source, index);
  if (char === "{") return parseJsonObject(source, index);
  if (char === "[") return parseJsonArray(source, index);
  if (char === "t") return parseJsonLiteral(source, index, "true", true);
  if (char === "f") return parseJsonLiteral(source, index, "false", false);
  if (char === "n") return parseJsonLiteral(source, index, "null", null);
  if (char === "-" || /\d/.test(char)) return parseJsonNumber(source, index);
  return { status: "invalid", value: null, nextIndex: index };
}

/** 安全收窄 partial JSON 节点为对象。 */
function asObject(
  value: PartialJsonValue | null | undefined,
): PartialJsonObject | null {
  return value?.kind === "object" ? value : null;
}

/** 安全收窄 partial JSON 节点为数组。 */
function asArray(value: PartialJsonValue | undefined): PartialJsonArray | null {
  return value?.kind === "array" ? value : null;
}

/** 只有完整闭合的字符串才允许进入 UI 快照。 */
function completeString(value: PartialJsonValue | undefined): string | null {
  return value?.kind === "string" && value.complete ? value.value : null;
}

/** 只有完整解析的数字才允许参与 schemaVersion 判断。 */
function completeNumber(value: PartialJsonValue | undefined): number | null {
  return value?.kind === "number" && value.complete ? value.value : null;
}

/** 完整字符串数组是 columns 可渲染的最低条件。 */
function completeStringArray(value: PartialJsonValue | undefined): string[] | null {
  const array = asArray(value);
  if (!array?.complete) return null;

  const strings: string[] = [];
  for (const item of array.value) {
    const text = completeString(item);
    if (text === null) return null;
    strings.push(text);
  }
  return strings;
}

/**
 * 只收录自身已经闭合、且所有单元格都是完整字符串的表格行。
 * 最后半行会留在 partial JSON 树里，但不会进入可渲染快照。
 */
function completedRows(value: PartialJsonValue | undefined): string[][] {
  const array = asArray(value);
  if (!array) return [];

  const rows: string[][] = [];
  for (const item of array.value) {
    const row = asArray(item);
    if (!row?.complete) continue;
    const cells = completeStringArray(row);
    if (cells) rows.push(cells);
  }
  return rows;
}

/**
 * 把宽松的 partial JSON 树转换为严格的 UI 快照。
 *
 * 只有当 kind 和当前 block 所需的字段都已完整时才构造 candidate，并用
 * StructuredSnapshotSchema 再做一次边界、列数和行数校验。校验失败时安静返回
 * null，让路由层继续等待更多 chunk。
 */
function buildStableBlock(root: PartialJsonObject, revision: number): StructuredBlock | null {
  const schemaVersion = completeNumber(root.value.schemaVersion);
  if (schemaVersion !== 1) return null;

  const block = asObject(root.value.block);
  if (!block) return null;
  const kind = completeString(block.value.kind);
  const title = completeString(block.value.title);
  if (!title) return null;

  if (kind === "table") {
    const columns = completeStringArray(block.value.columns);
    if (!columns) return null;
    const candidate = {
      schemaVersion: 1,
      revision,
      block: {
        kind: "table" as const,
        title,
        columns,
        rows: completedRows(block.value.rows),
      },
    };
    const parsed = StructuredSnapshotSchema.safeParse(candidate);
    return parsed.success ? parsed.data.block : null;
  }

  if (kind === "code") {
    const language = completeString(block.value.language);
    const content = block.value.content;
    if (!language || content?.kind !== "string" || !content.complete) return null;
    const candidate = {
      schemaVersion: 1,
      revision,
      block: {
        kind: "code" as const,
        title,
        language,
        content: content.value,
      },
    };
    const parsed = StructuredSnapshotSchema.safeParse(candidate);
    return parsed.success ? parsed.data.block : null;
  }

  return null;
}

/** 首版 block 很小，用稳定 JSON 比较即可判断内容是否真的增长。 */
function blocksEqual(left: StructuredBlock, right: StructuredBlock): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 检查新快照是否可以覆盖旧快照。
 *
 * UI 只能向前增长：类型和元数据不能变化，表格旧行不能被改写，代码内容只能追加。
 * 这里返回诊断而不是抛错，因为不可接受的中间态可能只是上游异常，不代表整个响应
 * 已经结束。
 */
function canAdvance(
  previous: StructuredSnapshot,
  next: StructuredBlock,
): { allowed: boolean; diagnostic: string | null } {
  if (previous.block.kind !== next.kind) {
    return { allowed: false, diagnostic: "snapshot_kind_changed" };
  }

  if (previous.block.kind === "code" && next.kind === "code") {
    if (
      previous.block.title !== next.title ||
      previous.block.language !== next.language
    ) {
      return { allowed: false, diagnostic: "code_metadata_changed" };
    }
    if (!next.content.startsWith(previous.block.content)) {
      return { allowed: false, diagnostic: "code_content_not_append_only" };
    }
  }

  if (previous.block.kind === "table" && next.kind === "table") {
    if (
      previous.block.title !== next.title ||
      JSON.stringify(previous.block.columns) !== JSON.stringify(next.columns)
    ) {
      return { allowed: false, diagnostic: "table_metadata_changed" };
    }
    if (next.rows.length < previous.block.rows.length) {
      return { allowed: false, diagnostic: "table_rows_shrank" };
    }
    for (let index = 0; index < previous.block.rows.length; index += 1) {
      if (
        JSON.stringify(previous.block.rows[index]) !==
        JSON.stringify(next.rows[index])
      ) {
        return { allowed: false, diagnostic: "table_row_changed" };
      }
    }
  }

  return { allowed: true, diagnostic: null };
}

/**
 * 解析到目前为止累计的文本，并在出现新的稳定内容时生成一个快照。
 *
 * 调用方每次只传“最新累计文本 + 上一次返回的 state”；函数不读取网络、不写 SSE，
 * 因此同一组输入会得到可重复验证的结果。
 */
export function parseStructuredChunk(
  accumulatedText: string,
  previous: PartialParseState,
): ParseStructuredChunkResult {
  // 累计文本倒退通常意味着调用方拼接错误，不能把旧快照误判为新的合法输入。
  if (accumulatedText.length < previous.lastRawLength) {
    return {
      state: {
        revision: previous.revision,
        lastRawLength: accumulatedText.length,
        lastSnapshot: structuredClone(previous.lastSnapshot),
      },
      nextSnapshot: null,
      diagnostic: "accumulated_text_shrank",
    };
  }

  let nextSnapshot: StructuredSnapshot | null = null;
  let diagnostic: string | null = null;

  const rootResult = parseJsonValue(accumulatedText, 0);
  const root = asObject(rootResult.value);
  if (rootResult.status === "invalid") {
    // 记录诊断但不抛错；后续 chunk 仍可能构成一次新的解析尝试。
    diagnostic = "partial_json_invalid";
  } else if (root) {
    const nextBlock = buildStableBlock(root, previous.revision + 1);
    if (nextBlock && previous.lastSnapshot) {
      // 内容没变化时不增加 revision，避免前端处理重复快照。
      if (!blocksEqual(previous.lastSnapshot.block, nextBlock)) {
        const advance = canAdvance(previous.lastSnapshot, nextBlock);
        if (advance.allowed) {
          nextSnapshot = {
            schemaVersion: 1,
            revision: previous.revision + 1,
            block: nextBlock,
          };
        } else {
          diagnostic = advance.diagnostic;
        }
      }
    } else if (nextBlock) {
      nextSnapshot = {
        schemaVersion: 1,
        revision: previous.revision + 1,
        block: nextBlock,
      };
    }
  }

  // 没有新快照时保留旧快照和 revision，但仍记录原始文本已经增长到哪个位置。
  const state: PartialParseState = {
    revision: nextSnapshot?.revision ?? previous.revision,
    lastRawLength: accumulatedText.length,
    lastSnapshot: nextSnapshot ?? previous.lastSnapshot,
  };

  return {
    state,
    nextSnapshot,
    diagnostic,
  };
}
