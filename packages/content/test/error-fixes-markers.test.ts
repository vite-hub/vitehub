import { expect, it } from "vitest"

import { contentClientDiagnostics } from "../src/client-diagnostics.ts"
import { contentErrorDiagnostics } from "../src/error-diagnostics.ts"
import { formatContentField } from "../src/client.ts"

it.each([
  contentErrorDiagnostics.CONTENT_EDITOR_FAILED({ command: "vi", code: 1 }),
  contentErrorDiagnostics.CONTENT_LIVE_DOCUMENT_HELD({ holder: "Cleo" }),
  contentErrorDiagnostics.CONTENT_LIVE_ROOM_UNKNOWN({ documentId: "posts/missing" }),
  contentClientDiagnostics.CONTENT_FIELD_ADDRESS_INVALID({ part: "field path", value: "hero title" }),
])("gives $code a fix and its own docs page", (error) => {
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/content/diagnostics/${error.code.toLowerCase()}`)
})

it("reports a field address that the format cannot hold with its code and fix", () => {
  expect(() => formatContentField({ collection: "about", field: "hero title" })).toThrow(expect.objectContaining({
    code: "CONTENT_FIELD_ADDRESS_INVALID",
    fix: expect.stringContaining("`hero.title`"),
    message: "[vitehub] \"hero title\" is not a Content field path.",
  }))
  expect(() => formatContentField({ collection: "posts", id: "a#b", field: "title" })).toThrow(expect.objectContaining({
    code: "CONTENT_FIELD_ADDRESS_INVALID",
    message: "[vitehub] \"a#b\" is not a Content document id.",
  }))
})
