// 把 seq-data.mjs 里的图渲染成标准样式的 SVG 时序图（无外部依赖）。
// 产物：diagrams/seq-<key>.svg、diagrams/arch.svg、diagrams/seq-scripts.svg、
//      diagrams/index.html（内联展示全部图，浏览器直接打开即可看）。
// 用法：node scripts/render-seq-svg.mjs

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seqDiagrams, pipelineBoxes } from "./seq-data.mjs";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../diagrams");

// ---------- 通用 ----------
const CJK =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
// 估算文本显示宽度：CJK 一字 ≈ 字号，ASCII 一字 ≈ 0.6 字号
function tw(text, fs = 13) {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? fs : fs * 0.6;
  return w;
}
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FONT = 'font-family="ui-sans-serif, -apple-system, \'PingFang SC\', \'Microsoft YaHei\', sans-serif"';

const C = {
  boxFill: "#eef3f3",
  boxStroke: "#a9bfc2",
  actorFill: "#fdf1d8",
  actorStroke: "#dfb866",
  ink: "#23313a",
  mute: "#5c6b70",
  lifeline: "#b6c6ca",
  frame: "#7e98a0",
  frameTag: "#7e98a0",
  noteFill: "#fff7dc",
  noteStroke: "#e0c97a",
  noteInk: "#5a4a10",
  tagText: "#ffffff",
};

const arrowMarker = (id, color = C.ink) =>
  `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
  `<path d="M 0 1 L 9 5 L 0 9 z" fill="${color}"/></marker>`;

const svgWrap = (id, w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img">\n` +
  `  <defs>${arrowMarker(`arr-${id}`)}</defs>\n${body}\n</svg>\n`;

