import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const notes = sqliteTable('notes', { id: integer('id').primaryKey() })
export const threads = sqliteTable('threads', { id: text('id').primaryKey() })
