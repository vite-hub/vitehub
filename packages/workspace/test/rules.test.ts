import { describe, expect, it } from "vitest"

import { resolveWorkspaceAutoCommit } from "../src/core/rules.ts"
import { createWorkspace } from "../src/core/workspace.ts"

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
})
