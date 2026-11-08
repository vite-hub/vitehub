import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { migrateViteHubOptions } from "../src/vitehub-options/transform.ts"

const scratch = fileURLToPath(new URL("../.tmp/vitehub-options-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

function lines(...values: string[]): string {
  return `${values.join("\n")}\n`
}

describe("vitehub-options transform", () => {
  it("moves logs into observability, env into vitehub(), and removes contentImportBase", () => {
    const input = lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "import { env } from 'vite-hub/env'",
      "",
      "export default defineConfig({",
      "  env: {",
      "    server: {",
      "      token: env({ secret: true }),",
      "    },",
      "  },",
      "  plugins: [",
      "    vitehub({",
      "      preset: 'node',",
      "      contentImportBase: 'vite-hub/content',",
      "      logs: { source: './server/logs.ts', evlog: { pretty: true } },",
      "      observability: { service: 'shop' },",
      "    }),",
      "  ],",
      "})",
    )
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.code).toBe(lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "import { env } from 'vite-hub/env'",
      "",
      "export default defineConfig({",
      "  plugins: [",
      "    vitehub({",
      "      preset: 'node',",
      "      observability: {",
      "        service: 'shop',",
      "        evlog: { pretty: true },",
      "        logs: { source: './server/logs.ts' },",
      "      },",
      "      env: {",
      "        server: {",
      "          token: env({ secret: true }),",
      "        },",
      "      },",
      "    }),",
      "  ],",
      "})",
    ))
    expect(result.followUps).toEqual([])
    expect(result.notes).toEqual(["vite.config.ts: removed contentImportBase. ViteHub always imports Content from vite-hub/content."])
  })

  it("renames logs in place when observability is not set", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ preset: 'node', logs: true })] }\n"
    expect(migrateViteHubOptions("vite.config.ts", input).code)
      .toBe("import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ preset: 'node', observability: { logs: true } })] }\n")
  })

  it("adds the Env options to a vitehub() call without options", () => {
    const input = lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "",
      "export default defineConfig({",
      "  plugins: [vitehub()],",
      "  env: {",
      "    public: { appName: env({ default: 'Acme', mode: 'build' }) },",
      "  },",
      "})",
    )
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(lines(
      "import { defineConfig } from 'vite'",
      "import { vitehub } from 'vite-hub'",
      "",
      "export default defineConfig({",
      "  plugins: [vitehub({",
      "    env: {",
      "      public: { appName: env({ default: 'Acme', mode: 'build' }) },",
      "    },",
      "  })],",
      "})",
    ))
  })

  it("passes top-level options to standalone owner plugins", () => {
    const input = lines(
      "import { envSchema, hubEnv } from '@vite-hub/env/vite'",
      "import { hubKv } from '@vite-hub/kv/vite'",
      "import { defineConfig } from 'vite'",
      "",
      "export default defineConfig({",
      "  plugins: [hubEnv({ prefix: 'APP_' }), hubKv()],",
      "  env: envSchema(new URL('./.env.example', import.meta.url)),",
      "  kv: { driver: 'fs-lite' },",
      "})",
    )
    expect(migrateViteHubOptions("vite.config.ts", input).code).toBe(lines(
      "import { envSchema, hubEnv } from '@vite-hub/env/vite'",
      "import { hubKv } from '@vite-hub/kv/vite'",
      "import { defineConfig } from 'vite'",
      "",
      "export default defineConfig({",
      "  plugins: [hubEnv({",
      "    prefix: 'APP_',",
      "    ...envSchema(new URL('./.env.example', import.meta.url)),",
      "  }), hubKv({ driver: 'fs-lite' })],",
      "})",
    ))
  })

  it("moves vite.env into the vite-hub/nuxt options", () => {
    const input = lines(
      "export default defineNuxtConfig({",
      "  modules: [['vite-hub/nuxt', { auth: true, preset: 'cloudflare' }]],",
      "  vite: {",
      "    env: {",
      "      server: { auth: { secret: env({ secret: true }) } },",
      "    },",
      "  } as never,",
      "})",
    )
    expect(migrateViteHubOptions("nuxt.config.ts", input).code).toBe(lines(
      "export default defineNuxtConfig({",
      "  modules: [['vite-hub/nuxt', {",
      "    auth: true,",
      "    preset: 'cloudflare',",
      "    env: {",
      "      server: { auth: { secret: env({ secret: true }) } },",
      "    },",
      "  }]],",
      "})",
    ))
  })

  it("reports what it cannot move", () => {
    const input = lines(
      "import { vitehub } from 'vite-hub'",
      "export default {",
      "  env: { server: {} },",
      "  plugins: [vitehub({ env: false, logs: isDev ? true : { source: './server/logs.ts' } })],",
      "}",
    )
    const result = migrateViteHubOptions("vite.config.ts", input)
    expect(result.changed).toBe(false)
    expect(result.followUps.map(followUp => followUp.message)).toEqual([
      expect.stringContaining("logs is an expression"),
      expect.stringContaining("vitehub({ env: false }) turns Env off"),
    ])
  })

  it("leaves configs that use the current options unchanged", () => {
    const input = "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { logs: true }, env: { server: {} } })] }\n"
    expect(migrateViteHubOptions("vite.config.ts", input)).toMatchObject({ changed: false, code: input, followUps: [] })
  })
})

describe("vitehub-options codemod", () => {
  it("edits config files and reports renamed option types", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "app-"))
    await writeFile(join(cwd, "vite.config.ts"), "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ logs: true })] }\n")
    await mkdir(join(cwd, "src"))
    await writeFile(join(cwd, "src/config.ts"), "import type { KVModuleOptions } from 'vite-hub'\nexport const kv: KVModuleOptions = false\n")
    const run = await runCodemod("vitehub-options", { cwd })
    expect(await readFile(join(cwd, "vite.config.ts"), "utf8")).toBe("import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ observability: { logs: true } })] }\n")
    expect(formatReport(run)).toContain("src/config.ts:1 KVModuleOptions is now KVOptions.")
  })
})
