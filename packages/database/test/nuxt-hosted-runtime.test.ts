import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { hubDb } from "../src/nuxt.ts"

describe("Nuxt hosted Database module preparation", () => {
  it.each([
    ["cloudflare-module", "cloudflare", "default"],
    ["cloudflare-module", "cloudflare", "orders"],
    ["cloudflare-module", "cloudflare", "__proto__"],
    ["vercel", "vercel", "default"],
    ["vercel", "vercel", "orders"],
    ["vercel", "vercel", "__proto__"],
  ])("creates a resolvable %s runtime for the %s provider and %s definition before Vite builds", async (preset, provider, name) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-nuxt-hosted-runtime-"))
    const projectRoot = join(root, "service")
    const definition = join(projectRoot, "server/databases", name!, "index.ts")
    const hooks: Array<(config: Record<string, unknown>) => void | Promise<void>> = []
    try {
      await mkdir(dirname(definition), { recursive: true })
      // Cloudflare needs a D1 resource for each Definition. Without one, the Vite build removes the hosted runtime.
      const cloudflare = provider === "cloudflare" ? `cloudflare: { databaseId: "db-id", databaseName: "db" },` : ""
      await writeFile(definition, `export default defineDatabase({ ${name === "default" ? "" : `name: ${JSON.stringify(name)},`} ${cloudflare} schema: {} })\n`)
      await hubDb({ projectRoot: "service" })(undefined, {
        hook: (event: string, callback: (config: Record<string, unknown>) => void | Promise<void>) => {
          if (event === "nitro:config") hooks.push(callback)
        },
        options: { dev: false, rootDir: root, vite: { root: "app" } },
      })
      const config = { alias: {} as Record<string, string>, preset }
      for (const hook of hooks) await hook(config)
      const runtimeFile = config.alias["@vite-hub/database/drizzle"]!
      expect(runtimeFile).toBe(join(projectRoot, `.vitehub/database/${provider}-runtime.mjs`))
      const runtime = await readFile(runtimeFile, "utf8")
      expect(runtime).toContain("createHostedDrizzleDb(")
      expect(runtime).toMatch(/runtime\/d1\.(?:js|ts)"/)
      expect(runtime).toContain(`[${JSON.stringify(name)}]: {`)
      // Generated schema imports must exist when Nitro first resolves the alias.
      const schemaImport = /import schema_0, \{ relations as relations_0 \} from "([^"]+)"/.exec(runtime)?.[1]
      expect(schemaImport).toBeTruthy()
      const schema = await readFile(resolve(dirname(runtimeFile), schemaImport!), "utf8")
      expect(schema).toContain("databaseDefinition.schema")
      await expect(readFile(config.alias["#vitehub/database/definition-defaults"]!, "utf8")).resolves.toContain("export default")

      const explicit = { alias: { "@vite-hub/database/drizzle": "/custom/database.mjs", "#vitehub/database/definition-defaults": "/custom/defaults.mjs" }, preset }
      for (const hook of hooks) await hook(explicit)
      // Without a remote libSQL URL, the hosted Definition runtime reaches D1 only.
      expect(explicit.alias).toEqual({
        "@vite-hub/database/drizzle": "/custom/database.mjs",
        "#vitehub/database/definition-defaults": "/custom/defaults.mjs",
        "#vitehub/database/definition-runtime": expect.stringMatching(/\/runtime\/d1\.(?:js|ts)$/),
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
