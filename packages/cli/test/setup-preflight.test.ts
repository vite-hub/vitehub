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

  it("keeps arrays and scalar dotted options when replaying an init", async () => {
    const root = await createProject()
    const options = ["--option", 'i18n.locales=["en","es"]', "--option", "mcp.auth=false", "--option", "mcp.serverInfo.name=Test"]
    const result = await runSetup<SetupInitPlan>([...init("i18n,mcp", ...options), "--no-install"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.stack.command).toContain(`--option 'i18n.locales=["en","es"]' --option mcp.auth=false --option mcp.serverInfo.name=Test`)
    expect(await readFile(join(root, "app/vite.config.ts"), "utf8")).toMatch(/i18n: \{ locales: \["en", "es"\] \}.*mcp: \{ auth: false, serverInfo: \{ name: "Test" \} \}/u)
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

  it("does not treat an opaque Auth setting as enabled", async () => {
    const before = `const enabled = () => { throw new Error("Do not evaluate config in setup") }\n${viteConfig('{ host: "node", auth: enabled() }')}`
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": before })
    const result = await runSetup<Result>(["add", "mcp", "--option", "mcp.auth=true", ...flags], root)
    expect(result.exitCode, result.stdout).toBe(2)
    expect(result.json.missing).toEqual([{ field: "auth" }])
    expect(result.loadConfig).not.toHaveBeenCalled()
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(before)
  })
})
