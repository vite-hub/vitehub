import { H3, readValidatedBody } from "h3"
import { desc, sql } from "drizzle-orm"
import * as v from "valibot"

import { db, schema } from "@vitehub/db/drizzle"

const app = new H3()
const noteBody = v.object({
  title: v.string(),
})

async function ensureNotesTable() {
  await db.run(sql`
    create table if not exists notes (
      id integer primary key autoincrement,
      title text not null
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

export default app
