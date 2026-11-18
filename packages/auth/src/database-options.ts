import { authErrorDiagnostics } from "./error-diagnostics.ts"

/** Reads the adapter's target without loading Better Auth or the Database runtime. */
export function authDatabaseName(database: unknown): string | undefined {
  if (typeof database !== "function") return
  const name: unknown = Reflect.get(database, "vitehubDatabase")
  return typeof name === "string" ? name : undefined
}

/** The owned schema has text IDs and references, with no database-generated default. */
export function assertAuthDatabaseIdStrategy(generateId: unknown): void {
  if (generateId === "serial" || generateId === "uuid" || generateId === false) {
    throw authErrorDiagnostics.AUTH_C0053({ message: "`authDatabase()` owns tables with text IDs. Use Better Auth's default ID generator or a custom function returning strings; `advanced.database.generateId` cannot be `serial`, `uuid`, or `false`. Use another Better Auth adapter to own a different ID schema." })
  }
}

/** The Auth Vite plugin reads `additionalFields` from the Definition to add their columns, so they must be static. */
export function authDatabaseAdditionalFieldsError(detail: string): Error {
  return authErrorDiagnostics.AUTH_C0055({ message: `\`authDatabase()\` adds a column for each additional field, but ${detail}.` })
}

/** The Better Auth options need a table, a column, or a name that the Database of `authDatabase()` does not have. */
export function authDatabaseSchemaError(detail: string): Error {
  return authErrorDiagnostics.AUTH_C0056({ message: `\`authDatabase()\` cannot store the Better Auth options: ${detail}.` })
}

export function authDatabasePlacementError(): Error {
  return authErrorDiagnostics.AUTH_C0054({ message: "`authDatabase()` needs one statically invariant Database: call it inline as `defineAuth()`'s `database`, in an object or a callback's single unconditional returned object. Do not select it in branches." })
}

/** Outside a development server, Auth keeps users in memory only when the Definition asks for it. */
export function authMemoryDatabaseError(): Error {
  return authErrorDiagnostics.AUTH_C0063({ message: "`defineAuth()` has no `database` or `preset`. Auth keeps users and sessions in memory only on a development server, because a restart or a second instance loses them." })
}
