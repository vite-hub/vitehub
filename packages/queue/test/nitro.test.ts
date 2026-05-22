import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import queueNitroModule from "../src/nitro.ts"

describe("Nitro module", () => {
  it("auto-imports queue definition and read helpers only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {},
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        output: { dir: join(root, ".output") },
        plugins: [],
        rootDir: root,
        scanDirs: [],
      },
    }

    await queueNitroModule.setup(nitro as never)

    expect(nitro.options.imports).toMatchObject({
      presets: [
        {
          from: "@vitehub/queue",
          imports: ["defineQueue", "getQueue"],
        },
      ],
    })
  })
})
