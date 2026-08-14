<script setup lang="ts">
import { computed } from "vue";
import { Bot } from "@lucide/vue";
import { findHitByPromptIndex, splitCitedText, validPromptIndexes } from "../rag/citations";
import type { ChatMessage } from "../types";

const props = defineProps<{
  message: ChatMessage;
  streaming: boolean;
  /** 当前点中的引用编号；只高亮本条消息 */
  activeCite?: number | null;
}>();

const emit = defineEmits<{
  cite: [n: number];
}>();

const validIndexes = computed(() => validPromptIndexes(props.message.rag?.hits));

const parts = computed(() => {
  if (!props.message.rag || props.message.role !== "assistant") {
    return [{ kind: "text" as const, text: props.message.content }];
  }
  return splitCitedText(props.message.content, validIndexes.value);
});

const ragCaption = computed(() => {
  const rag = props.message.rag;
  if (!rag) return "";
  const score = rag.topScore == null ? "—" : rag.topScore.toFixed(2);
  if (rag.empty) return `资料里没有 · Top1 ${score} · 未调模型`;
  return rag.calledModel ? `已根据资料回答 · Top1 ${score}` : `资料问答 · Top1 ${score}`;
});

function citeTitle(n: number, valid: boolean): string {
  if (!valid) return `[${n}] 不在本次注入的资料里，不能当依据`;
  const hit = findHitByPromptIndex(props.message.rag?.hits, n);
  const label = hit?.title || hit?.id || `资料 ${n}`;
  return `查看 [${n}] ${label}`;
}

function onCite(n: number, valid: boolean) {
  if (!valid) return;
  emit("cite", n);
}
</script>

<template>
  <div class="message" :class="message.role">
    <div class="avatar">
      <span v-if="message.role === 'user'">我</span>
      <Bot v-else :size="16" />
    </div>
    <div class="bubble">
      <div class="bubble-text">
        <template v-for="(part, index) in parts" :key="index">
          <template v-if="part.kind === 'text'">{{ part.text }}</template>
          <button
            v-else
            type="button"
            class="cite-chip"
            :class="{ on: part.valid && activeCite === part.n, invalid: !part.valid }"
            :disabled="!part.valid"
            :title="citeTitle(part.n, part.valid)"
            @click="onCite(part.n, part.valid)"
          >[{{ part.n }}]</button>
        </template>
        <span v-if="streaming" class="caret" />
      </div>
      <div v-if="ragCaption" class="bubble-meta">{{ ragCaption }}</div>
    </div>
  </div>
</template>
