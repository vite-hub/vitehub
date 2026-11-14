import { registerHooks } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupError, SetupFeatureStatus, SetupStatus } from "../src/setup/index.ts"

function feature(status: SetupStatus, id: SetupFeatureStatus["id"]): SetupFeatureStatus {
  return status.features.find(item => item.id === id)!
}

describe("vitehub status", () => {
  it.each([
    '{ sqlite: { runMigrations: true } }',
    '{ postgres: { schema: "custom" } }',
    '{ sqlite: { path: "   " } }',
    '{ postgres: { url: "" } }',
  ])("keeps partial Workflow storage options on the inline provider (%s)", async (options) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", workflow: ${options} }`) })
    const { exitCode, json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(exitCode).toBe(0)
    expect(feature(json, "workflow").missingPackages).toEqual(["@vite-hub/workflow"])
    expect(feature(json, "workflow").fix).toBe("pnpm add @vite-hub/workflow")
  })

  it.each([
    ["workflow", '{ provider: "openworkflow" }', ["openworkflow"]],
    ["workflow", '{ sqlite: { path: ".data/workflows.db" } }', ["openworkflow"]],
    ["workflow", '{ postgres: { url: "postgres://localhost/workflows" } }', ["openworkflow"]],
    ["workflow", '{ postgres: { url: { kind: "env-variable", source: { kind: "env", name: "DATABASE_URL" } } } }', ["openworkflow"]],
    ["blob", '{ driver: "s3", bucket: "assets" }', ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-presigned-post", "@aws-sdk/s3-request-presigner"]],
    ["blob", '{ stores: { default: { driver: "s3", bucket: "assets" } } }', ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-presigned-post", "@aws-sdk/s3-request-presigner"]],
  ] as const)("reports missing provider packages for %s: %s", async (id, options, packages) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", ${id}: ${options} }`) })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(feature(json, id).missingPackages).toEqual(expect.arrayContaining([...packages]))
    for (const name of packages) expect(feature(json, id).fix).toContain(name)
  })

  it("reads the host from config without loading it", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      // Running this config would set the flag and throw.
      "vite.config.ts": `globalThis.__vitehubEvaluated = true\nthrow new Error("boom")\n${viteConfig(`{ host: "cloudflare", kv: true }`)}`,
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

  it.each([
    'import * as hub from "vite-hub"; export default { plugins: [hub.vitehub({ kv: true })] }',
    'import { vitehub } from "vite-hub"; const config = { plugins: [vitehub({ kv: true })] }; export { config as default }',
  ])("reports configured features with alternate ESM syntax: %s", async (code) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": code })
    const { json, loadConfig } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(json.config).toMatchObject({ file: "vite.config.ts", form: "vite-call" })
    expect(feature(json, "kv")).toMatchObject({ enabled: "on", reason: "config" })
    expect(loadConfig).not.toHaveBeenCalled()
  })

  it("reads the host from the Nuxt module tuple", async () => {
    const root = await createProject({
      "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: [["vite-hub/nuxt", { host: "vercel" }]],\n})\n`,
      "package.json": pnpmManifest,
    })

    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)

    expect(json).toMatchObject({ config: { file: "nuxt.config.ts", form: "nuxt-module-tuple" }, framework: "nuxt", host: { name: "vercel", source: "config" } })
  })

  it("falls back to detectHost, then node", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ kv: true }") })

    expect((await runSetup<SetupStatus>(["status", "--json"], root, { NETLIFY: "true" })).json.host).toEqual({ name: "netlify", source: "env" })
    expect((await runSetup<SetupStatus>(["status", "--json"], root, { NITRO_PRESET: "cloudflare_module" })).json.host).toEqual({ name: "cloudflare", source: "env" })
    expect((await runSetup<SetupStatus>(["status", "--json"], root)).json.host).toEqual({ name: "node", source: "default" })
  })

  it.each([`{ host: process.env.DEPLOY_TARGET, agent: true }`, `{ host: "vercel", ...shared, agent: true }`])("keeps a dynamic host unknown: %s", async (options) => {
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
      [`nuxt.config.${extension}`]: `export default defineNuxtConfig({ modules: [["vite-hub/nuxt", { host: "vercel", kv: false }]], vitehub: { host: "node", kv: true, queue: true } })`,
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
    ["backend", "backend/comments.ts", "on"],
    ["backend", "server/comments.ts", "off"],
    ["", "server/comments.ts", "on"],
  ])("discovers Nuxt Comments only in serverDir %j: %s", async (serverDir, file, enabled) => {
    const root = await createProject({
      [file]: `throw new Error("must not load discovery files")`,
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], serverDir: ${JSON.stringify(serverDir)} })`,
      "package.json": pnpmManifest,
    })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(feature(json, "comments")).toMatchObject({ enabled, reason: "default" })
    expect(feature(json, "database")).toMatchObject({ enabled, reason: enabled === "on" ? "implied" : "default" })
    if (enabled === "on") expect(feature(json, "database").missingPackages).toContain("@vite-hub/database")
  })

  it.each([
    [`serverDir: process.env.SERVER_DIR`, {}],
    [`extends: ["./base"]`, { "base/nuxt.config.ts": "export default {}", "base/server/comments.ts": "export default {}" }],
    ["", { "layers/base/nuxt.config.ts": "export default {}", "layers/base/server/comments.ts": "export default {}" }],
  ])("keeps unresolved Nuxt discovery unknown: %s", async (options, files) => {
    const root = await createProject({
      ...files,
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${options} })`,
      "package.json": pnpmManifest,
    })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(feature(json, "comments").enabled).toBe("unknown")
    expect(feature(json, "database").enabled).toBe("unknown")
    expect(feature(json, "kv").enabled).toBe("off")
  })

  it("keeps explicit false authoritative with unresolved Nuxt discovery", async () => {
    const root = await createProject({
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], serverDir: process.env.SERVER_DIR, vitehub: { comments: false } })`,
      "package.json": pnpmManifest,
    })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(feature(json, "comments")).toMatchObject({ enabled: "off", reason: "config" })
    expect(feature(json, "database").enabled).toBe("off")
  })

  it.each<Record<string, string>>([
    { "nuxt.config.ts": `export default defineNuxtConfig({ extends: ["./base"] })`, "base/nuxt.config.ts": `export default { modules: ["vite-hub/nuxt"], vitehub: { kv: true } }` },
    { "nuxt.config.ts": `export default defineNuxtConfig({})`, "layers/base/nuxt.config.ts": `export default { modules: ["vite-hub/nuxt"], vitehub: { kv: true } }` },
    { "nuxt.config.ts": `export default defineNuxtConfig({ modules: [...(enabled ? ["vite-hub/nuxt"] : [])] })` },
    { "vite.config.ts": `import { vitehub } from "vite-hub"; export default { plugins: enabled ? [vitehub({ kv: true })] : [] }` },
  ])("keeps unresolved plugin registration unknown: %j", async (files) => {
    const root = await createProject({ ...files, "package.json": pnpmManifest })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(json.config).toMatchObject({ manual: "dynamic-options" })
    expect(feature(json, "kv")).toMatchObject({ enabled: "unknown", reason: "config" })
    expect(json.host.name).toBe("unknown")
  })

  it.each(["vite", "nuxt"])("reports CommonJS %s config as manual instead of absent", async (framework) => {
    const root = await createProject({
      [`${framework}.config.cjs`]: framework === "vite"
        ? `const { vitehub } = require("vite-hub"); module.exports = { plugins: [vitehub({ kv: true })] }`
        : `module.exports = { modules: ["vite-hub/nuxt"], vitehub: { kv: true } }`,
      "package.json": pnpmManifest,
    })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(json.config).toMatchObject({ manual: "dynamic-options" })
    expect(json.host.name).toBe("unknown")
    expect(feature(json, "kv")).toMatchObject({ enabled: "unknown", reason: "config" })
  })

  it.each([
    ['modules: ["vite-hub/nuxt"], vitehub: { kv: true }, ...shared', "unknown"],
    ['...shared, modules: ["vite-hub/nuxt"], vitehub: { kv: true }', "on"],
  ])("preserves Nuxt root spread precedence: %s", async (properties, enabled) => {
    const root = await createProject({
      "nuxt.config.ts": `export default defineNuxtConfig({ ${properties} })`,
      "package.json": pnpmManifest,
    })
    const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
    expect(feature(json, "kv")).toMatchObject({ enabled, reason: "config" })
    if (enabled === "unknown") {
      expect(json.config).toMatchObject({ manual: "spread" })
      expect(json.host.name).toBe("unknown")
    }
  })

  it("uses the active package resolver for dependencies outside node_modules", async () => {
    const root = await createProject({
      ".yarn/cache/schedule/index.cjs": `throw new Error("must not load installed packages")`,
      "package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }),
      "vite.config.ts": viteConfig("{ schedule: true }"),
    })
    // Yarn PnP installs a resolver hook; use Node's hook API to exercise that boundary.
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@vite-hub/schedule" && context.parentURL === pathToFileURL(join(root, "package.json")).href) {
          return { shortCircuit: true, url: pathToFileURL(join(root, ".yarn/cache/schedule/index.cjs")).href }
        }
        return nextResolve(specifier, context)
      },
    })
    try {
      const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
      expect(json.packageManager).toBe("yarn")
      expect(feature(json, "schedule").missingPackages).toEqual([])
      expect(feature(json, "schedule").fix).toBeUndefined()
    }
    finally {
      hooks.deregister()
    }
  })

  it("excludes packages resolved only through NODE_PATH", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ schedule: true }") })
    const global = await createProject({
      "node_modules/@vite-hub/schedule/package.json": JSON.stringify({ name: "@vite-hub/schedule", main: "index.cjs" }),
      "node_modules/@vite-hub/schedule/index.cjs": `throw new Error("must not load global packages")`,
    })
    vi.stubEnv("NODE_PATH", join(global, "node_modules"))
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === pathToFileURL(join(root, "package.json")).href && (specifier === "@vite-hub/schedule" || specifier === "@vite-hub/schedule/package.json")) {
          const file = specifier.endsWith("/package.json") ? "package.json" : "index.cjs"
          return { shortCircuit: true, url: pathToFileURL(join(global, "node_modules/@vite-hub/schedule", file)).href }
        }
        return nextResolve(specifier, context)
      },
    })
    try {
      const { json } = await runSetup<SetupStatus>(["status", "--json"], root)
      expect(feature(json, "schedule").missingPackages).toEqual(["@vite-hub/schedule"])
    }
    finally {
      hooks.deregister()
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ["{ agent: process.env.AGENT === '1' }", "workflow", "unknown"],
    ["{ agent: process.env.AGENT === '1', host: 'netlify' }", "workflow", "off"],
    ["{ console: true }", "comments", "off"],
    ["{ comments: process.env.COMMENTS === '1' }", "database", "unknown"],
    ["{ comments: process.env.COMMENTS === '1', database: false }", "database", "off"],
    ["{ console: process.env.CONSOLE === '1' }", "comments", "off"],
    ["{ console: process.env.CONSOLE === '1' }", "database", "off"],
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
    // drizzle-orm has no `./package.json` export, so the check reads the folder instead of resolving the package.
    const installed = await createProject({
      "node_modules/@vite-hub/schedule/package.json": "{}",
      "node_modules/drizzle-orm/package.json": JSON.stringify({ exports: { ".": "./index.js" }, name: "drizzle-orm" }),
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig("{ schedule: true, database: true }"),
    })
    const issuers = new Set([root, installed].map(directory => pathToFileURL(join(directory, "package.json")).href))
    const packageDirs = [root, installed].map(directory => `${pathToFileURL(join(directory, "node_modules")).href}/`)
    // CI's NODE_PATH can expose workspace dependencies to otherwise empty fixtures.
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context)
        if (issuers.has(context.parentURL ?? "") && !packageDirs.some(directory => result.url.startsWith(directory))) throw new Error("Package is outside the test fixture")
        return result
      },
    })
    try {
      const missing = (await runSetup<SetupStatus>(["status", "--json"], root)).json
      expect(feature(missing, "schedule")).toMatchObject({ fix: "pnpm add @vite-hub/schedule", missingPackages: ["@vite-hub/schedule"] })
      expect(feature(missing, "database")).toMatchObject({
        fix: "pnpm add @vite-hub/database drizzle-orm && pnpm add -D drizzle-kit",
        missingPackages: ["@vite-hub/database", "drizzle-orm", "drizzle-kit"],
      })

      const found = (await runSetup<SetupStatus>(["status", "--json"], installed)).json
      expect(feature(found, "schedule").missingPackages).toEqual([])
      expect(feature(found, "schedule").fix).toBeUndefined()
      expect(feature(found, "database").missingPackages).toEqual(["@vite-hub/database", "drizzle-kit"])
    }
    finally {
      hooks.deregister()
    }
  })

  it("reports env on by default and workflow implied by agent, except on Netlify", async () => {
    const node = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig("{ agent: true }") })
    const status = (await runSetup<SetupStatus>(["status", "--json"], node)).json
    expect(feature(status, "env")).toMatchObject({ enabled: "on", reason: "default" })
    expect(feature(status, "workflow")).toMatchObject({ enabled: "on", reason: "implied" })
    expect(feature(status, "kv")).toMatchObject({ enabled: "off", reason: "default" })

    const netlify = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "netlify", agent: true }`) })
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
        docs: "https://vitehub.dev/docs/cli/diagnostics/setup_not_a_project",
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
