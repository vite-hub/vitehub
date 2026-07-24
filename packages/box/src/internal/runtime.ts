import type { BoxRuntime } from "../index.ts";

export const builtInBoxRuntime: symbol = Symbol.for("vitehub.box.internal-runtime");

export function isBuiltInBoxRuntime(runtime: BoxRuntime): boolean {
  return builtInBoxRuntime in runtime;
}

export function markBuiltInBoxRuntime(runtime: BoxRuntime): BoxRuntime {
  Object.defineProperty(runtime, builtInBoxRuntime, { value: true });
  return runtime;
}
