import { H3, readBody } from "h3"
import { desc, sql } from "drizzle-orm"

import { useDatabase } from "@vite-hub/database/drizzle"

const app = new H3()
const analytics = useDatabase("analytics")
const primary = useDatabase("primary")

async function ensureNotesTable() {
  await primary.db.run(sql`
    create table if not exists notes (
      id integer primary key autoincrement,
      title text not null
    )
  `)
}

async function ensureAnalyticsEventsTable() {
  await analytics.db.run(sql`
    create table if not exists analytics_events (
      id integer primary key autoincrement,
      name text not null
    )
  `)
}

app.get("/api/notes", async () => {
  await ensureNotesTable()
  const notes = await primary.db.select().from(primary.schema.notes).orderBy(desc(primary.schema.notes.id))
  return { notes, ok: true }
})

app.post("/api/notes", async (event) => {
  await ensureNotesTable()
  const body = await readBody<{ title?: string }>(event)
  const result = await primary.db.insert(primary.schema.notes).values({ title: body.title || "hello database" }).returning()
  return { note: result[0], ok: true }
})

app.get("/api/analytics/events", async () => {
  await ensureAnalyticsEventsTable()
  const events = await analytics.db
    .select()
    .from(analytics.schema.analyticsEvents)
    .orderBy(desc(analytics.schema.analyticsEvents.id))
  return { events, ok: true }
})

app.post("/api/analytics/events", async (event) => {
  await ensureAnalyticsEventsTable()
  const body = await readBody<{ name?: string }>(event)
  const result = await analytics.db
    .insert(analytics.schema.analyticsEvents)
    .values({ name: body.name || "page-view" })
    .returning()
  return { event: result[0], ok: true }
})

export default app
