import { describe, expect, it } from "vitest"

import { defineWorkspace, loader, registerWorkspace, source, useWorkspace } from "../src/index.ts"

describe("workspace public API", () => {
  it("defines, registers, syncs, and uses a workspace", async () => {
    registerWorkspace(defineWorkspace({
      name: "api",
      store: { provider: "memory" },
      sources: [
        source.markdown({
          path: "README.md",
          workspacePath: "README.md",
          content: "# API\n",
        }),
      ],
      loaders: [loader.files()],
    }))

    const workspace = await useWorkspace("api")
    await workspace.sync()
    await workspace.writeFile("generated/summary.md", "summary")

    expect(await workspace.readFile("README.md")).toBe("# API\n")
    expect(await workspace.exists("generated/summary.md")).toBe(true)
    expect(await workspace.glob("**/*.md")).toHaveLength(2)
    expect(workspace.mount({ mode: "copy-on-write" })).toMatchObject({
      mode: "copy-on-write",
      target: "/workspace",
    })
  })
})
