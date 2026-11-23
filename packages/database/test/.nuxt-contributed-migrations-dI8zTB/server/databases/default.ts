import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'
export const users = sqliteTable('users', { id: integer('id').primaryKey() })
export default defineDatabase({ schema: { users } })
