import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { describe, expect, it, onTestFinished } from "vitest"
import { resolve } from "pathe"
import { collectViteHubProviderOutputEntries } from "@vite-hub/internal/inspect"
import { createDefaultVercelOutputRoot } from "@vite-hub/internal/build/deployment-output"

import { normalizeWorkflowOptions } from "../src/config.ts"
import { createCloudflareWorkflowBindings, getCloudflareWorkflowBindingName, getCloudflareWorkflowClassName, getCloudflareWorkflowName, getLegacyCloudflareWorkflowClassName } from "../src/integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../src/integrations/vercel.ts"
import { hubWorkflow } from "../src/vite.ts"

async function resolvePlugin(plugin: ReturnType<typeof hubWorkflow>) {
  const root = await mkdtemp(resolve(tmpdir(), "vitehub-workflow-config-"))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  await (plugin.configResolved as (config: unknown) => Promise<void>)({ root })
}

describe("workflow config", () => {
  it("inspects the standalone Vercel function without a Nitro function name", async () => {
    const entries = await collectViteHubProviderOutputEntries([hubWorkflow({ driver: "vercel" })])
    expect(entries).toEqual([{
      description: "Generated Vercel Workflow function",
      owner: "workflow",
      path: resolve(createDefaultVercelOutputRoot(process.cwd()), "functions/__server.func/index.mjs"),
    }])
  })

  it("serializes shared Provider Output finalization", () => {
    expect(hubWorkflow().closeBundle).toMatchObject({ order: "post", sequential: true })
  })

  it("infers cloudflare from hosting", () => {
    expect(normalizeWorkflowOptions({}, { hosting: "cloudflare-module" })).toEqual({
      driver: "cloudflare",
    })
  })

  it("infers cloudflare from hosting without workflow options", () => {
    expect(normalizeWorkflowOptions(undefined, { hosting: "cloudflare-module" })).toEqual({
      driver: "cloudflare",
    })
  })

  it("defaults to vercel", () => {
    expect(normalizeWorkflowOptions(undefined)).toEqual({
      driver: "vercel",
    })
  })

  it("does not infer Vercel for Netlify hosting", () => {
    expect(() => normalizeWorkflowOptions(undefined, { hosting: "netlify" })).toThrow(/cannot be inferred for Netlify/)
    expect(normalizeWorkflowOptions({ driver: "vercel" }, { hosting: "netlify" })).toEqual({ driver: "vercel" })
  })

  it("does not infer openworkflow from node hosting without Postgres config", () => {
    expect(normalizeWorkflowOptions(undefined, { hosting: "node-server" })).toEqual({
      driver: "vercel",
    })
  })

  it("infers openworkflow from node hosting with Postgres config", () => {
    expect(normalizeWorkflowOptions({
      postgres: {
        url: "postgres://localhost/vitehub",
      },
      worker: { concurrency: 2 },
    }, { hosting: "node-server" })).toEqual({
      postgres: {
        url: "postgres://localhost/vitehub",
      },
      driver: "openworkflow",
      worker: { concurrency: 2 },
    })
  })

  it("infers openworkflow from node hosting with SQLite config", () => {
    expect(normalizeWorkflowOptions({
      sqlite: {
        path: ".data/workflow.sqlite",
      },
    }, { hosting: "node-server" })).toEqual({
      driver: "openworkflow",
      sqlite: {
        path: ".data/workflow.sqlite",
      },
    })
  })

  it("preserves SQLite filenames and trims Postgres URLs while rejecting blank values", () => {
    const sqlite = { path: " workflow.sqlite " }
    const postgres = { url: " postgres://localhost/workflow " }
    expect(normalizeWorkflowOptions({ driver: "openworkflow", sqlite })).toMatchObject({ sqlite })
    expect(normalizeWorkflowOptions({ driver: "openworkflow", postgres })).toMatchObject({ postgres: { url: "postgres://localhost/workflow" } })
    expect(() => normalizeWorkflowOptions({ driver: "openworkflow", sqlite: { path: "   " } })).toThrow(/non-empty string/)
    expect(() => normalizeWorkflowOptions({ driver: "openworkflow", postgres: { url: "   " } })).toThrow(/non-empty string/)
  })

  it("accepts runtime env declarations for OpenWorkflow SQLite storage", () => {
    const path = {
      default: "file:.data/workflow.sqlite",
      kind: "env-variable",
      source: { kind: "env", name: "VITEHUB_WORKFLOW_DATABASE_URL" },
    } as const

    expect(normalizeWorkflowOptions({
      sqlite: { path },
    }, { hosting: "node-server" })).toEqual({
      driver: "openworkflow",
      sqlite: { path },
    })
  })

  it.each([undefined, "openworkflow", "cloudflare", "vercel"])("rejects unsupported database references with provider %s", (provider) => {
    expect(() => normalizeWorkflowOptions({
      database: "workflow",
      driver: provider,
    } as never, { hosting: "node-server" })).toThrow(/workflow\.database.*not supported/)
  })

  it("ignores a deprecated database property inherited from a prototype", () => {
    const options = Object.create({ database: "legacy" }) as Record<string, unknown>
    options.driver = "cloudflare"
    expect(normalizeWorkflowOptions(options as never)).toEqual({ driver: "cloudflare" })
  })

  it("does not infer openworkflow from docker hosting without Postgres config", () => {
    expect(normalizeWorkflowOptions({}, { hosting: "docker" })).toEqual({
      driver: "vercel",
    })
  })

  it("does not prepare a Vercel schedule runtime for Cloudflare workflows", async () => {
    const plugin = hubWorkflow({ driver: "cloudflare" })
    await resolvePlugin(plugin)

    await expect(plugin.vitehub?.workflow?.prepareScheduleRuntime?.()).resolves.toBeUndefined()
  })

  it("leaves implicitly enabled Workflow disabled when Schedule prepares a Netlify build", async () => {
    const plugin = hubWorkflow(undefined, { hosting: "netlify", implicitlyEnabled: true })
    await resolvePlugin(plugin)

    await expect(plugin.vitehub?.workflow?.prepareScheduleRuntime?.()).resolves.toBeUndefined()
  })

  it("keeps explicit Workflow provider enforcement when Schedule prepares a Netlify build", async () => {
    const plugin = hubWorkflow({}, { hosting: "netlify" })
    await resolvePlugin(plugin)

    await expect(plugin.vitehub?.workflow?.prepareScheduleRuntime?.()).rejects.toThrow(/cannot be inferred for Netlify/)
  })

  it("rejects invalid openworkflow options", () => {
    expect(() => normalizeWorkflowOptions({
      postgres: "postgres://localhost/vitehub",
      driver: "openworkflow",
    } as never)).toThrow(/workflow\.postgres/)
    expect(() => normalizeWorkflowOptions({
      driver: "openworkflow",
      worker: { concurrency: 0 },
    } as never)).toThrow(/workflow\.worker\.concurrency/)
    expect(() => normalizeWorkflowOptions({
      driver: "openworkflow",
      sqlite: "file:.data/workflow.sqlite",
    } as never)).toThrow(/workflow\.sqlite/)
    expect(() => normalizeWorkflowOptions({
      database: "workflow",
      driver: "openworkflow",
      sqlite: { path: ".data/workflow.sqlite" },
    } as never)).toThrow(/workflow\.database/)
  })

  it("rejects unknown drivers", () => {
    expect(() => normalizeWorkflowOptions({ driver: "other" } as never)).toThrow(/Unknown `workflow.driver`/)
  })

  it("creates stable provider names", () => {
    expect(getCloudflareWorkflowBindingName("welcome-email")).toBe("WORKFLOW_77656C636F6D652D656D61696C")
    expect(getCloudflareWorkflowName("welcome-email")).toBe("workflow--77656c636f6d652d656d61696c")
    expect(getCloudflareWorkflowClassName("welcome-email")).toMatch(/^ViteHubWelcomeEmail[a-f0-9]{16}Workflow$/)
    expect(getLegacyCloudflareWorkflowClassName("welcome-email")).toMatch(/^ViteHubWelcomeEmail[a-f0-9]{8}Workflow$/)
    expect(getVercelWorkflowName("welcome-email")).toBe("workflow--77656c636f6d652d656d61696c")
  })

  it("bounds long Cloudflare workflow names", () => {
    const name = getCloudflareWorkflowName("notifications/onboarding/send-welcome-email")
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(/^workflow--[a-f0-9]+-[a-f0-9]{16}$/)
  })

  it("keeps long Cloudflare workflow names distinct after truncation", () => {
    const first = "ppppppppppppppppppppppqjamwa4nbhjdw"
    const second = "ppppppppppppppppppppppqahfblo6lc9cj"

    expect(first).not.toBe(second)
    expect(getCloudflareWorkflowName(first)).not.toBe(getCloudflareWorkflowName(second))
  })

  it("creates collision-resistant Cloudflare workflow class names", () => {
    expect(getCloudflareWorkflowClassName("email/welcome")).not.toBe(getCloudflareWorkflowClassName("email-welcome"))
  })

  it("uses single-workflow Cloudflare binding overrides", () => {
    expect(createCloudflareWorkflowBindings(
      [{ handler: "/tmp/welcome.ts", name: "welcome" }],
      { binding: "WORKFLOW_CUSTOM", name: "workflow-custom" },
    )).toEqual([{
      binding: "WORKFLOW_CUSTOM",
      class_name: getCloudflareWorkflowClassName("welcome"),
      name: "workflow-custom",
    }])
  })

  it("keeps Agent recovery bindings separate from single-workflow overrides", () => {
    const recovery = "vitehub-agent-invocation-recovery-welcome"
    expect(createCloudflareWorkflowBindings(
      [
        { handler: "/tmp/welcome.ts", name: "welcome", source: "agent-workflow" },
        { handler: "/tmp/welcome.ts", name: recovery, source: "agent-workflow-recovery" },
      ],
      { binding: "WORKFLOW_CUSTOM", name: "workflow-custom" },
    )).toEqual([
      {
        binding: "WORKFLOW_CUSTOM",
        class_name: getCloudflareWorkflowClassName("welcome"),
        name: "workflow-custom",
      },
      {
        binding: getCloudflareWorkflowBindingName(recovery),
        class_name: getCloudflareWorkflowClassName(recovery),
        name: getCloudflareWorkflowName(recovery),
      },
    ])
  })

  it("rejects Cloudflare binding overrides for multiple workflows", () => {
    expect(() => createCloudflareWorkflowBindings(
      [
        { handler: "/tmp/welcome.ts", name: "welcome" },
        { handler: "/tmp/receipt.ts", name: "receipt" },
      ],
      { binding: "WORKFLOW_CUSTOM" },
    )).toThrow(/only supported when one workflow is discovered/)
  })
})
