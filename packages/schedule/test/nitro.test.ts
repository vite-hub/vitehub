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
        plugins: [] as string[],
        rootDir: root,
        scanDirs: [],
      },
    }

    await scheduleNitroModule.setup(nitro as never)

    const registryFile = join(root, ".nitro", "vitehub", "schedule", "nitro-registry.mjs")
    const pluginFile = join(root, ".nitro", "vitehub", "schedule", "nitro-plugin.ts")
    expect(nitro.options.alias["@vitehub/schedule/runtime/state"]).toBeTypeOf("string")
    expect(nitro.options.alias["#vitehub/schedule/registry"]).toBe(registryFile)
    expect(nitro.options.alias["#vitehub/schedule/targets"]).toBe(join(root, ".nitro", "vitehub", "schedule", "targets.mjs"))
    expect(nitro.options.plugins).toEqual([pluginFile])
    expect(await readFile(registryFile, "utf8")).toBe([
      "",
      "const registry = {",
      "}",
      "",
      "export default registry",
      "",
    ].join("\n"))
    await expect(readFile(pluginFile, "utf8")).resolves.toContain("setScheduleRuntimeRegistry(scheduleRegistry)")
    await expect(readFile(pluginFile, "utf8")).resolves.toContain("@vitehub/schedule/runtime/state")
  })

  it("auto-imports only the schedule definition boundary helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-imports-"))
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {} as Record<string, string>,
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        plugins: [] as string[],
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
