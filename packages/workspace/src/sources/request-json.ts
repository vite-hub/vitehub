export function requestJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON comparison accepts arbitrary body values and must preserve primitive serialization before inspecting object prototypes.
  if (!value || typeof value !== "object") return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortJson(item)]))
}
