import type { UsageSummary } from "../types";

export async function fetchUsageSummary(): Promise<UsageSummary | null> {
  try {
    const response = await fetch("/api/usage");
    if (!response.ok) return null;
    return (await response.json()) as UsageSummary;
  } catch {
    return null;
  }
}

export async function clearUsageHistory(): Promise<boolean> {
  try {
    const response = await fetch("/api/usage", { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}
