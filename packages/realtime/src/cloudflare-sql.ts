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
    if (Function.prototype.toString.call(constructor) !== "function SqlStorage() { [native code] }") return false
    if (Function.prototype.toString.call(exec) !== "function exec() { [native code] }") return false
    if (!/\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(databaseSize))) return false

    // This read-only native getter checks workerd's internal SqlStorage receiver.
    // Copying its prototype onto an ordinary object does not pass the check.
    return Number.isFinite(Reflect.apply(databaseSize, sql, []))
  }
  catch {
    return false
  }
}
