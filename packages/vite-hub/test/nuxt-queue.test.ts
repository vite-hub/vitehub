import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import viteHubNuxtModule from "../src/nuxt.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it.each([
  { queue: true, viteRoot: "app" },
  { queue: { provider: "cloudflare" as const }, viteRoot: "app" },
  { queue: true, viteRoot: "." },
])("adds Cloudflare Queue bindings to the Nuxt Nitro config (queue: $queue, Vite root: $viteRoot)", async ({ queue, viteRoot }) => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-nuxt-queue-"))
  roots.push(rootDir)
  const serverDir = join(rootDir, "server")
  await mkdir(join(serverDir, "queues"), { recursive: true })
  await writeFile(join(serverDir, "queues", "sync.ts"), "export default {}\n", "utf8")
  await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "nuxt-queue-app" }), "utf8")

  let nitroConfigHook: ((config: Record<string, unknown>) => Promise<void>) | undefined
  const nuxt = {
    hook(name: string, callback: (config: Record<string, unknown>) => Promise<void>) {
      if (name === "nitro:config") nitroConfigHook = callback
    },
    options: {
      buildDir: join(rootDir, ".nuxt"),
      dev: false,
      rootDir,
      serverDir,
      srcDir: join(rootDir, "app"),
      // Nuxt sets the Vite root to its srcDir. A Vite root at the project root must give the same result.
      vite: { define: {}, root: join(rootDir, viteRoot) },
      vitehub: { preset: "cloudflare" as const, queue },
    },
  }

  await viteHubNuxtModule(undefined, nuxt)
  if (!nitroConfigHook) throw new TypeError("Expected a Nitro config hook.")
  const nitroConfig: Record<string, unknown> = { cloudflare: { wrangler: { name: "nuxt-queue-app" } } }
  await nitroConfigHook(nitroConfig)

  // The Worker sends to and consumes the same prefixed queue that the generated runtime resolves.
  const name = "nuxt-queue-app-queue--73796e63"
  expect(nitroConfig).toMatchObject({
    cloudflare: {
      wrangler: {
        queues: {
          consumers: [{ queue: name }],
          producers: [{ binding: "QUEUE_73796E63", queue: name }],
        },
      },
    },
  })
  const runtime = await readFile(join(rootDir, ".vitehub/nitro/queue/plugin.ts"), "utf8")
  expect(runtime).toContain(`"namePrefix": "nuxt-queue-app-"`)
  expect(runtime).toContain(`"${name}": "sync"`)
})
