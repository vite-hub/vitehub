import { join } from "node:path"

import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "..")

describe("Agent Invocation journal Drizzle", () => {
  it("keeps the published Agent runtime independent of the optional Database package", async () => {
    const { metafile } = await build({
      bundle: true,
      entryPoints: [join(packageRoot, "dist/agent.js")],
      format: "esm",
      metafile: true,
      packages: "external",
      platform: "node",
      write: false,
    })
    const imports = Object.values(metafile.outputs).flatMap(output => output.imports.map(item => item.path))
    expect(imports.filter(path => /^@vite-hub\/database(?:\/|$)/.test(path))).toEqual([])
  })

  // `getAgentInvocationsDatabase()` loads this module in every Agent app, also in a Cloudflare Worker whose journal is D1.
  it("bundles no libSQL client", async () => {
    const { metafile } = await build({
      bundle: true,
      conditions: ["workerd", "worker", "browser"],
      entryPoints: [join(packageRoot, "../agent/src/invocations/journal-database.ts")],
      external: ["cloudflare:workers", "node:*"],
      format: "esm",
      metafile: true,
      platform: "neutral",
      write: false,
    })
    const inputs = Object.keys(metafile.inputs)
    expect(inputs.some(input => input.includes("drizzle-orm/libsql/driver-core"))).toBe(true)
    expect(inputs.filter(input => /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@libsql\//.test(input))).toEqual([])
  }, 30_000)
})
