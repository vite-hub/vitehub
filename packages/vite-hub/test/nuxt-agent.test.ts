import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, expect, it } from "vitest"

import viteHubNuxtModule from "../src/nuxt.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it.each([false, true].flatMap(dev => [undefined, false, true].map(noExternals => ({ dev, noExternals }))))("registers Agent handlers and applies Nitro 3 inlining (dev: $dev, noExternals: $noExternals)", async ({ dev, noExternals }) => {
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
  const nitroConfig: Record<string, unknown> = noExternals === undefined ? {} : { noExternals }
  await nitroConfigHook(nitroConfig)

  const expectedNoExternals = noExternals === true ? true : [
    ...(noExternals === false ? [] : ["@t3tools/provider-runtime", "effect", "@effect/platform-node", "@effect/platform-node-shared"]),
    "vite-hub",
    "@vite-hub/",
    join(rootDir, ".vitehub"),
    dirname(fileURLToPath(import.meta.resolve("h3/package.json"))),
  ]
  expect(nitroConfig.noExternals).toEqual(expectedNoExternals)
  expect(nitroConfig).toMatchObject({
    // Other plugins, including the development RPC, can register handlers too.
    handlers: expect.arrayContaining([
      {
        handler: join(buildDir, "vitehub/agent/ready-route.ts"),
        lazy: true,
        route: "/api/_vitehub/ready",
      },
      {
        handler: join(buildDir, "vitehub/agent/chat-webhook-route.ts"),
        lazy: true,
        route: "/api/_vitehub/agents/:agent/chat",
      },
      {
        handler: join(buildDir, "vitehub/agent/chat-webhook-route.ts"),
        lazy: true,
        route: "/api/_vitehub/agents/:agent/webhooks/:webhook",
      },
      {
        handler: join(buildDir, "vitehub/agent/declared-webhook-route.ts"),
        lazy: true,
        middleware: true,
        route: "/**",
      },
      ...(dev ? [
        {
          handler: join(buildDir, "vitehub/agent/invocations-dev-handler.ts"),
          lazy: true,
          route: "/_vitehub/agent/invocations/dev",
        },
      ] : []),
    ].map(handler => expect.objectContaining(handler))),
  })

  // Development hooks reject an already registered invocation route on the same config.
  if (!dev) {
    await nitroConfigHook(nitroConfig)
    expect(nitroConfig.noExternals).toEqual(expectedNoExternals)
  }
  expect(nitroConfig).not.toHaveProperty("externals")
})

it.each([
  [{ invocations: "memory" as const }, `installAgentInvocations({ default: "memory" })`],
  [{}, "installAgentInvocations({ journal: { projectRoot: "],
])("installs the app-wide Agent Invocation journal first in the Nuxt Nitro config: %j", async (agent, installation) => {
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
      // Without `invocations`, ViteHub installs the default journal. The Console is off.
      vitehub: { agent, preset: "node" as const },
    },
  }

  await viteHubNuxtModule(undefined, nuxt)
  if (!nitroConfigHook) throw new TypeError("Expected a Nitro config hook.")
  const nitroConfig: Record<string, unknown> = { plugins: ["/app/existing-plugin.mjs"] }
  await nitroConfigHook(nitroConfig)

  const generated = join(rootDir, ".vitehub/nitro/agent/invocations.mjs")
  const standardContext = join(rootDir, ".vitehub/nitro/standard-context.mjs")
  const workflow = join(rootDir, ".vitehub/nitro/workflow/dev-plugin.mjs")
  expect(nitroConfig.plugins).toEqual([generated, standardContext, workflow, "/app/existing-plugin.mjs", ...(nitroConfig.plugins as string[]).slice(4)])
  expect((nitroConfig.plugins as string[]).filter(plugin => plugin === generated)).toHaveLength(1)
  await expect(readFile(generated, "utf8")).resolves.toContain(installation)
})

it("leaves the serve-only Console out of the workflow registry of a Nuxt build", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-nuxt-agent-workflow-registry-"))
  roots.push(rootDir)
  const serverDir = join(rootDir, "server")
  await mkdir(join(serverDir, "agents"), { recursive: true })
  await writeFile(join(serverDir, "agents", "support.ts"), "export default {}\n", "utf8")
  await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "vitehub-nuxt-agent-workflow-registry" }), "utf8")

  let nitroConfigHook: ((config: Record<string, unknown>) => Promise<void>) | undefined
  const nuxt = {
    hook(name: string, callback: (config: Record<string, unknown>) => Promise<void>) {
      if (name === "nitro:config") nitroConfigHook = callback
    },
    options: { buildDir: join(rootDir, ".nuxt"), dev: false, rootDir, serverDir, srcDir: join(rootDir, "app"), vite: { define: {} } },
  }

  // Without Console options, `vite dev` serves the operation RPC through a Console plugin that applies only to `serve`.
  await viteHubNuxtModule({ agent: true, console: false, preset: "cloudflare" }, nuxt)
  if (!nitroConfigHook) throw new TypeError("Expected a Nitro config hook.")
  await nitroConfigHook({})

  // The Vite build transforms this file again without the Console. Both must agree, or the registry imports twice.
  const registry = await readFile(join(rootDir, ".vitehub/workflow/registry-runtime.mjs"), "utf8")
  expect(registry).toContain("setAgentChannelDeliveryWorkflowStateResolver")
  expect(registry).not.toContain("vite-hub/console/server")
})
