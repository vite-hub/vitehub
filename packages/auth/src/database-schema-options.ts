import { getAuthTables } from "better-auth/db"

import { authDatabaseSchemaError } from "./database-options.ts"

import type { BetterAuthOptions } from "better-auth"

/** Better Auth reads each table by its key and each column by its field key, so the options must not rename them. */
export function assertAuthDatabaseNames(options: BetterAuthOptions): void {
  for (const [model, table] of Object.entries(getAuthTables(options))) {
    if (table.modelName !== model) throw authDatabaseSchemaError(`${model}.modelName cannot be ${JSON.stringify(table.modelName)}, because the table keeps the key \`${model}\``)
    for (const [key, field] of Object.entries(table.fields)) {
      if (field.fieldName && field.fieldName !== key) throw authDatabaseSchemaError(`${model}.${key} cannot map to ${JSON.stringify(field.fieldName)}, because the column keeps the key \`${key}\``)
    }
  }
}
