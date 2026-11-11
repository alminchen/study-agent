<script setup lang="ts">
/**
 * 待发图片缩略图（步骤 6）。
 *
 * 只消费内存态 ChatAttachment：previewUrl 是 objectURL，仅当前会话可预览；
 * base64 不在这里展示，也不会被持久化。
 */
import { X } from "@lucide/vue";
import type { ChatAttachment } from "../types";

defineProps<{
  /** 压缩完成、等待发送的图片附件。 */
  attachment: ChatAttachment;
}>();

const emit = defineEmits<{
  /** 点移除按钮；父组件负责释放 objectURL。 */
  remove: [id: string];
}>();

/** 字节数 → 人类可读尺寸，展示在缩略图下方。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
</script>

<template>
  <div class="image-attachment" :title="attachment.name">
    <img
      class="thumb"
      :src="attachment.previewUrl"
      :alt="attachment.name"
      loading="lazy"
    />
    <div class="meta">
      <span class="name">{{ attachment.name }}</span>
      <span class="detail">
        {{ formatBytes(attachment.byteSize) }} · {{ attachment.width }}×{{ attachment.height }}
      </span>
    </div>
    <button
      type="button"
      class="remove"
      title="移除图片"
      aria-label="移除图片"
      @click="emit('remove', attachment.id)"
    >
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.image-attachment {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 224px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #ffffff;
}
.thumb {
  flex: none;
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: #f8fafc;
}
.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}
.name {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail {
  font-size: 11px;
  color: var(--muted);
}
.remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.remove:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
</style>
