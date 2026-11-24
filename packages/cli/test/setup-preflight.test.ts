import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { SetupAddPlan, SetupCatalog, SetupError, SetupInitPlan, SetupMissing } from "../src/setup/index.ts"

type Result = (SetupAddPlan | SetupInitPlan) & { error?: SetupError, missing?: SetupMissing[], rerun?: string }

const flags = ["--yes", "--json"]
const init = (features: string, ...options: string[]) => ["init", "app", "--host", "node", "--features", features, ...options, ...flags]

describe("setup feature inputs", () => {
  it("lists required inputs in the catalog", async () => {
    const { json } = await runSetup<SetupCatalog>(["catalog", "--json"], await createProject())
    expect(json.features.find(feature => feature.id === "i18n")).toMatchObject({ requiredOptions: [{ option: "i18n.locales" }] })
    expect(json.features.find(feature => feature.id === "mcp")).toMatchObject({ requiredOptions: [{ option: "mcp.auth" }] })
  })

  it.each([[], ["--option", "i18n.locales=[]"], ["--option", 'i18n.locales=["en",42]'], ["--option", "i18n.locales=en"]])("requires I18n locale names before creating a project (%j)", async (...options) => {
    const root = await createProject()
    const result = await runSetup<Result>(init("i18n", ...options), root)
    expect(result.exitCode, result.stdout).toBe(2)
    expect(result.json.missing).toEqual([{ field: "i18n.locales" }])
    expect(result.json.rerun).toBeUndefined()
    expect(existsSync(join(root, "app"))).toBe(false)
  })

  it("rejects malformed JSON arrays as command arguments", async () => {
    const root = await createProject()
    const result = await runSetup<Result>(init("i18n", "--option", 'i18n.locales=["en",]'), root)
    expect(result.exitCode).toBe(1)
    expect(result.json.error?.code).toBe("CLI_R0003")
    expect(existsSync(join(root, "app"))).toBe(false)
  })

  it("keeps locale arrays and bracket-prefixed strings in init and replay", async () => {
    const root = await createProject()
    const options = [
      "--option", 'i18n.locales=["en","es-MX"]',
      "--option", "mcp.auth=false",
      "--option", "mcp.instructions=[Read-only] Search project docs.",
      "--option", 'mcp.serverInfo.name=["Docs"]',
    ]
    const result = await runSetup<SetupInitPlan>([...init("i18n,mcp", ...options), "--no-install"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.stack.command).toContain("'i18n.locales=[\"en\",\"es-MX\"]'")
    expect(result.json.stack.command).toContain("--option mcp.auth=false")
    expect(result.json.stack.command).toContain("'mcp.instructions=[Read-only] Search project docs.'")
    expect(result.json.stack.command).toContain("'mcp.serverInfo.name=[\"Docs\"]'")
    const config = await readFile(join(root, "app/vite.config.ts"), "utf8")
    expect(config).toContain('i18n: { locales: ["en", "es-MX"] }')
    expect(config).toContain('instructions: "[Read-only] Search project docs."')
    expect(config).toContain('serverInfo: { name: "[\\"Docs\\"]" }')
  })

  it.each([
    ['["en","en_US"]', "BCP 47"],
    ['["en","EN"]', "listed twice"],
  ])("rejects invalid locale lists before creating or adopting a project (%s)", async (locales, problem) => {
    const root = await createProject()
    const created = await runSetup<Result>(init("i18n", "--option", "i18n.locales=" + locales), root)
    expect(created.exitCode, created.stdout).toBe(2)
    expect(created.json.missing).toEqual([{ field: "i18n.locales" }])
    expect(created.json.error?.fix).toContain(problem)
    expect(existsSync(join(root, "app"))).toBe(false)

    const before = viteConfig('{ host: "node", i18n: { locales: ' + locales + " } }")
    const parent = await createProject({ "app/package.json": pnpmManifest, "app/vite.config.ts": before })
    const adopted = await runSetup<Result>(init("i18n"), parent)
    expect(adopted.exitCode, adopted.stdout).toBe(2)
    expect(adopted.json.missing).toEqual([{ field: "i18n.locales" }])
    expect(await readdir(join(parent, "app"))).toEqual(["package.json", "vite.config.ts"])
    expect(await readFile(join(parent, "app/vite.config.ts"), "utf8")).toBe(before)
  })

  it("keeps valid literal locales on adopt and rejects empty locales on add before writing", async () => {
    const before = viteConfig('{ host: "node", i18n: { locales: ["en", "es"] } }')
    const root = await createProject({ "app/package.json": pnpmManifest, "app/vite.config.ts": before })
    const invalid = await runSetup<Result>(init("i18n", "--option", "i18n.locales=[]"), root)
    expect(invalid.exitCode, invalid.stdout).toBe(2)
    expect(invalid.json.missing).toEqual([{ field: "i18n.locales" }])
    expect(existsSync(join(root, "app/README.md"))).toBe(false)
    const adopted = await runSetup<Result>([...init("i18n"), "--no-install"], root)
    expect(adopted.exitCode, adopted.stdout).toBe(0)
    expect(await readFile(join(root, "app/vite.config.ts"), "utf8")).toBe(before)
    const result = await runSetup<Result>(["add", "i18n", "queue", "--name", "jobs", "--option", "i18n.locales=[]", ...flags], join(root, "app"))
    expect(result.exitCode, result.stdout).toBe(2)
    expect(result.json.missing).toEqual([{ field: "i18n.locales" }])
    expect(await readFile(join(root, "app/vite.config.ts"), "utf8")).toBe(before)
    expect(existsSync(join(root, "app/server/queues/jobs.ts"))).toBe(false)
  })

  it.each(["true", "optional"])("requires Auth for MCP mode %s", async (mode) => {
    const root = await createProject()
    const result = await runSetup<Result>(init("mcp", "--option", `mcp.auth=${mode}`), root)
    expect(result.exitCode, result.stdout).toBe(2)
    expect(result.json.missing).toEqual([{ field: "auth" }])
    expect(result.json.error?.fix).toContain("mcpOAuth()")
    expect(result.json.rerun).toBeUndefined()
    expect(existsSync(join(root, "app"))).toBe(false)
  })

  it("requires a deliberate MCP auth choice before adding it without Auth", async () => {
    const before = viteConfig('{ host: "node", auth: false }')
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": before })
    const result = await runSetup<Result>(["add", "mcp", ...flags], root)
    expect(result.exitCode, result.stdout).toBe(2)
    expect(result.json.missing).toEqual([{ choices: ["true", "optional", "false"], field: "mcp.auth" }])
    expect(result.json.error?.fix).toContain("anyone")
    expect(result.json.rerun).toBeUndefined()
    expect(await readdir(root)).toEqual(["package.json", "vite.config.ts"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(before)
  })

  it.each([
    ['{ host: "node", mcp: { publicRoute: "/mcp/public" } }', "mcp.auth=false"],
    ['{ host: "node", auth: true, mcp: { auth: "optional" } }', "publicRoute=/mcp/public"],
  ])("rejects a public route on an unsigned or optional MCP endpoint (%s)", async (config, option) => {
    const before = viteConfig(config)
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": before })
    const result = await runSetup<Result>(["add", "mcp", "--option", option, ...flags], root)
    expect(result.exitCode, result.stdout).toBe(2)
    expect(result.json.missing).toEqual([{ field: "mcp.publicRoute" }])
    expect(result.json.error?.fix).toContain("mcp.auth=true")
    expect(result.json.rerun).toBeUndefined()
    expect(await readdir(root)).toEqual(["package.json", "vite.config.ts"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(before)
  })

  it("uses the runtime MCP default with an existing Auth Definition and names that file", async () => {
    const root = await createProject({
      "nuxt.config.ts": 'export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], serverDir: "backend", vitehub: { host: "node" } })',
      "package.json": pnpmManifest,
      "backend/auth.mts": "throw new Error('Do not evaluate Definitions in setup')",
    })
    const result = await runSetup<SetupAddPlan>(["add", "mcp", "--no-install", ...flags], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.nextSteps).toEqual(expect.arrayContaining([expect.stringMatching(/mcpOAuth.*backend\/auth\.mts/u)]))
    expect(await readFile(join(root, "nuxt.config.ts"), "utf8")).toContain("mcp: true")
  })

  it("asks for a manual Auth check when the Auth setting is opaque", async () => {
    const before = `const enabled = () => { throw new Error("Do not evaluate config in setup") }\n${viteConfig('{ host: "node", auth: enabled() }')}`
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": before })
    const result = await runSetup<Result>(["add", "mcp", "--option", "mcp.auth=true", ...flags], root)
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_CONFIG_MANUAL")
    expect(result.json.error?.fix).toContain("Confirm Auth is enabled")
    expect(result.loadConfig).not.toHaveBeenCalled()
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(before)
  })

  it("asks for a manual Auth check when a Nuxt layer can supply the Definition", async () => {
    const before = 'export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], vitehub: { host: "node" } })'
    const root = await createProject({
      "layers/base/server/auth.ts": "throw new Error('Do not evaluate Definitions in setup')",
      "nuxt.config.ts": before,
      "package.json": pnpmManifest,
    })
    const result = await runSetup<Result>(["add", "mcp", "--option", "mcp.auth=optional", ...flags], root)
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_CONFIG_MANUAL")
    expect(result.json.error?.fix).toContain("mcpOAuth()")
    expect(result.loadConfig).not.toHaveBeenCalled()
    expect(await readFile(join(root, "nuxt.config.ts"), "utf8")).toBe(before)
  })
})
