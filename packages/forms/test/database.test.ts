import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"

import { createDrizzleFormsStore, formsTables } from "../src/database.ts"
import { createFormsInbox, createMemoryFormsStore } from "../src/index.ts"

import type { FormsStore, FormSubmission } from "../src/index.ts"

async function drizzleStore(): Promise<FormsStore> {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${formsTables.join(";\n")};`)
  return createDrizzleFormsStore(drizzle(client))
}

function submission(id: string, form: string, createdAt: number): FormSubmission {
  return { id, form, data: { message: id }, page: "/", anchor: id === "a" ? { text: "x" } : null, user: null, status: "open", createdAt, updatedAt: createdAt }
}

describe.each([
  ["Drizzle SQLite", drizzleStore],
  ["memory", async () => createMemoryFormsStore()],
])("%s store", (_, create) => {
  it("lists newest first, by form and status, and pages with before", async () => {
    const store = await create()
    for (const row of [submission("a", "contact", 1), submission("b", "contact", 2), submission("c", "feedback", 2), submission("d", "contact", 3)]) await store.insert(row)
    expect((await store.list()).map(row => row.id)).toEqual(["d", "c", "b", "a"])
    expect((await store.list({ form: "contact" })).map(row => row.id)).toEqual(["d", "b", "a"])
    expect((await store.list({ before: { createdAt: 2, id: "c" } })).map(row => row.id)).toEqual(["b", "a"])
    expect((await store.list({ limit: 1 })).map(row => row.id)).toEqual(["d"])
    expect(await store.get("a")).toEqual(submission("a", "contact", 1))
    expect(await store.get("missing")).toBeUndefined()
  })

  it("changes the status through the inbox", async () => {
    const store = await create()
    await store.insert(submission("a", "contact", 1))
    const inbox = createFormsInbox(store, () => 50)
    const [error, done] = await inbox.setStatus("a", "done")
    expect(error).toBeUndefined()
    expect(done).toMatchObject({ status: "done", updatedAt: 50 })
    expect((await inbox.list({ status: "open" }))[1]).toEqual([])
    const [missing] = await inbox.get("nope")
    expect(missing?.message).toContain("No form submission has the id \"nope\"")
  })
})

it("names the migration when the table is missing", async () => {
  const store = createDrizzleFormsStore(drizzle(createClient({ url: ":memory:" })))
  const [error] = await createFormsInbox(store).list()
  expect(error?.message).toContain("vitehub db migrate")
})
