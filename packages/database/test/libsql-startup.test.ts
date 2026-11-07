import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { build } from "esbuild"
import { describe, expect, it, vi } from "vitest"

import { localLibsql } from "../src/runtime/local-client.ts"

const packageRoot = resolve(import.meta.dirname, "..")

vi.mock("@libsql/client", { spy: true })

/** The inputs that `entry` reaches through static imports only, as at Worker startup. */
async function staticInputs(entry: string) {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-libsql-startup-"))
  try {
    const stub = join(dir, "stub.mjs")
    await writeFile(stub, "export default {}\n", "utf8")
    const { metafile } = await build({
      alias: {
        "#vitehub/database/databases": stub,
        "#vitehub/database/definition-defaults": stub,
      },
      bundle: true,
      conditions: ["workerd", "worker", "browser"],
      entryPoints: [join(packageRoot, entry)],
      external: ["cloudflare:workers", "node:*"],
      format: "esm",
      metafile: true,
      outdir: join(dir, "out"),
      platform: "neutral",
      splitting: true,
      write: false,
    })
    const root = Object.keys(metafile.inputs).find(input => input.endsWith(entry))!
    const reached = new Set([root])
    for (const input of reached) {
      for (const edge of metafile.inputs[input]!.imports) {
        if (edge.kind === "import-statement" && !edge.external) reached.add(edge.path)
      }
    }
    return [...reached]
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("libSQL at startup", () => {
  it.each([
    "src/runtime/drizzle-runtime.ts",
    "src/runtime/definition-local.ts",
    "src/runtime/definition-hosted.ts",
    "src/runtime/hosted.ts",
  ])("%s imports no libSQL client statically", async (entry) => {
    const inputs = await staticInputs(entry)
    expect(inputs.some(input => input.includes("drizzle-orm/libsql/driver-core"))).toBe(true)
    expect(inputs.filter(input => /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@libsql\//.test(input))).toEqual([])
  })

  it("loads @libsql/client on the first query of a local database", async () => {
    const { createClient } = await import("@libsql/client")
    const client = localLibsql.createClient({ url: ":memory:" })
    expect(client.protocol).toBe("file")
    expect(createClient).not.toHaveBeenCalled()

    const result = await client.execute("select 1 as one")
    expect(result.rows[0]?.one).toBe(1)
    expect(createClient).toHaveBeenCalledOnce()
    expect(client.protocol).toBe("file")

    client.close()
    expect(client.closed).toBe(true)
    await expect(client.execute("select 1")).rejects.toThrow()
  })
})
