import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"

import { createDrizzleFormsStore, formsTables } from "../src/database.ts"
import { formsDiagnostics } from "../src/errors.ts"
import { createFormsInbox, createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"

import type { FormsStore, FormSubmission } from "../src/index.ts"

async function drizzleStore(): Promise<FormsStore> {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${formsTables.join(";\n")};`)
  // The Database of a ViteHub app has the Forms schema, so the store takes a Drizzle Database with any schema.
  return createDrizzleFormsStore(drizzle({ client }))
}

it("runs a keyed submission hook once across independent handlers sharing SQLite", async () => {
  const client = createClient({ url: ":memory:" })
  try {
    await client.executeMultiple(`${formsTables.join(";\n")};`)
    const firstStore = createDrizzleFormsStore(drizzle({ client }))
    const secondStore = createDrizzleFormsStore(drizzle({ client }))
    vi.resetModules()
    const { handleFormRequest: handleRetry } = await import("../src/handler.ts")
    const key = crypto.randomUUID()
    const request = () => new Request("https://site.test/form", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ message: "Hi" }) })
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    let releaseHook!: () => void
    const finish = new Promise<void>(resolve => { releaseHook = resolve })
    const onSubmit = vi.fn<() => Promise<void>>(async () => {}).mockImplementationOnce(async () => {
      signalStarted()
      await finish
    })
    const email = vi.fn(async () => {})
    const form = defineForm({ schema: v.object({ message: v.string() }), onSubmit, notify: { email: { to: "owner@example.com" } } })
    const first = handleFormRequest("contact", form, request(), { store: firstStore, email })
    await started
    let retry: Response
    try {
      expect(await secondStore.list()).toEqual([])
      expect(await secondStore.get(key)).toBeUndefined()
      expect(await secondStore.setStatus(key, "spam", 1)).toBeUndefined()
      retry = await handleRetry("contact", form, request(), { store: secondStore, email })
    }
    finally {
      releaseHook()
      await first
    }
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(retry.status).toBe(409)
    expect((await first).status).toBe(201)
    const replay = await handleRetry("contact", form, request(), { store: secondStore, email })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual({ id: key })
    expect(await secondStore.list()).toMatchObject([{ id: key, status: "open" }])
    expect(email).toHaveBeenCalledOnce()
  }
  finally {
    client.close()
  }
})

function submission(id: string, form: string, createdAt: number): FormSubmission {
  return { id, form, data: { message: id }, page: "/", anchor: id === "a" ? { selector: "p", exact: "x", prefix: "", suffix: "" } : null, user: null, status: "open", createdAt, updatedAt: createdAt }
}

describe.each([
  ["Drizzle SQLite", drizzleStore],
  ["memory", async () => createMemoryFormsStore()],
])("%s store", (_, create) => {
  const request = () => new Request("https://site.test/form", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hi" }) })

  it("releases the reservation when a keyed hook responds or throws", async () => {
    const store = await create()
    const key = crypto.randomUUID()
    const onSubmit = vi.fn()
      .mockResolvedValueOnce(new Response("No drop", { status: 404 }))
      .mockRejectedValueOnce(new Error("hook failed"))
    const form = defineForm({ schema: v.object({ message: v.string() }), onSubmit })
    const send = () => {
      const incoming = request()
      incoming.headers.set("idempotency-key", key)
      return handleFormRequest("contact", form, incoming, { store })
    }
    expect((await send()).status).toBe(404)
    expect(await store.list()).toEqual([])
    await expect(send()).rejects.toThrow("hook failed")
    expect(await store.list()).toEqual([])
    expect((await send()).status).toBe(201)
    expect(await store.list()).toMatchObject([{ id: key }])
  })

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

  it("keeps the first submission of an id and says so", async () => {
    const store = await create()
    expect(await store.insert(submission("a", "contact", 1))).toBe(true)
    expect(await store.insert({ ...submission("a", "contact", 2), data: { message: "again" } })).toBe(false)
    expect(await store.list()).toEqual([submission("a", "contact", 1)])
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

  it("deletes only the submissions of one user", async () => {
    const store = await create()
    await store.insert({ ...submission("mine", "contact", 1), user: { id: "user-1", email: "ana@example.com" } })
    await store.insert({ ...submission("other", "contact", 2), user: { id: "user-10" } })
    await store.insert(submission("anonymous", "contact", 3))
    await store.deleteUser("user-1")
    await store.deleteUser("user-without-submissions")
    expect((await store.list()).map(row => row.id)).toEqual(["anonymous", "other"])
  })
})

it("names the migration when the table is missing", async () => {
  const store = createDrizzleFormsStore(drizzle({ client: createClient({ url: ":memory:" }) }))
  const [error] = await createFormsInbox(store).list()
  expect(error).toMatchObject({
    code: "FORMS_TABLES_MISSING",
    fix: expect.stringMatching(/vitehub database generate.*vitehub database migrate/),
    why: "[vitehub] Forms could not list submissions: the Database has no `vitehub_form_submissions` table.",
  })
})

it("answers a form post without the Forms tables with the code and the fix", async () => {
  const store = createDrizzleFormsStore(drizzle({ client: createClient({ url: ":memory:" }) }))
  const log = vi.fn()
  const form = defineForm({ schema: v.object({ message: v.string() }) })
  const request = (browser = false) => new Request("https://site.test/_vitehub/forms/review", {
    method: "POST",
    headers: {
      "content-type": browser ? "application/x-www-form-urlencoded" : "application/json",
      ...browser ? { accept: "text/html" } : {},
      origin: "https://site.test",
      referer: "https://site.test/ai-workflows",
    },
    body: browser ? "message=Hi" : JSON.stringify({ message: "Hi" }),
  })

  const response = await handleFormRequest("review", form, request(), { store, log })
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({
    code: "FORMS_TABLES_MISSING",
    fix: expect.stringContaining("vitehub database migrate"),
    message: "[vitehub] Forms could not store a submission: the Database has no `vitehub_form_submissions` table.",
  })
  expect(log).toHaveBeenCalledWith("[vitehub] The review form could not store a submission.", expect.objectContaining({ code: "FORMS_TABLES_MISSING" }))

  const native = await handleFormRequest("review", form, request(true), { store, log })
  expect(native.status).toBe(303)
  expect(native.headers.get("location")).toBe("/ai-workflows?form=review.error")
})

it("keeps the Forms code that the Database lookup throws", async () => {
  const store = createDrizzleFormsStore(() => { throw formsDiagnostics.FORMS_DATABASE_MISSING({ database: "inbox" }) })
  const [error] = await createFormsInbox(store).list()
  expect(error).toMatchObject({ code: "FORMS_DATABASE_MISSING" })
})

it("keeps FORMS_R0001 for other Database errors", async () => {
  const client = createClient({ url: ":memory:" })
  await client.execute("CREATE TABLE `vitehub_form_submissions` (`id` text PRIMARY KEY NOT NULL)")
  const [error] = await createFormsInbox(createDrizzleFormsStore(drizzle({ client }))).list()
  expect(error).toMatchObject({ code: "FORMS_R0001", why: "[vitehub] Forms could not list submissions." })
})
