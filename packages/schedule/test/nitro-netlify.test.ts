import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build, createNitro, prepare } from "nitro/builder"
import { afterEach, describe, expect, it } from "vitest"

import type { NitroConfig } from "nitro/types"

import { createScheduleNitroConfig } from "../src/vite.ts"

const roots: string[] = []
const scheduleGlobal = globalThis as typeof globalThis & {
  vitehubNetlifyScheduleRun?: { cron: string, nitroPlugin: unknown, scheduledAt: unknown }
  vitehubNetlifyNitroPlugin?: string
}

afterEach(async () => {
  delete scheduleGlobal.vitehubNetlifyScheduleRun
  delete scheduleGlobal.vitehubNetlifyNitroPlugin
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Netlify scheduled functions in a Nitro build", () => {
  it("runs each Schedule in Nitro's server bundle, after Nitro's plugins", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-netlify-"))
    roots.push(root)
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
    // Nitro's plugins configure the app's primitives, such as the Database, before any handler runs.
    await writeFile(join(root, "configure.mjs"), "export default () => { globalThis.vitehubNetlifyNitroPlugin = 'configured' }\n")
    await writeFile(join(root, "server", "schedules", "cleanup.ts"), [
      `import { defineSchedule } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@vite-hub/schedule")))}`,
      "export default defineSchedule({",
      "  cron: '0 * * * *',",
      "  handler({ cron, scheduledAt }) {",
      "    globalThis.vitehubNetlifyScheduleRun = { cron, nitroPlugin: globalThis.vitehubNetlifyNitroPlugin, scheduledAt }",
      "  },",
      "})",
      "",
    ].join("\n"))

    const config = await createScheduleNitroConfig({
      command: "build",
      cron: { cleanup: "0 0 * * *" },
      nitro: { preset: "netlify" },
      nitroOwnsPaths: true,
      projectRoot: root,
      root,
      runtimeImport: fileURLToPath(import.meta.resolve("@vite-hub/schedule/runtime/static")),
    } as Parameters<typeof createScheduleNitroConfig>[0])
    expect(config).not.toBeNull()
    const nitro = await createNitro({
      compatibilityDate: "2026-10-01",
      dev: false,
      logLevel: 0,
      // SAFETY: createScheduleNitroConfig() returns Nitro module paths and plugin paths.
      modules: config!.modules as NitroConfig["modules"],
      plugins: [...config!.plugins as string[], join(root, "configure.mjs")],
      preset: "netlify",
      rootDir: root,
    })
    try {
      await prepare(nitro)
      await build(nitro)
    }
    finally {
      await nitro.close()
    }

    const functionName = "vitehub-schedule-cleanup"
    const functionDir = join(nitro.options.output.dir, functionName)
    expect(await readdir(nitro.options.output.dir)).toContain(functionName)
    // Netlify deploys each function directory alone, so load it without the app sources or the server function.
    const deployed = join(root, "deployed")
    await cp(functionDir, deployed, { recursive: true })
    await rm(nitro.options.output.dir, { force: true, recursive: true })
    const scheduled = await import(pathToFileURL(join(deployed, `${functionName}.mjs`)).href) as {
      config: Record<string, unknown>
      default: (request: Request) => Promise<Response>
    }

    // The server function's entry keeps Nitro's request handler.
    expect(typeof (await import(pathToFileURL(join(deployed, "main.mjs")).href) as { default: unknown }).default).toBe("function")
    expect(scheduled.config).toEqual({ includedFiles: ["**"], nodeBundler: "none", schedule: "0 0 * * *" })
    expect((await scheduled.default(new Request("https://app.netlify.app/", { body: "{\"next_run\":\"\"}", method: "POST" }))).status).toBe(204)
    expect(scheduleGlobal.vitehubNetlifyScheduleRun).toMatchObject({ cron: "0 0 * * *", nitroPlugin: "configured" })
    expect(scheduleGlobal.vitehubNetlifyScheduleRun?.scheduledAt).toBeInstanceOf(Date)
  })
})
