import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import scheduleNitroModule from "../src/nitro.ts"

describe("Nitro schedule integration", () => {
  it("writes and aliases the stable schedule registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-"))
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {} as Record<string, string>,
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        rootDir: root,
        scanDirs: [],
      },
    }

    await scheduleNitroModule.setup(nitro as never)

    const registryFile = join(root, ".nitro", "vitehub", "schedule", "nitro-registry.mjs")
    expect(nitro.options.alias["#vitehub/schedule/registry"]).toBe(registryFile)
    expect(await readFile(registryFile, "utf8")).toBe([
      "",
      "const registry = {",
      "}",
      "",
      "export default registry",
      "",
    ].join("\n"))
  })

  it("auto-imports only the schedule definition boundary helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-imports-"))
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {} as Record<string, string>,
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        rootDir: root,
        scanDirs: [],
      },
    }

    await scheduleNitroModule.setup(nitro as never)

    expect(nitro.options.imports).toMatchObject({
      presets: [
        {
          from: "@vitehub/schedule",
          imports: ["defineSchedule"],
        },
      ],
    })
  })
})
