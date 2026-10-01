import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { withViteStageServer } from "@vite-hub/internal/vite-stage"
import { afterEach, describe, expect, it } from "vitest"

import { createEnvCliContributor } from "../src/cli.ts"
import { isBlockingServerEnvEntry } from "../src/server.ts"
import { hubEnv } from "../src/vite.ts"

import type { ViteHubCliContext, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { EnvCliInspectInput } from "../src/cli.ts"
import type { ServerEnvInspection } from "../src/types.ts"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const secretValue = "stage-secret-value-7f3a"
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function captureContext(rootDir: string, env: NodeJS.ProcessEnv = {}) {
  const output = { stderr: "", stdout: "" }
  const context: ViteHubCliContext = {
    cwd: rootDir,
    env,
    rootDir,
    spawn: async () => ({ exitCode: 0 }),
    stderr: { write: (chunk) => { output.stderr += String(chunk) } },
    stdout: { write: (chunk) => { output.stdout += String(chunk) } },
  }
  return { context, output }
}

function feature(name: "check" | "inspect", inspect?: (input: EnvCliInspectInput) => Promise<ServerEnvInspection>): ViteHubCliFeature {
  const contributor = createEnvCliContributor({ inspect, resolveProjectRoot: root => root })
  const found = contributor.namespaces[0]?.features.find(item => item.name === name)
  if (!found) throw new Error(`Missing env ${name} feature.`)
  return found
}

const healthy: ServerEnvInspection = {
  entries: [
    { masked: true, path: "env.server.apiToken", required: true, source: "env", status: "available" },
    { masked: false, path: "env.server.region", required: true, source: "env", status: "defaulted" },
    { masked: false, path: "env.server.label", required: false, source: "env", status: "missing" },
    { masked: true, path: "env.server.remote", provider: "vault", required: true, source: "provider", status: "available" },
  ],
}

const broken: ServerEnvInspection = {
  entries: [
    { masked: true, path: "env.server.apiToken", required: true, source: "env", status: "missing" },
    { masked: false, path: "env.server.label", required: false, source: "env", status: "missing" },
  ],
}

describe("env CLI", () => {
  it("registers inspect and check under the env namespace", () => {
    const contributor = hubEnv().vitehub.cli()
    expect(contributor.namespaces.map(namespace => namespace.name)).toEqual(["env"])
    expect(contributor.namespaces[0]?.features.map(item => item.name)).toEqual(["inspect", "check"])
  })

  it("treats only failing loadServerEnv() conditions as blocking", () => {
    expect(isBlockingServerEnvEntry({ masked: false, required: false, source: "env", status: "missing" })).toBe(false)
    expect(isBlockingServerEnvEntry({ masked: false, required: true, source: "env", status: "missing" })).toBe(true)
    expect(isBlockingServerEnvEntry({ masked: false, required: false, source: "env", status: "invalid" })).toBe(true)
    expect(isBlockingServerEnvEntry({ masked: false, required: false, source: "provider", status: "error" })).toBe(true)
    expect(isBlockingServerEnvEntry({ masked: false, required: true, source: "env", status: "defaulted" })).toBe(false)
  })

  it("prints a status table and passes the selected stage", async () => {
    const inputs: EnvCliInspectInput[] = []
    const { context, output } = captureContext("/app", { KEEP: "1" })
    const exitCode = await feature("inspect", async (input) => {
      inputs.push(input)
      return healthy
    }).run(["--stage", "staging"], context)

    expect(exitCode).toBe(0)
    expect(inputs).toEqual([{ env: { KEEP: "1" }, rootDir: "/app", stage: "staging" }])
    expect(output.stdout).toContain("Server Env (stage: staging)")
    expect(output.stdout).toMatch(/apiToken\s+available\s+host env\s+yes\s+yes/)
    expect(output.stdout).toMatch(/remote\s+available\s+provider:vault\s+yes\s+yes/)
    expect(output.stdout).toContain("4 variables checked. Values are not shown.")
  })

  it("defaults to the development stage", async () => {
    const stages: string[] = []
    const { context } = captureContext("/app")
    await feature("inspect", async (input) => {
      stages.push(input.stage)
      return healthy
    }).run([], context)
    expect(stages).toEqual(["development"])
  })

  it("exits with 1 from check when a required value is missing", async () => {
    const { context, output } = captureContext("/app")
    expect(await feature("check", async () => broken).run(["--stage=production"], context)).toBe(1)
    expect(output.stdout).toMatch(/apiToken\s+missing !/)
    expect(output.stdout).toMatch(/label\s+missing\s/)
    expect(output.stdout).toContain("1 of 2 variables would make loadServerEnv() fail.")
    expect(output.stdout).toContain("Server Env check failed.")
  })

  it("exits with 0 from check when optional values are missing", async () => {
    const { context, output } = captureContext("/app")
    expect(await feature("check", async () => healthy).run([], context)).toBe(0)
    expect(output.stdout).toContain("Server Env check passed.")
  })

  it("reports problems from inspect without failing", async () => {
    const { context } = captureContext("/app")
    expect(await feature("inspect", async () => broken).run([], context)).toBe(0)
  })

  it("prints JSON with the check result", async () => {
    const { context, output } = captureContext("/app")
    expect(await feature("check", async () => broken).run(["--json", "--stage", "preview"], context)).toBe(1)
    expect(JSON.parse(output.stdout)).toEqual({ entries: broken.entries, ok: false, stage: "preview" })
  })

  it("rejects invalid arguments with usage and exit code 1", async () => {
    for (const args of [["--stage"], ["--stage", "--json"], ["--unknown"]]) {
      const { context, output } = captureContext("/app")
      expect(await feature("check", async () => healthy).run(args, context)).toBe(1)
      expect(output.stderr).toContain("Usage: vitehub env check [--stage <name>] [--json]")
      expect(output.stdout).toBe("")
    }
  })

  it("prints help without inspecting", async () => {
    const { context, output } = captureContext("/app")
    expect(await feature("inspect", async () => {
      throw new Error("must not inspect")
    }).run(["--help"], context)).toBe(0)
    expect(output.stdout).toContain("Usage: vitehub env inspect [--stage <name>] [--json]")
  })
})

async function createStageFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-env-cli-"))
  roots.push(root)
  await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
  await symlink(packageRoot, join(root, "node_modules", "@vite-hub", "env"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "env-cli-fixture", private: true, type: "module" }), "utf8")
  await mkdir(join(root, "server"), { recursive: true })
  // The provider reveals which region value won without printing it.
  await writeFile(join(root, "server", "region-provider.mjs"), [
    "import { defineEnvProvider } from \"@vite-hub/env/provider\"",
    "export default defineEnvProvider({",
    "  read: ({ env }) => ({ regionToken: env.region === \"process-region\" ? \"process-won\" : undefined }),",
    "})",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(root, "vite.config.mjs"), [
    "import { env, hubEnv } from \"@vite-hub/env/vite\"",
    "export default {",
    "  plugins: [hubEnv({ diagnostics: \"off\", providers: { region: \"./server/region-provider.mjs\" } })],",
    "  env: {",
    "    server: {",
    "      apiToken: env({ secret: true, source: env.source(\"ENV_CLI_API_TOKEN\") }),",
    "      label: env({ optional: true, source: env.source(\"ENV_CLI_LABEL\") }),",
    "      region: env({ source: env.source(\"ENV_CLI_REGION\") }),",
    "      regionToken: env({ secret: true, source: env.provider(\"region\", \"regionToken\") }),",
    "    },",
    "  },",
    "}",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(root, ".env.staging"), `ENV_CLI_API_TOKEN=${secretValue}\nENV_CLI_REGION=stage-region\n`, "utf8")
  return root
}

function realFeature(name: "check" | "inspect", projectRoot?: string): ViteHubCliFeature {
  const found = hubEnv({ projectRoot }).vitehub.cli().namespaces[0]?.features.find(item => item.name === name)
  if (!found) throw new Error(`Missing env ${name} feature.`)
  return found
}

describe("Env CLI stage regeneration for Nuxt", () => {
  it("loads Nuxt from the application root with custom Vite and Env output roots", async () => {
    const root = await createStageFixture()
    await writeFile(join(root, "nuxt.config.mjs"), "export default {}\n")
    const kitRoot = join(root, "node_modules", "nuxt")
    await mkdir(kitRoot, { recursive: true })
    await writeFile(join(kitRoot, "package.json"), JSON.stringify({ type: "module", exports: { "./kit": "./kit.mjs" } }))
    await writeFile(join(kitRoot, "kit.mjs"), [
      'import { hubEnv, env } from "@vite-hub/env/vite"',
      'export async function loadNuxt(options) {',
      `  if (options.cwd !== ${JSON.stringify(root)}) throw new Error("Incorrect application root")`,
      '  if (process.env.ENV_CLI_REGION !== "stage-region") throw new Error("Application env file not loaded")',
      '  return { close: async () => {}, options: { vite: { plugins: [hubEnv({ projectRoot: "packages/config", diagnostics: "off" })], env: { server: { [options.envName]: env({ source: env.source("ENV_CLI_API_TOKEN") }) } } } } }',
      '}',
    ].join("\n"))
    const { context, output } = captureContext(root, {})
    context.rootDir = join(root, "app")
    await mkdir(context.rootDir, { recursive: true })
    expect(await realFeature("inspect", "packages/discovery").run(["--stage", "staging", "--json"], context)).toBe(0)
    expect(JSON.parse(output.stdout)).toMatchObject({ entries: [{ path: "env.server.staging", status: "available" }], stage: "staging" })
    expect(output.stdout).not.toContain(secretValue)
  }, 60_000)

  it("keeps process precedence when the input environment is process.env itself", async () => {
    const root = await createStageFixture()
    await writeFile(join(root, "nuxt.config.mjs"), "export default {}\n")
    const kitRoot = join(root, "node_modules", "nuxt")
    await mkdir(kitRoot, { recursive: true })
    await writeFile(join(kitRoot, "package.json"), JSON.stringify({ type: "module", exports: { "./kit": "./kit.mjs" } }))
    await writeFile(join(kitRoot, "kit.mjs"), [
      'import { hubEnv, env } from "@vite-hub/env/vite"',
      'export async function loadNuxt() {',
      '  return { close: async () => {}, options: { vite: { plugins: [hubEnv({ diagnostics: "off" })], env: { server: { [process.env.ENV_CLI_REGION]: env({ source: env.source("ENV_CLI_API_TOKEN") }) } } } } }',
      '}',
    ].join("\n"))
    const previous = process.env.ENV_CLI_REGION
    process.env.ENV_CLI_REGION = "process-region"
    try {
      const { context, output } = captureContext(root, process.env)
      expect(await realFeature("inspect").run(["--stage", "staging", "--json"], context)).toBe(0)
      expect(JSON.parse(output.stdout)).toMatchObject({ entries: [{ path: "env.server.process-region" }] })
      expect(process.env.ENV_CLI_REGION).toBe("process-region")
    }
    finally {
      if (previous === undefined) delete process.env.ENV_CLI_REGION
      else process.env.ENV_CLI_REGION = previous
    }
  }, 60_000)

  it("reloads Nuxt stage declarations instead of retaining discovery output", async () => {
    const root = await createStageFixture()
    await writeFile(join(root, "nuxt.config.mjs"), "export default {}\n")
    const kitRoot = join(root, "node_modules", "nuxt")
    await mkdir(kitRoot, { recursive: true })
    await writeFile(join(kitRoot, "package.json"), JSON.stringify({ type: "module", exports: { "./kit": "./kit.mjs" } }))
    await writeFile(join(kitRoot, "kit.mjs"), [
      'import { hubEnv, env } from "@vite-hub/env/vite"',
      'export async function loadNuxt(options) {',
      '  if (!options.overrides.vitehubCliDiscovery || options.overrides.vite.mode !== options.envName) throw new Error("Incorrect Nuxt stage")',
      '  return { close: async () => {}, options: { vite: { plugins: [hubEnv({ diagnostics: "off" })], env: { server: { [options.envName]: env({ source: env.source("ENV_CLI_API_TOKEN") }) } } } } }',
      '}',
    ].join("\n"))
    for (const stage of ["development", "production"]) {
      const { context, output } = captureContext(root, { ENV_CLI_API_TOKEN: secretValue })
      expect(await realFeature("inspect").run(["--stage", stage, "--json"], context)).toBe(0)
      expect(JSON.parse(output.stdout)).toMatchObject({ entries: [{ path: `env.server.${stage}` }], stage })
      expect(output.stdout).not.toContain(secretValue)
    }
  }, 60_000)
})

describe("env CLI with Vite stage files", () => {
  it("loads the module generated by a stage-specific Env project root", async () => {
    const root = await createStageFixture()
    await writeFile(join(root, "vite.config.mjs"), [
      'import { env, hubEnv } from "@vite-hub/env/vite"',
      'export default ({ mode }) => ({ plugins: [hubEnv({ projectRoot: mode === "production" ? "prod" : "dev", diagnostics: "off" })], env: { server: { [mode]: env({ source: env.source("ENV_CLI_API_TOKEN") }) } } })',
    ].join("\n"))
    const { context, output } = captureContext(root, { ENV_CLI_API_TOKEN: secretValue })
    expect(await realFeature("inspect").run(["--stage", "production", "--json"], context)).toBe(0)
    expect(JSON.parse(output.stdout)).toMatchObject({ entries: [{ path: "env.server.production" }] })
  }, 60_000)

  it("loads stage files, lets process env win, and never prints values", async () => {
    const root = await createStageFixture()
    const before = { ...process.env }

    const human = captureContext(root, { ...process.env, ENV_CLI_REGION: "process-region" })
    expect(await realFeature("check").run(["--stage", "staging"], human.context)).toBe(0)
    expect(human.output.stdout).toMatch(/apiToken\s+available\s+host env\s+yes\s+yes/)
    expect(human.output.stdout).toMatch(/region\s+available\s+host env\s+yes\s+no/)
    expect(human.output.stdout).toMatch(/regionToken\s+available\s+provider:region\s+yes\s+yes/)
    expect(human.output.stdout).toMatch(/label\s+missing\s+host env\s+no\s+no/)

    const json = captureContext(root, { ...process.env, ENV_CLI_REGION: "process-region" })
    expect(await realFeature("inspect").run(["--stage", "staging", "--json"], json.context)).toBe(0)
    expect(JSON.parse(json.output.stdout)).toMatchObject({ ok: true, stage: "staging" })

    for (const text of [human.output.stdout, human.output.stderr, json.output.stdout, json.output.stderr]) {
      expect(text).not.toContain(secretValue)
      expect(text).not.toContain("process-region")
      expect(text).not.toContain("stage-region")
      expect(text).not.toContain("process-won")
    }
    expect(process.env).toEqual(before)
  }, 60_000)

  it("uses stage values when the process does not set them", async () => {
    const root = await createStageFixture()
    const { context, output } = captureContext(root, { ...process.env })
    expect(await realFeature("check").run(["--stage", "staging", "--json"], context)).toBe(1)
    const report: { entries: Array<{ path?: string, status: string }>, ok: boolean } = JSON.parse(output.stdout)
    expect(report.ok).toBe(false)
    // The stage file provides the region, so the provider does not see the process value.
    expect(report.entries.find(entry => entry.path === "env.server.region")?.status).toBe("available")
    expect(report.entries.find(entry => entry.path === "env.server.regionToken")?.status).toBe("missing")
  }, 60_000)

  it("fails check for a stage without env files", async () => {
    const root = await createStageFixture()
    const { context, output } = captureContext(root, { ...process.env })
    expect(await realFeature("check").run(["--stage", "production"], context)).toBe(1)
    expect(output.stdout).toMatch(/apiToken\s+missing !/)
    expect(output.stdout).toContain("Server Env check failed.")
  }, 60_000)

  it("restores process env after the stage server closes", async () => {
    const root = await createStageFixture()
    const before = { ...process.env }
    const seen = await withViteStageServer(await import("vite"), {
      env: { ...process.env, ENV_CLI_REGION: "process-region" },
      rootDir: root,
      stage: "staging",
    }, async () => ({ region: process.env.ENV_CLI_REGION, token: process.env.ENV_CLI_API_TOKEN }))
    expect(seen).toEqual({ region: "process-region", token: secretValue })
    expect(process.env).toEqual(before)
  }, 60_000)
})
