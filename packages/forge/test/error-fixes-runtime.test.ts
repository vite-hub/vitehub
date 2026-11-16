import { expect, it } from "vitest"

import { forgeDiagnostics } from "../src/error-diagnostics.ts"
import { forgeArchive, forgeBlob } from "../src/index.ts"

const fixedCodes = [
  "FORGE_R0001",
  "FORGE_R0002",
  "FORGE_R0003",
  "FORGE_R0004",
  "FORGE_R0005",
  "FORGE_R0006",
  "FORGE_R0007",
  "FORGE_R0009",
] as const

const gitlab = { forge: "gitlab" } as never
const repo = { owner: "acme", name: "app" } as never

it("gives each Forge code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = forgeDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/forge/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer to read an archive with a GitHub provider", async () => {
  await expect(forgeArchive(gitlab, repo, {} as never)).rejects.toMatchObject({
    code: "FORGE_R0002",
    fix: expect.stringContaining("GitHub provider"),
  })
})

it("tells the developer to read a blob with a GitHub provider", async () => {
  await expect(forgeBlob(gitlab, repo, "0123456789abcdef0123456789abcdef01234567")).rejects.toMatchObject({
    code: "FORGE_R0004",
    fix: expect.stringContaining("GitHub provider"),
  })
})
