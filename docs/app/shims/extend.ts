type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainRecord(value)) return value;

  return merge(true, {}, value);
}

function merge(deep: boolean, target: PlainRecord, ...sources: unknown[]) {
  for (const source of sources) {
    if (!isPlainRecord(source) && !Array.isArray(source)) continue;

    for (const [key, value] of Object.entries(source)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;

      if (deep && (isPlainRecord(value) || Array.isArray(value))) {
        const current = target[key];
        const base = Array.isArray(value)
          ? Array.isArray(current) ? current : []
          : isPlainRecord(current) ? current : {};

        target[key] = merge(true, base as PlainRecord, cloneValue(value));
      } else {
        target[key] = value;
      }
    }
  }

  return target;
}

export default function extend(...args: unknown[]) {
  const deep = args[0] === true;
  const target = (deep ? args[1] : args[0]) as PlainRecord | null | undefined;
  const sources = args.slice(deep ? 2 : 1);

  return merge(deep, target ?? {}, ...sources);
}
