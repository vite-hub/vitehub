import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { BetterAuthOptions } from "better-auth"

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

/** The contributed core tables cannot persist application-defined columns. */
export function assertAuthDatabaseAdditionalFields(options: Pick<BetterAuthOptions, "user" | "session" | "account" | "verification">): void {
  for (const model of ["user", "session", "account", "verification"] as const) {
    const fields = options[model]?.additionalFields
    if (fields && Object.keys(fields).length) throw authDatabaseAdditionalFieldsError(model)
  }
}

export function authDatabaseAdditionalFieldsError(model: string): Error {
  return authErrorDiagnostics.AUTH_C0055({ message: `\`authDatabase()\` owns fixed tables and does not support \`${model}.additionalFields\`. Use another Better Auth adapter with a schema that includes your fields; extending the owned tables through a Database contribution is not supported.` })
}

export function authDatabaseSchemaError(detail: string): Error {
  return authErrorDiagnostics.AUTH_C0056({ message: `\`authDatabase()\` owns fixed table and field names: ${detail}. Use another Better Auth adapter with a schema matching your options and plugins.` })
}

export function authDatabasePlacementError(): Error {
  return authErrorDiagnostics.AUTH_C0054({ message: "`authDatabase()` needs one statically invariant Database: call it inline as `defineAuth()`'s `database`, in an object or a callback's single unconditional returned object. Do not select it in branches or override the Database through `runtime` or runtime options." })
}
