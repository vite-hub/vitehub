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
    return error instanceof Error ? `[Unable to display payload: ${error.message}]` : "[Unable to display payload]";
  }
}

