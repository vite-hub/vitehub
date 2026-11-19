import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatMigrationReport, formatReport, runCodemod, runMigration } from "../src/index.ts"
import { pageRoute, ruleFor } from "../src/nuxt-better-auth/pages.ts"
import { withVersionPlaceholder } from "./fixture-version.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/nuxt-better-auth-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function createApp(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [file, code] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, file)), { recursive: true })
    await writeFile(join(cwd, file), code)
  }
  return cwd
}

const serverConfig = "import { defineServerAuth } from '@nuxtjs/better-auth/config'\n\nexport default defineServerAuth({ emailAndPassword: { enabled: true } })\n"

describe("nuxt-better-auth", () => {
  it("migrates the Auth configs, route rules, pages, server helpers, and a layer", async () => {
    const input = join(fixtures, "nuxt-better-auth", "input")
    const run = await runCodemod("nuxt-better-auth", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      if (edit.after !== null) await expect(withVersionPlaceholder(edit.after)).toMatchFileSnapshot(join(fixtures, "nuxt-better-auth", "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "nuxt-better-auth", "output", "report.txt"))
  })

  it("runs after nuxthub in a full migration, and a second run finds nothing", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "migrate-"))
    await cp(join(fixtures, "nuxt-better-auth", "input"), cwd, { recursive: true })
    const found = await detectCodemods(cwd)
    expect(found.map(entry => entry.codemod.name)).toEqual(["nuxthub", "nuxt-better-auth"])
    const migration = await runMigration({ cwd })
    expect(migration.steps.map(step => step.error ?? "ok")).toEqual(["ok", "ok"])
    expect(await readFile(join(cwd, "server/auth.ts"), "utf8")).toContain("database: authDatabase()")
    expect(formatMigrationReport(migration)).toContain("moved 1 Auth config to server/auth.ts")
    expect(await detectCodemods(cwd)).toEqual([])
  })

  it("detects the module in a local layer only", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({\n  extends: ['./base'],\n})\n",
      "base/nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'] })\n",
      "base/server/auth.config.ts": serverConfig,
    })
    const run = await runCodemod("nuxt-better-auth", { cwd, dryRun: true })
    const paths = run.result.edits.map(edit => `${edit.path}${edit.after === null ? " (deleted)" : ""}`)
    expect(paths).toEqual(expect.arrayContaining(["nuxt.config.ts", "base/nuxt.config.ts", "base/server/auth.config.ts (deleted)", "base/server/auth.ts"]))
    expect(run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after).toContain("modules: ['vite-hub/nuxt'],")
    expect(run.result.edits.find(edit => edit.path === "base/nuxt.config.ts")?.after).not.toContain("better-auth")
  })

  it("rewrites a callback context identifier and keeps requestOrigin", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'], vitehub: { host: 'node', database: true } })\n",
      "server/auth.config.ts": "export default defineServerAuth((ctx) => ({\n  appName: ctx.runtimeConfig.public.appName,\n  trustedOrigins: [ctx.requestOrigin],\n}))\n",
    })
    const run = await runCodemod("nuxt-better-auth", { cwd, dryRun: true })
    const definition = run.result.edits.find(edit => edit.path === "server/auth.ts")?.after
    expect(definition).toBe([
      "import { defineAuth } from \"vite-hub/auth\"",
      "import { useRuntimeConfig } from \"nitro/runtime-config\"",
      "import { authDatabase } from \"vite-hub/auth/database\"",
      "",
      "export default defineAuth((ctx) => ({",
      "  database: authDatabase(),",
      "  appName: useRuntimeConfig().public.appName,",
      "  trustedOrigins: [ctx.requestOrigin],",
      "}))",
      "",
    ].join("\n"))
  })

  it("stops without edits when no server config can move", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'] })\n",
      "server/auth.config.ts": "export default createConfig()\n",
    })
    await expect(runCodemod("nuxt-better-auth", { cwd, dryRun: true })).rejects.toThrow("No server/auth.config.ts with defineServerAuth() could be moved")
  })
})

describe("nuxt-better-auth route matching", () => {
  it.each([
    ["index.vue", "/"],
    ["dashboard/index.vue", "/dashboard"],
    ["dashboard/[id].vue", "/dashboard/:id"],
    ["(marketing)/about.vue", "/about"],
    ["docs/[...slug].vue", "/docs/**"],
  ])("maps %s to %s", (file, route) => {
    expect(pageRoute(file)).toBe(route)
  })

  it("picks the most specific rule, as Nitro route rules do", () => {
    const rule = (pattern: string) => ({ pattern, meta: pattern, user: true, server: false })
    const rules = [rule("/**"), rule("/app/**"), rule("/app/public")]
    expect(ruleFor(rules, "/")?.pattern).toBe("/**")
    expect(ruleFor(rules, "/app")?.pattern).toBe("/app/**")
    expect(ruleFor(rules, "/app/:id")?.pattern).toBe("/app/**")
    expect(ruleFor(rules, "/app/public")?.pattern).toBe("/app/public")
    expect(ruleFor([rule("/app")], "/app/settings")).toBeUndefined()
  })
})
