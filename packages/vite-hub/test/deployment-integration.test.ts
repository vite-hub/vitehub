import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createBuilder, createServer, resolveConfig } from "vite"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { getDeploymentHost, VITEHUB_ENV_SERVER, VITEHUB_FEATURES } from "@vite-hub/internal/build/vite"
import { createSetupSession } from "@vite-hub/cli/setup"
import { collectViteHubProviderOutputEntries } from "@vite-hub/internal/inspect"
import { env, hubEnv } from "@vite-hub/env/vite"
import type { EnvRuntimeConfigOptions } from "@vite-hub/env"
import { vitehub } from "../src/index.ts"


describe("built-in host integration", () => {
  // The host checks run before the owners read their options. A host without the service, such as Rate Limit on Vercel
  // or Sandbox on Node, stopped with INTERNAL_R0002 and hid the rename.
  it.each(["cloudflare", "node", "vercel"] as const)("rejects old provider keys before %s driver inference", async (host) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-old-provider-"))
    onTestFinished(() => rm(root, { force: true, maxRetries: 5, recursive: true }))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "old-provider-test", type: "module" }))
    for (const feature of ["queue", "rateLimit", "sandboxTask"] as const) {
      const options = { host, env: false, blob: false, workflow: false, queue: false, rateLimit: false }
      // SAFETY: An app config without types still passes the former key.
      expect(() => vitehub({ ...options, [feature]: { provider: "vercel" } } as never))
        .toThrow(expect.objectContaining({ code: "VITE_HUB_RENAMED_PROVIDER_KEY", fix: expect.stringContaining(`${feature}: { driver: "vercel" }`) }))
      if (host === "node") continue
      for (const command of ["build", "serve"] as const) {
        await expect(resolveConfig({
          configFile: false,
          root,
          // SAFETY: An app config without types still passes the former key next to `driver`.
          plugins: [vitehub({ ...options, [feature]: { provider: "vercel", driver: feature === "rateLimit" && host === "vercel" ? "memory" : host } } as never)],
        }, command)).resolves.toBeTruthy()
      }
    }
  }, 30_000)

  it.each([undefined, "custom-output"])(
    "inspects deployment output from a separate Nitro root with output %s",
    async (outputDir) => {
      const root = await mkdtemp(join(tmpdir(), "vitehub-inspect-nitro-root-"));
      try {
        const nitroRoot = join(root, "nitro");
        await mkdir(nitroRoot);
        const config = await resolveConfig(
          {
            configFile: false,
            root,
            nitro: { rootDir: nitroRoot, ...(outputDir ? { output: { dir: outputDir } } : {}) },
            plugins: [
              vitehub({ host: "node", blob: false, env: false, queue: false, rateLimit: false }),
            ],
          } as Parameters<typeof resolveConfig>[0],
          "build",
        );
        const entries = await collectViteHubProviderOutputEntries(config.plugins);
        expect(entries).toContainEqual(
          expect.objectContaining({
            owner: "vite-hub",
            path: join(nitroRoot, outputDir ?? ".output", "deployment.json"),
          }),
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );


  it.each(["cloudflare", "netlify", "vercel", "deno", "node"] as const)("resolves the minimal %s host with real owner plugins", async (host) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-config-"))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        host,
        blob: false,
        env: false,
        queue: false,
        rateLimit: false,
      })],
    }, "build")
    expect(config.plugins.map(plugin => plugin.name)).not.toContain("@vite-hub/sandbox/task/vite")
    expect((config as typeof config & { nitro?: { preset?: string } }).nitro?.preset).toBeTruthy()
  })

  it.each([undefined, true, false] as const)("turns Agents on from server/agents with agent %s", async (agent) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-option-"))
    onTestFinished(() => rm(root, { force: true, maxRetries: 5, recursive: true }))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "labeller.ts"), "export default {}\n")
    // `vitehub()` looks for Definition files in the project of the working directory.
    vi.spyOn(process, "cwd").mockReturnValue(root)
    onTestFinished(() => { vi.restoreAllMocks() })
    const config = await resolveConfig({
      configFile: false,
      root,
      plugins: [vitehub({ host: "cloudflare", blob: false, env: false, queue: false, rateLimit: false, workflow: false, ...(agent === undefined ? {} : { agent }) })],
    }, "build")
    expect(config.plugins.some(plugin => plugin.name === "@vite-hub/agent/vite")).toBe(agent !== false)
  })

  it("fails when the Vite root has Definition files that the working directory does not have", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-root-"))
    // Vite rejects at the first failed configResolved hook while the other hooks still write type files, so retry.
    onTestFinished(() => rm(root, { force: true, maxRetries: 5, recursive: true }))
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "labeller.ts"), "export default {}\n")
    await expect(resolveConfig({
      configFile: false,
      root,
      plugins: [vitehub({ host: "node", blob: false, env: false, queue: false, rateLimit: false, workflow: false })],
    }, "build")).rejects.toMatchObject({ code: "VITE_HUB_DEFINITION_ROOT_MISMATCH" })
  })

  it("reports a root mismatch before validating a Browser Definition from the working directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-browser-cwd-"))
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-root-"))
    await mkdir(join(cwd, "server/browsers"), { recursive: true })
    await writeFile(join(cwd, "server/browsers/main.ts"), "export default {}\n")
    const workingDirectory = vi.spyOn(process, "cwd").mockReturnValue(cwd)
    onTestFinished(async () => {
      workingDirectory.mockRestore()
      await Promise.all([cwd, root].map(path => rm(path, { force: true, recursive: true })))
    })
    const plugins = vitehub({ host: "netlify" })
    await expect(resolveConfig({ configFile: false, root, plugins }, "build")).rejects.toMatchObject({ code: "VITE_HUB_DEFINITION_ROOT_MISMATCH" })
    await expect(resolveConfig({ configFile: false, root: cwd, plugins }, "build")).rejects.toMatchObject({ code: "VITE_HUB_R0088" })
  })

  it("requires a restart when Setup adds or removes the only Queue Definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-restart-"))
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root)
    onTestFinished(async () => {
      cwd.mockRestore()
      await rm(root, { force: true, maxRetries: 5, recursive: true })
    })
    const source = 'import { vitehub } from "vite-hub"\nexport default { plugins: [vitehub()] }\n'
    await writeFile(join(root, "vite.config.ts"), source)
    const start = () => createServer({ configFile: false, root, plugins: [vitehub()], server: { middlewareMode: true, watch: null, ws: false } })
    const session = createSetupSession({ env: {}, root, run: async () => ({ exitCode: 0 }) })
    for (const action of ["add", "remove"] as const) {
      const server = await start()
      try {
        const includesQueue = () => server.config.plugins.some(plugin => plugin.name === "@vite-hub/queue/vite")
        expect(includesQueue()).toBe(action === "remove")
        const plan = await session.plan({ action, features: ["queue"], ...(action === "add" ? { install: false, name: "jobs" } : { uninstall: false }) })
        expect(plan.body).toMatchObject({ restart: false, restartRequired: true, status: "planned" })
        const applied = await session.apply(plan.body.planId)
        expect(applied.body).toMatchObject({ restart: false, restartRequired: true, status: "applied" })
        expect(includesQueue()).toBe(action === "remove")
        expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(source)
      }
      finally {
        await server.close()
      }
    }
  })

  it("applies deployment-owned Nitro configuration only during build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-command-"))
    try {
      // `vitehub()` includes Nitro, so the dev config resolves this module.
      const localModule = { name: "local-module", setup() {} }
      const developmentConfig = {
        nitro: {
          modules: [localModule],
          preset: "node-server",
        },
        root,
        plugins: [vitehub({
          host: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
      } as Parameters<typeof resolveConfig>[0] & {
        nitro: { modules: unknown[], preset: string }
      }
      const development = await resolveConfig(developmentConfig, "serve")
      expect((development as typeof development & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        // The Console adds a module that refuses app route files on its route.
        modules: [localModule, expect.objectContaining({ name: "vite-hub/console-route-guard" })],
        preset: "node-server",
      })
      expect(getDeploymentHost(development)).toBe("cloudflare")

      const production = await resolveConfig({
        root,
        plugins: [vitehub({
          host: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
      }, "build")
      expect((production as typeof production & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        modules: expect.arrayContaining([expect.any(Function)]),
        preset: "cloudflare-module",
      })
      expect(getDeploymentHost(production)).toBe("cloudflare")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves a Worker name configured through the Nitro plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-worker-name-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [
          vitehub({ name: "logical-app", host: "cloudflare" }),
          {
            name: "nitro-config",
            config() {
              return {
                nitro: {
                  cloudflare: {
                    wrangler: {
                      name: "physical-worker",
                    },
                  },
                },
              } as never
            },
          },
        ],
      }, "build")
      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { name?: string } } }
      }).nitro?.cloudflare?.wrangler?.name).toBe("physical-worker")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares an auto-provisionable KV binding in Cloudflare Nitro output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cloudflare-kv-binding-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [vitehub({
          blob: false,
          env: false,
          kv: true,
          host: "cloudflare",
          queue: false,
          rateLimit: false,
        })],
      }, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { kv_namespaces?: Array<{ binding: string, id?: string }> } } }
      }).nitro?.cloudflare?.wrangler?.kv_namespaces).toEqual([{ binding: "KV" }])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares exact required Server Env secrets in Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-required-secrets-"))
    try {
      const config = await resolveConfig({
        nitro: {
          cloudflare: {
            wrangler: {
              secrets: { required: ["APP_SECRET"] },
            },
          },
        },
        root,
        plugins: [vitehub({
          env: {
            providers: { credentials: "./server/env/credentials.ts" },
            server: {
              nested: {
                required: env({ secret: true, source: env.source("VITEHUB_NESTED_REQUIRED") }),
                optional: env({ optional: true, secret: true, source: env.source("OPTIONAL_TOKEN") }),
                alternatives: env({ secret: true, source: env.source(["PRIMARY_TOKEN", "FALLBACK_TOKEN"]) }),
                external: env({ secret: true, source: env.provider("credentials", "github/token") }),
                publicValue: env({ source: env.source("PUBLIC_VALUE") }),
              },
            },
          },
          host: "cloudflare",
        })],
      } as Parameters<typeof resolveConfig>[0], "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toEqual(["APP_SECRET", "VITEHUB_NESTED_REQUIRED"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each(["before", "after"] as const)("discovers Channel Env when a plugin %s vitehub changes the root", async (position) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-root-"))
    const agentRoot = join(root, "app")
    try {
      await mkdir(join(agentRoot, "server", "agents"), { recursive: true })
      await writeFile(join(agentRoot, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/channels/adapters"`,
        `export default defineAgent({ channels: { telegram: telegram() } })`,
      ].join("\n"))
      const rootPlugin = {
        name: "application-root",
        config: () => ({ root: agentRoot }),
      }
      const hub = vitehub({ agent: true, host: "cloudflare" })
      const config = await resolveConfig({
        root,
        plugins: position === "before" ? [rootPlugin, hub] : [hub, rootPlugin],
      }, "build")
      expect(config.root).toBe(agentRoot)
      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required ?? []).toEqual([])
      const types = await readFile(join(agentRoot, ".vitehub", "types", "env.d.ts"), "utf8")
      expect(types).toContain('"telegram": {')
      expect(types).toContain('"botToken": import("vite-hub/env").SecretEnv<string>')
      const description = await readFile(join(agentRoot, ".vitehub", "env", "description.mjs"), "utf8")
      expect(description).toContain("VITEHUB_TELEGRAM_BOT_TOKEN")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each(["before", "after"] as const)("derives deployment resources from the root set by a plugin %s vitehub", async (position) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-deployment-root-"))
    const appRoot = join(root, "app")
    let capturedWrangler: unknown
    try {
      await mkdir(appRoot)
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "original-root" }))
      await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "application-root" }))
      const rootPlugin = { name: "application-root", config: () => ({ root: appRoot }) }
      const hub = vitehub({ host: "cloudflare", blob: true, queue: true, rateLimit: true, sandboxTask: true, env: false })
      const config = await resolveConfig({
        configFile: false,
        nitro: { modules: [{ name: "capture-resources", setup(nitro) {
          capturedWrangler = structuredClone(nitro.options.cloudflare?.wrangler)
        } }] },
        root,
        plugins: position === "before" ? [rootPlugin, hub] : [hub, rootPlugin],
      }, "build")
      expect(config.root).toBe(appRoot)
      expect(config).toMatchObject({
        [VITEHUB_FEATURES]: { blob: { bucketName: "application-root", driver: "cloudflare" }, queue: { namePrefix: "application-root-", driver: "cloudflare" }, rateLimit: { namespace: "application-root", driver: "cloudflare" }, sandboxTask: { name: "application-root-sandbox", driver: "cloudflare" } },
        nitro: { cloudflare: { wrangler: {
          name: "application-root",
          r2_buckets: [{ binding: "BLOB", bucket_name: "application-root" }],
        } } },
      })
      expect(capturedWrangler).toMatchObject({
        name: "application-root",
        r2_buckets: [{ binding: "BLOB", bucket_name: "application-root" }],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares optional Server Env for gateway presets used by Agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-gateway-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "dev.ts"), [
        `import { codexDriver, defineAgent } from "vite-hub/agent"`,
        `import { cliproxy, cloudflareAccess } from "vite-hub/gateways"`,
        `export default defineAgent({ driver: codexDriver({ gateway: cliproxy({ headers: cloudflareAccess() }) }) })`,
      ].join("\n"))
      const config = await resolveConfig({
        root,
        plugins: [vitehub({ agent: true, host: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0], "build")
      // A gateway key is optional, so a server that also hosts Agents without the gateway still starts.
      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required ?? []).toEqual([])
      const types = await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")
      expect(types).toContain("\"cliproxy\": {")
      expect(types).toContain("\"apiKey\"?: import(\"vite-hub/env\").SecretEnv<string>")
      expect(types).toContain("\"cloudflareAccess\": {")
      const description = await readFile(join(root, ".vitehub", "env", "description.mjs"), "utf8")
      expect(description).toContain("env.server.cliproxy.url")
      expect(description).toContain("env.server.cloudflareAccess.clientSecret")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares Server Env for built-in Channels used by Agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { github, telegram } from "vite-hub/channels/adapters"`,
        `export default defineAgent({ channels: { repo: github(), telegram: telegram({ mode: "webhook" }) } })`,
      ].join("\n"))
      const resolve = (server?: EnvRuntimeConfigOptions) => resolveConfig({
        root,
        // A single vendor name can be required by Wrangler only when canonical aliases are disabled.
        plugins: [vitehub({ agent: true, env: { prefix: false, ...(server ? { server } : {}) }, host: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0], "build")
      const requiredSecrets = (config: Awaited<ReturnType<typeof resolve>>) => (config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required

      const config = await resolve()
      expect(requiredSecrets(config)).toEqual(["TELEGRAM_BOT_TOKEN"])
      await symlink(join(import.meta.dirname, "../../..", "node_modules"), join(root, "node_modules"), "dir")
      const moduleUrl = pathToFileURL(join(root, ".vitehub", "env", "server.mjs")).href
      const token = execFileSync(process.execPath, ["--input-type=module", "-e", `
        const { useServerEnv } = await import(${JSON.stringify(moduleUrl)})
        const env = { VITEHUB_GITHUB_TOKEN: "", FORGES_GITHUB_TOKEN: "fallback-token", GH_TOKEN: "ignored-token", GITHUB_TOKEN: "ignored-token", TELEGRAM_BOT_TOKEN: "telegram-token" }
        // A request event whose Standard Context carries these Cloudflare bindings.
        const serverEnv = useServerEnv({ "~standard": { vendor: "test", req: new Request("https://example.test/"), res: {}, runtime: { cloudflare: { env } } } })
        console.log(serverEnv.github.token.unseal())
      `], { encoding: "utf8" })
      expect(token.trim()).toBe("fallback-token")
      const types = await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")
      expect(types).toContain("\"telegram\": {")
      expect(types).toContain("\"botToken\": import(\"vite-hub/env\").SecretEnv<string>")
      expect(types).toContain("\"webhookSecret\"?: import(\"vite-hub/env\").SecretEnv<string>")
      expect(types).toContain("\"privateKey\"?: import(\"vite-hub/env\").SecretEnv<string>")
      const description = await readFile(join(root, ".vitehub", "env", "description.mjs"), "utf8")
      expect(description).toContain("env.server.telegram.botToken")

      const renamed = await resolve({ telegram: { botToken: env({ secret: true, source: env.source("TELEGRAM_TOKEN") }) } })
      expect(requiredSecrets(renamed)).toEqual(["TELEGRAM_TOKEN"])

      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/channels/adapters"`,
        `interface Helpers { telegram(): void }`,
        `const helpers = { telegram() {} }`,
        `class Tools { telegram() {} }`,
        `function format() { const telegram = () => ({}); return telegram() }`,
        `const base = {}`,
        `export default defineAgent({ channels: { telegram: { ...base, kind: "custom" } } })`,
      ].join("\n"))
      const custom = await resolve()
      expect(requiredSecrets(custom) ?? []).not.toContain("TELEGRAM_BOT_TOKEN")
      expect(await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).not.toContain("\"telegram\": {")

      for (const { source, required } of [
        { source: `defineAgent({ channels: { telegram: telegram(undefined) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram(({})) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram((({ botToken: "token" }))) } })`, required: false },
        { source: `defineAgent({ channels: { telegram: telegram?.({ botToken: "token" }) } })`, required: false },
        { source: `defineAgent({ channels: { support: telegram<Runtime> } })`, required: true },
        { source: `defineAgent({ channels: { support: (telegram) } })`, required: true },
        { source: `const channels = ({ support: telegram }); defineAgent({ channels })`, required: true },
        { source: `const channels = ({ support: telegram }) && custom; defineAgent({ channels })`, required: false },
        { source: `defineAgent({ channels: { telegram: telegram({ botToken: void 0 }) } })`, required: true },
        { source: `defineAgent({ channels: { support: channelFactories?.["telegram"]() } })`, required: true },
        { source: `defineAgent({ channels: { support: channelFactories?.["telegram"]?.<Runtime>({ botToken: "token" }) } })`, required: false },
        { source: `function run() { telegram()\n{} }; defineAgent({ channels: {} })`, required: true },
        { source: `label: { telegram()\n{} }; defineAgent({ channels: {} })`, required: true },
        { source: `switch (value) { case "ready": { telegram()\n{} } }; defineAgent({ channels: {} })`, required: true },
        { source: `function build({ telegram: configured }: { telegram?: string }) { return telegram() }; defineAgent({ channels: { support: build({}) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram({ botToken: undefined as string | undefined }) } })`, required: true },
        { source: `const present = "telegram" in { telegram() {} }; type Conditional<T> = T extends { telegram(): void } ? true : false; defineAgent({ channels: {} })`, required: false },
        { source: `const channels = { support: telegram }; defineAgent({ channels: channels satisfies AgentChannelInputs })`, required: true },
        { source: `const channels = { support: telegram }; defineAgent({ channels: (channels as AgentChannelInputs) })`, required: true },
        { source: `const channels = { support: telegram }; defineAgent({ channels: ((channels satisfies AgentChannelInputs)) })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram({ async botToken() { return "token" } }) } })`, required: false },
      ]) {
        await writeFile(join(root, "server", "agents", "support.ts"), [
          `import { defineAgent } from "vite-hub/agent"`,
          `import { telegram } from "vite-hub/channels/adapters"`,
          `import * as channelFactories from "vite-hub/channels/adapters"`,
          source,
          // The build reads the default export of every Agent file. Server Env discovery reads every defineAgent() call.
          `export default {}`,
        ].join("\n"))
        expect((requiredSecrets(await resolve()) ?? []).includes("TELEGRAM_BOT_TOKEN"), source).toBe(required)
      }

      await rm(join(root, "server", "agents", "support.ts"))
      await writeFile(join(root, "server", "agents", "support.js"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/channels/adapters"`,
        `const compared = telegram < Runtime > ({ botToken: "token" })`,
        `export default defineAgent({ channels: {} })`,
      ].join("\n"))
      const comparison = await resolve()
      expect(requiredSecrets(comparison) ?? []).not.toContain("TELEGRAM_BOT_TOKEN")
      expect(await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).not.toContain("\"telegram\": {")
      await rm(join(root, "server", "agents", "support.js"))

      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { telegram } from "vite-hub/channels/adapters"`,
        `const defineAgent = (options) => options`,
        `export default defineAgent({ channels: { support: telegram } })`,
      ].join("\n"))
      expect(requiredSecrets(await resolve()) ?? []).not.toContain("TELEGRAM_BOT_TOKEN")
      expect(await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).not.toContain("\"telegram\": {")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("emits required Server Env secrets through the Nitro Vite plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-required-secrets-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({
          host: "cloudflare",
          env: {
            server: {
              token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
            },
          },
        }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({ secrets: { required: ["VITEHUB_TOKEN"] } })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("writes Server Env names, never values, to deployment.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-env-names-build-"))
    const canary = "canary-value-5d81e2"
    const previous = process.env.VENDOR_TOKEN
    process.env.VENDOR_TOKEN = canary
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      await mkdir(join(root, "server", "env"), { recursive: true })
      await writeFile(join(root, "server", "env", "credentials.ts"), "export default { read: () => ({}) }\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({
          host: "node",
          blob: false,
          queue: false,
          rateLimit: false,
          env: {
            server: {
              token: env({ secret: true, source: env.source(["VENDOR_TOKEN", "LEGACY_TOKEN"]) }),
              region: env({ default: canary }),
              direct: env({ optional: true, source: env.source("DIRECT_URL", { canonical: false }) }),
              vault: env({ secret: true, source: env.provider("credentials", "github/token") }),
            },
            providers: { credentials: "./server/env/credentials.ts" },
          },
        }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const text = await readFile(join(root, ".output", "deployment.json"), "utf8")
      expect(JSON.parse(text).env).toEqual([
        { path: "env.server.token", names: ["VITEHUB_TOKEN", "VENDOR_TOKEN", "LEGACY_TOKEN"], required: true, secret: true, hasDefault: false },
        { path: "env.server.region", names: ["VITEHUB_REGION", "REGION"], required: true, secret: false, hasDefault: true },
        { path: "env.server.direct", names: ["DIRECT_URL"], required: false, secret: false, hasDefault: false },
        { names: ["VITEHUB_SECRET"], required: false, secret: true, hasDefault: false, owners: ["env"] },
      ])
      expect(JSON.parse(text).envDir).toBe("..")
      expect(text).not.toContain(canary)
      expect(text).not.toContain("github/token")
    }
    finally {
      if (previous === undefined) delete process.env.VENDOR_TOKEN
      else process.env.VENDOR_TOKEN = previous
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("writes the names that primitives read on Cloudflare with D1, never values", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-primitive-names-cloudflare-"))
    const canary = "canary-value-cf-41d7a9c2e8b05f63"
    const previous = process.env.VITEHUB_SECRET
    process.env.VITEHUB_SECRET = canary
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await mkdir(join(root, "server", "databases"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      await writeFile(join(root, "server", "databases", "default.ts"), [
        "import { defineDatabase } from \"vite-hub/database\"",
        "import { sqliteTable, text } from \"drizzle-orm/sqlite-core\"",
        "const notes = sqliteTable(\"notes\", { title: text(\"title\") })",
        "export default defineDatabase({",
        "  cloudflare: { binding: \"DB\", databaseId: \"database-id\", databaseName: \"app\" },",
        "  schema: { notes },",
        "})",
        "",
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({ console: true, database: { driver: "cloudflare" }, host: "cloudflare", queue: false, rateLimit: false }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const text = await readFile(join(root, ".output", "deployment.json"), "utf8")
      // The D1 binding holds the connection, so no database variable is listed.
      expect(JSON.parse(text).env).toEqual([
        { names: ["VITEHUB_SECRET"], required: false, secret: true, hasDefault: false, owners: ["env"] },
        { names: [], prefix: "VITEHUB_CONSOLE_KEY_", required: true, secret: false, hasDefault: false, owners: ["console"] },
      ])
      expect(text).not.toContain(canary)
    }
    finally {
      if (previous === undefined) delete process.env.VITEHUB_SECRET
      else process.env.VITEHUB_SECRET = previous
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  it("writes the names that primitives read on Vercel with libSQL and Blob, never values", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-primitive-names-vercel-"))
    const canary = "canary-value-vc-9e2b51d0a7c3f846"
    const variables = { BLOB_READ_WRITE_TOKEN: `vercel_blob_rw_store_${canary}`, TURSO_AUTH_TOKEN: canary, TURSO_DATABASE_URL: `libsql://${canary}.turso.io`, VITEHUB_SECRET: canary }
    const previous = Object.fromEntries(Object.keys(variables).map(name => [name, process.env[name]]))
    Object.assign(process.env, variables)
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await mkdir(join(root, "server", "databases"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      await writeFile(join(root, "server", "databases", "default.ts"), [
        "import { defineDatabase } from \"vite-hub/database\"",
        "import { sqliteTable, text } from \"drizzle-orm/sqlite-core\"",
        "const notes = sqliteTable(\"notes\", { title: text(\"title\") })",
        "export default defineDatabase({",
        "  connection: { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN },",
        "  schema: { notes },",
        "})",
        "",
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({ blob: true, database: true, host: "vercel", queue: false, rateLimit: false }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const text = await readFile(join(root, ".vercel", "output", "deployment.json"), "utf8")
      expect(JSON.parse(text).env).toEqual([
        { names: ["TURSO_DATABASE_URL"], required: true, secret: true, hasDefault: false, owners: ["database"] },
        { names: ["TURSO_AUTH_TOKEN"], required: true, secret: true, hasDefault: false, owners: ["database"] },
        { names: ["VITEHUB_SECRET"], required: false, secret: true, hasDefault: false, owners: ["env"] },
        { names: ["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"], required: true, secret: true, hasDefault: false, owners: ["blob"] },
      ])
      expect(text).not.toContain(canary)
    }
    finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  it("writes the names that Queue, Realtime, and Workflow read on a Node server, never values", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-primitive-names-node-"))
    const canary = "canary-value-node-3f7a0c19d25e"
    const variables = { QUEUE_POSTGRES_URL: `postgres://${canary}@db.example.com/jobs`, REDIS_URL: `redis://${canary}@cache.example.com` }
    const previous = Object.fromEntries(Object.keys(variables).map(name => [name, process.env[name]]))
    Object.assign(process.env, variables)
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({
          host: "node",
          blob: false,
          queue: { driver: "postgres" },
          rateLimit: false,
          realtime: { driver: "redis" },
          workflow: { driver: "openworkflow" },
        }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const text = await readFile(join(root, ".output", "deployment.json"), "utf8")
      const owned = (JSON.parse(text) as { env: Array<{ owners?: string[] }> }).env.filter(entry => entry.owners?.some(owner => ["queue", "realtime", "workflow"].includes(owner)))
      expect(owned).toEqual([
        { names: ["REDIS_URL"], required: true, secret: true, hasDefault: false, owners: ["realtime"] },
        { names: ["REALTIME_NAMESPACE"], required: false, secret: false, hasDefault: true, owners: ["realtime"] },
        { names: ["OPENWORKFLOW_SQLITE_PATH"], required: false, secret: false, hasDefault: true, owners: ["workflow"] },
        { names: ["OPENWORKFLOW_POSTGRES_URL", "DATABASE_URL"], required: false, secret: true, hasDefault: true, owners: ["workflow"] },
        { names: ["OPENWORKFLOW_NAMESPACE_ID"], required: false, secret: false, hasDefault: true, owners: ["workflow"] },
        { names: ["OPENWORKFLOW_SCHEMA"], required: false, secret: false, hasDefault: true, owners: ["workflow"] },
        // Realtime and Workflow plugins run with `enforce: "pre"`, so the Queue entry comes last.
        { names: ["QUEUE_POSTGRES_URL"], required: true, secret: true, hasDefault: false, owners: ["queue"] },
      ])
      expect(text).not.toContain(canary)
    }
    finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  it("keeps one Wrangler entry per binding when the project's wrangler.json repeats generated ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-project-wrangler-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      // A Deploy to Cloudflare template: the button writes real ids over the all-zero ones.
      await writeFile(join(root, "wrangler.json"), JSON.stringify({
        compatibility_flags: ["nodejs_compat"],
        kv_namespaces: [{ binding: "KV", id: "kv-id" }, { binding: "CACHE", id: "00000000000000000000000000000000" }],
        r2_buckets: [{ binding: "BLOB", bucket_name: "assets", preview_bucket_name: "assets-preview" }],
        secrets: { required: ["VITEHUB_TOKEN", "OTHER_TOKEN"] },
      }))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        nitro: {
          cloudflare: {
            wrangler: {
              compatibility_flags: ["nodejs_compat"],
              kv_namespaces: [{ binding: "KV" }, { binding: "CACHE" }],
              r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }],
            },
          },
        },
        root,
        plugins: [vitehub({
          host: "cloudflare",
          env: { server: { token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }) } },
        }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({
        compatibility_flags: ["nodejs_compat"],
        kv_namespaces: [{ binding: "KV", id: "kv-id" }, { binding: "CACHE" }],
        r2_buckets: [{ binding: "BLOB", bucket_name: "assets", preview_bucket_name: "assets-preview" }],
        secrets: { required: ["VITEHUB_TOKEN", "OTHER_TOKEN"] },
      })
      expect(wrangler).not.toHaveProperty("kv_namespaces.1.id")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  it("emits discovered D1 bindings through the Nitro Vite plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-d1-bindings-build-"))
    try {
      await mkdir(join(root, "server", "databases", "default", "migrations"), { recursive: true })
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      await writeFile(join(root, "server", "databases", "default", "migrations", "0001_init.sql"), "create table notes (title text);\n")
      await writeFile(join(root, "server", "databases", "default.ts"), [
        "import { defineDatabase } from \"vite-hub/database\"",
        "import { sqliteTable, text } from \"drizzle-orm/sqlite-core\"",
        "const notes = sqliteTable(\"notes\", { title: text(\"title\") })",
        "export default defineDatabase({",
        "  cloudflare: { binding: \"DB\", databaseId: \"database-id\", databaseName: \"app\" },",
        "  schema: { notes },",
        "})",
        "",
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        nitro: {
          cloudflare: {
            wrangler: {
              d1_databases: [{ binding: "LEGACY", database_id: "legacy-id", database_name: "legacy" }],
            },
          },
        },
        root,
        plugins: [vitehub({ database: { driver: "cloudflare" }, host: "cloudflare" }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toHaveProperty("d1_databases", [
        { binding: "LEGACY", database_id: "legacy-id", database_name: "legacy" },
        { binding: "DB", database_id: "database-id", database_name: "app", migrations_dir: ".vitehub/database/migrations/DB" },
      ])
      await expect(readFile(join(root, ".output", "server", ".vitehub", "database", "migrations", "DB", "0001_init.sql"), "utf8"))
        .resolves.toBe("create table notes (title text);\n")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  it("emits each required secret and user Wrangler entry once when Agents are enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-required-secrets-build-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "agents", "helper.ts"), [
        "import { defineAgent } from \"vite-hub/agent\"",
        "export default defineAgent({ driver: { run: () => \"ok\" } })",
        "",
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        nitro: {
          cloudflare: {
            wrangler: {
              routes: [{ custom_domain: true, pattern: "app.example.com" }],
            },
          },
        },
        root,
        plugins: [vitehub({
          agent: true,
          host: "cloudflare",
          workflow: false,
          env: {
            server: {
              token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
            },
          },
        }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      // toMatchObject compares array lengths, so a repeated entry fails this assertion.
      expect(wrangler).toMatchObject({
        durable_objects: { bindings: [{ class_name: "ViteHubAgentStateDO", name: "CHAT_STATE" }] },
        migrations: [{ new_sqlite_classes: ["ViteHubAgentStateDO"], tag: "vitehub-agent-state-v1" }],
        routes: [{ custom_domain: true, pattern: "app.example.com" }],
        secrets: { required: ["VITEHUB_TOKEN"] },
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  it("keeps the provider Driver runtime out of a Cloudflare Worker with a model Driver Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-worker-bundle-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "agents", "support.ts"), [
        "import { defineAgent } from \"vite-hub/agent\"",
        "import { progressSummary, title } from \"vite-hub/agent/capabilities\"",
        "export default defineAgent({ capabilities: [title(), progressSummary()], driver: { model: \"openai/gpt-5\" } })",
        "",
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({ agent: true, host: "cloudflare" }), nitro() as never],
      })
      await builder.buildApp()

      const serverDir = join(root, ".output", "server")
      const files = (await readdir(serverDir, { recursive: true })).filter(file => file.endsWith(".mjs"))
      const sources = await Promise.all(files.map(file => readFile(join(serverDir, file), "utf8")))
      const bundle = sources.join("\n")
      expect(files.filter(file => file.includes("provider-agent"))).toEqual([])
      expect(bundle).not.toContain("createSqliteProviderRuntimeSessionStore")
      expect(bundle).not.toMatch(/["']node:child_process["']/)
      expect(bundle).not.toMatch(/createRequire\(\s*import\.meta\.url\s*\)/)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 300_000)

  it("fails a Cloudflare Worker build with a provider Driver Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-worker-provider-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "agents", "review.ts"), [
        "import { codexDriver, defineAgent } from \"vite-hub/agent\"",
        "export default defineAgent({ driver: codexDriver() })",
        "",
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({ agent: true, host: "cloudflare" }), nitro() as never],
      })

      await expect(builder.buildApp()).rejects.toThrow(/AGENT_B0019[\s\S]*cannot run in a Cloudflare Worker/)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 300_000)

  it("omits fallback secret names from a standalone Env plugin with a custom prefix through Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-prefixed-standalone-secrets-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({ env: false, host: "cloudflare" }), hubEnv({
          prefix: "APP_",
          server: { token: env({ secret: true }) },
        }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      // Either APP_TOKEN or TOKEN satisfies the declaration; Wrangler cannot require either one alone.
      expect(wrangler).not.toHaveProperty("secrets.required")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("emits secrets contributed by later pre hooks through Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-late-pre-secrets-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [
          vitehub({ host: "cloudflare" }),
          {
            // A ViteHub feature, such as Agent Channels, declares Server Env from a config hook.
            name: "app/server-env",
            enforce: "pre",
            config: () => ({ [VITEHUB_ENV_SERVER]: { token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }) } }),
          },
          nitro() as never,
        ],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({ secrets: { required: ["VITEHUB_TOKEN"] } })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it.each([true, undefined])("writes non-secret Server Env from the build environment to Worker vars with cloudflare.vars %s", async (vars) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cloudflare-vars-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      await writeFile(join(root, ".env"), [
        "EXECUTOR_URL=https://executor.example.com",
        "EXECUTOR_API_KEY=sk-not-a-var",
        "VITEHUB_GMAIL_ACCOUNT=acc_canonical",
        "GMAIL_ACCOUNT=acc_conventional",
        "DRY_RUN=false",
        "PUBSUB_TOPIC=",
        "VITEHUB_PAYMENT_LINK=https://pay.example.com/from-env",
        "VITEHUB_EXECUTOR_API_KEY=sk-not-a-var-either",
        "VITEHUB_PUBLIC_EXECUTOR_LABEL=public-label",
        "",
      ].join("\n"))
      await writeFile(join(root, ".env.development"), "LOG_LEVEL=debug\n")
      await writeFile(join(root, "wrangler.json"), JSON.stringify({
        vars: { PAYMENT_LINK: "https://pay.example.com/from-wrangler" },
        env: { staging: { vars: { DRY_RUN: "true" } }, production: { vars: { PAYMENT_LINK: "https://pay.example.com/production" } } },
      }))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({
          host: "cloudflare",
          ...(vars ? { cloudflare: { vars } } : {}),
          env: {
            server: {
              executor: {
                url: env({ source: env.source("EXECUTOR_URL") }),
                apiKey: env({ secret: true, source: env.source("EXECUTOR_API_KEY") }),
              },
              gmailAccount: env(),
              dryRun: env.boolean({ default: true, source: env.source("DRY_RUN") }),
              pubsubTopic: env({ optional: true, source: env.source("PUBSUB_TOPIC") }),
              logLevel: env({ default: "info", source: env.source("LOG_LEVEL") }),
              paymentLink: env({ source: env.source("PAYMENT_LINK") }),
              paymentLinkAlias: env({ source: env.source("VITEHUB_PAYMENT_LINK", { canonical: false }) }),
              executorKeyAlias: env({ source: env.source("EXECUTOR_API_KEY") }),
              canonicalKeyAlias: env({ source: env.source("VITEHUB_EXECUTOR_API_KEY") }),
              publicExecutorLabel: env({ source: env.source("EXECUTOR_API_KEY") }),
            },
          },
        }), nitro() as never],
      } as Parameters<typeof createBuilder>[0])
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      if (!vars) {
        expect(wrangler).toMatchObject({ vars: { PAYMENT_LINK: "https://pay.example.com/from-wrangler" } })
        expect(wrangler).not.toHaveProperty("vars.EXECUTOR_URL")
        return
      }
      const generated = {
        EXECUTOR_URL: "https://executor.example.com",
        // Server Env reads the canonical name first, so the Worker gets the same value under the same name.
        VITEHUB_GMAIL_ACCOUNT: "acc_canonical",
        DRY_RUN: "false",
        VITEHUB_PUBLIC_EXECUTOR_LABEL: "public-label",
      }
      expect(wrangler).toHaveProperty("vars", { ...generated, PAYMENT_LINK: "https://pay.example.com/from-wrangler" })
      // Named environments do not inherit vars, and keep their own.
      expect(wrangler).toHaveProperty("env.staging.vars", { ...generated, DRY_RUN: "true", VITEHUB_PAYMENT_LINK: "https://pay.example.com/from-env" })
      expect(wrangler).toHaveProperty("env.production.vars", { ...generated, PAYMENT_LINK: "https://pay.example.com/production" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 60_000)

  it.each([undefined, "APP_", false] as const)("uses exact Wrangler requirements with prefix %s", async (prefix) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-secret-aliases-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [vitehub({ env: false, host: "cloudflare" }), hubEnv({
          prefix,
          server: { token: env({ secret: true }) },
        })],
      } as Parameters<typeof resolveConfig>[0], "build")
      const required = (config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required
      expect(required).toEqual(prefix === false ? ["TOKEN"] : undefined)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares required secrets from a standalone Env plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-standalone-required-secrets-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [
          vitehub({ env: false, host: "cloudflare" }),
          hubEnv({
            server: {
              token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
            },
          }),
        ],
      } as Parameters<typeof resolveConfig>[0], "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toEqual(["VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps standalone Env subscriptions scoped to their Cloudflare configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-reused-env-plugin-"))
    try {
      const envPlugin = hubEnv({ server: { token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }) } })
      await resolveConfig({
        root,
        plugins: [vitehub({ env: false, host: "cloudflare" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0], "build")
      const nodeConfig = await resolveConfig({
        root,
        plugins: [vitehub({ env: false, host: "node" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0], "build")

      expect((nodeConfig as typeof nodeConfig & { nitro?: { cloudflare?: unknown } }).nitro?.cloudflare).toBeUndefined()

      const [first, second] = await Promise.all([
        resolveConfig({
          root,
          plugins: [vitehub({ env: false, host: "cloudflare" }), hubEnv({ server: { first: env({ secret: true, source: env.source("VITEHUB_FIRST") }) } })],
        } as Parameters<typeof resolveConfig>[0], "build"),
        resolveConfig({
          root,
          plugins: [vitehub({ env: false, host: "cloudflare" }), hubEnv({ server: { second: env({ secret: true, source: env.source("VITEHUB_SECOND") }) } })],
        } as Parameters<typeof resolveConfig>[0], "build"),
      ])
      const required = (config: typeof first) => (config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required
      expect(required(first)).toEqual(["VITEHUB_FIRST"])
      expect(required(second)).toEqual(["VITEHUB_SECOND"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares required secrets in named environments from later post hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-late-required-secrets-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [
          vitehub({
            host: "cloudflare",
            env: {
              server: {
                token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
              },
            },
          }),
          {
            name: "app/cloudflare-environments",
            enforce: "post",
            config() {
              return {
                nitro: {
                  cloudflare: {
                    wrangler: {
                      env: { staging: { name: "staging-worker" } },
                    },
                  },
                },
              }
            },
          },
        ],
      } as Parameters<typeof resolveConfig>[0], "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { env?: { staging?: { secrets?: { required?: string[] } } } } } }
      }).nitro?.cloudflare?.wrangler?.env?.staging?.secrets?.required).toEqual(["VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps required Server Env secrets out of non-Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-node-required-secrets-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [vitehub({
          host: "node",
          env: {
            server: {
              token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
            },
          },
        })],
      } as Parameters<typeof resolveConfig>[0], "build")

      expect((config as typeof config & { nitro?: { cloudflare?: unknown } }).nitro?.cloudflare).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
