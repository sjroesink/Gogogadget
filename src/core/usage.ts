import type { Command } from "./types";
export type Usage = Record<string, number>;
export type SortOrder = "relevance" | "most-used" | "name";
export const usageKey = (item: Pick<Command, "id" | "kind">) =>
  `${item.kind}:${item.id}`;
export function parseUsage(value: unknown): Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, count]) =>
          key.length <= 600 &&
          /^(app|command|ai):/.test(key) &&
          Number.isSafeInteger(count) &&
          Number(count) > 0,
      )
      .slice(0, 2000),
  );
}
export function recordUsage(
  usage: Usage,
  item: Pick<Command, "id" | "kind">,
): Usage {
  const key = usageKey(item);
  const next = {
    ...usage,
    [key]: Math.min((usage[key] ?? 0) + 1, Number.MAX_SAFE_INTEGER),
  };
  if (Object.keys(next).length > 2000) {
    const oldest = Object.keys(next)
      .filter((k) => k !== key)
      .sort((a, b) => next[a] - next[b])[0];
    delete next[oldest];
  }
  return next;
}
