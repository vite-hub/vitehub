import { expect, it } from "vitest"

import { internalErrorDiagnostics } from "../src/error-diagnostics.ts"
import { normalizeHttpRequest, parseStandardSchema } from "../src/http-request.ts"
import { resolveAppFetch } from "../src/runtime/app.ts"

const fixedCodes = [
  "INTERNAL_B0001",
  "INTERNAL_B0016",
  "INTERNAL_B0017",
  "INTERNAL_B0018",
  "INTERNAL_B0019",
  "INTERNAL_B0020",
  "INTERNAL_B0021",
  "INTERNAL_B0022",
  "INTERNAL_B0028",
  "INTERNAL_B0029",
  "INTERNAL_B0031",
  "INTERNAL_B0032",
  "INTERNAL_B0033",
  "INTERNAL_B0035",
  "INTERNAL_B0039",
  "INTERNAL_B0046",
  "INTERNAL_B0047",
  "INTERNAL_R0004",
  "INTERNAL_R0005",
  "INTERNAL_R0006",
  "INTERNAL_R0007",
  "INTERNAL_R0008",
  "INTERNAL_R0009",
  "INTERNAL_R0010",
  "INTERNAL_R0011",
  "INTERNAL_R0012",
  "INTERNAL_R0013",
] as const

it("gives each Internal build and runtime code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = internalErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer which HTTP methods a request can use", () => {
  expect(() => normalizeHttpRequest({ method: "PUT", url: "https://example.com" })).toThrow(expect.objectContaining({
    code: "INTERNAL_R0005",
    fix: expect.stringContaining("`method`"),
  }))
})

it("tells the developer which timeout a request can use", () => {
  expect(() => normalizeHttpRequest({ timeout: -1, url: "https://example.com" })).toThrow(expect.objectContaining({
    code: "INTERNAL_R0006",
    fix: expect.stringContaining("`timeout`"),
  }))
})

it("tells the developer to send a value that matches the schema", async () => {
  const schema = {
    "~standard": {
      validate: () => ({ issues: [{ message: "Expected a string" }] }),
      vendor: "test",
      version: 1 as const,
    },
  }
  await expect(parseStandardSchema(schema, 1, "HTTP request body")).rejects.toMatchObject({
    code: "INTERNAL_R0008",
    fix: expect.stringContaining("schema"),
  })
})

it("tells the developer which kinds of app a hosted runtime accepts", () => {
  expect(() => resolveAppFetch("Workflow", {})).toThrow(expect.objectContaining({
    code: "INTERNAL_R0011",
    fix: expect.stringContaining("`app`"),
  }))
})
