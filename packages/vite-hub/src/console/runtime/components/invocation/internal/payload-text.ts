import { hasRuntimeType } from "./runtime-type.ts";

export function payloadText(value: unknown): string {
  if (hasRuntimeType(value, "string")) return value;
  const ancestors: object[] = [];
  try {
    return JSON.stringify(value, function (this: unknown, _key, item: unknown) {
      if (hasRuntimeType(item, "bigint")) return `${item}n`;
      if (!hasRuntimeType(item, "object") || item === null) return item;
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(item)) return "[Circular]";
      ancestors.push(item);
      return item;
    }, 2) ?? String(value);
  } catch (error) {
    let message: string | undefined;
    try {
      const candidate = error as { message?: unknown };
      const raw = candidate?.message;
      if (typeof raw === "string") message = raw;
      else if (raw !== undefined) {
        try { message = String(raw); } catch {}
      }
    } catch {}
    if (message === undefined) return "[Unable to display payload]";
    try { return `[Unable to display payload: ${message}]`; }
    catch { return "[Unable to display payload]"; }
  }
}
