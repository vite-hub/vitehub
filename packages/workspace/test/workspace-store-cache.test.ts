import { afterEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceDefinition } from "../src/core/types.ts"

afterEach(() => {
  vi.resetModules()
})

describe("workspace store cache", () => {
  it("shares one memory store between two copies of the package", async () => {
    const definition: WorkspaceDefinition = { name: "docs", store: { driver: "memory" } }

    // A second package (for example Realtime) can load its own copy of @vite-hub/workspace.
    const first = await import("../src/core/workspace.ts")
    vi.resetModules()
    const second = await import("../src/core/workspace.ts")
    expect(second.createWorkspace).not.toBe(first.createWorkspace)

    await first.createWorkspace(definition).writeFile("note.md", "hello")

    expect(await second.createWorkspace(definition).readFile("note.md")).toBe("hello")
  })
})
