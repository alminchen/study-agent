import type { Express } from "express";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { isVisionCapableModel } from "../vision/capability.js";

interface ModelOption {
  id: string;
  label: string;
  /** 该模型是否支持图片输入；前端据此禁用上传入口。 */
  supportsVision: boolean;
}

/** 常见模型的可读名称；上游返回的其他 id 直接原样展示。 */
const KNOWN_MODEL_LABELS: Record<string, string> = {
  "deepseek-chat": "DeepSeek Chat",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "gpt-5.4-mini": "GPT 5.4 mini",
  "gpt-5.6-sol": "GPT 5.6 sol",
};

/** 上游 /models 不可用时仍保留原下拉的三项，避免页面突然空白。 */
const FALLBACK_MODELS: ModelOption[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", supportsVision: false },
  { id: "gpt-5.4-mini", label: "GPT 5.4 mini", supportsVision: true },
  { id: "gpt-5.6-sol", label: "GPT 5.6 sol", supportsVision: true },
];

const MODEL_LIST_TIMEOUT_MS = 8_000;

/** 图片生成/识别模型不能用于当前文本聊天链路，按 id 关键字排除。 */
const IMAGE_MODEL_MARKERS = [
  "image",
  "dall-e",
  "dalle",
  "flux",
  "midjourney",
  "stable-diffusion",
  "sdxl",
  "imagen",
  "cogview",
  "seedream",
  "kolors",
  "t2i",
];

function modelLabel(id: string): string {
  return KNOWN_MODEL_LABELS[id] ?? id;
}

function isImageModel(id: string): boolean {
  const normalized = id.toLowerCase();
  return IMAGE_MODEL_MARKERS.some((marker) => normalized.includes(marker));
}

/** 兜底列表始终包含服务端配置的默认模型，避免当前选择不在选项中。 */
function fallbackModels(defaultModel: string): ModelOption[] {
  const models = [...FALLBACK_MODELS];
  if (!models.some((model) => model.id === defaultModel)) {
    models.unshift({
      id: defaultModel,
      label: modelLabel(defaultModel),
      supportsVision: isVisionCapableModel(defaultModel),
    });
  }
  return models;
}

/**
 * OpenAI 兼容的 /models 通常返回 { data: [{ id }] }；
 * 同时兼容 { models: [...] } 和字符串数组，方便不同代理实现。
 */
function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as Record<string, unknown>;
  const list = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : [];

  const ids = list.flatMap((item): string[] => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (!item || typeof item !== "object") return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });

  return [...new Set(ids)];
}

/** GET /api/models — 代理供应商的模型列表，避免浏览器直接暴露 API Key。 */
export function registerModelRoutes(app: Express): void {
  app.get("/api/models", async (_req, res) => {
    const config = getRuntimeConfig();
    const fallback = fallbackModels(config.model);

    if (config.mockMode) {
      res.json({ models: fallback, source: "fallback" });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        res.json({ models: fallback, source: "fallback" });
        return;
      }

      const modelIds = extractModelIds(await response.json()).filter(
        (id) => !isImageModel(id),
      );
      if (modelIds.length === 0) {
        res.json({ models: fallback, source: "fallback" });
        return;
      }

      res.json({
        models: modelIds.map((id) => ({
          id,
          label: modelLabel(id),
          supportsVision: isVisionCapableModel(id),
        })),
        source: "api",
      });
    } catch {
      // 上游不可达或超时时返回本地兜底，不把网络错误变成页面错误。
      res.json({ models: fallback, source: "fallback" });
    } finally {
      clearTimeout(timer);
    }
  });
}
