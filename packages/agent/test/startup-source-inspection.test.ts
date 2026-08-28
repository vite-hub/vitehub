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
          async getItem(key) {
            requests++
            return { content: "# Ready", key }
          },
          async getItems() {
            requests++
            return [{ content: "# Ready", key: "ready.md" }]
          },
          async getKeys() {
            requests++
            return ["ready.md"]
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

  it("reports prepared startup descendants as ready", async () => {
    const workspaceName = `startup-inspection-ready-${crypto.randomUUID()}`
    const workspace = {
      sources: {
        docs: custom({
          async getItem(key) { return { content: "# Ready", key } },
          async getKeys() { return ["guides/start.md"] },
          materialize: "startup" as const,
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({ name: workspaceName, workspace, driver: { run: () => "ok" } })

    const preparation = createWorkspacePreparation({ workspace: workspaceName })
    await preparation.start()
    const metadata = await resolveAgentInspectionMetadata(agent)
    await preparation.stop()

    expect(JSON.stringify(metadata.files)).not.toContain('"materialize":"startup"')
    expect(metadata.files).toEqual([expect.objectContaining({ source: "docs", status: "ready" })])
  })

  it("represents an unprepared root-mounted startup Source", async () => {
    const workspaceName = `startup-inspection-root-${crypto.randomUUID()}`
    const workspace = {
      sources: {
        instructions: custom({
          async getItem(key) { return { content: "# Ready", key } },
          async getKeys() { return ["AGENTS.md"] },
          materialize: "startup" as const,
          mount: "",
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({ name: workspaceName, workspace, driver: { run: () => "ok" } })

    const metadata = await resolveAgentInspectionMetadata(agent)

    expect(metadata.files).toEqual([expect.objectContaining({
      path: "",
      source: "instructions",
      status: "lazy",
    })])
  })

  it("clears the preparation hint from a ready root-mounted startup Source", async () => {
    const workspaceName = `startup-inspection-root-ready-${crypto.randomUUID()}`
    const workspace = {
      sources: {
        instructions: custom({
          async getItem(key) { return { content: "# Ready", key } },
          async getKeys() { return ["AGENTS.md"] },
          materialize: "startup" as const,
          mount: "",
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({ name: workspaceName, workspace, driver: { run: () => "ok" } })
    const preparation = createWorkspacePreparation({ workspace: workspaceName })

    await preparation.start()
    const metadata = await resolveAgentInspectionMetadata(agent)
    await preparation.stop()

    expect(metadata.files).toEqual([expect.objectContaining({
      materialized: true,
      path: "",
      source: "instructions",
      status: "ready",
    })])
    expect(metadata.files?.[0]).not.toHaveProperty("materialize")
  })

  it("represents every root-mounted startup Source", async () => {
    const workspaceName = `startup-inspection-multiple-roots-${crypto.randomUUID()}`
    const workspace = {
      sources: {
        instructions: custom({
          async getItem(key) { return { content: "# Instructions", key } },
          async getKeys() { return ["AGENTS.md"] },
          materialize: "startup" as const,
          mount: "",
        }),
        readme: custom({
          async getItem(key) { return { content: "# Readme", key } },
          async getKeys() { return ["README.md"] },
          materialize: "startup" as const,
          mount: "",
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({ name: workspaceName, workspace, driver: { run: () => "ok" } })

    const preparation = createWorkspacePreparation({ workspace: workspaceName })
    await preparation.start()
    const metadata = await resolveAgentInspectionMetadata(agent)
    await preparation.stop()

    expect(metadata.files).toEqual([
      expect.objectContaining({
        children: [expect.objectContaining({ path: "AGENTS.md" })],
        path: "",
        source: "instructions",
        status: "ready",
      }),
      expect.objectContaining({
        children: [expect.objectContaining({ path: "README.md" })],
        path: "",
        source: "readme",
        status: "ready",
      }),
    ])
  })

  it("preserves the most-specific Source owner in nested inspection", async () => {
    const workspaceName = `startup-inspection-nested-${crypto.randomUUID()}`
    const workspace = {
      sources: {
        docs: custom({
          async getItem(key) { return { content: "# Docs", key } },
          async getKeys() { return ["index.md"] },
          materialize: "startup" as const,
        }),
        generated: custom({
          async getItem(key) { return { content: "# Generated", key } },
          async getKeys() { return ["output.md"] },
          materialize: "startup" as const,
          mount: "docs/generated",
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({ name: workspaceName, workspace, driver: { run: () => "ok" } })
    const preparation = createWorkspacePreparation({ workspace: workspaceName })

    await preparation.start()
    const metadata = await resolveAgentInspectionMetadata(agent)
    await preparation.stop()

    const docs = metadata.files?.find(item => item.path === "docs")
    const generated = docs?.children?.find(item => item.path === "docs/generated")
    expect(docs).toMatchObject({ source: "docs", status: "ready" })
    expect(generated).toMatchObject({ source: "generated", status: "ready" })
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
          materialize: "startup" as const,
        }),
      },
    }
    registerWorkspace(workspaceName, workspace)
    const agent = defineAgent({
      name: workspaceName,
      workspace,
      driver: { run: () => "ok" },
    })

    const preparation = createWorkspacePreparation({ workspace: workspaceName })
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
