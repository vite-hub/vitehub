import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build, createNitro, prepare } from "nitro/builder"
import { nitro as nitroPlugin } from "nitro/vite"
import { createBuilder } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Nitro, NitroConfig, NitroModule } from "nitro/types"

import { createScheduleNitroConfig, hubSchedule } from "../src/vite.ts"

const roots: string[] = []
const scheduleGlobal = globalThis as typeof globalThis & {
  vitehubNetlifyScheduleRun?: { cron: string, nitroPlugin: unknown, scheduledAt: unknown }
  vitehubNetlifyNitroPlugin?: string
}

afterEach(async () => {
  vi.unstubAllEnvs()
  delete scheduleGlobal.vitehubNetlifyScheduleRun
  delete scheduleGlobal.vitehubNetlifyNitroPlugin
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Netlify scheduled functions in a Nitro build", () => {
  it.each(["nitro", "vite"])("copies the final server bundle and runs after Nitro's plugins through %s", { timeout: 60_000 }, async (integration) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-netlify-"))
    roots.push(root)
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
    await symlink(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
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

    const scheduleOptions = {
      command: "build",
      cron: { cleanup: "0 0 * * *" },
      nitro: { preset: "netlify" },
      nitroOwnsPaths: true,
      projectRoot: root,
      root,
      runtimeImport: fileURLToPath(import.meta.resolve("@vite-hub/schedule/runtime/static")),
    } as Parameters<typeof createScheduleNitroConfig>[0]
    let instance: Nitro | undefined
    // Database registers its migration writer after Schedule's configured Nitro module in direct Vite apps.
    const laterWriter: NitroModule = {
      name: "later-compiled-writer",
      setup(nitro) {
        instance = nitro
        nitro.hooks.hook("compiled", async () => {
          const migrations = join(nitro.options.output.serverDir, "migrations")
          await mkdir(migrations, { recursive: true })
          await writeFile(join(migrations, "0001.sql"), "CREATE TABLE scheduled_job (id integer);\n")
        })
      },
    }
    const nitroOptions: NitroConfig = {
      compatibilityDate: "2026-10-01",
      dev: false,
      logLevel: 0,
      plugins: [join(root, "configure.mjs")],
      preset: "netlify",
      rootDir: root,
    }
    if (integration === "vite") {
      const builder = await createBuilder({
        configFile: false,
        logLevel: "silent",
        plugins: [hubSchedule(scheduleOptions), { name: "later-writer", nitro: laterWriter }, nitroPlugin(nitroOptions)],
        root,
      })
      await builder.buildApp()
    }
    else {
      const config = await createScheduleNitroConfig(scheduleOptions)
      expect(config).not.toBeNull()
      const nitro = await createNitro({
        ...nitroOptions,
        // SAFETY: createScheduleNitroConfig() returns Nitro module paths and plugin paths.
        modules: [...config!.modules as NonNullable<NitroConfig["modules"]>, laterWriter],
        plugins: [...config!.plugins as string[], ...nitroOptions.plugins!],
      })
      try {
        await prepare(nitro)
        await build(nitro)
      }
      finally {
        await nitro.close()
      }
    }
    const nitro = instance!

    const functionName = "vitehub-schedule-cleanup"
    const functionDir = join(nitro.options.output.dir, functionName)
    expect(await readdir(nitro.options.output.dir)).toContain(functionName)
    await expect(readFile(join(nitro.options.output.serverDir, "migrations", "0001.sql"), "utf8")).resolves.toContain("CREATE TABLE")
    await expect(readFile(join(functionDir, "migrations", "0001.sql"), "utf8")).resolves.toContain("CREATE TABLE")
    // Netlify deploys each function directory alone, so load it without the app sources or the server function.
    const deployed = join(root, "deployed")
    await cp(functionDir, deployed, { recursive: true })
    await rm(nitro.options.output.dir, { force: true, recursive: true })
    await rm(join(root, "node_modules"))
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

  it.each([
    { command: "build", preset: "node-server" },
    { command: "build", preset: "cloudflare_module" },
    { command: "build", preset: "netlify" },
    { command: "serve", preset: "netlify" },
  ] as const)("validates colliding names only for a resolved Netlify build ($command, $preset)", async ({ command, preset }) => {
    vi.stubEnv("NITRO_PRESET", undefined)
    vi.stubEnv("SERVER_PRESET", undefined)
    vi.stubEnv("VITEHUB_HOSTING", undefined)
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-nitro-names-"))
    roots.push(root)
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    for (const name of ["foo.bar", "foo_bar"]) {
      await writeFile(join(root, "server", "schedules", `${name}.ts`), "export default defineSchedule({ cron: '0 * * * *', handler() {} })\n")
    }
    // The effective host is supplied by the Nitro integration after Schedule's Vite config has run.
    const config = await createScheduleNitroConfig({ command, nitroOwnsPaths: true, root })
    expect(config).not.toBeNull()
    const create = () => createNitro({
      compatibilityDate: "2026-10-01",
      dev: command === "serve",
      logLevel: 0,
      // SAFETY: createScheduleNitroConfig() returns Nitro module paths.
      modules: config!.modules as NitroConfig["modules"],
      preset,
      rootDir: root,
    })
    if (command === "build" && preset === "netlify") {
      await expect(create()).rejects.toMatchObject({ code: "SCHEDULE_R0006" })
    }
    else {
      const nitro = await create()
      await nitro.close()
    }
  })
})
