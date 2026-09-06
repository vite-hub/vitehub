import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

const packageJson: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)
if (!isRecord(packageJson) || !isRecord(packageJson.exports)) {
  throw new TypeError("Expected @vite-hub/email package.json to define an exports object")
}
const packageExports = packageJson.exports

describe("@vite-hub/email package contract", () => {
  it("exposes only the documented public entrypoints", () => {
    expect(Object.keys(packageExports).sort()).toEqual([
      ".",
      "./drivers/cloudflare-email",
      "./drivers/resend",
      "./markdown",
      "./package.json",
      "./server",
      "./test",
      "./vite",
    ])
  })
})
