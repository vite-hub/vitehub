import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFile = promisify(execFileCallback)

it("runs a due Static Schedule in a Node Nuxt build without KV", async () => {
  const cache = resolve(import.meta.dirname, "../../../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "nuxt-node-schedule-"))
  try {
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    for (const name of ["@vite-hub/schedule", "nuxt", "vite-hub", "vue"]) {
      const target = name === "vite-hub" ? resolve(import.meta.dirname, "..") : resolve(import.meta.dirname, "../node_modules", name)
      await symlink(target, join(root, "node_modules", name), "dir")
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@vite-hub/schedule": "*", nuxt: "*", "vite-hub": "*", vue: "*" } }))
    await writeFile(join(root, "nuxt.config.ts"), `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], vitehub: { host: "node", console: false, schedule: true } })\n`)
    await writeFile(join(root, "app.vue"), "<template><div /></template>\n")
    await writeFile(join(root, "server/schedules/heartbeat.ts"), `
import { defineSchedule } from "vite-hub/schedule"

export default defineSchedule({
  cron: "* * * * *",
  handler: () => process.stdout.write("heartbeat ran\\n", () => process.exit(0)),
})
`)

    const { build, loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, logLevel: "silent" } })
    try {
      await build(nuxt)
    }
    finally {
      await nuxt.close()
    }

    const { stdout } = await execFile(process.execPath, [".output/server/index.mjs"], {
      cwd: root,
      env: { ...process.env, NITRO_HOST: "127.0.0.1", NITRO_PORT: "0" },
      timeout: 15_000,
    })
    expect(stdout).toContain("heartbeat ran")
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
