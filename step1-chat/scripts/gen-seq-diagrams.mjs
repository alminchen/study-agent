// 生成对齐的 ASCII 时序图：CJK 按双宽计算列位置
// 数据来自 seq-data.mjs（与 SVG 渲染器共用同一份）

import { seqDiagrams } from "./seq-data.mjs";

// CJK 按双宽计算列位置
function dispWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function seqDiagram({ title, cols, cw, items }) {
  const CW = cw ?? Math.max(...cols.map(dispWidth)) + 2;
  const base = 3;
  const centers = cols.map((_, i) => base + i * CW + Math.floor(CW / 2));
  const total = base + cols.length * CW;
  const lines = [];
  lines.push(`# ${title}`);

  // 表头字段在列内居中，lifeline 落在字段中心，视觉上对齐标签
  let hdr = " ".repeat(base);
  for (const c of cols) {
    const w = dispWidth(c);
    const left = Math.floor((CW - w) / 2);
    const right = CW - w - left;
    hdr += " ".repeat(left) + c + " ".repeat(right);
  }
  lines.push(hdr);

  // 箭头行：跨列之间连续填 ─，源端点 │，目标端点 ▶ / ◀，未参与列保持 │
  const arrowRow = (from, to) => {
    const arr = new Array(total).fill(" ");
    centers.forEach((c) => (arr[c] = "│"));
    if (from === to) {
      arr[centers[from]] = "○";
      return arr.join("");
    }
    const a = Math.min(centers[from], centers[to]);
    const b = Math.max(centers[from], centers[to]);
    for (let i = a; i <= b; i++) arr[i] = "─";
    arr[centers[from]] = "│";
    arr[centers[to]] = from < to ? "▶" : "◀";
    return arr.join("");
  };

  const textRow = (text, at) => {
    return " ".repeat(at) + text;
  };

  const branchLabel = (kind, text) => {
    const prefix = kind === "alt" ? "alt" : kind === "else" ? "else" : "end";
    return kind === "end" ? prefix : `${prefix}  ${text}`;
  };

  for (const item of items) {
    if (item.kind === "alt" || item.kind === "else" || item.kind === "end") {
      lines.push(" ".repeat(base) + branchLabel(item.kind, item.text ?? ""));
      continue;
    }
    if (item.kind === "note") {
      lines.push(" ".repeat(base + 2) + "— " + item.text);
      continue;
    }
    if (item.kind === "self") {
      lines.push(textRow(item.text, centers[item.from] + 2));
      lines.push(arrowRow(item.from, item.from));
      continue;
    }
    const { from, to, text } = item;
    const at = centers[from] + 2;
    lines.push(textRow(text, at));
    lines.push(arrowRow(from, to));
  }

  lines.push("");
  return lines.join("\n");
}

const out = seqDiagrams
  .map((d) =>
    seqDiagram({
      title: d.title,
      cols: d.cols,
      items: d.items,
    })
  )
  .join("\n");

process.stdout.write(out + "\n");
