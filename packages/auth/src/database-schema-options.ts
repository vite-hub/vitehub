import { getAuthTables } from "better-auth/db"

import { authDatabaseSchemaError } from "./database-options.ts"
import { authTableSpecs } from "./schema.ts"

import type { BetterAuthOptions } from "better-auth"
import type { AuthTableName } from "./schema.ts"

/** Compare effective plugin fields and schema mappings before the adapter opens the Database. */
export function assertAuthDatabaseSchema(options: BetterAuthOptions): void {
  for (const [model, table] of Object.entries(getAuthTables(options))) {
    // Other plugin tables can be supplied by the application's Database Definition.
    if (!Object.hasOwn(authTableSpecs, model)) continue
    const spec = authTableSpecs[model as AuthTableName]
    if (table.modelName !== model) throw authDatabaseSchemaError(`${model}.modelName cannot be ${JSON.stringify(table.modelName)}`)
    for (const [key, field] of Object.entries(table.fields)) {
      if (!Object.hasOwn(spec.fields, key)) throw authDatabaseSchemaError(`${model}.${key} is not an owned column`)
      if (field.fieldName && field.fieldName !== key) throw authDatabaseSchemaError(`${model}.${key} cannot map to ${JSON.stringify(field.fieldName)}`)
      if (field.type !== spec.fields[key]!.type) throw authDatabaseSchemaError(`${model}.${key} has an incompatible type`)
    }
  }
}
