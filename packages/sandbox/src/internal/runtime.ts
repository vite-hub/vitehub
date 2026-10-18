import type { SandboxRuntime } from "../index.ts";

const builtInSandboxRuntime: symbol = Symbol.for("vitehub.sandbox.internal-runtime");
type RuntimeConstructor = { prototype?: unknown } & ((...args: never[]) => unknown);

function isFunction(value: unknown): value is RuntimeConstructor {
  return typeof value === "function";
}

function isOrdinaryObjectPrototype(value: object): boolean {
  if (Object.getPrototypeOf(value) !== null || !Object.hasOwn(value, "constructor")) return false;
  const constructor = Object.getOwnPropertyDescriptor(value, "constructor")?.value;
  return isFunction(constructor)
    && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
}

export function isBuiltInSandboxRuntime(runtime: SandboxRuntime): boolean {
  return Object.getOwnPropertyDescriptor(runtime, builtInSandboxRuntime)?.value === true;
}

export function hasDeclaredSandboxRuntimeMember(value: object, key: PropertyKey): boolean {
  if (Object.hasOwn(value, key)) return true;
  let prototype = Object.getPrototypeOf(value);
  while (prototype && prototype !== Object.prototype) {
    if (isOrdinaryObjectPrototype(prototype)) return false;
    if (Object.hasOwn(prototype, key)) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      return isFunction(constructor)
        && constructor.prototype === prototype
        && /^class\b/.test(Function.prototype.toString.call(constructor));
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

export function markBuiltInSandboxRuntime(runtime: SandboxRuntime): SandboxRuntime {
  Object.defineProperty(runtime, builtInSandboxRuntime, { value: true });
  return runtime;
}
