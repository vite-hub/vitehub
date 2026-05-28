import { H3, readBody } from "h3"
import { desc, sql } from "drizzle-orm"

import { databases } from "@vitehub/database/drizzle"

const app = new H3()

async function ensureNotesTable() {
  await databases.primary.db.run(sql`
    create table if not exists notes (
      id integer primary key autoincrement,
      title text not null
    )
  `)
}

async function ensureAnalyticsEventsTable() {
  await databases.analytics.db.run(sql`
    create table if not exists analytics_events (
      id integer primary key autoincrement,
      name text not null
    )
  `)
}

app.get("/api/notes", async () => {
  await ensureNotesTable()
  const notes = await databases.primary.db.select().from(databases.primary.schema.notes).orderBy(desc(databases.primary.schema.notes.id))
  return { notes, ok: true }
})

app.post("/api/notes", async (event) => {
  await ensureNotesTable()
  const body = await readBody<{ title?: string }>(event)
  const result = await databases.primary.db.insert(databases.primary.schema.notes).values({ title: body.title || "hello database" }).returning()
  return { note: result[0], ok: true }
})

app.get("/api/analytics/events", async () => {
  await ensureAnalyticsEventsTable()
  const events = await databases.analytics.db
    .select()
    .from(databases.analytics.schema.analyticsEvents)
    .orderBy(desc(databases.analytics.schema.analyticsEvents.id))
  return { events, ok: true }
})

app.post("/api/analytics/events", async (event) => {
  await ensureAnalyticsEventsTable()
  const body = await readBody<{ name?: string }>(event)
  const result = await databases.analytics.db
    .insert(databases.analytics.schema.analyticsEvents)
    .values({ name: body.name || "page-view" })
    .returning()
  return { event: result[0], ok: true }
})

export default app
