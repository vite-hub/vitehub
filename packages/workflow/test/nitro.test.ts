import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import workflowNitroModule from "../src/nitro.ts"

describe("Nitro module", () => {
  it("auto-imports workflow definition and read helpers only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-"))
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {},
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        output: { serverDir: join(root, ".output/server") },
        plugins: [],
        rootDir: root,
        scanDirs: [],
      },
    }

    await workflowNitroModule.setup(nitro as never)

    expect(nitro.options.imports).toMatchObject({
      presets: [
        {
          from: "@vite-hub/workflow",
          imports: ["defineWorkflow", "getWorkflowRun"],
        },
      ],
    })
  })

  it("marks OpenWorkflow provider dependencies for Nitro tracing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-openworkflow-"))
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {},
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        output: { serverDir: join(root, ".output/server") },
        plugins: [],
        rootDir: root,
        scanDirs: [],
        traceDeps: undefined as string[] | undefined,
        workflow: { provider: "openworkflow", postgres: { url: "postgres://example" } },
      },
    }

    await workflowNitroModule.setup(nitro as never)

    expect(nitro.options.traceDeps).toEqual(expect.arrayContaining(["openworkflow", "postgres"]))
  })

  it("marks OpenWorkflow SQLite provider dependencies for Nitro tracing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-openworkflow-sqlite-"))
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {},
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        output: { serverDir: join(root, ".output/server") },
        plugins: [],
        rootDir: root,
        scanDirs: [],
        traceDeps: undefined as string[] | undefined,
        workflow: { provider: "openworkflow", sqlite: { path: ".data/workflow.sqlite" } },
      },
    }

    await workflowNitroModule.setup(nitro as never)

    expect(nitro.options.traceDeps).toContain("openworkflow")
    expect(nitro.options.traceDeps).not.toContain("postgres")
  })

  it("resolves OpenWorkflow storage from a Database Definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-database-"))
    delete process.env.VITEHUB_TEST_WORKFLOW_DATABASE_URL
    await mkdir(join(root, "server/databases/workflow"), { recursive: true })
    await writeFile(join(root, "server/databases/workflow/config.ts"), [
      `import { defineDatabase } from "@vite-hub/database"`,
      `export default defineDatabase({`,
      `  connection: { url: process.env.VITEHUB_TEST_WORKFLOW_DATABASE_URL || "file:.data/workflow/openworkflow.sqlite" },`,
      `  tables: {},`,
      `})`,
      ``,
    ].join("\n"), "utf8")
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        alias: {},
        buildDir: join(root, ".nitro"),
        imports: undefined as { presets?: Array<{ from: string, imports: string[] }> } | undefined,
        output: { serverDir: join(root, ".output/server") },
        plugins: [],
        rootDir: root,
        runtimeConfig: {} as { workflow?: unknown },
        scanDirs: [],
        traceDeps: undefined as string[] | undefined,
        workflow: { database: "workflow", provider: "openworkflow" },
      },
    }

    await workflowNitroModule.setup(nitro as never)

    expect(nitro.options.runtimeConfig.workflow).toMatchObject({
      database: "workflow",
      provider: "openworkflow",
      sqlite: {
        path: {
          default: ".data/workflow/openworkflow.sqlite",
          kind: "env-variable",
          source: { kind: "env", name: "VITEHUB_TEST_WORKFLOW_DATABASE_URL" },
        },
      },
    })
    expect(nitro.options.traceDeps).toContain("openworkflow")
    expect(nitro.options.traceDeps).not.toContain("postgres")
  })
})
