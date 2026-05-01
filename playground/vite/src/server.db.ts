import { H3, readValidatedBody } from "h3"
import { desc, sql } from "drizzle-orm"
import * as v from "valibot"

import { databases, db, schema } from "@vitehub/db/drizzle"

const app = new H3()
const noteBody = v.object({
  title: v.string(),
})
const analyticsEventBody = v.object({
  name: v.string(),
})

async function ensureNotesTable() {
  await db.run(sql`
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

app.get("/", () => ({ db: "drizzle", ok: true }))

app.get("/api/db", async () => {
  await ensureNotesTable()
  const notes = await db.select().from(schema.notes).orderBy(desc(schema.notes.id))
  return { notes, ok: true }
})

app.post("/api/db", async (event) => {
  await ensureNotesTable()
  const body = await readValidatedBody(event, noteBody)
  const result = await db.insert(schema.notes).values({ title: body.title }).returning()
  return { note: result[0], ok: true }
})

app.get("/api/db/analytics", async () => {
  await ensureAnalyticsEventsTable()
  const events = await databases.analytics.db
    .select()
    .from(databases.analytics.schema.analyticsEvents)
    .orderBy(desc(databases.analytics.schema.analyticsEvents.id))
  return { events, ok: true }
})

app.post("/api/db/analytics", async (event) => {
  await ensureAnalyticsEventsTable()
  const body = await readValidatedBody(event, analyticsEventBody)
  const result = await databases.analytics.db
    .insert(databases.analytics.schema.analyticsEvents)
    .values({ name: body.name })
    .returning()
  return { event: result[0], ok: true }
})

export default app
