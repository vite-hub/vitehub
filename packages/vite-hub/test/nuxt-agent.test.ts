import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import viteHubNuxtModule from "../src/nuxt.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it.each([false, true].flatMap(dev => [undefined, false, true].map(noExternals => ({ dev, noExternals }))))("registers Agent handlers and preserves Nitro 2 externals (dev: $dev, noExternals: $noExternals)", async ({ dev, noExternals }) => {
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
    hook(
      name: "close" | "nitro:config",
      callback: (() => Promise<void>) | ((config: Record<string, unknown>) => Promise<void>),
    ) {
      if (name === "nitro:config") {
        // SAFETY: Nuxt passes the nitro:config callback for this hook name.
        nitroConfigHook = callback as (config: Record<string, unknown>) => Promise<void>
      }
    },
    options: {
      app: { baseURL: "/portal/" },
      buildDir,
      dev,
      rootDir,
      serverDir,
      srcDir,
      vite: { define: {} },
    },
  }

  await viteHubNuxtModule({ agent: true, preset: "node" }, nuxt)
  expect(nuxt.options.vite.define).toMatchObject({
    __VITEHUB_APP_BASE_URL__: JSON.stringify("/portal/"),
  })
  if (!nitroConfigHook) throw new TypeError("Expected a Nitro config hook.")
  const configuredInline = ["consumer-package", "@vite-hub/agent"]
  const nitroConfig: Record<string, unknown> = {
    externals: { inline: configuredInline, external: ["external-package"], trace: false },
    ...(noExternals === undefined ? {} : { noExternals }),
  }
  await nitroConfigHook(nitroConfig)

  if (noExternals === undefined) expect(nitroConfig).not.toHaveProperty("noExternals")
  else expect(nitroConfig.noExternals).toBe(noExternals)
  expect(nitroConfig.externals).toMatchObject({
    inline: expect.arrayContaining([
      "consumer-package",
      "vite-hub",
      "@vite-hub/agent",
      "@t3tools/provider-runtime",
      ...(noExternals === true ? [] : ["effect", "@effect/platform-node", "@effect/platform-node-shared"]),
    ]),
    external: ["external-package"],
    trace: false,
  })
  expect(nitroConfig).toMatchObject({
    // Other plugins, including the development RPC, can register handlers too.
    handlers: expect.arrayContaining([
      {
        handler: join(buildDir, "vitehub/agent/ready-route.ts"),
        route: "/api/_vitehub/ready",
      },
      {
        handler: join(buildDir, "vitehub/agent/chat-webhook-route.ts"),
        route: "/api/_vitehub/agents/:agent/chat",
      },
      {
        handler: join(buildDir, "vitehub/agent/chat-webhook-route.ts"),
        route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
      },
      {
        handler: join(buildDir, "vitehub/agent/declared-webhook-route.ts"),
        middleware: true,
        route: "/**",
      },
      ...(dev ? [
        {
          handler: join(buildDir, "vitehub/agent/invocations-dev-handler.ts"),
          route: "/_vitehub/agent/invocations/dev",
        },
      ] : []),
    ].map(handler => expect.objectContaining(handler))),
  })

  const expectedExternals = structuredClone(nitroConfig.externals)
  const { inline } = nitroConfig.externals as { inline: string[] }
  expect(inline).toEqual([...new Set(inline)])
  // Development hooks reject an already registered invocation route on the same config.
  if (!dev) {
    await nitroConfigHook(nitroConfig)
    if (noExternals === undefined) expect(nitroConfig).not.toHaveProperty("noExternals")
    else expect(nitroConfig.noExternals).toBe(noExternals)
    expect(nitroConfig.externals).toEqual(expectedExternals)
  }
  expect(configuredInline).toEqual(["consumer-package", "@vite-hub/agent"])
})

it("installs the app-wide Agent Invocation journal first in the Nuxt Nitro config", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-nuxt-agent-invocations-"))
  roots.push(rootDir)
  const serverDir = join(rootDir, "server")
  await mkdir(join(serverDir, "agents"), { recursive: true })
  await writeFile(join(serverDir, "agents", "support.ts"), "export default {}\n", "utf8")
  await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "vitehub-nuxt-agent-invocations" }), "utf8")

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
      vite: { define: {} },
      vitehub: { agent: { invocations: "memory" as const }, preset: "node" as const },
    },
  }

  await viteHubNuxtModule(undefined, nuxt)
  if (!nitroConfigHook) throw new TypeError("Expected a Nitro config hook.")
  const nitroConfig: Record<string, unknown> = { plugins: ["/app/existing-plugin.mjs"] }
  await nitroConfigHook(nitroConfig)

  const generated = join(rootDir, ".vitehub/nitro/agent/invocations.mjs")
  const standardContext = join(rootDir, ".vitehub/nitro/standard-context.mjs")
  expect(nitroConfig.plugins).toEqual([generated, standardContext, "/app/existing-plugin.mjs", ...(nitroConfig.plugins as string[]).slice(3)])
  expect((nitroConfig.plugins as string[]).filter(plugin => plugin === generated)).toHaveLength(1)
  await expect(readFile(generated, "utf8")).resolves.toContain(`installAgentInvocations({ default: "memory" })`)
})
