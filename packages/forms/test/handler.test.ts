import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"

import { createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"

import type { FormServices } from "../src/index.ts"

const contact = defineForm({
  schema: v.object({
    email: v.pipe(v.string(), v.email("Enter a valid email.")),
    message: v.pipe(v.string(), v.trim(), v.minLength(1, "Write a message."), v.maxLength(5000)),
  }),
  notify: { email: { to: "owner@example.com", replyTo: "email" } },
})

const origin = "https://site.test"

function post(body: unknown, init: { headers?: Record<string, string>, type?: string, raw?: string } = {}): Request {
  const type = init.type ?? "application/json"
  return new Request(`${origin}/api/_vitehub/forms/contact`, {
    method: "POST",
    headers: { "content-type": type, origin, referer: `${origin}/pricing?plan=pro`, ...init.headers },
    body: init.raw ?? (type === "application/json" ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString()),
  })
}

function services(overrides: FormServices = {}) {
  const store = createMemoryFormsStore()
  const email = vi.fn(async () => {})
  let n = 0
  return { store, email, all: { store, email, now: () => 1000, id: () => `id-${++n}`, ...overrides } satisfies FormServices }
}

describe("handleFormRequest", () => {
  it("stores a valid submission with its page and emails the owner", async () => {
    const { store, email, all } = services()
    const response = await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: " Hello " }), all)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: "id-1" })
    expect(await store.list()).toEqual([{
      id: "id-1",
      form: "contact",
      data: { email: "ada@example.com", message: "Hello" },
      page: "/pricing?plan=pro",
      anchor: null,
      user: null,
      status: "open",
      createdAt: 1000,
      updatedAt: 1000,
    }])
    expect(email).toHaveBeenCalledWith({
      to: "owner@example.com",
      replyTo: "ada@example.com",
      subject: "New contact form message",
      text: "New message from the contact form.\n\nemail: ada@example.com\nmessage: Hello\npage: /pricing?plan=pro",
    })
  })

  it("answers 400 with the issue of each field", async () => {
    const { store, all } = services()
    const response = await handleFormRequest("contact", contact, post({ email: "nope", message: "" }), all)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      message: "Check the form and try again.",
      issues: [{ message: "Enter a valid email.", path: ["email"] }, { message: "Write a message.", path: ["message"] }],
    })
    expect(await store.list()).toEqual([])
  })

  it("redirects browser forms with non-JSON schema output before hooks or storage", async () => {
    const onSubmit = vi.fn()
    const form = defineForm({
      schema: v.pipe(v.object({ message: v.string() }), v.transform(() => ({ value: new Date("2026-01-01") }))),
      onSubmit,
      notify: { email: { to: "owner@example.com" } },
    })
    const { store, email, all } = services()
    const response = await handleFormRequest("contact", form, post({ message: "Hi", _page: "/contact" }, { type: "application/x-www-form-urlencoded", headers: { accept: "text/html" } }), all)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/contact?form=contact.error")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(email).not.toHaveBeenCalled()
    expect(await store.list()).toEqual([])
  })

  it("keeps the page and anchor fields out of the data", async () => {
    const { store, all } = services()
    await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Typo", _page: "/docs/intro", _anchor: { selector: "main p", exact: "teh word", prefix: "Fix ", suffix: " here", kind: "text" } }), all)
    const [saved] = await store.list()
    expect(saved).toMatchObject({ data: { email: "ada@example.com", message: "Typo" }, page: "/docs/intro", anchor: { selector: "main p", exact: "teh word", prefix: "Fix ", suffix: " here" } })
  })

  it("keeps no anchor without a selector", async () => {
    const { store, all } = services()
    await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi", _anchor: { exact: "orphan" } }), all)
    expect((await store.list())[0]?.anchor).toBeNull()
  })

  it("does not keep the result of an earlier post in the page", async () => {
    const { store, all } = services()
    await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }, { headers: { referer: `${origin}/contact?plan=pro&form=contact.error` } }), all)
    expect((await store.list())[0]?.page).toBe("/contact?plan=pro")
    // A `form` query of the app itself stays.
    await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }, { headers: { referer: `${origin}/signup?form=newsletter` } }), all)
    expect((await store.list())[0]?.page).toBe("/signup?form=newsletter")
  })

  it("does not keep a page of another origin", async () => {
    const { store, all } = services()
    await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi", _page: "https://evil.test/x" }), all)
    expect((await store.list())[0]?.page).toBeNull()
  })

  it("pretends success for a filled honeypot and stores nothing", async () => {
    const { store, email, all } = services()
    const response = await handleFormRequest("contact", contact, post({ email: "bot@example.com", message: "Buy", website: "https://spam.test" }), all)
    expect(response.status).toBe(202)
    expect(await store.list()).toEqual([])
    expect(email).not.toHaveBeenCalled()
  })

  it("rejects another origin, other methods, other bodies, and large bodies", async () => {
    const { all } = services()
    expect((await handleFormRequest("contact", contact, post({}, { headers: { origin: "https://evil.test" } }), all)).status).toBe(403)
    expect((await handleFormRequest("contact", contact, new Request(`${origin}/x`), all)).status).toBe(405)
    expect((await handleFormRequest("contact", contact, post({}, { type: "text/plain", raw: "hi" }), all)).status).toBe(415)
    expect((await handleFormRequest("contact", contact, post({}, { raw: "[1]" }), all)).status).toBe(400)
    expect((await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "x".repeat(70_000) }), all)).status).toBe(413)
  })

  it("lets a listed origin post", async () => {
    const form = defineForm({ schema: v.object({ message: v.string() }), origins: ["https://other.test"] })
    const { all } = services()
    expect((await handleFormRequest("other", form, post({ message: "Hi" }, { headers: { origin: "https://other.test" } }), all)).status).toBe(201)
  })

  it("asks the rate limit with the form key and the default policy", async () => {
    const rateLimit = vi.fn(async () => ({ allowed: false, retryAfter: 41.2 }))
    const { store, all } = services({ rateLimit })
    const response = await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }), all)
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("42")
    expect(rateLimit).toHaveBeenCalledWith(expect.any(Request), "form:contact", { limit: 5, window: "1m" })
    expect(await store.list()).toEqual([])
  })

  it("checks authorize with the identified user", async () => {
    const form = defineForm({ schema: v.object({ text: v.string() }), authorize: ({ user }) => user?.id === "ada" })
    // A refused sender uses no rate budget.
    const rateLimit = vi.fn(async () => ({ allowed: true }))
    const anonymous = services({ rateLimit })
    expect((await handleFormRequest("issue", form, post({ text: "x" }), anonymous.all)).status).toBe(401)
    expect(rateLimit).not.toHaveBeenCalled()
    const grace = services({ identify: () => ({ id: "grace" }) })
    expect((await handleFormRequest("issue", form, post({ text: "x" }), grace.all)).status).toBe(403)
    const ada = services({ identify: () => ({ id: "ada", name: "Ada" }) })
    expect((await handleFormRequest("issue", form, post({ text: "x" }), ada.all)).status).toBe(201)
    expect((await ada.store.list())[0]?.user).toEqual({ id: "ada", name: "Ada" })
  })

  it.each(["identify", "authorize"])("bounds the body before %s can read it, without using rate budget", async (consumer) => {
    const read = vi.fn(async (request: Request) => request.text())
    const form = defineForm({
      schema: v.object({ text: v.string() }),
      maxBytes: 2048,
      authorize: async ({ request }) => {
        if (consumer === "authorize") await read(request)
        return false
      },
    })
    const rateLimit = vi.fn(async () => ({ allowed: true }))
    const { store, all } = services({
      identify: async (request) => {
        if (consumer === "identify") await read(request)
        return null
      },
      rateLimit,
    })
    expect((await handleFormRequest("issue", form, post({ text: "x".repeat(8192) }), all)).status).toBe(413)
    expect(read).not.toHaveBeenCalled()
    expect(rateLimit).not.toHaveBeenCalled()
    expect(await store.list()).toEqual([])
    expect((await handleFormRequest("issue", form, post({ text: "Hi" }), all)).status).toBe(401)
    expect(read).toHaveBeenCalledOnce()
    expect(rateLimit).not.toHaveBeenCalled()
  })

  it("answers with the Response that onSubmit returns and stores nothing", async () => {
    const form = defineForm({
      schema: v.object({ target: v.string() }),
      onSubmit: ({ data }) => data.target === "/d/missing" ? new Response("No drop", { status: 404 }) : undefined,
    })
    const { store, all } = services()
    expect((await handleFormRequest("report", form, post({ target: "/d/missing" }), all)).status).toBe(404)
    expect((await handleFormRequest("report", form, post({ target: "/d/ok" }), all)).status).toBe(201)
    expect((await store.list()).map(row => row.data)).toEqual([{ target: "/d/ok" }])
  })

  it.each([
    ["rejects", async () => { throw new Error("SMTP down") }],
    ["throws", () => { throw new Error("SMTP down") }],
  ])("keeps a stored submission when email %s", async (_, email) => {
    const log = vi.fn()
    const { store, all } = services({ email, log })
    const response = await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }), all)
    expect(response.status).toBe(201)
    expect(await store.list()).toHaveLength(1)
    expect(log).toHaveBeenCalledWith("[vitehub] The contact form stored a submission but could not send its email.", expect.any(Error))
  })

  it("requires the store before running submission hooks or sending email", async () => {
    const schema = v.object({ message: v.string() })
    const request = () => post({ message: "Hi" })
    const plain = defineForm({ schema })
    expect((await handleFormRequest("contact", plain, request())).status).toBe(503)

    const onSubmit = vi.fn()
    const form = defineForm({ schema, onSubmit, notify: { email: { to: "owner@example.com" } } })
    const { email, all } = services({ store: undefined })
    expect((await handleFormRequest("contact", form, request(), all)).status).toBe(503)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(email).not.toHaveBeenCalled()
    const native = await handleFormRequest("contact", plain, post({ message: "Hi" }, { type: "application/x-www-form-urlencoded", headers: { accept: "text/html" } }))
    expect(native.status).toBe(303)
    expect(native.headers.get("location")).toBe("/pricing?plan=pro&form=contact.error")

    const handled = defineForm({ schema, store: false, onSubmit })
    expect((await handleFormRequest("contact", handled, request())).status).toBe(201)
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it("passes the email to waitUntil when the host has it", async () => {
    const waitUntil = vi.fn()
    const { email, all } = services({ waitUntil })
    await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }), all)
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
    expect(email).toHaveBeenCalledOnce()
  })

  it("fails without store when the email fails", async () => {
    const form = defineForm({ schema: v.object({ message: v.string() }), store: false, notify: { email: { to: "owner@example.com" } } })
    const failing = services({ email: async () => { throw new Error("down") } })
    expect((await handleFormRequest("contact", form, post({ message: "Hi" }), failing.all)).status).toBe(502)
    const none = services({ email: undefined })
    expect((await handleFormRequest("contact", form, post({ message: "Hi" }), none.all)).status).toBe(503)
    const working = services()
    expect((await handleFormRequest("contact", form, post({ message: "Hi" }), working.all)).status).toBe(201)
    expect(await working.store.list()).toEqual([])
  })

  it("sends a browser form without JavaScript back to its page", async () => {
    const { store, all } = services()
    const sent = await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }, { type: "application/x-www-form-urlencoded", headers: { accept: "text/html" } }), all)
    expect(sent.status).toBe(303)
    expect(sent.headers.get("location")).toBe("/pricing?plan=pro&form=contact.sent")
    expect(await store.list()).toHaveLength(1)
    const wrong = await handleFormRequest("contact", contact, post({ email: "x", message: "Hi" }, { type: "application/x-www-form-urlencoded", headers: { accept: "text/html" } }), all)
    expect(wrong.headers.get("location")).toBe("/pricing?plan=pro&form=contact.error")
    // Every other failure also goes back to the page, such as the rate limit.
    const limited = await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }, { type: "application/x-www-form-urlencoded", headers: { accept: "text/html" } }), { ...all, rateLimit: async () => ({ allowed: false }) })
    expect(limited.status).toBe(303)
    expect(limited.headers.get("location")).toBe("/pricing?plan=pro&form=contact.error")
  })

  it.each(["urlencoded", "multipart"])("decodes supported Valibot fields in a native %s post", async (encoding) => {
    enum Size { Small = 1, Large = 2 }
    const schema = v.object({
      count: v.pipe(v.number(), v.minValue(1), v.transform(value => value + 1)),
      size: v.enum(Size),
      choice: v.optional(v.picklist([1, 2])),
      extra: v.optional(v.number()),
      newsletter: v.boolean(),
      terms: v.optional(v.boolean()),
    })
    const form = defineForm({ schema })
    const { store, all } = services()
    const values = { count: "2", size: "2", choice: "1", extra: "", terms: "on" }
    const body = encoding === "multipart" ? new FormData() : new URLSearchParams()
    for (const [key, value] of Object.entries(values)) body.set(key, value)
    const response = await handleFormRequest("contact", form, new Request(`${origin}/api/_vitehub/forms/contact`, {
      method: "POST",
      headers: { origin, referer: `${origin}/pricing?plan=pro`, accept: "text/html" },
      body,
    }), all)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/pricing?plan=pro&form=contact.sent")
    expect((await store.list()).map(row => row.data)).toStrictEqual([{ count: 3, size: 2, choice: 1, newsletter: false, terms: true }])
  })

  it("keeps JSON input strict and rejects invalid native values", async () => {
    const form = defineForm({ schema: v.object({ count: v.number(), terms: v.boolean(), choice: v.optional(v.picklist([1, 2])) }) })
    const { store, all } = services()
    expect((await handleFormRequest("contact", form, post({ count: "2", terms: "on" }), all)).status).toBe(400)
    for (const values of [{ count: "nope", terms: "on" }, { count: "", terms: "on" }, { count: "2", terms: "wrong" }, { count: "2", terms: "on", choice: "3" }]) {
      expect((await handleFormRequest("contact", form, post(values, { type: "application/x-www-form-urlencoded" }), all)).status).toBe(400)
    }
    expect(await store.list()).toEqual([])
  })

  it("trusts the origin of a TLS proxy, keeps redirects on the site, and rejects a broken multipart body", async () => {
    const { all } = services()
    // The proxy ends TLS, so the server sees `http:` and the browser sends its `https:` origin.
    const proxied = new Request("http://site.test/api/_vitehub/forms/contact", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://site.test", "x-forwarded-proto": "https" },
      body: JSON.stringify({ email: "ada@example.com", message: "Hi" }),
    })
    expect((await handleFormRequest("contact", contact, proxied, all)).status).toBe(201)
    // A path with two leading slashes would send the visitor to another site.
    const html = { type: "application/x-www-form-urlencoded", headers: { accept: "text/html", referer: `${origin}//x//evil.test` } }
    const sent = await handleFormRequest("contact", contact, post({ email: "ada@example.com", message: "Hi" }, html), all)
    expect(sent.headers.get("location")).toBe("/x//evil.test?form=contact.sent")
    const broken = post({}, { type: "multipart/form-data", raw: "not multipart" })
    expect((await handleFormRequest("contact", contact, broken, all)).status).toBe(400)
  })

  it("reads multipart form data", async () => {
    const { store, all } = services()
    const body = new FormData()
    body.set("email", "ada@example.com")
    body.set("message", "Hi")
    const request = new Request(`${origin}/x`, { method: "POST", headers: { origin }, body })
    expect((await handleFormRequest("contact", contact, request, all)).status).toBe(201)
    expect((await store.list())[0]?.data).toEqual({ email: "ada@example.com", message: "Hi" })
  })
})

