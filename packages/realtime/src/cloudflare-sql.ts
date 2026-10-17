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
    // Function source strings and own `prototype` properties vary between
    // workerd versions. The receiver probe below is the platform brand check;
    // descriptor shape only ensures that invoking discovery cannot run an
    // arbitrary inherited getter.
    if (typeof constructor !== "function" || typeof exec !== "function" || typeof databaseSize !== "function") return false
    // All platform members belong to one prototype, and its constructor must
    // identify that exact prototype. This rejects copied members and bound or
    // arrow constructor proxies before any candidate callback is invoked.
    if (constructorEntry.owner !== execEntry.owner || constructorEntry.owner !== databaseSizeEntry.owner) return false
    if (!Object.hasOwn(constructor, "prototype") || constructor.prototype !== constructorEntry.owner) return false
    // Accessor callbacks supplied by JavaScript have an own `prototype`;
    // workerd's native getter does not. Reject these before the brand probe so
    // discovery never invokes a fabricated getter.
    if (Object.hasOwn(databaseSize, "prototype")) return false
    // The platform getter is a native accessor. This prevents ordinary
    // JavaScript accessors from forging the receiver-sensitive brand probe.
    // Native accessors have a stable engine-generated source form. A broad
    // substring check is forgeable by an ordinary JavaScript getter whose
    // source merely contains "[native code]".
    // Keep the native marker check independent of optional engine whitespace
    // and accessor naming details while still requiring a native body.
    const nativeGetterSource = /^function\s+get(?:\s+\w+)?\s*\(\s*\)\s*\{\s*\[native\s+code\]\s*\}$/
    if (!nativeGetterSource.test(Function.prototype.toString.call(databaseSize))) return false

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
