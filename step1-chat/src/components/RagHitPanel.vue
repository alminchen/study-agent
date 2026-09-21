<script setup lang="ts">
import { computed, watch } from "vue";
import type { RagHitView, RagMeta } from "../types";

const props = defineProps<{
  rag: RagMeta | null;
  highlightIndex?: number | null;
}>();

const hits = computed(() => props.rag?.hits ?? []);
const usedHits = computed(() =>
  hits.value
    .filter((hit) => hit.promptIndex != null)
    .slice()
    .sort((a, b) => (a.promptIndex ?? 0) - (b.promptIndex ?? 0)),
);
const unusedHits = computed(() => hits.value.filter((hit) => hit.promptIndex == null));
const vectorTop = computed(() =>
  hits.value
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5),
);

const rewrite = computed(() => props.rag?.rewriteMeta ?? null);
const kbRoute = computed(() => props.rag?.kbRouteMeta ?? null);
const multiQuery = computed(() => props.rag?.multiQueryMeta ?? null);
const hyde = computed(() => props.rag?.hydeMeta ?? null);

const hasEnhance = computed(() =>
  Boolean(rewrite.value || kbRoute.value || multiQuery.value || hyde.value),
);

/** 有命中，或有问句增强 meta（即使判空 / 路由 none）都显示面板 */
const visible = computed(() => props.rag != null && (hits.value.length > 0 || hasEnhance.value));

const orderChanged = computed(() => {
  const before = vectorTop.value.map((hit) => hit.id).join(",");
  const after = usedHits.value.map((hit) => hit.id).join(",");
  return before.length > 0 && after.length > 0 && before !== after;
});

function previewOf(text: string, max = 90): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function scoreOf(score: number): string {
  return score.toFixed(4);
}

function unusedLabel(hit: RagHitView): string {
  return hit.title || hit.id;
}

function hitId(index: number): string {
  return `rag-cite-${index}`;
}

function shortName(hit: RagHitView): string {
  return hit.title || hit.id;
}

function sourcesLabel(sources: string[] | null | undefined): string {
  if (sources == null) return "全库";
  if (sources.length === 0) return "空池";
  return sources.join(", ");
}

watch(
  () => props.highlightIndex,
  (index) => {
    if (index == null) return;
    requestAnimationFrame(() => {
      document.getElementById(hitId(index))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  },
);
</script>

<template>
  <section v-if="visible && rag" class="trace-panel hit-panel" aria-label="检索命中">
    <header class="trace-header">检索命中</header>

    <!-- 本课：问句增强可解释区（默认关开关时也会显示 status=disabled） -->
    <div v-if="hasEnhance" class="hit-summary enhance-block">
      <div class="enhance-title">问句增强（本课）</div>
      <div v-if="rewrite">
        <span class="hit-label">扩写</span>
        status={{ rewrite.status }}
        <template v-if="rewrite.intent"> · intent={{ rewrite.intent }}</template>
        <template v-if="rewrite.status === 'ok' || rewrite.status === 'fallback'">
          · 检索句={{ rewrite.queryUsed }}
        </template>
        <template v-if="rewrite.reason"> · {{ rewrite.reason }}</template>
      </div>
      <div v-if="kbRoute">
        <span class="hit-label">路由</span>
        status={{ kbRoute.status }} · route={{ kbRoute.route }} · 库={{ sourcesLabel(kbRoute.sourcesAllowed) }}
        <template v-if="kbRoute.reason"> · {{ kbRoute.reason }}</template>
      </div>
      <div v-if="multiQuery">
        <span class="hit-label">多路</span>
        status={{ multiQuery.status }}
        <template v-if="multiQuery.queries.length">
          · {{ multiQuery.queries.length }} 路 · merge={{ multiQuery.merge }} · 合并 {{ multiQuery.mergedCount }}
        </template>
        <template v-if="multiQuery.reason"> · {{ multiQuery.reason }}</template>
        <ul v-if="multiQuery.queries.length" class="enhance-list">
          <li v-for="(q, i) in multiQuery.queries" :key="i">q{{ i + 1 }}: {{ q }}</li>
        </ul>
      </div>
      <div v-if="hyde">
        <span class="hit-label">HyDE</span>
        status={{ hyde.status }}
        <template v-if="hyde.reason"> · {{ hyde.reason }}</template>
        <p v-if="hyde.hydeDoc" class="hit-preview">假文档：{{ previewOf(hyde.hydeDoc, 160) }}</p>
      </div>
      <div class="enhance-hint">开关：RAG_QUERY_REWRITE / RAG_KB_ROUTE / RAG_MULTI_QUERY / RAG_HYDE（写进服务端 .env 后重启）</div>
    </div>

    <div class="hit-summary">
      <div><span class="hit-label">问句</span>{{ rag.question }}</div>
      <div>
        <span class="hit-label">闸门</span>
        <template v-if="rag.empty">
          Top1 低于门槛，资料未进 prompt、未调模型。下面「未采用」只是向量硬搜出的相对最像，不是答案。
        </template>
        <template v-else>
          向量先召回 {{ hits.length }} 段，重排后注入 {{ usedHits.length }} 段。
          {{ orderChanged ? "重排改变了前 5 名顺序。" : "重排后前 5 名与向量顺序相同。" }}
          点回答里的 [n] 会对到下面这一段。
        </template>
        <template v-if="rag.topScore != null"> · 向量 Top1 {{ scoreOf(rag.topScore) }}</template>
      </div>
      <div v-if="!rag.empty && vectorTop.length > 0">
        <span class="hit-label">向量</span>
        {{ vectorTop.map((hit, index) => `${index + 1}.${shortName(hit)}`).join(" · ") }}
      </div>
      <div v-if="!rag.empty && usedHits.length > 0">
        <span class="hit-label">重排</span>
        {{ usedHits.map((hit) => `${hit.promptIndex}.${shortName(hit)}`).join(" · ") }}
      </div>
    </div>

    <ol v-if="usedHits.length > 0" class="trace-list">
      <li
        v-for="hit in usedHits"
        :id="hit.promptIndex != null ? hitId(hit.promptIndex) : undefined"
        :key="hit.id"
        class="hit-item"
        :class="{ active: hit.promptIndex != null && hit.promptIndex === highlightIndex }"
      >
        <div class="trace-title">
          向量 #{{ hit.rank }}
          <template v-if="hit.rerankRank != null"> → 重排 #{{ hit.rerankRank }}</template>
          <span v-if="hit.rerankScore != null" class="hit-score">rerank {{ scoreOf(hit.rerankScore) }}</span>
          <span class="hit-badge in">注入 [{{ hit.promptIndex }}]</span>
        </div>
        <div class="hit-meta">{{ hit.id }} · {{ hit.source }}<template v-if="hit.title"> · {{ hit.title }}</template></div>
        <p class="hit-preview">{{ previewOf(hit.text) }}</p>
      </li>
    </ol>

    <div v-if="unusedHits.length > 0" class="hit-unused">
      <div class="hit-unused-title">未采用（召回了但未进 prompt）</div>
      <ul class="hit-unused-list">
        <li v-for="hit in unusedHits" :key="hit.id">
          向量 #{{ hit.rank }}
          <template v-if="hit.rerankRank != null"> · 重排 #{{ hit.rerankRank }}</template>
          {{ scoreOf(hit.score) }} · {{ unusedLabel(hit) }}
        </li>
      </ul>
    </div>
  </section>
</template>
