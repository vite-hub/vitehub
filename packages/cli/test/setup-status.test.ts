import { describe, expect, it } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupError, SetupFeatureStatus, SetupStatus } from "../src/setup/index.ts"

function feature(status: SetupStatus, id: SetupFeatureStatus["id"]): SetupFeatureStatus {
  return status.features.find(item => item.id === id)!
}

describe("vitehub status", () => {
  it("reads the host from config without loading it", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      // Running this config would set the flag and throw.
      "vite.config.ts": `globalThis.__vitehubEvaluated = true\nthrow new Error("boom")\n${viteConfig(`{ preset: "cloudflare", kv: true }`)}`,
    })

    const { exitCode, json, loadConfig, stderr } = await runSetup<SetupStatus>(["status", "--json"], root)

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(loadConfig).not.toHaveBeenCalled()
    expect(Reflect.get(globalThis, "__vitehubEvaluated")).toBeUndefined()
    expect(json).toMatchObject({
      config: { file: "vite.config.ts", form: "vite-call" },
      framework: "vite",
      host: { name: "cloudflare", source: "config" },
      packageManager: "pnpm",
      schemaVersion: 1,
    })
    expect(feature(json, "kv")).toMatchObject({ enabled: "on", reason: "config", support: { adapter: "cloudflare-kv-binding", level: "native" } })
  })

  it("reads the host from the Nuxt module tuple", async () => {
    const root = await createProject({
      "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: [["vite-hub/nuxt", { preset: "vercel" }]],\n})\n`,
      "package.json": pnpmManifest,
    })

    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)

    expect(json).toMatchObject({ config: { file: "nuxt.config.ts", form: "nuxt-module-tuple" }, framework: "nuxt", host: { name: "vercel", source: "config" } })
  })

  it("falls back to detectPreset, then node", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ kv: true }") })

    expect((await runSetup<SetupStatus>(["status", "--json"], root, { NETLIFY: "true" })).json.host).toEqual({ name: "netlify", source: "env" })
    expect((await runSetup<SetupStatus>(["status", "--json"], root, { NITRO_PRESET: "cloudflare_module" })).json.host).toEqual({ name: "cloudflare", source: "env" })
    expect((await runSetup<SetupStatus>(["status", "--json"], root)).json.host).toEqual({ name: "node", source: "default" })
  })

  it.each([`{ preset: process.env.DEPLOY_TARGET, agent: true }`, `{ preset: "vercel", ...shared, agent: true }`])("keeps a dynamic host unknown: %s", async (options) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(options) })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root, { NETLIFY: "true" })
    expect(json.host).toEqual({ name: "unknown", source: "config" })
    expect(feature(json, "agent").support).toMatchObject({ level: "unknown" })
    expect(feature(json, "workflow")).toMatchObject({ enabled: "unknown" })
    const human = await runSetup(["status"], root)
    expect(human.stdout).toContain("unknown (config)")
  })

  it.each(["cts", "cjs"])("reads merged Nuxt options in nuxt.config.%s", async (extension) => {
    const root = await createProject({
      [`nuxt.config.${extension}`]: `export default defineNuxtConfig({ modules: [["vite-hub/nuxt", { preset: "vercel", kv: false }]], vitehub: { preset: "node", kv: true, queue: true } })`,
      "package.json": pnpmManifest,
    })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(json).toMatchObject({ config: { file: `nuxt.config.${extension}`, form: "nuxt-module-tuple" }, framework: "nuxt", host: { name: "vercel", source: "config" } })
    expect(feature(json, "kv")).toMatchObject({ enabled: "off", reason: "config" })
    expect(feature(json, "queue")).toMatchObject({ enabled: "on", reason: "config" })
  })

  it("discovers Comments and its Database unless explicitly disabled", async () => {
    for (const disabled of [false, true]) {
      const root = await createProject({
        "package.json": pnpmManifest,
        "server/comments.ts": `throw new Error("must not load discovery files")`,
        "vite.config.ts": viteConfig(disabled ? "{ comments: false }" : "{}"),
      })
      const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
      expect(feature(json, "comments")).toMatchObject({ enabled: disabled ? "off" : "on", reason: disabled ? "config" : "default" })
      expect(feature(json, "database").enabled).toBe(disabled ? "off" : "on")
      if (!disabled) expect(feature(json, "database").missingPackages).toContain("@vite-hub/database")
    }
  })

  it.each([
    ["{ agent: process.env.AGENT === '1' }", "workflow", "unknown"],
    ["{ agent: process.env.AGENT === '1', preset: 'netlify' }", "workflow", "off"],
    ["{ console: process.env.CONSOLE === '1' }", "comments", "unknown"],
    ["{ console: process.env.CONSOLE === '1' }", "database", "unknown"],
    ["{ console: process.env.CONSOLE === '1', comments: false }", "database", "off"],
    ["{ console: process.env.CONSOLE === '1', database: false }", "database", "off"],
    ["{ kv: true, ...shared }", "kv", "unknown"],
    ["{ ...shared, kv: true }", "kv", "on"],
  ] as const)("propagates only possible implications: %s / %s", async (options, id, enabled) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(options) })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(feature(json, id).enabled).toBe(enabled)
  })

  it("reports factored plugin calls as manual instead of absent", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": `import { vitehub } from "vite-hub"\nconst plugin = vitehub({ kv: true }); export default { plugins: [plugin] }`,
    })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(json.config).toMatchObject({ manual: "dynamic-options" })
    expect(feature(json, "kv").enabled).toBe("unknown")
  })

  it("lists the install command for a missing owner package", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ schedule: true, database: true }") })

    const missing = (await runSetup<SetupStatus>(["status", "--json"], root)).json
    expect(feature(missing, "schedule")).toMatchObject({ fix: "pnpm add @vite-hub/schedule", missingPackages: ["@vite-hub/schedule"] })
    expect(feature(missing, "database")).toMatchObject({
      fix: "pnpm add @vite-hub/database drizzle-orm && pnpm add -D drizzle-kit",
      missingPackages: ["@vite-hub/database", "drizzle-orm", "drizzle-kit"],
    })

    // drizzle-orm has no `./package.json` export, so the check reads the folder instead of resolving the package.
    const installed = await createProject({
      "node_modules/@vite-hub/schedule/package.json": "{}",
      "node_modules/drizzle-orm/package.json": JSON.stringify({ exports: { ".": "./index.js" }, name: "drizzle-orm" }),
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig("{ schedule: true, database: true }"),
    })
    const found = (await runSetup<SetupStatus>(["status", "--json"], installed)).json
    expect(feature(found, "schedule").missingPackages).toEqual([])
    expect(feature(found, "schedule").fix).toBeUndefined()
    expect(feature(found, "database").missingPackages).toEqual(["@vite-hub/database", "drizzle-kit"])
  })

  it("reports env on by default and workflow implied by agent, except on Netlify", async () => {
    const node = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ agent: true }") })
    const status = (await runSetup<SetupStatus>(["status", "--json"], node)).json
    expect(feature(status, "env")).toMatchObject({ enabled: "on", reason: "default" })
    expect(feature(status, "workflow")).toMatchObject({ enabled: "on", reason: "implied" })
    expect(feature(status, "kv")).toMatchObject({ enabled: "off", reason: "default" })

    const netlify = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "netlify", agent: true }`) })
    expect(feature((await runSetup<SetupStatus>(["status", "--json"], netlify)).json, "workflow")).toMatchObject({ enabled: "off", reason: "default" })

    const disabled = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ agent: true, workflow: false, env: false }") })
    const off = (await runSetup<SetupStatus>(["status", "--json"], disabled)).json
    expect(feature(off, "workflow")).toMatchObject({ enabled: "off", reason: "config" })
    expect(feature(off, "env")).toMatchObject({ enabled: "off", reason: "config" })
  })

  it("reports unknown for a non-literal option and exits 0", async () => {
    const expression = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ kv: process.env.KV === "1" }`) })
    const run = await runSetup<SetupStatus>(["status", "--json"], expression)
    expect(run.exitCode).toBe(0)
    expect(feature(run.json, "kv")).toMatchObject({ enabled: "unknown", reason: "config", missingPackages: [] })

    const dynamic = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": `import { vitehub } from "vite-hub"\nconst options = { kv: true }\nexport default { plugins: [vitehub(options)] }\n`,
    })
    const manual = await runSetup<SetupStatus>(["status", "--json"], dynamic)
    expect(manual.exitCode).toBe(0)
    expect(manual.json.config).toEqual({ file: "vite.config.ts", line: 3, manual: "dynamic-options" })
    expect(feature(manual.json, "kv")).toMatchObject({ enabled: "unknown", reason: "config" })

    const human = await runSetup(["status"], dynamic)
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toMatch(/^config +vite\.config\.ts:3: manual \(dynamic-options\)$/mu)
  })

  it("returns SETUP_NOT_A_PROJECT with exit 1 without package.json", async () => {
    const root = await createProject()

    const { exitCode, json, stderr } = await runSetup<{ schemaVersion: number, error: SetupError }>(["status", "--json"], root)

    expect(exitCode).toBe(1)
    expect(stderr).toBe("")
    expect(json).toEqual({
      error: {
        code: "SETUP_NOT_A_PROJECT",
        docs: "https://vitehub.dev/docs/development/cli#setup_not_a_project",
        fix: "Run the command in the folder of your Vite or Nuxt app, where its package.json is.",
        message: `${root} has no package.json, vite.config, or nuxt.config file.`,
        why: `${root} has no package.json, vite.config, or nuxt.config file.`,
      },
      schemaVersion: 1,
    })

    const human = await runSetup(["status"], root)
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toBe("")
    expect(human.stderr).toContain("SETUP_NOT_A_PROJECT")
  })
})
