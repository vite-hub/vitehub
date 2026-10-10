import type { BoxRuntime } from "../index.ts";

const builtInBoxRuntime: symbol = Symbol.for("vitehub.box.internal-runtime");
type RuntimeConstructor = { prototype?: unknown } & ((...args: never[]) => unknown);

function isFunction(value: unknown): value is RuntimeConstructor {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This boundary checks callability across realms without consulting Symbol.toStringTag.
  return typeof value === "function";
}

// doctor-disable-next-line typescript/evidence/no-object-parameters -- Prototype inspection accepts any object and requires no runtime capability properties.
function isOrdinaryObjectPrototype(value: object): boolean {
  if (Object.getPrototypeOf(value) !== null || !Object.hasOwn(value, "constructor")) return false;
  const constructor = Object.getOwnPropertyDescriptor(value, "constructor")?.value;
  return isFunction(constructor)
    && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
}

export function isBuiltInBoxRuntime(runtime: BoxRuntime): boolean {
  return Object.getOwnPropertyDescriptor(runtime, builtInBoxRuntime)?.value === true;
}

// doctor-disable-next-line typescript/evidence/no-object-parameters -- This boundary inspects property ownership before the caller validates runtime capability values.
export function hasDeclaredBoxRuntimeMember(value: object, key: PropertyKey): boolean {
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

export function markBuiltInBoxRuntime(runtime: BoxRuntime): BoxRuntime {
  Object.defineProperty(runtime, builtInBoxRuntime, { value: true });
  return runtime;
}
