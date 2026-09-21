import type { Express } from "express";
import { registerChatRoutes } from "./chat.js";
import { registerChatConfirmRoutes } from "./chatConfirm.js";
import { registerChatMultiRoutes } from "./chatMulti.js";
import { registerHealthRoutes } from "./health.js";
import { registerRagChatRoutes } from "./ragChat.js";
import { registerUsageRoutes } from "./usage.js";

/** 挂载全部 HTTP 路由；业务逻辑在各自 register* 文件内 */
export function registerRoutes(app: Express): void {
  registerUsageRoutes(app);
  registerHealthRoutes(app);
  registerRagChatRoutes(app);
  registerChatRoutes(app);
  registerChatConfirmRoutes(app);
  registerChatMultiRoutes(app);
}
