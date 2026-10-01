import { expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { testProvider } from "./helpers.ts"

it("preserves the typed provider and explicit actor access definition", () => {
  const definition = { access: { "agent:triage": { read: true, write: ["mail.messages.modify"] as const } }, api: { mail: ["messages.modify"] as const }, provider: testProvider(), scopes: ["mail.modify"] }
  expect(defineConnection(definition)).toBe(definition)
})
