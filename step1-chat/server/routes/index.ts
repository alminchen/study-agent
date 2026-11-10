import type { Express } from "express";
import { registerChatRoutes } from "./chat.js";
import { registerChatConfirmRoutes } from "./chatConfirm.js";
import { registerChatMultiRoutes } from "./chatMulti.js";
import { registerChatPlanRoutes } from "./chatPlan.js";
import { registerChatReflectionRoutes } from "./chatReflection.js";
import { registerChatStructuredRoutes } from "./chatStructured.js";
import { registerHealthRoutes } from "./health.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerModelRoutes } from "./models.js";
import { registerRagChatRoutes } from "./ragChat.js";
import { registerUsageRoutes } from "./usage.js";

/** 挂载全部 HTTP 路由；业务逻辑在各自 register* 文件内 */
export function registerRoutes(app: Express): void {
  registerUsageRoutes(app);
  registerHealthRoutes(app);
  registerModelRoutes(app);
  registerRagChatRoutes(app);
  // 结构化输出使用独立端点，和普通聊天/RAG 路由并行挂载，互不改写协议。
  registerChatStructuredRoutes(app);
  registerChatRoutes(app);
  registerChatConfirmRoutes(app);
  registerChatMultiRoutes(app);
  // Plan-and-Execute 使用独立端点，与普通聊天链路并行挂载。
  registerChatPlanRoutes(app);
  // Reflection 使用独立端点：先出一版答案再回头评分/重写，默认关闭（REFLECTION_MODE=off）。
  registerChatReflectionRoutes(app);
  // 跨会话记忆的读写接口：用户可以查看、修改、删除自己被记住的内容。
  registerMemoryRoutes(app);
}
