export interface RealtimeRoomSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> }
}

/** Accept explicit adapters and the native workerd SqlStorage receiver. */
export function hasCloudflareSqlExec(sql: unknown): sql is RealtimeRoomSql {
  if (sql === null || Object(sql) !== sql) return false
  try {
    const ownExec = Object.getOwnPropertyDescriptor(sql, "exec")
    if (ownExec) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- SQL adapters must provide a callable own data property without invoking accessors.
      return "value" in ownExec && typeof ownExec.value === "function"
    }

    const prototype = Object.getPrototypeOf(sql)
    if (!prototype) return false
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
    const exec = Object.getOwnPropertyDescriptor(prototype, "exec")?.value
    const databaseSize = Object.getOwnPropertyDescriptor(prototype, "databaseSize")?.get
    if (!databaseSize) return false
    // Native function source formatting is runtime-defined, so only require
    // the stable native marker and the platform's prototype shape.
    const isNativeFunction = (value: unknown): value is Function => {
      if (typeof value !== "function") return false
      return /\[native code\]/.test(Function.prototype.toString.call(value))
    }
    const isNativeMethod = (value: unknown): value is Function => {
      if (!isNativeFunction(value)) return false
      // Platform methods and accessors have no user-function `prototype`
      // own property. A Proxy around an ordinary callback retains it.
      return !Object.hasOwn(value, "prototype")
    }
    // SqlStorage is a constructable platform type. Requiring its own
    // prototype rejects proxy-wrapped arrow and bound functions, which can
    // otherwise mimic the native source marker while remaining ordinary JS.
    const isNativeConstructor = (value: unknown): value is Function =>
      isNativeFunction(value) && Object.hasOwn(value, "prototype")
    if (!isNativeConstructor(constructor) || !isNativeMethod(exec) || !isNativeMethod(databaseSize)) return false

    // The native getter must enforce workerd's internal SqlStorage brand.
    // A fabricated getter (including a Proxy-wrapped arrow or bound function)
    // will also return a finite value for an object that merely copies the
    // prototype, whereas the platform getter rejects that counterfeit receiver.
    try {
      Reflect.apply(databaseSize, Object.create(prototype), [])
      return false
    }
    catch {
      return Number.isFinite(Reflect.apply(databaseSize, sql, []))
    }
  }
  catch {
    return false
  }
}
