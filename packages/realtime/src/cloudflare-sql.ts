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
    if (!isNativeFunction(constructor) || !isNativeMethod(exec) || !isNativeMethod(databaseSize)) return false

    // This read-only native getter checks workerd's internal SqlStorage receiver.
    // Copying its prototype onto an ordinary object does not pass the check.
    return Number.isFinite(Reflect.apply(databaseSize, sql, []))
  }
  catch {
    return false
  }
}
