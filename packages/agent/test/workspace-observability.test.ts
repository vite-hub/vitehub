import { describe, expect, it, vi } from "vitest"
import { createTraceEventLog } from "@vite-hub/runtime"

import { createWorkspaceSetupObservers } from "../src/internal/workspace-observability.ts"

describe("Workspace setup observability", () => {
  it("turns source materialization progress into one timed preparation step", async () => {
    const traceLog = createTraceEventLog({ content: "content" })
    const observer = createWorkspaceSetupObservers({ traceLog, workspace: "docs" }).materialization
    const base = {
      cacheStatus: "miss" as const,
      mountPath: "skills",
      path: "skills/review",
      provider: "github",
      revision: { id: "commit-123", immutable: true, ref: "main" },
      source: "review-skill",
    }

    await observer({ ...base, status: "started" })
    await observer({
      ...base,
      bytes: 4096,
      counts: { added: 2, removed: 1, unchanged: 4, updated: 1 },
      durationMs: 42,
      files: 7,
      status: "completed",
    })

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "vitehub.workspace.materialization.start",
      "vitehub.workspace.materialized",
    ])
    expect(traceLog.entries()[1]).toMatchObject({
      attributes: {
        "step.id": "vitehub.workspace.materialization:review-skill:skills/review",
        "vitehub.activity.detail": "review-skill · github · 7 files · 4.0 KB · cache miss · commit-123",
        "vitehub.activity.kind": "preparation",
        "vitehub.inspect.target": "workspace",
        "workspace.materialization.count.added": 2,
        "workspace.materialization.count.removed": 1,
        "workspace.materialization.durationMs": 42,
        "workspace.name": "docs",
        "workspace.source.revision.id": "commit-123",
      },
      type: "lifecycle",
    })
  })

  it("records sandbox preparation failures without letting trace storage break setup", async () => {
    const traceLog = createTraceEventLog({ content: "content" })
    const observer = createWorkspaceSetupObservers({ traceLog, workspace: "docs" }).preparation

    await observer({ id: "workspace.prepare.entries", label: "Resolving workspace entries", status: "started" })
    await observer({
      data: { bytes: 128, files: 2, revision: "revision-1" },
      durationMs: 12,
      error: "Store unavailable",
      id: "workspace.prepare.entries",
      label: "Resolving workspace entries",
      status: "failed",
    })

    expect(traceLog.entries()[1]).toMatchObject({
      attributes: {
        "error.message": "Store unavailable",
        "step.id": "vitehub.workspace.prepare.entries",
        "vitehub.activity.detail": "2 files · 128 B · revision-1",
      },
      name: "vitehub.workspace.prepare.entries.error",
      type: "error",
    })

    const unavailable = createWorkspaceSetupObservers({
      traceLog: { append: vi.fn(async () => { throw new Error("trace unavailable") }), entries: () => [] },
    })
    await expect(unavailable.preparation({
      id: "workspace.prepare.reset-sandbox",
      label: "Resetting sandbox workspace",
      status: "started",
    })).resolves.toBeUndefined()
  })
})
