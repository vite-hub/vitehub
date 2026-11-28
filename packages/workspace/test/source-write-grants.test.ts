import { describe, expect, it, vi } from "vitest"

import { custom } from "../src/index.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { createWorkspaceSourceView, type WorkspaceSourceWriteGrant } from "../src/sources/view.ts"
import { createMemoryWorkspaceStore } from "../src/storage/memory.ts"

import type { WorkspaceDefinition } from "../src/core/types.ts"

function docsSource(options: { materialize?: "lazy" | "startup" | "none", sync?: boolean } = {}) {
  return custom({
    materialize: "lazy",
    mount: "docs",
    ...options,
    async getKeys() {
      return ["guide.md"]
    },
    async getItem(key) {
      return { key, path: key, content: "# Guide\n" }
    },
  })
}

function definition(name: string, rules?: WorkspaceDefinition["rules"]): WorkspaceDefinition {
  return { name, rules, sources: { docs: docsSource() }, store: { driver: "memory" } }
}

describe("Source write grants", () => {
  it("rejects Source paths before it creates a grant", async () => {
    const view = createWorkspaceSourceView(definition("grant-source-path"), createMemoryWorkspaceStore())

    await expect(view.assertWritable("docs/guide.md")).rejects.toThrow("read-only")
    await expect(view.assertWritable("docs/new.md")).rejects.toThrow("read-only")
    await expect(view.writeFile("docs/guide.md", "nope")).rejects.toThrow("read-only")
    await expect(view.mkdir("docs/new")).rejects.toThrow("read-only")
    await expect(view.rm("docs/guide.md")).rejects.toThrow("read-only")
  })

  it("names the path and its Source with a fix", async () => {
    const view = createWorkspaceSourceView(definition("grant-source-diagnostic"), createMemoryWorkspaceStore())

    await expect(view.writeFile("docs/guide.md", "nope")).rejects.toMatchObject({
      code: "WORKSPACE_SOURCE_READ_ONLY",
      details: { path: "docs/guide.md", source: "docs" },
      fix: expect.stringContaining("`workspace.sync({ sources: ['handbook'] })`"),
      name: "ViteHubError",
      why: 'The Workspace path "docs/guide.md" belongs to Source "docs". Source paths are read-only: a write, removal, or move cannot change them.',
    })
  })

  it("binds a grant to one normalized path", async () => {
    const view = createWorkspaceSourceView(definition("grant-binding"), createMemoryWorkspaceStore())
    const write = vi.fn(async (path: string, content: string) => `${path}:${content}`)
    const guarded = view.requireWriteGrant(write)
    const grant = await view.assertWritable("notes\\a.md")

    expect(grant.path).toBe("notes/a.md")
    expect(Object.isFrozen(grant)).toBe(true)
    await expect(guarded(grant, "notes/a.md/", "ok")).resolves.toBe("notes/a.md:ok")
    await expect(guarded(grant, "notes/b.md", "nope")).rejects.toThrow("requires a Source write grant")
    await expect(guarded(grant, "docs/guide.md", "nope")).rejects.toThrow("requires a Source write grant")
    expect(write).toHaveBeenCalledOnce()
  })

  it("rejects writes to a synced file with an empty Source key", async () => {
    const workspace = createWorkspace({ ...definition("grant-empty-sync-key"), sources: { "": docsSource({ materialize: "none", sync: true }) } })
    await workspace.sync({ sources: [""] })

    await expect(workspace.writeFile("docs/guide.md", "nope")).rejects.toMatchObject({
      code: "WORKSPACE_SOURCE_READ_ONLY",
      details: { path: "docs/guide.md", source: "" },
    })
    await expect(workspace.readFile("docs/guide.md")).resolves.toBe("# Guide\n")
  })

  it("rejects writes inside a startup mount with an empty Source key", async () => {
    const workspace = createWorkspace({ ...definition("grant-empty-startup-key"), sources: { "": docsSource({ materialize: "startup" }) } })

    await expect(workspace.writeFile("docs/guide.md", "nope")).rejects.toMatchObject({
      code: "WORKSPACE_SOURCE_READ_ONLY",
      details: { path: "docs/guide.md", source: "" },
    })
  })

  it("reports the recorded owner on a shared mount and omits ambiguous claims", async () => {
    const workspace = createWorkspace({
      ...definition("grant-shared-mount"),
      sources: {
        policies: docsSource({ materialize: "startup" }),
        reference: docsSource({ materialize: "none", sync: true }),
      },
    })
    await workspace.sync({ sources: ["reference"] })

    await expect(workspace.writeFile("docs/guide.md", "nope")).rejects.toMatchObject({
      code: "WORKSPACE_SOURCE_READ_ONLY",
      details: { path: "docs/guide.md", source: "reference" },
    })
    await expect(workspace.writeFile("docs/new.md", "nope")).rejects.toMatchObject({
      code: "WORKSPACE_SOURCE_READ_ONLY",
      why: expect.stringContaining('"docs/new.md" belongs to a Source'),
    })
  })

  it("rejects forged, missing, and foreign grants", async () => {
    const view = createWorkspaceSourceView(definition("grant-forgery"), createMemoryWorkspaceStore())
    const other = createWorkspaceSourceView(definition("grant-forgery-other"), createMemoryWorkspaceStore())
    const write = vi.fn(async (_path: string) => {})
    const guarded = view.requireWriteGrant(write)
    const issued = await view.assertWritable("notes/a.md")
    const GrantClass = issued.constructor as new (path: string) => WorkspaceSourceWriteGrant
    // SAFETY: These values simulate JavaScript callers that bypass the TypeScript contract.
    const forged = [
      { path: "docs/guide.md" },
      Object.freeze({ path: "notes/a.md" }),
      Object.create(issued),
      undefined,
      null,
      "docs/guide.md",
    ] as unknown as WorkspaceSourceWriteGrant[]

    for (const grant of forged) {
      await expect(guarded(grant, "notes/a.md")).rejects.toThrow("requires a Source write grant")
    }
    await expect(guarded(new GrantClass("docs/guide.md"), "docs/guide.md")).rejects.toThrow("requires a Source write grant")
    await expect(guarded(await other.assertWritable("notes/a.md"), "notes/a.md")).rejects.toThrow("requires a Source write grant")
    expect(write).not.toHaveBeenCalled()
  })

  it("checks the path after a write policy rewrites it", async () => {
    const workspace = createWorkspace(definition("grant-policy-rewrite", {
      "notes/**": { validate: input => ({ ...input, path: input.path.replace(/^notes\//, "docs/") }) },
    }))

    await expect(workspace.writeFile("notes/guide.md", "nope")).rejects.toThrow("read-only")
    await expect(workspace.mkdir("notes/new")).rejects.toThrow("read-only")
    await expect(workspace.rm("notes/guide.md", { force: true })).rejects.toThrow("read-only")
    await expect(workspace.readFile("docs/guide.md")).resolves.toBe("# Guide\n")
    await expect(workspace.exists("docs/new")).resolves.toBe(false)
  })

  it("keeps grants for unchanged policy paths", async () => {
    const workspace = createWorkspace(definition("grant-policy-unchanged"))

    await expect(workspace.writeFile("notes\\a.md", "ok")).resolves.toBe("notes/a.md")
    await workspace.mkdir("notes/dir")
    await workspace.rm("notes/a.md")
    await expect(workspace.exists("notes/a.md")).resolves.toBe(false)
    await expect(workspace.exists("notes/dir")).resolves.toBe(true)
  })
})
