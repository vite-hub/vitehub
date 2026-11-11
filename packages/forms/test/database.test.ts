import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"

import { createDrizzleFormsStore, formsTables } from "../src/database.ts"
import { createFormsInbox, createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"

import type { FormsStore, FormSubmission } from "../src/index.ts"

async function drizzleStore(): Promise<FormsStore> {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${formsTables.join(";\n")};`)
  // The Database of a ViteHub app has the Forms schema, so the store takes a Drizzle Database with any schema.
  return createDrizzleFormsStore(drizzle({ client }))
}

function submission(id: string, form: string, createdAt: number): FormSubmission {
  return { id, form, data: { message: id }, page: "/", anchor: id === "a" ? { selector: "p", exact: "x", prefix: "", suffix: "" } : null, user: null, status: "open", createdAt, updatedAt: createdAt }
}

describe.each([
  ["Drizzle SQLite", drizzleStore],
  ["memory", async () => createMemoryFormsStore()],
])("%s store", (_, create) => {
  const request = () => new Request("https://site.test/form", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hi" }) })

  it.each([
    { name: "nested JSON", output: { message: "Hi", details: { items: [true, null, 3] }, zero: -0 }, expected: { message: "Hi", details: { items: [true, null, 3] }, zero: 0 }, text: 'details: {"items":[true,null,3]}' },
    { name: "null", output: null, expected: null, text: "value: null" },
  ])("uses the same $name output in hooks, email, and storage", async ({ output, expected, text }) => {
    const store = await create()
    const onSubmit = vi.fn()
    const email = vi.fn(async () => {})
    const form = defineForm({
      schema: v.pipe(v.object({ message: v.string() }), v.transform(() => output)),
      onSubmit,
      notify: { email: { to: "owner@example.com" } },
    })
    const response = await handleFormRequest("contact", form, request(), { store, email })
    expect(response.status).toBe(201)
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ data: expected }), expect.anything())
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(text) }))
    expect((await store.list())[0]?.data).toEqual(expected)
  })

  it.each([
    { name: "bigint", output: () => ({ value: 1n }) },
    { name: "Date", output: () => ({ value: new Date("2026-01-01") }) },
    { name: "Map", output: () => ({ value: new Map([["key", "value"]]) }) },
    { name: "non-finite number", output: () => ({ value: Infinity }) },
    { name: "undefined field", output: () => ({ value: undefined }) },
    { name: "undefined output", output: () => undefined },
    { name: "cycle", output: () => { const value: { self?: unknown } = {}; value.self = value; return value } },
  ])("rejects transformed $name before hooks, email, or storage", async ({ output }) => {
    const store = await create()
    const onSubmit = vi.fn()
    const email = vi.fn(async () => {})
    const form = defineForm({
      schema: v.pipe(v.object({ message: v.string() }), v.transform(() => output())),
      onSubmit,
      notify: { email: { to: "owner@example.com" } },
    })
    const response = await handleFormRequest("contact", form, request(), { store, email })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ issues: [{ path: [], message: expect.stringContaining("JSON") }] })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(email).not.toHaveBeenCalled()
    expect(await store.list()).toEqual([])
  })

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
  const store = createDrizzleFormsStore(drizzle({ client: createClient({ url: ":memory:" }) }))
  const [error] = await createFormsInbox(store).list()
  expect(error?.message).toContain("vitehub database generate")
  expect(error?.message).toContain("vitehub database migrate")
})