describe("defineForm", () => {
  const schema = v.object({ message: v.string() })

  it("rejects what it cannot run", () => {
    // @ts-expect-error not a Standard Schema
    expect(() => defineForm({ schema: {} })).toThrow("`schema` must be a Standard Schema")
    expect(() => defineForm({ schema, rateLimit: { limit: 0, window: "1m" } })).toThrow("`rateLimit.limit`")
    expect(() => defineForm({ schema, rateLimit: { limit: 1, window: "a minute" } })).toThrow("`rateLimit.window`")
    expect(() => defineForm({ schema, honeypot: "no spaces" })).toThrow("`honeypot`")
    expect(() => defineForm({ schema, maxBytes: 10 })).toThrow("`maxBytes`")
    expect(() => defineForm({ schema, origins: ["https://a.test/path"] })).toThrow("`origins`")
    expect(() => defineForm({ schema, notify: { email: { to: [] } } })).toThrow("`notify.email.to`")
    expect(() => defineForm({ schema, store: false })).toThrow("With `store: false`")
  })

  it("types notify.replyTo and onSubmit from the schema output", () => {
    defineForm({
      schema: v.object({ email: v.string(), count: v.number() }),
      notify: { email: { to: "a@b.c", replyTo: "email", subject: data => `${data.count}` } },
      onSubmit: ({ data }) => { data.count.toFixed() },
    })
    // @ts-expect-error not a field of the schema
    defineForm({ schema: v.object({ email: v.string() }), notify: { email: { to: "a@b.c", replyTo: "mail" } } })
  })
})
