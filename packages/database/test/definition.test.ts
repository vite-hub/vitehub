import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { defineDatabase } from "../src/definition.ts"
import { inspectDatabaseDefinitions } from "../src/inspect.ts"

describe("defineDatabase name validation", () => {
  it.each([42, null])("rejects a non-string name: %s", (name) => {
    expect(() => defineDatabase({ name: name as never, schema: {} })).toThrow(expect.objectContaining({
      code: "DATABASE_INVALID_NAME",
      message: "`defineDatabase().name` must be a normalized path of letters, numbers, dots, underscores, or dashes.",
    }))
  })
})

describe("defineDatabase remote", () => {
  it("keeps the remote switch on a D1 Definition", () => {
    const definition = defineDatabase({ cloudflare: { databaseId: "database-id" }, remote: true, schema: {} })
    expect(definition.remote).toBe(true)
  })

  it("rejects a remote value that is not a boolean", () => {
    expect(() => defineDatabase({ remote: "true" as never, schema: {} })).toThrow(expect.objectContaining({ code: "DATABASE_INVALID_REMOTE" }))
  })

  it("rejects remote: false with cloudflare.http, because D1 over HTTP is remote in development", () => {
    expect(() => defineDatabase({ cloudflare: { databaseId: "database-id", http: true }, name: "analytics", remote: false, schema: {} }))
      .toThrow(expect.objectContaining({ code: "DATABASE_REMOTE_CONFLICT", why: expect.stringContaining("\"analytics\"") }))
  })

  it("rejects remote on a Postgres Definition", () => {
    expect(() => defineDatabase({ dialect: "postgresql", remote: true as never, schema: {} }))
      .toThrow(expect.objectContaining({ code: "DATABASE_UNKNOWN_OPTION", why: expect.stringContaining("`remote`") }))
  })
})

describe("remote inspection", () => {
  it.each([
    ["remote: true", "remote: true, cloudflare: { databaseId: 'id' }", true],
    ["cloudflare.http", "cloudflare: { databaseId: 'id', http: true }", true],
    ["no switch", "cloudflare: { databaseId: 'id' }", false],
  ])("shows whether vite dev is remote with %s", async (_label, options, remote) => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-remote-"))
    try {
      await mkdir(join(rootDir, "server", "databases"), { recursive: true })
      await writeFile(join(rootDir, "server", "databases", "config.ts"), `import { defineDatabase } from '@vite-hub/database'\nexport default defineDatabase({ ${options}, schema: {} })\n`)
      const [definition] = await inspectDatabaseDefinitions({ projectRoot: rootDir, rootDir })
      const field = definition?.fields.find(item => item.label === "Development")
      expect(field?.value.startsWith("Remote.") ?? false).toBe(remote)
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
