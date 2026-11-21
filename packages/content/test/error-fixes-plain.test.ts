import { expect, it } from "vitest"

import { contentErrorDiagnostics } from "../src/error-diagnostics.ts"
import { defineContent } from "../src/index.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"

/** The codes that replaced plain errors in `defineContent()`, `content.from()`, `content.cache`, and the Console actions. */
const codes = [
  "CONTENT_CACHE_KEY_UNKNOWN",
  "CONTENT_RUNTIME_EXPORT_INVALID",
  "CONTENT_SOURCE_CONFLICT",
  "CONTENT_SOURCE_MISSING",
  "CONTENT_SOURCE_UNKNOWN",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  // Each code takes its own params. One object that has all of them fits every code.
  const create = contentErrorDiagnostics[code] as (params: { key: string, name: string }) => Error & { docs?: string, fix?: string }
  const error = create({ key: "docs:index.md", name: "docs" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/content/diagnostics/${code.toLowerCase()}`)
})

it("reports defineContent() with both source and sources with its code and fix", () => {
  // SAFETY: defineContent() rejects the pair before it reads either value.
  expect(() => defineContent({ source: {} as never, sources: {} as never })).toThrow(expect.objectContaining({
    code: "CONTENT_SOURCE_CONFLICT",
    fix: expect.stringContaining("`sources`"),
    message: "Define either source or sources, not both.",
  }))
})

it("reports a Console runtime that is not defineContent() with its code and fix", () => {
  expect(() => createContentConsoleActions({})).toThrow(expect.objectContaining({
    code: "CONTENT_RUNTIME_EXPORT_INVALID",
    fix: expect.stringContaining("server/content.ts"),
  }))
})