// ---------- 时序图渲染 ----------
function renderSeq({ key, title, cols, items }) {
  const FS = 13; // 参与者字号
  const bw = cols.map((c) => Math.max(tw(c, FS) + 22, 42));
  const pitch = bw.map((w) => Math.max(w + 44, 110));
  const margin = 44;
  const width = margin * 2 + pitch.reduce((a, b) => a + b, 0);
  const colX = [];
  let cx = margin;
  for (let i = 0; i < cols.length; i++) {
    colX[i] = cx + pitch[i] / 2;
    cx += pitch[i];
  }

  const boxH = 30;
  const top = 12;
  const lfTop = top + boxH;
  let curY = lfTop + 18;

  // 第一遍：给每个元素定位，收集 alt/else 分块坐标
  const frames = [];
  let open = null;
  for (const it of items) {
    if (it.kind === "alt") {
      open = { start: curY, end: null, alt: it.text, elseY: null, else: null };
      curY += 30; // 给顶部的 alt 标签留一行
      frames.push(open);
      continue;
    }
    if (it.kind === "else") {
      if (open) {
        open.elseY = curY;
        open.else = it.text;
        curY += 30; // 给分隔线上的 else 标签留一行
      }
      continue;
    }
    if (it.kind === "end") {
      if (open) {
        open.end = curY;
        open = null;
      }
      continue;
    }
    it.y = curY;
    curY += it.kind === "note" ? 34 : 30;
  }
  if (open) open.end = curY;
  const height = curY + 26;

  // 第二遍：按 z 序输出（分块 → lifeline → 消息/备注 → 参与者盒子 → 分块标签）
  const parts = [];
  const frameX = margin - 10;
  const frameW = width - margin * 2 + 20;
  for (const f of frames) {
    if (f.start == null || f.end == null) continue;
    const topY = f.start - 4;
    const botY = f.end + 8;
    parts.push(
      `<rect x="${frameX}" y="${topY}" width="${frameW}" height="${botY - topY}" rx="4" fill="none" stroke="${C.frame}" stroke-width="1" stroke-dasharray="4 3"/>`
    );
    if (f.alt) parts.push(tag(frameX + 8, f.start, `alt  ${f.alt}`));
    if (f.elseY != null && f.else) {
      parts.push(
        `<line x1="${frameX}" y1="${f.elseY}" x2="${frameX + frameW}" y2="${f.elseY}" stroke="${C.frame}" stroke-width="1" stroke-dasharray="4 3"/>`
      );
      parts.push(tag(frameX + 8, f.elseY + 6, `else  ${f.else}`));
    }
  }

  colX.forEach((x) =>
    parts.push(
      `<line x1="${x}" y1="${lfTop + 2}" x2="${x}" y2="${height - 16}" stroke="${C.lifeline}" stroke-width="1" stroke-dasharray="4 4"/>`
    )
  );

  for (const it of items) {
    if (it.kind === "alt" || it.kind === "else" || it.kind === "end") continue;
    if (it.kind === "note") {
      const w = tw(it.text, 11.5) + 26;
      const nx = width / 2 - w / 2;
      parts.push(
        `<rect x="${nx}" y="${it.y}" width="${w}" height="24" rx="3" fill="${C.noteFill}" stroke="${C.noteStroke}" stroke-width="1"/>` +
          `<text x="${width / 2}" y="${it.y + 16}" ${FONT} font-size="11.5" fill="${C.noteInk}" text-anchor="middle">${esc(it.text)}</text>`
      );
      continue;
    }
    if (it.kind === "self") {
      const x = colX[it.from];
      const y = it.y;
      const arm = 22;
      const drop = 12;
      parts.push(
        `<path d="M ${x} ${y} h ${arm} v ${drop} h ${-arm}" fill="none" stroke="${C.ink}" stroke-width="1.2" marker-end="url(#arr-${key})"/>` +
          `<text x="${x + arm + 8}" y="${y + 10}" ${FONT} font-size="11.5" fill="${C.ink}" text-anchor="start">${esc(it.text)}</text>`
      );
      continue;
    }
    const x1 = colX[it.from];
    const x2 = colX[it.to];
    const y = it.y;
    const dashed = it.to < it.from;
    // 标签居中，但碰到画布边缘时向内侧收，保证不越界
    let lx = (x1 + x2) / 2;
    const half = tw(it.text, 11.5) / 2;
    if (lx - half < 4) lx = 4 + half;
    if (lx + half > width - 4) lx = width - 4 - half;
    parts.push(
      `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${C.ink}" stroke-width="1.2" stroke-dasharray="${dashed ? "5 3" : "none"}" marker-end="url(#arr-${key})"/>` +
        `<text x="${lx}" y="${y - 6}" ${FONT} font-size="11.5" fill="${C.ink}" text-anchor="middle">${esc(it.text)}</text>`
    );
  }

  cols.forEach((label, i) => {
    const x = colX[i];
    const w = bw[i];
    const isActor = i === 0;
    parts.push(
      `<rect x="${x - w / 2}" y="${top}" width="${w}" height="${boxH}" rx="5" fill="${isActor ? C.actorFill : C.boxFill}" stroke="${isActor ? C.actorStroke : C.boxStroke}" stroke-width="1.2"/>` +
        `<text x="${x}" y="${top + 20}" ${FONT} font-size="12.5" font-weight="600" fill="${C.ink}" text-anchor="middle">${esc(label)}</text>`
    );
  });

  return svgWrap(key, width, height, parts.join("\n"));
}

