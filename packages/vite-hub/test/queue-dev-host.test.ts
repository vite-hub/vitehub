import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { afterEach, expect, it } from "vitest"
import { vitehub } from "../src/index.ts"
import viteHubNuxtModule from "../src/nuxt.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

// `vite dev` and `nuxt dev` have no Nitro preset, so Queue must read the host from `vitehub({ host })`.
it.each(["vite", "nuxt"] as const)("runs the Queue of a Node app with the local driver in %s dev", async (framework) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-queue-dev-host-"))
  roots.push(root)
  await mkdir(join(root, "server/queues"), { recursive: true })
  await writeFile(join(root, "package.json"), '{"name":"queue-dev-host","type":"module"}')
  await writeFile(join(root, "server/queues/narrate.ts"), "export default { handler: async () => undefined }\n")
  const options = {
    agent: false, auth: false, blob: false, database: false,
    env: false, host: "node", kv: false, queue: true, rateLimit: false,
    realtime: false, sandboxTask: false, schedule: false, workflow: false, workspace: false,
  } as const
  if (framework === "nuxt") {
    const hooks: Array<(config: Record<string, unknown>) => Promise<void>> = []
    await viteHubNuxtModule(options, {
      hook(name: string, callback: (config: Record<string, unknown>) => Promise<void>) {
        if (name === "nitro:config") hooks.push(callback)
      },
      options: { buildDir: join(root, ".nuxt"), dev: true, rootDir: root, serverDir: join(root, "server") },
    })
    for (const hook of hooks) await hook({})
  }
  else {
    await resolveConfig({ configFile: false, root, plugins: vitehub(options) }, "serve")
  }
  const nitroPlugin = await readFile(join(root, ".vitehub/nitro/queue/plugin.ts"), "utf8")
  expect(nitroPlugin).toContain('"driver": "local"')
  expect(nitroPlugin).not.toContain('"rules"')
})
