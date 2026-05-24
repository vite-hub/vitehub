import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
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
    expect(nitro.options.alias["#vitehub/schedule/targets"]).toBe(join(root, ".nitro", "vitehub", "schedule", "targets.mjs"))
    expect(await readFile(registryFile, "utf8")).toBe([
      "",
      "const registry = {",
      "}",
      "",
      "export default registry",
      "",
    ].join("\n"))
  })

  it("adds Cloudflare cron triggers and the schedule provider plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-cloudflare-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "cleanup.ts"), "export default { cron: '0 0 * * *', handler: () => undefined }\n", "utf8")
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {} as Record<string, string>,
        buildDir: join(root, ".nitro"),
        cloudflare: {} as { wrangler?: { triggers?: { crons?: string[] } } },
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        plugins: [] as string[],
        preset: "cloudflare_module",
        rootDir: root,
        scanDirs: [],
      },
    }

    await scheduleNitroModule.setup(nitro as never)

    expect(nitro.options.cloudflare.wrangler?.triggers?.crons).toEqual(["0 0 * * *"])
    expect(nitro.options.plugins[0]).toBe(join(root, ".nitro", "vitehub", "schedule", "nitro-plugin.ts"))
    expect(await readFile(nitro.options.plugins[0]!, "utf8")).toContain("cloudflare:scheduled")
  })

  it("does not require static cron strings outside provider presets", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-non-provider-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "cleanup.ts"), "export default defineSchedule(process.env.CRON!, () => undefined)\n", "utf8")
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {} as Record<string, string>,
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        plugins: [] as string[],
        preset: "node-server",
        rootDir: root,
        scanDirs: [],
      },
    }

    await expect(scheduleNitroModule.setup(nitro as never)).resolves.toBeUndefined()
    expect(nitro.options.plugins[0]).toBe(join(root, ".nitro", "vitehub", "schedule", "nitro-plugin.ts"))
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
