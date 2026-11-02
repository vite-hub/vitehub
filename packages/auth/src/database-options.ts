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

/** The contributed user table cannot persist application-defined profile columns. */
export function assertAuthDatabaseUserFields(additionalFields: object | undefined): void {
  if (additionalFields && Object.keys(additionalFields).length) throw authDatabaseUserFieldsError()
}

export function authDatabaseUserFieldsError(): Error {
  return authErrorDiagnostics.AUTH_C0055({ message: "`authDatabase()` owns a fixed user table and does not support `user.additionalFields`. Use another Better Auth adapter with a schema that includes your profile fields; extending the owned `user` table through a Database contribution is not supported." })
}

export function authDatabasePlacementError(): Error {
  return authErrorDiagnostics.AUTH_C0054({ message: "`authDatabase()` needs one statically invariant Database: call it inline as `defineAuth()`'s `database`, in an object or a callback's single unconditional returned object. Do not select it in branches or override the Database through `runtime` or runtime options." })
}
