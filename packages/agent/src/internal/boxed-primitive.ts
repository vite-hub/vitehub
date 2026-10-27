import { hasRuntimeType } from "./runtime-type.ts"

export function boxedPrimitive(value: unknown): { type: string, value: bigint | boolean | number | string } | undefined {
  if (!value || !hasRuntimeType(value, "object")) return
  for (const [type, unwrap] of [
    ["Boolean", () => Boolean.prototype.valueOf.call(value)],
    ["Number", () => Number.prototype.valueOf.call(value)],
    ["String", () => String.prototype.valueOf.call(value)],
    ["BigInt", () => BigInt.prototype.valueOf.call(value)],
  ] as const) {
    try {
      return { type, value: unwrap() }
    }
    catch {
      // Try the next intrinsic wrapper.
    }
  }
}
