import { describe, expect, it, vi } from "vitest"

import { defineWorkspace } from "../src/core/define.ts"
import { resolveWorkspaceAutoCommit } from "../src/core/rules.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import type { WorkspaceRules } from "../src/core/types.ts"

describe("workspace rules", () => {
  it("keeps ordinary direct Workspace braces compatible in memory stores", async () => {
    const workspace = createWorkspace({ name: "docs", store: { provider: "memory" } })
    await workspace.writeFile("docs/readme.md", "readme")
    await workspace.writeFile("docs/guide.mdx", "guide")

    await expect(workspace.glob("docs/*.{md,mdx}")).resolves.toEqual([
      expect.objectContaining({ path: "docs/guide.mdx", type: "file" }),
      expect.objectContaining({ path: "docs/readme.md", type: "file" }),
    ])
  })

  it("creates an auto-commit plan from workspace commit", () => {
    expect(resolveWorkspaceAutoCommit({
      commit: "chore: update docs",
      name: "docs",
    }, {
      entries: [
        { after: { type: "file" }, path: "inbox/audio.ogg", type: "added" },
        { after: { type: "file" }, path: "notes/today.md", type: "modified" },
      ],
      to: "next",
    })).toEqual({
      message: "chore: update docs",
      paths: ["inbox/audio.ogg", "notes/today.md"],
    })
  })

  it("creates an auto-commit plan from empty workspace commit", () => {
    expect(resolveWorkspaceAutoCommit({
      commit: "",
      name: "docs",
    }, {
      entries: [
        { after: { type: "file" }, path: "notes/today.md", type: "modified" },
      ],
      to: "next",
    })).toEqual({
      message: "chore: update docs workspace",
      paths: ["notes/today.md"],
    })
  })

  it("creates an auto-commit plan when every changed path matches a commit rule", () => {
    expect(resolveWorkspaceAutoCommit({
      name: "docs",
      rules: {
        "inbox/**": {
          commit: "chore: archive inbox files",
          write: true,
        },
      },
    }, {
      entries: [
        { after: { type: "file" }, path: "inbox/audio.ogg", type: "added" },
        { after: { type: "file" }, path: "inbox/audio.md", type: "added" },
      ],
      to: "next",
    })).toEqual({
      message: "chore: archive inbox files",
      paths: ["inbox/audio.ogg", "inbox/audio.md"],
    })
  })

  it("keeps ordinary developer-authored brace rules compatible", () => {
    expect(resolveWorkspaceAutoCommit({
      name: "docs",
      rules: {
        "notes/{draft,final}.md": { commit: true, write: true },
      },
    }, {
      entries: [
        { after: { type: "file" }, path: "notes/final.md", type: "added" },
      ],
      to: "next",
    })).toEqual({
      message: "chore: update docs workspace",
      paths: ["notes/final.md"],
    })
  })

  it("does not auto-commit changes outside commit rules", () => {
    expect(resolveWorkspaceAutoCommit({
      name: "docs",
      rules: {
        "inbox/**": { commit: true, write: true },
        "drafts/**": { write: true },
      },
    }, {
      entries: [
        { after: { type: "file" }, path: "inbox/audio.md", type: "added" },
        { after: { type: "file" }, path: "drafts/note.md", type: "added" },
      ],
      to: "next",
    })).toBeUndefined()
  })

  it("passes write metadata through validators before storing", async () => {
    const seen: unknown[] = []
    const workspace = createWorkspace({
      name: "docs",
      rules: {
        "**": {
          validate(input) {
            seen.push(input.metadata)
            return { ...input, metadata: { gitMode: "100755" } }
          },
          write: true,
        },
      },
      store: { provider: "memory" },
    })

    await workspace.writeFile("script.sh", "echo ok\n", { metadata: { gitMode: "120000" } })

    expect(seen).toEqual([{ gitMode: "120000" }])
    await expect(workspace.stat("script.sh")).resolves.toMatchObject({
      metadata: { gitMode: "100755" },
    })
  })

  describe("policy", () => {
    it("rejects a read rule, because Workspace rules do not limit reads", () => {
      const rules: WorkspaceRules = {
        "secrets/**": {
          // @ts-expect-error `read` is not a Workspace rule.
          read: false,
        },
      }
      expect(() => defineWorkspace({ rules })).toThrow(expect.objectContaining({ code: "WORKSPACE_R0075" }))
      expect(() => createWorkspace({ name: "secrets", rules, store: { provider: "memory" } }))
        .toThrow("Workspace rule \"secrets/**\" sets read. Workspace rules do not limit reads.")
      expect(() => createWorkspace({ name: "plugin-secrets", plugins: [{ id: "guard", rules }], store: { provider: "memory" } }))
        .toThrow(expect.objectContaining({ code: "WORKSPACE_R0075" }))
    })

    it("keeps a broader write: false when a more specific rule does not set write", async () => {
      const workspace = createWorkspace({
        name: "locked",
        rules: { "**": { write: false }, "docs/**": { maxBytes: 100 } },
        store: { provider: "memory" },
      })

      await expect(workspace.writeFile("docs/page.md", "page")).rejects.toThrow("Workspace rule \"**\" does not allow writeFile")
      await expect(workspace.exists("docs/page.md")).resolves.toBe(false)
    })

    it("lets a more specific rule allow writes with an explicit write: true", async () => {
      const workspace = createWorkspace({
        name: "carve-out",
        rules: { "**": { maxBytes: 4, write: false }, "docs/**": { write: true } },
        store: { provider: "memory" },
      })

      await expect(workspace.writeFile("docs/page.md", "page")).resolves.toBe("docs/page.md")
      await expect(workspace.writeFile("docs/large.md", "large")).rejects.toThrow("Workspace rule \"**\" limits writes to 4 bytes")
      await expect(workspace.writeFile("other.md", "x")).rejects.toThrow("does not allow writeFile")
    })

    it("runs the validators of every matching rule", async () => {
      const workspace = createWorkspace({
        name: "validators",
        rules: { "**": { validate: () => false }, "docs/**": { write: true } },
        store: { provider: "memory" },
      })

      await expect(workspace.writeFile("docs/page.md", "page")).rejects.toThrow("validator rejected")
    })

    it("keeps plugin rule fields when the app rule on the same pattern sets other fields", async () => {
      const validate = vi.fn(() => false)
      const workspace = createWorkspace({
        name: "plugin-merge",
        plugins: [{ id: "guard", rules: { "secrets/**": { write: false }, "posts/**": { validate } } }],
        rules: { "secrets/**": { maxBytes: 100 }, "posts/**": { maxBytes: 100 } },
        store: { provider: "memory" },
      })

      await expect(workspace.writeFile("secrets/token.txt", "x")).rejects.toThrow("does not allow writeFile")
      await expect(workspace.writeFile("posts/a.md", "x")).rejects.toThrow("validator rejected")
      expect(validate).toHaveBeenCalledOnce()
    })

    it("checks mediaType from the path when the write passes no media type", async () => {
      const workspace = createWorkspace({
        name: "media",
        rules: { "**": { mediaType: "text/markdown" } },
        store: { provider: "memory" },
      })

      await expect(workspace.writeFile("page.html", "<script>alert(1)</script>")).rejects.toThrow("does not allow media type text/html: page.html")
      await expect(workspace.writeFile("no-extension", "x")).rejects.toThrow("does not allow media type application/octet-stream")
      await expect(workspace.writeFile("page.md", "# Page\n")).resolves.toBe("page.md")
      await expect(workspace.stat("page.md")).resolves.toMatchObject({ mediaType: "text/markdown" })
      await expect(workspace.mkdir("folder", { recursive: true })).resolves.toBeUndefined()
    })
  })
})
