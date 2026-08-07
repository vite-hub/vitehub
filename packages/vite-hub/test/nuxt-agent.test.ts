import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import viteHubNuxtModule from "../src/nuxt.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it("registers generated Agent handlers from the Nuxt build directory", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-nuxt-agent-root-"))
  roots.push(rootDir)
  const srcDir = join(rootDir, "app")
  const serverDir = join(rootDir, "server")
  const buildDir = join(rootDir, ".nuxt")
  await mkdir(join(serverDir, "agents"), { recursive: true })
  await writeFile(join(serverDir, "agents", "support.ts"), "export default {}\n", "utf8")
  await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "vitehub-nuxt-agent-root" }), "utf8")

  let nitroConfigHook: ((config: Record<string, unknown>) => Promise<void>) | undefined
  const nuxt = {
    hook(name: "nitro:config", callback: (config: Record<string, unknown>) => Promise<void>) {
      if (name === "nitro:config") nitroConfigHook = callback
    },
    options: {
      buildDir,
      dev: false,
      rootDir,
      serverDir,
      srcDir,
      vite: {},
    },
  }

  viteHubNuxtModule({ agent: true, preset: "node" }, nuxt)
  if (!nitroConfigHook) throw new TypeError("Expected a Nitro config hook.")
  const nitroConfig: Record<string, unknown> = {}
  await nitroConfigHook(nitroConfig)

  expect(nitroConfig).toMatchObject({
    handlers: [{
      handler: join(buildDir, "vitehub/agent/chat-webhook-route.ts"),
      route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
    }],
  })
})
