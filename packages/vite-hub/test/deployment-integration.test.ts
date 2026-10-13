import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createBuilder, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { collectViteHubProviderOutputEntries } from "@vite-hub/internal/inspect"
import { env, hubEnv } from "@vite-hub/env/vite"
import { vitehub } from "../src/index.ts"

import type { EnvViteUserConfig } from "@vite-hub/env"

describe("built-in deployment preset integration", () => {
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
              vitehub({ preset: "node", blob: false, env: false, queue: false, rateLimit: false }),
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


  it.each(["cloudflare", "netlify", "vercel", "deno", "node"] as const)("resolves the minimal %s preset with real owner plugins", async (preset) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-config-"))
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        preset,
        blob: false,
        env: false,
        queue: false,
        rateLimit: false,
      })],
    }, "build")
    expect(config.plugins.map(plugin => plugin.name)).not.toContain("@vite-hub/sandbox/vite")
    expect((config as typeof config & { nitro?: { preset?: string } }).nitro?.preset).toBeTruthy()
  })

  it("applies deployment-owned Nitro configuration only during build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-command-"))
    try {
      const developmentConfig = {
        nitro: {
          modules: ["local-module"],
          preset: "node-server",
        },
        root,
        plugins: [vitehub({
          preset: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
        vitehub: {
          marker: "preserved",
        },
      } as Parameters<typeof resolveConfig>[0] & {
        nitro: { modules: string[], preset: string }
        vitehub: { marker: string }
      }
      const development = await resolveConfig(developmentConfig, "serve")
      expect((development as typeof development & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        modules: ["local-module"],
        preset: "node-server",
      })
      expect(development.vitehub).toEqual({
        marker: "preserved",
        preset: "cloudflare",
      })

      const production = await resolveConfig({
        root,
        plugins: [vitehub({
          preset: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
      }, "build")
      expect((production as typeof production & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        modules: [expect.any(Function)],
        preset: "cloudflare-module",
      })
      expect(production.vitehub).toEqual({
        preset: "cloudflare",
      })
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
          vitehub({ name: "logical-app", preset: "cloudflare" }),
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
          preset: "cloudflare",
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
        env: {
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
        nitro: {
          cloudflare: {
            wrangler: {
              secrets: { required: ["APP_SECRET"] },
            },
          },
        },
        root,
        plugins: [vitehub({ env: { providers: { credentials: "./server/env/credentials.ts" } }, preset: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

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
        `import { telegram } from "vite-hub/agent/channels"`,
        `export default defineAgent({ channels: { telegram: telegram() } })`,
      ].join("\n"))
      const rootPlugin = {
        name: "application-root",
        config: () => ({ root: agentRoot }),
      }
      const hub = vitehub({ agent: true, preset: "cloudflare" })
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
      expect(types).toContain('"botToken": import("vite-hub/env/secret").SecretEnv<string>')
      const description = await readFile(join(agentRoot, ".vitehub", "env", "description.mjs"), "utf8")
      expect(description).toContain("VITEHUB_TELEGRAM_BOT_TOKEN")
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
        `import { defineAgent } from "vite-hub/agent"`,
        `import { cliproxy, cloudflareAccess } from "vite-hub/agent/gateways"`,
        `export default defineAgent({ driver: { kind: "codex", gateway: cliproxy({ headers: cloudflareAccess() }) } })`,
      ].join("\n"))
      const config = await resolveConfig({
        root,
        plugins: [vitehub({ agent: true, preset: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")
      // A gateway key is optional, so a server that also hosts Agents without the gateway still starts.
      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required ?? []).toEqual([])
      const types = await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")
      expect(types).toContain("\"cliproxy\": {")
      expect(types).toContain("\"apiKey\"?: import(\"vite-hub/env/secret\").SecretEnv<string>")
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
        `import { github, telegram } from "vite-hub/agent/channels"`,
        `export default defineAgent({ channels: { repo: github(), telegram: telegram({ mode: "webhook" }) } })`,
      ].join("\n"))
      const resolve = (server?: Record<string, unknown>) => resolveConfig({
        ...(server ? { env: { server } } : {}),
        root,
        // A single vendor name can be required by Wrangler only when canonical aliases are disabled.
        plugins: [vitehub({ agent: true, env: { prefix: false }, preset: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")
      const requiredSecrets = (config: Awaited<ReturnType<typeof resolve>>) => (config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required

      const config = await resolve()
      expect(requiredSecrets(config)).toEqual(["TELEGRAM_BOT_TOKEN"])
      await symlink(join(import.meta.dirname, "../../..", "node_modules"), join(root, "node_modules"), "dir")
      const moduleUrl = pathToFileURL(join(root, ".vitehub", "env", "server.mjs")).href
      const token = execFileSync(process.execPath, ["--input-type=module", "-e", `
        const { useServerEnv } = await import(${JSON.stringify(moduleUrl)})
        const serverEnv = useServerEnv({
          env: { VITEHUB_GITHUB_TOKEN: "", GH_TOKEN: "fallback-token", GITHUB_TOKEN: "last-token", TELEGRAM_BOT_TOKEN: "telegram-token" },
        })
        console.log(serverEnv.github.token.unseal())
      `], { encoding: "utf8" })
      expect(token.trim()).toBe("fallback-token")
      const types = await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")
      expect(types).toContain("\"telegram\": {")
      expect(types).toContain("\"botToken\": import(\"vite-hub/env/secret\").SecretEnv<string>")
      expect(types).toContain("\"webhookSecret\"?: import(\"vite-hub/env/secret\").SecretEnv<string>")
      expect(types).toContain("\"appPrivateKey\"?: import(\"vite-hub/env/secret\").SecretEnv<string>")
      const description = await readFile(join(root, ".vitehub", "env", "description.mjs"), "utf8")
      expect(description).toContain("env.server.telegram.botToken")

      const renamed = await resolve({ telegram: { botToken: env({ secret: true, source: env.source("TELEGRAM_TOKEN") }) } })
      expect(requiredSecrets(renamed)).toEqual(["TELEGRAM_TOKEN"])

      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/agent/channels"`,
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
        { source: `defineAgent({ channels: { telegram: undefined } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram(undefined) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram(({})) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram((({ botToken: "token" }))) } })`, required: false },
        { source: `defineAgent({ channels: { telegram: telegram?.({ botToken: "token" }) } })`, required: false },
        { source: `defineAgent({ channels: { support: telegram<Runtime> } })`, required: true },
        { source: `defineAgent({ channels: { support: (telegram) } })`, required: true },
        { source: `const channels = ({ telegram: {} }); defineAgent({ channels })`, required: true },
        { source: `const channels = ({ telegram: {} }) && custom; defineAgent({ channels })`, required: false },
        { source: `defineAgent({ channels: { telegram: telegram({ botToken: void 0 }) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: { botToken: void 0, adapter: void 0 } } })`, required: true },
        { source: `defineAgent({ channels: { telegram: void 0 } })`, required: true },
        { source: `defineAgent({ channels: { support: channelFactories?.["telegram"]() } })`, required: true },
        { source: `defineAgent({ channels: { support: channelFactories?.["telegram"]?.<Runtime>({ botToken: "token" }) } })`, required: false },
        { source: `function run() { telegram()\n{} }; defineAgent({ channels: {} })`, required: true },
        { source: `label: { telegram()\n{} }; defineAgent({ channels: {} })`, required: true },
        { source: `switch (value) { case "ready": { telegram()\n{} } }; defineAgent({ channels: {} })`, required: true },
        { source: `function build({ telegram: configured }: { telegram?: string }) { return telegram() }; defineAgent({ channels: { support: build({}) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram({ botToken: undefined as string | undefined }) } })`, required: true },
        { source: `const present = "telegram" in { telegram() {} }; type Conditional<T> = T extends { telegram(): void } ? true : false; defineAgent({ channels: {} })`, required: false },
        { source: `const channels = { telegram: {} }; defineAgent({ channels: channels satisfies AgentChannelInputs })`, required: true },
        { source: `const channels = { telegram: {} }; defineAgent({ channels: (channels as AgentChannelInputs) })`, required: true },
        { source: `const channels = { telegram: {} }; defineAgent({ channels: ((channels satisfies AgentChannelInputs)) })`, required: true },
        { source: `defineAgent({ channels: { telegram: { async botToken() { return "token" } } } })`, required: false },
      ]) {
        await writeFile(join(root, "server", "agents", "support.ts"), [
          `import { defineAgent } from "vite-hub/agent"`,
          `import { telegram } from "vite-hub/agent/channels"`,
          `import * as channelFactories from "vite-hub/agent/channels"`,
          source,
        ].join("\n"))
        expect((requiredSecrets(await resolve()) ?? []).includes("TELEGRAM_BOT_TOKEN"), source).toBe(required)
      }

      await rm(join(root, "server", "agents", "support.ts"))
      await writeFile(join(root, "server", "agents", "support.js"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/agent/channels"`,
        `const compared = telegram < Runtime > ({ botToken: "token" })`,
        `export default defineAgent({ channels: {} })`,
      ].join("\n"))
      const comparison = await resolve()
      expect(requiredSecrets(comparison) ?? []).not.toContain("TELEGRAM_BOT_TOKEN")
      expect(await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).not.toContain("\"telegram\": {")
      await rm(join(root, "server", "agents", "support.js"))

      await writeFile(join(root, "server", "agents", "support.ts"), [
        `const defineAgent = (options) => options`,
        `export default defineAgent({ channels: { telegram: {} } })`,
      ].join("\n"))
      expect(requiredSecrets(await resolve()) ?? []).not.toContain("TELEGRAM_BOT_TOKEN")
      expect(await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).not.toContain("\"telegram\": {")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("emits required Server Env secrets through the Nitro Vite plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-required-secrets-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        logLevel: "silent",
        root,
        plugins: [vitehub({ preset: "cloudflare" }), nitro() as never],
      } as Parameters<typeof createBuilder>[0] & EnvViteUserConfig)
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({ secrets: { required: ["VITEHUB_TOKEN"] } })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("emits discovered D1 bindings through the Nitro Vite plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-d1-bindings-build-"))
    try {
      await mkdir(join(root, "server", "databases", "migrations"), { recursive: true })
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      await writeFile(join(root, "server", "databases", "migrations", "0001_init.sql"), "create table notes (title text);\n")
      await writeFile(join(root, "server", "databases", "config.ts"), [
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
        plugins: [vitehub({ database: { driver: "d1" }, preset: "cloudflare" }), nitro() as never],
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
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        logLevel: "silent",
        nitro: {
          cloudflare: {
            wrangler: {
              routes: [{ custom_domain: true, pattern: "app.example.com" }],
            },
          },
        },
        root,
        plugins: [vitehub({ agent: true, preset: "cloudflare", workflow: false }), nitro() as never],
      } as Parameters<typeof createBuilder>[0] & EnvViteUserConfig)
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
        plugins: [vitehub({ agent: true, preset: "cloudflare", workflow: false }), nitro() as never],
      })
      await builder.buildApp()

      const serverDir = join(root, ".output", "server")
      const files = (await readdir(serverDir, { recursive: true })).filter(file => file.endsWith(".mjs"))
      const sources = await Promise.all(files.map(file => readFile(join(serverDir, file), "utf8")))
      const bundle = sources.join("\n")
      expect(bundle).toContain("AGENT_R0928")
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
        "import { defineAgent } from \"vite-hub/agent\"",
        "export default defineAgent({ driver: \"codex\" })",
        "",
      ].join("\n"))
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [vitehub({ agent: true, preset: "cloudflare", workflow: false }), nitro() as never],
      })

      await expect(builder.buildApp()).rejects.toThrow(/AGENT_B0019[\s\S]*server\/agents\/review\.ts/)
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
        env: { server: { token: env({ secret: true }) } },
        logLevel: "silent",
        root,
        plugins: [vitehub({ env: false, preset: "cloudflare" }), hubEnv({ prefix: "APP_" }), nitro() as never],
      } as Parameters<typeof createBuilder>[0] & EnvViteUserConfig)
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
          vitehub({ preset: "cloudflare" }),
          {
            name: "app/server-env",
            enforce: "pre",
            config: () => ({ env: { server: { token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }) } } }),
          },
          nitro() as never,
        ],
      } as Parameters<typeof createBuilder>[0] & EnvViteUserConfig)
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({ secrets: { required: ["VITEHUB_TOKEN"] } })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it.each([undefined, "APP_", false] as const)("uses exact Wrangler requirements with prefix %s", async (prefix) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-secret-aliases-"))
    try {
      const config = await resolveConfig({
        env: { server: { token: env({ secret: true }) } },
        root,
        plugins: [vitehub({ env: false, preset: "cloudflare" }), hubEnv({ prefix })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")
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
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [
          vitehub({ env: false, preset: "cloudflare" }),
          hubEnv(),
        ],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

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
      const envPlugin = hubEnv()
      const server = { token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }) }
      await resolveConfig({
        env: { server },
        root,
        plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")
      const emptyCloudflareConfig = await resolveConfig({
        root,
        plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0], "build")
      const nodeConfig = await resolveConfig({
        env: { server },
        root,
        plugins: [vitehub({ env: false, preset: "node" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((emptyCloudflareConfig as typeof emptyCloudflareConfig & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toBeUndefined()
      expect((nodeConfig as typeof nodeConfig & { nitro?: { cloudflare?: unknown } }).nitro?.cloudflare).toBeUndefined()

      const [first, second] = await Promise.all([
        resolveConfig({
          env: { server: { first: env({ secret: true, source: env.source("VITEHUB_FIRST") }) } },
          root,
          plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
        } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build"),
        resolveConfig({
          env: { server: { second: env({ secret: true, source: env.source("VITEHUB_SECOND") }) } },
          root,
          plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
        } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build"),
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
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [
          vitehub({ preset: "cloudflare" }),
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
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

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
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [vitehub({ preset: "node" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & { nitro?: { cloudflare?: unknown } }).nitro?.cloudflare).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
