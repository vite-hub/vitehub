import { H3, readValidatedBody } from "h3"
import { desc, sql } from "drizzle-orm"
import * as v from "valibot"

import { useDatabase } from "@vite-hub/database/drizzle"

const app = new H3()
const analytics = useDatabase("analytics")
const primary = useDatabase("primary")
const noteBody = v.object({
  title: v.string(),
})
const analyticsEventBody = v.object({
  name: v.string(),
})

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

app.get("/", () => ({ db: "drizzle", ok: true }))

app.get("/api/database", async () => {
  await ensureNotesTable()
  const notes = await primary.db.select().from(primary.schema.notes).orderBy(desc(primary.schema.notes.id))
  return { notes, ok: true }
})

app.post("/api/database", async (event) => {
  await ensureNotesTable()
  const body = await readValidatedBody(event, noteBody)
  const result = await primary.db.insert(primary.schema.notes).values({ title: body.title }).returning()
  return { note: result[0], ok: true }
})

app.get("/api/database/analytics", async () => {
  await ensureAnalyticsEventsTable()
  const events = await analytics.db
    .select()
    .from(analytics.schema.analyticsEvents)
    .orderBy(desc(analytics.schema.analyticsEvents.id))
  return { events, ok: true }
})

app.post("/api/database/analytics", async (event) => {
  await ensureAnalyticsEventsTable()
  const body = await readValidatedBody(event, analyticsEventBody)
  const result = await analytics.db
    .insert(analytics.schema.analyticsEvents)
    .values({ name: body.name })
    .returning()
  return { event: result[0], ok: true }
})

export default app
