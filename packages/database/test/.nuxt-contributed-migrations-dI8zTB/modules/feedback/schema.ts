import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const feedbackSchema = { feedback: sqliteTable('feedback', { id: integer('id').primaryKey(), body: text('body').notNull() }) }
