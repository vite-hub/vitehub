import { describe, expect, it } from "vitest"

import { resolveWorkspaceAutoCommit } from "../src/core/rules.ts"

describe("workspace rules", () => {
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
})
