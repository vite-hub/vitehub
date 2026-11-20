import { execFile as execFileCallback } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFile = promisify(execFileCallback)

const schedule = `
import { defineSchedule } from "vite-hub/schedule"

export default defineSchedule({
  cron: "*/5 * * * *",
  handler: () => {
    Reflect.set(globalThis, "heartbeatRuns", (Reflect.get(globalThis, "heartbeatRuns") ?? 0) + 1)
  },
})
`

// Registers each Deno.cron call and stubs the server, then runs the registered callback once.
const probe = `
const crons = []
Object.defineProperty(Deno, "cron", { configurable: true, value: (name, schedule, handler) => { crons.push({ handler, name, schedule }) } })
Object.defineProperty(Deno, "serve", {
  configurable: true,
  value: () => ({ addr: { hostname: "127.0.0.1", port: 0, transport: "tcp" }, finished: Promise.resolve(), ref() {}, shutdown: async () => {}, unref() {} }),
})
await import("./main.ts")
for (const cron of crons) await cron.handler()
console.log(JSON.stringify({ crons: crons.map(({ name, schedule }) => ({ name, schedule })), runs: globalThis.heartbeatRuns ?? 0 }))
Deno.exit(0)
`

// Nuxt runs its Nitro build apart from Vite. The Deno output must still register the Schedules with Deno.cron.
it("registers Nuxt Schedules with Deno.cron in the Deno host output", async () => {
  const cache = resolve(import.meta.dirname, "../../../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "nuxt-deno-schedule-"))
  try {
    const packageRoot = resolve(import.meta.dirname, "..")
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    // vite-hub is linked like a workspace package, with its tests and the temporary folders that other tests create.
    for (const name of ["@vite-hub/schedule", "nuxt", "vite-hub", "vue"]) {
      const target = name === "vite-hub" ? packageRoot : await realpath(join(packageRoot, "node_modules", name))
      await symlink(target, join(root, "node_modules", name), "dir")
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@vite-hub/schedule": "*", nuxt: "*", "vite-hub": "*", vue: "*" } }))
    await writeFile(join(root, "nuxt.config.ts"), `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], vitehub: { host: "deno", console: false, schedule: true } })\n`)
    await writeFile(join(root, "app.vue"), "<template><div /></template>\n")
    await writeFile(join(root, "server/schedules/heartbeat.ts"), schedule)

    const { build, loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, logLevel: "silent" } })
    try {
      await build(nuxt)
    }
    finally {
      await nuxt.close()
    }

    const output = join(root, ".output")
    await expect(readFile(join(output, "deno.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      deploy: { runtime: { entrypoint: "./main.ts" } },
      tasks: { start: "deno run --unstable-cron -A ./main.ts" },
    })
    await expect(readFile(join(output, "schedule/deno-cron.mjs"), "utf8")).resolves.toContain("Deno.cron(")
    // The retained Schedule sources hold vite-hub's published files, not its tests.
    const retainedPackage = join(root, ".vitehub/schedule/sources/0/packages/vite-hub")
    expect(existsSync(join(retainedPackage, "dist"))).toBe(true)
    expect(existsSync(join(retainedPackage, "test"))).toBe(false)
    const { stdout } = await execFile("deno", ["eval", probe], { cwd: output, timeout: 60_000 })
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      crons: [{ name: "vitehub-0-heartbeat", schedule: "*/5 * * * *" }],
      runs: 1,
    })
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