function tag(x, y, text) {
  const w = tw(text, 11) + 12;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="18" rx="3" fill="${C.frameTag}"/>` +
    `<text x="${x + 6}" y="${y + 13}" ${FONT} font-size="11" fill="${C.tagText}" text-anchor="start">${esc(text)}</text>`
  );
}

// ---------- 图 6：单点验证脚本顺序（线性流水线） ----------
function renderPipeline() {
  const boxes = pipelineBoxes;
  const gap = 36;
  const boxH = 58;
  const y = 18;
  let x = 16;
  const xs = [];
  const ws = [];
  for (const b of boxes) {
    const w = Math.max(tw(b.name), tw(b.sub)) + 26;
    xs.push(x);
    ws.push(w);
    x += w + gap;
  }
  const width = x - gap + 16;
  const height = 96;

  const parts = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const bx = xs[i];
    const bw = ws[i];
    parts.push(
      `<rect x="${bx}" y="${y}" width="${bw}" height="${boxH}" rx="5" fill="${C.boxFill}" stroke="${C.boxStroke}" stroke-width="1.2"/>` +
        `<text x="${bx + bw / 2}" y="${y + 22}" ${FONT} font-size="12.5" font-weight="600" fill="${C.ink}" text-anchor="middle">${esc(b.name)}</text>` +
        `<text x="${bx + bw / 2}" y="${y + 42}" ${FONT} font-size="10.5" fill="${C.mute}" text-anchor="middle">${esc(b.sub)}</text>`
    );
    if (i < boxes.length - 1) {
      parts.push(
        `<line x1="${bx + bw}" y1="${y + boxH / 2}" x2="${xs[i + 1]}" y2="${y + boxH / 2}" stroke="${C.ink}" stroke-width="1.4" marker-end="url(#arr-pipe)"/>`
      );
    }
  }
  return svgWrap("pipe", width, height, parts.join("\n"));
}

// ---------- 图 1：架构与数据边界（手工排版） ----------
function renderArch() {
  const W = 900;
  const H = 470;
  const P = [];
  const band = (x, y, w, h, title) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="#f5f8f8" stroke="#b6c6ca" stroke-width="1"/>` +
    `<text x="${x + 16}" y="${y + 24}" ${FONT} font-size="13" font-weight="700" fill="${C.ink}" text-anchor="start">${title}</text>`;
  const mini = (x, y, w, h, lines) => {
    const cy = y + h / 2;
    const n = lines.length;
    const lh = 15;
    const start = cy - ((n - 1) * lh) / 2 + 4;
    return (
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#ffffff" stroke="#c8d6d8" stroke-width="1"/>` +
      lines
        .map(
          (ln, i) =>
            `<text x="${x + w / 2}" y="${start + i * lh}" ${FONT} font-size="11" fill="${C.ink}" text-anchor="middle">${esc(ln)}</text>`
        )
        .join("")
    );
  };
  const arrowDown = (x1, y1, x2, y2, label) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.ink}" stroke-width="1.4" marker-end="url(#arr-arch)"/>` +
    `<text x="${x2 + 10}" y="${(y1 + y2) / 2 + 4}" ${FONT} font-size="11" fill="${C.mute}" text-anchor="start">${esc(label)}</text>`;

  // 浏览器带
  P.push(band(20, 16, 860, 96, "浏览器 · Vue 3（src/）"));
  P.push(mini(40, 52, 250, 40, ["App.vue + useChat.ts", "普通/资料问答两套状态"]));
  P.push(mini(310, 52, 260, 40, ["streamChat.ts", "解析 SSE 逐帧增量"]));
  P.push(mini(590, 52, 270, 40, ["askRag.ts", "收整段 JSON 回答"]));

  P.push(arrowDown(250, 112, 250, 146, "POST /api/chat（SSE）"));
  P.push(arrowDown(650, 112, 650, 146, "POST /api/rag/chat（JSON）"));

  // Express 带
  P.push(band(20, 150, 860, 122, "Express · server/"));
  P.push(
    mini(40, 186, 410, 68, [
      "链路 A · 普通对话  /api/chat",
      "→ createChatStream + tools/ 天气·时间",
    ])
  );
  P.push(
    mini(470, 186, 390, 68, [
      "链路 B · 资料问答  /api/rag/chat",
      "→ server/rag/ 检索→判空→重排→拼prompt",
    ])
  );

  // 两条链路都调 LLM；本地资源（句向量 / 重排 / 向量库）只服务链路 B
  P.push(arrowDown(250, 272, 250, 306, "chat/completions（tools · 两轮闭环）"));
  P.push(arrowDown(560, 272, 560, 306, "chat/completions（单轮）"));
  P.push(arrowDown(700, 272, 700, 306, "本地句向量 · 重排 · 向量库"));

  // LLM 带（两条链路共用）
  P.push(band(20, 312, 560, 116, "DeepSeek · 聊天模型（OpenAI 兼容）"));
  P.push(
    mini(40, 346, 520, 62, [
      "chat/completions · 链路 A：工具两轮调用 / 链路 B：单轮无工具",
      "system 与历史存储两条链路完全隔离",
    ])
  );

  // 本地资源带（仅链路 B）
  P.push(band(580, 312, 320, 116, "本地资源 · 仅链路 B"));
  P.push(mini(596, 346, 100, 62, ["bge-large-zh", "句向量 1024 维"]));
  P.push(mini(704, 346, 100, 62, ["bge-reranker", "交叉重排"]));
  P.push(mini(812, 346, 88, 62, [".chroma", "my_notes.json"]));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img">
  <defs>${arrowMarker("arr-arch")}</defs>
${P.join("\n")}
</svg>
`;
  return svg;
}

// ---------- index.html ----------
function renderIndexHtml(svgs) {
  const figures = svgs
    .map(
      ([file, title, caption]) => `<figure>
  <div class="fhead"><span class="no">${title}</span></div>
  <img src="${file}" alt="${title}">
  <figcaption>${caption}</figcaption>
</figure>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>step1-chat · 模块时序图</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; background: #f1f4f3; color: #1b2426;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    line-height: 1.6;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 48px 24px 80px; }
  h1 { font-size: 26px; letter-spacing: -0.01em; margin: 0 0 6px; }
  .lede { color: #5c6b70; margin: 0 0 28px; font-size: 14.5px; }
  figure {
    margin: 0 0 34px; background: #fff; border: 1px solid #d8e0e1; border-radius: 8px;
    overflow: hidden; box-shadow: 0 1px 2px rgba(16,24,26,.05), 0 6px 20px rgba(16,24,26,.05);
  }
  .fhead { padding: 10px 16px; border-bottom: 1px solid #e3e9ea; }
  .no { font-weight: 600; font-size: 13.5px; }
  figure img { display: block; width: 100%; height: auto; padding: 16px; background: #fff; }
  figcaption {
    padding: 8px 16px 12px; font-size: 12.5px; color: #5c6b70;
    border-top: 1px solid #eef2f2; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>step1-chat · 模块时序图</h1>
  <p class="lede">由 scripts/render-seq-svg.mjs 直接生成的标准 SVG 时序图，无需任何渲染器，浏览器 / Quick Look 直接打开。源码数据在 scripts/seq-data.mjs。</p>
${figures}
</div>
</body>
</html>
`;
}

// ---------- 主流程 ----------
await mkdir(OUT_DIR, { recursive: true });

const svgs = [];
for (const d of seqDiagrams) {
  const file = `seq-${d.key}.svg`;
  await writeFile(path.join(OUT_DIR, file), renderSeq(d));
  svgs.push([file, d.title, caption(d)]);
  console.log("written", file);
}

await writeFile(path.join(OUT_DIR, "arch.svg"), renderArch());
svgs.splice(1, 0, ["arch.svg", "图 1 · 架构与数据边界", "两条链路共用前端状态与 Express，但接口、协议、system 与历史存储完全隔离；本地模型与向量库只服务资料链路。"]);
console.log("written arch.svg");

await writeFile(path.join(OUT_DIR, "seq-scripts.svg"), renderPipeline());
svgs.push(["seq-scripts.svg", "图 6 · 单点验证脚本顺序", "每条命令只练一个环节，失败只重跑那一条；入库成功 ≠ 检索合格，检索有命中 ≠ 可以注入。"]);
console.log("written seq-scripts.svg");

await writeFile(path.join(OUT_DIR, "index.html"), renderIndexHtml(svgs));
console.log("written index.html");

function caption(d) {
  const map = {
    chat: "tool calling 闭环：决定 → 执行 → 回填 → 再问，全程非流式两次请求；前端每次读到 data 帧就渲染一段。",
    rag: "空结果不消耗模型调用；RagHitView 去掉 1024 维向量再回前端，引用编号只认本次注入的 promptIndex。",
    ingest: "同一 source 只允许一份数据：replaceSource 先删旧再写新，禁止直接 push 造成新旧两版并存。",
    lifecycle: "watch([messages, isStreaming, ragMode]) 在非流式时把当前模式的历史写回 localStorage，普通对话与资料问答各一份。",
  };
  return map[d.key];
}
