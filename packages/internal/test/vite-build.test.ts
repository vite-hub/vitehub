import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { resolveNitroVercelFunctionName } from "../src/build/vite.ts"

describe("Vite provider builds", () => {
  it("isolates provider functions when Nitro owns the Vercel output", async () => {
    const plugins = [{ name: "vitehub" }, { name: "nitro:main" }]
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-nitro-vercel-output-"))
    await mkdir(join(rootDir, ".vercel", "output"), { recursive: true })
    await writeFile(join(rootDir, ".vercel", "output", "config.json"), "{}\n", "utf8")

    try {
      expect(resolveNitroVercelFunctionName(plugins, "blob", rootDir)).toBe("__blob.func")
      expect(resolveNitroVercelFunctionName(plugins, "database", rootDir)).toBe("__database.func")
      expect(resolveNitroVercelFunctionName(plugins, "queue", rootDir)).toBe("__queue.func")
      expect(resolveNitroVercelFunctionName(plugins, "workflow", rootDir)).toBe("__workflow.func")
      expect(resolveNitroVercelFunctionName([{ name: "vitehub" }], "blob", rootDir)).toBeUndefined()
      expect(resolveNitroVercelFunctionName(undefined, "blob", rootDir)).toBeUndefined()
      expect(resolveNitroVercelFunctionName(plugins, "blob", join(rootDir, "missing"))).toBeUndefined()
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
