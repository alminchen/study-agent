import type { ModelCatalog, ModelOption } from "../types";

/** 读取服务端代理的模型目录；解析失败时返回 null，由调用方保留兜底列表。 */
export async function fetchModelCatalog(): Promise<ModelCatalog | null> {
  try {
    const response = await fetch("/api/models");
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      models?: unknown;
      source?: unknown;
    };
    if (!Array.isArray(payload.models)) return null;

    const models = payload.models.flatMap((item): ModelOption[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id.trim()) return [];
      const id = row.id.trim();
      const label =
        typeof row.label === "string" && row.label.trim() ? row.label.trim() : id;
      return [{ id, label }];
    });

    return {
      models,
      source: payload.source === "api" ? "api" : "fallback",
    };
  } catch {
    return null;
  }
}
