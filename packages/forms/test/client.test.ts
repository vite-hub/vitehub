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
    expect(error).toMatchObject({ name: "FormSubmitError", status: 400, issues: [{ message: "Too short.", path: ["message"] }] })
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

  it("builds the route below the app base", () => {
    expect(formRoute("contact")).toBe("/api/_vitehub/forms/contact")
    expect(formRoute("bug report", "/docs")).toBe("/docs/api/_vitehub/forms/bug%20report")
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
