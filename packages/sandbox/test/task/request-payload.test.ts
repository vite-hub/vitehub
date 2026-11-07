import { describe, expect, it } from "vitest"

import { readRequestPayload } from "../../src/task/index.ts"

function standardRequest(body: string) {
  return {
    "~standard": {
      vendor: "test",
      req: new Request("https://example.test/api/release-notes", { body, method: "POST" }),
      res: { headers: new Headers() },
    },
  }
}

describe("readRequestPayload", () => {
  it("reads the JSON body of the Standard Context request", async () => {
    await expect(readRequestPayload(standardRequest('{"notes":"fixed"}'))).resolves.toEqual({ notes: "fixed" })
  })

  it("returns the fallback when the body is not JSON", async () => {
    await expect(readRequestPayload(standardRequest("not json"), { notes: "" })).resolves.toEqual({ notes: "" })
  })

  it("sets Standard Context on an H3 2 event without the Nitro plugin", async () => {
    const event = { req: new Request("https://example.test/", { body: "[1]", method: "POST" }), res: { headers: new Headers() } }
    await expect(readRequestPayload(event as never)).resolves.toEqual([1])
  })
})
