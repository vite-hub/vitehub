import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { resolveConfig } from "vite"
import { expect, it } from "vitest"
import { vitehub } from "../src/index.ts"
import viteHubNuxtModule from "../src/nuxt.ts"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)

it.each([
  ["cloudflare", "vite"], ["vercel", "vite"],
  ["cloudflare", "nuxt"], ["vercel", "nuxt"],
] as const)("generates public dispatch types with %s runtime adapters in %s", async (preset, framework) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-public-dispatch-"))
  try {
    await mkdir(join(root, "src"))
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"name":"public-dispatch","type":"module"}')
    await writeFile(join(root, "src/welcome.queue.ts"), [
      'import { defineQueue } from "vite-hub/queue"',
      'export default defineQueue<{ email: string }>(job => job.payload.email)',
    ].join("\n"))
    await writeFile(join(root, "src/report.schedule.ts"), [
      'import { defineSchedule } from "vite-hub/schedule"',
      'export default defineSchedule({ cron: "0 9 * * *", handler: context => context.scheduledAt.toISOString() })',
    ].join("\n"))
    const options = {
      agent: false, auth: false, blob: false, database: false,
      env: false, kv: false, preset, queue: true, rateLimit: false,
      realtime: false, sandbox: false, schedule: true, workflow: false, workspace: false,
    } as const
    if (framework === "nuxt") {
      const hooks: Array<(config: Record<string, unknown>) => Promise<void>> = []
      await viteHubNuxtModule(options, {
        hook(name, callback) {
          if (name === "nitro:config") hooks.push(callback)
        },
        options: { buildDir: join(root, ".nuxt"), rootDir: root, serverDir: join(root, "src") },
      })
      expect(hooks).not.toHaveLength(0)
      const nitroConfig = {}
      for (const hook of hooks) await hook(nitroConfig)
    }
    else {
      await resolveConfig({ configFile: false, root, plugins: vitehub(options) }, "build")
    }
    const contents = await readFile(join(root, ".vitehub/queue.d.ts"), "utf8")
    expect(contents).toContain(`declare module "vite-hub/queue"`)
    expect(contents).not.toContain("_internal")
    // Static Schedules need no generated type map.
    await expect(readFile(join(root, ".vitehub/schedule.d.ts"), "utf8")).rejects.toThrow()
    await writeFile(join(root, "consumer.mts"), [
      'import { runQueue, getQueue } from "vite-hub/queue"',
      'await runQueue("welcome", { email: "ada@example.test" })',
      'await (await getQueue("welcome")).send({ email: "ada@example.test" })',
      '// @ts-expect-error Queue payload comes from the generated public map.',
      'await runQueue("welcome", { count: 1 })',
    ].join("\n"))
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true, module: "NodeNext", moduleResolution: "NodeNext",
        noEmit: true, skipLibCheck: true, strict: true, target: "ESNext", types: ["node"],
      },
      include: ["consumer.mts", "src/**/*.ts", ".vitehub/*.d.ts"],
    }))
    const result = await exec(process.execPath, [require.resolve("typescript/lib/tsc.js"), "-p", join(root, "tsconfig.json")])
    expect(result.stdout).toBe("")
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 30_000)
