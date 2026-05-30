import { mkdtemp } from "node:fs/promises"
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
})
