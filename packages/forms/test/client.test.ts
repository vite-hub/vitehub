import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { formRoute, submitForm } from "../src/client.ts"
import { createMemoryFormsStore, defineForm, handleFormRequest } from "../src/index.ts"

const form = defineForm({ schema: v.object({ message: v.pipe(v.string(), v.minLength(2, "Too short.")) }) })

function server(store = createMemoryFormsStore()): typeof fetch {
  return async (input, init) => {
    const request = new Request(new URL(String(input), "https://site.test"), init)
    return handleFormRequest("feedback", form, request, { store })
  }
}

describe("submitForm", () => {
  it("posts to the form route with the page and anchor", async () => {
    const store = createMemoryFormsStore()
    const [error, data] = await submitForm("feedback", { message: "Hello" }, { fetch: server(store), page: "/docs", anchor: { text: "selected" } })
    expect(error).toBeUndefined()
    expect(data?.id).toEqual(expect.any(String))
    expect((await store.list())[0]).toMatchObject({ data: { message: "Hello" }, page: "/docs", anchor: { text: "selected" } })
  })

  it("returns the field issues of a 400", async () => {
    const [error] = await submitForm("feedback", { message: "x" }, { fetch: server() })
    expect(error).toMatchObject({ name: "FormSubmitError", status: 400, issues: [{ message: "Too short.", path: ["message"] }] })
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
