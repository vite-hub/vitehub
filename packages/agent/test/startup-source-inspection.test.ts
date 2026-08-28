import { describe, expect, it } from "vitest"
import { custom } from "@vite-hub/workspace"
import { createWorkspacePreparation, registerWorkspace } from "@vite-hub/workspace/runtime"

import { createAgentInspectionMetadata, defineAgent, resolveAgentInspectionMetadata } from "../src/index.ts"

describe("startup Source inspection", () => {
  it("reports an unprepared startup Source as pending", () => {
    const agent = defineAgent({
      workspace: {
        sources: {
          docs: custom({
            getItem: async key => ({ content: "# Ready", key }),
            getItems: async () => [{ content: "# Ready", key: "ready.md" }],
            getKeys: async () => ["ready.md"],
            materialize: "startup",
          }),
        },
      },
      driver: { run: () => "ok" },
    })

    expect(createAgentInspectionMetadata(agent).files).toEqual([{
      kind: "directory",
      label: "docs",
      materialize: "startup",
      materialized: false,
      path: "docs",
      source: "docs",
      status: "lazy",
    }])
  })

  it("observes startup Source state without materializing it", async () => {
    let requests = 0
    const workspaceName = `startup-inspection-observe-${crypto.randomUUID()}`
    const workspace = {
      sources: {
        docs: custom({
          async getItems() {
            requests++
            return [{ content: "# Ready", key: "ready.md" }]
          },
          materialize: "startup" as const,
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({ name: workspaceName, workspace, driver: { run: () => "ok" } })

    const metadata = await resolveAgentInspectionMetadata(agent)

    expect(requests).toBe(0)
    expect(metadata.files).toEqual([expect.objectContaining({ source: "docs", status: "lazy" })])
  })

  it("reports a partially materialized startup Source as failed", async () => {
    const workspaceName = `startup-inspection-${crypto.randomUUID()}`
    const workspace = {
      sources: {
        docs: custom({
          async getItem(key) {
            if (key === "z-failed.md") throw new Error("provider unavailable")
            return { content: "# Ready", key }
          },
          async getKeys() { return ["a-ready.md", "z-failed.md"] },
          materialize: "startup",
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({
      name: workspaceName,
      workspace,
      driver: { run: () => "ok" },
    })

    const preparation = createWorkspacePreparation({ retry: false, workspace: workspaceName })
    await preparation.start()
    const metadata = await resolveAgentInspectionMetadata(agent)
    await preparation.stop()

    expect(metadata.files).toEqual([
      expect.objectContaining({
        materialize: "startup",
        materialized: false,
        source: "docs",
        status: "error",
      }),
    ])
  })
})
