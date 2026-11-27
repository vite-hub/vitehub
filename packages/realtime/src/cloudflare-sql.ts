export interface RealtimeRoomSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> }
}

function hasCloudflareSqlExecInternal(sql: unknown, allowOwnExec: boolean): sql is RealtimeRoomSql {
  if (sql === null || Object(sql) !== sql) return false
  try {
    const ownExec = Object.getOwnPropertyDescriptor(sql, "exec")
    if (ownExec) {
      return allowOwnExec && "value" in ownExec && typeof ownExec.value === "function"
    }

    const prototype = Object.getPrototypeOf(sql)
    if (!prototype) return false
    const findDescriptor = (key: PropertyKey): { descriptor: PropertyDescriptor, owner: object } | undefined => {
      let current: object | null = prototype
      while (current && current !== Object.prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor) return { descriptor, owner: current }
        current = Object.getPrototypeOf(current)
      }
      return undefined
    }
    const constructorEntry = findDescriptor("constructor")
    const execEntry = findDescriptor("exec")
    const databaseSizeEntry = findDescriptor("databaseSize")
    const constructor = constructorEntry?.descriptor.value
    const exec = execEntry?.descriptor.value
    const databaseSize = databaseSizeEntry?.descriptor.get
    if (!constructorEntry || !execEntry || !databaseSizeEntry || !databaseSize) return false
    if (typeof constructor !== "function" || typeof exec !== "function" || typeof databaseSize !== "function") return false
    if (constructor.prototype !== prototype) return false
    if (constructor === Map || constructor === Set || constructor === ArrayBuffer || constructor === DataView || constructor === Uint8Array) return false
    if (typeof URLSearchParams === "function" && constructor === URLSearchParams) return false
    if (typeof SharedArrayBuffer === "function" && constructor === SharedArrayBuffer) return false
    const nativeGetterSource = /^function(?:\s+[\w$]+)*\s*\(\s*\)\s*\{\s*\[native\s+code\]\s*\}$/
    if (!nativeGetterSource.test(Function.prototype.toString.call(databaseSize))) return false
    if (!/^(?:|databaseSize|get databaseSize)$/i.test(databaseSize.name)) return false
    const hasFiniteDatabaseSize = (createReceiver: () => object): boolean => {
      try {
        return Number.isFinite(Reflect.apply(databaseSize, createReceiver(), []))
      }
      catch {
        return false
      }
    }
    if (hasFiniteDatabaseSize(() => new Map())) return false
    if (hasFiniteDatabaseSize(() => new Set())) return false
    if (typeof URLSearchParams === "function" && hasFiniteDatabaseSize(() => new URLSearchParams())) return false
    if (hasFiniteDatabaseSize(() => new ArrayBuffer(0))) return false
    if (hasFiniteDatabaseSize(() => new DataView(new ArrayBuffer(0)))) return false
    if (hasFiniteDatabaseSize(() => new Uint8Array(0))) return false
    if (typeof SharedArrayBuffer === "function" && hasFiniteDatabaseSize(() => new SharedArrayBuffer(0))) return false

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

/** Accept explicit adapters and the native workerd SqlStorage receiver. */
export function hasCloudflareSqlExec(sql: unknown): sql is RealtimeRoomSql {
  return hasCloudflareSqlExecInternal(sql, true)
}

/** Accept only the branded workerd SqlStorage receiver, never explicit adapters. */
export function hasNativeCloudflareSql(sql: unknown): sql is RealtimeRoomSql {
  return hasCloudflareSqlExecInternal(sql, false)
}
