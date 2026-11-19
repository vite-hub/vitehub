import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { fieldErrors, formRoute, submitForm } from "../src/client.ts"
import { createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"

const form = defineForm({ schema: v.object({ message: v.pipe(v.string(), v.minLength(2, "Too short.")), seats: v.optional(v.number()) }) })

function server(store = createMemoryFormsStore()): typeof fetch {
  return async (input, init) => {
    const request = new Request(new URL(String(input), "https://site.test"), init)
    return handleFormRequest("feedback", form, request, { store })
  }
}

describe("submitForm", () => {
  it("posts to the form route with the page and anchor", async () => {
    const store = createMemoryFormsStore()
    const [error, data] = await submitForm("feedback", { message: "Hello" }, { fetch: server(store), page: "/docs", anchor: { selector: "main p", exact: "selected", prefix: "", suffix: "" } })
    expect(error).toBeUndefined()
    expect(data?.id).toEqual(expect.any(String))
    expect((await store.list())[0]).toMatchObject({ data: { message: "Hello" }, page: "/docs", anchor: { selector: "main p", exact: "selected", prefix: "", suffix: "" } })
  })

  it("returns the field issues of a 400", async () => {
    const [error] = await submitForm("feedback", { message: "x" }, { fetch: server() })
    expect(error).toMatchObject({ code: "FORMS_SUBMIT_INVALID", fix: expect.stringContaining("fieldErrors"), status: 400, issues: [{ message: "Too short.", path: ["message"] }] })
  })

  it("sends FormData as form fields, which the server decodes to the schema types", async () => {
    const store = createMemoryFormsStore()
    const data = new FormData()
    data.set("message", "Hello")
    data.set("seats", "3")
    const [error] = await submitForm("feedback", data, { fetch: server(store), page: "/docs", anchor: { selector: "main p", exact: "selected", prefix: "", suffix: "" } })
    expect(error).toBeUndefined()
    expect((await store.list())[0]).toMatchObject({ data: { message: "Hello", seats: 3 }, page: "/docs", anchor: { selector: "main p", exact: "selected" } })
  })

  it("returns a network failure as status 0", async () => {
    const [error] = await submitForm("feedback", {}, { fetch: async () => { throw new TypeError("offline") } })
    expect(error).toMatchObject({ status: 0, message: "offline" })
  })

  it("sends the same Idempotency-Key when a retry has the same values, so a lost answer stores one message", async () => {
    const store = createMemoryFormsStore()
    const keys: (string | null)[] = []
    let lose = true
    const lossy: typeof fetch = async (input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"))
      const response = await server(store)(input, init)
      // The server stored the message, but the answer did not arrive.
      if (lose) throw new TypeError("network error")
      return response
    }
    const [lost] = await submitForm("feedback", { message: "Retry me" }, { fetch: lossy, page: "/docs" })
    expect(lost?.status).toBe(0)
    lose = false
    const [error, data] = await submitForm("feedback", { message: "Retry me" }, { fetch: lossy, page: "/docs" })
    expect(error).toBeUndefined()
    expect(keys[1]).toBe(keys[0])
    expect(data?.id).toBe(keys[0])
    expect(await store.list()).toHaveLength(1)
    // After the success, the same values are a new message with a new key.
    await submitForm("feedback", { message: "Retry me" }, { fetch: lossy, page: "/docs" })
    expect(keys[2]).not.toBe(keys[0])
    expect(await store.list()).toHaveLength(2)
  })

  it("sends a new key for other values, and the key of idempotencyKey", async () => {
    const keys: (string | null)[] = []
    const failing: typeof fetch = async (_input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"))
      throw new TypeError("offline")
    }
    await submitForm("feedback", { message: "First" }, { fetch: failing, page: "/docs" })
    await submitForm("feedback", { message: "Edited" }, { fetch: failing, page: "/docs" })
    expect(keys[1]).not.toBe(keys[0])
    await submitForm("feedback", { message: "First" }, { fetch: failing, page: "/docs", idempotencyKey: "0b5c2a8e-1d4f-4e7a-9c3b-2f6d8e1a7b90" })
    expect(keys[2]).toBe("0b5c2a8e-1d4f-4e7a-9c3b-2f6d8e1a7b90")
  })

  it("forgets the key of a failed message when another message is sent", async () => {
    const store = createMemoryFormsStore()
    const keys: (string | null)[] = []
    let lose = true
    const lossy: typeof fetch = async (input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"))
      const response = await server(store)(input, init)
      if (lose) throw new TypeError("network error")
      return response
    }
    await submitForm("feedback", { message: "First note" }, { fetch: lossy, page: "/docs" })
    lose = false
    await submitForm("feedback", { message: "Second note" }, { fetch: lossy, page: "/docs" })
    // The person writes the first note again later: a new message, not a retry.
    await submitForm("feedback", { message: "First note" }, { fetch: lossy, page: "/docs" })
    expect(new Set(keys).size).toBe(3)
    expect(await store.list()).toHaveLength(3)
  })

  it.each([true, false])("keeps the latest retry state when the older send finishes last (older response lost: %s)", async (olderLost) => {
    const store = createMemoryFormsStore()
    const keys: (string | null)[] = []
    let signalStored!: () => void
    const olderStored = new Promise<void>(resolve => { signalStored = resolve })
    let releaseOlder!: () => void
    const finishOlder = new Promise<void>(resolve => { releaseOlder = resolve })
    const fetchForm: typeof fetch = async (input, init) => {
      const index = keys.push(new Headers(init?.headers).get("idempotency-key"))
      const response = await server(store)(input, init)
      if (index === 1) {
        signalStored()
        await finishOlder
      }
      if ((index === 1 && olderLost) || (index === 2 && !olderLost)) throw new TypeError("network error")
      return response
    }
    const options = { fetch: fetchForm, page: "/docs", url: formRoute("overlapping") }
    const first = { message: "First note" }
    const second = { message: "Second note" }
    const older = submitForm("feedback", first, options)
    await olderStored
    await submitForm("feedback", second, options)
    releaseOlder()
    await older
    const [error, result] = await submitForm("feedback", olderLost ? first : second, options)
    expect(error).toBeUndefined()
    if (olderLost) {
      expect(new Set(keys).size).toBe(3)
      expect(await store.list()).toHaveLength(3)
    }
    else {
      expect(keys[2]).toBe(keys[1])
      expect(result?.id).toBe(keys[1])
      expect(await store.list()).toHaveLength(2)
    }
  })

  it("builds the route below the app base", () => {
    expect(formRoute("contact")).toBe("/_vitehub/forms/contact")
    expect(formRoute("bug report", "/docs")).toBe("/docs/_vitehub/forms/bug%20report")
  })
})

describe("fieldErrors", () => {
  it("keeps the first message of each field by name, and leaves out issues of the whole form", () => {
    expect(fieldErrors({ issues: [
      { message: "Enter a valid email.", path: ["email"] },
      { message: "Second problem.", path: ["email"] },
      { message: "Pick a city.", path: ["address", "city"] },
      { message: "Too many requests.", path: [] },
    ] })).toEqual({ email: "Enter a valid email.", "address.city": "Pick a city." })
    expect(fieldErrors(undefined)).toEqual({})
  })
})
