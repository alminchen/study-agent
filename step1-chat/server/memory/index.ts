/**
 * 记忆模块的统一出口。
 *
 * 业务链路（/api/chat、/api/chat/multi、/api/chat/plan、
 * /api/rag/chat、/api/chat/structured）只应该从这一个入口取记忆能力，
 * 不直接依赖记忆模块内部的拆分文件。
 *
 * 内部模块（store / retrieve / pipeline / extract …）之间要互相调用，
 * 它们仍然直接 import 各自的文件——index.ts 只面向外部调用方。
 */

export {
  buildExtractionInput,
  buildMemoryInjectedEvent,
  retrieveMemoryBlock,
  scheduleMemoryExtraction,
  type ExtractionInputOptions,
  type MemoryBridgeOptions,
  type MemoryExtractionDeps,
} from "./bridge.js";
export {
  MEMORY_BLOCK_HEADER,
  MEMORY_SECTION_TITLE,
  renderMemoryBlock,
  renderMemorySection,
} from "./context.js";
export { extractAndStoreFacts } from "./pipeline.js";
export { retrieveRelevantFacts, type RetrievedMemory } from "./retrieve.js";
export {
  clearMemory,
  createMemoryFact,
  deleteFact,
  readMemory,
  updateFact,
  upsertFact,
} from "./store.js";
export {
  isValidUserId,
  MAX_FACTS_PER_USER,
  MIN_CONFIDENCE,
  SIMILARITY_THRESHOLD,
  type MemoryFact,
  type MemoryInjectedItem,
  type MemoryTraceEvent,
} from "./types.js";
