import { describe, expect, it } from "vitest"

import { createWorkspaceChatStateAdapter } from "../src/chat/runtime/workspace-state.ts"

describe("workspace chat state", () => {
  it("stores default state in a visible workspace path", async () => {
    const writes = new Map<string, string>()
    const dirs: string[] = []
    const adapter = createWorkspaceChatStateAdapter({
      fs: {
        async mkdir(path: string) {
          if (path.startsWith(".")) throw new Error("hidden path rejected")
          dirs.push(path)
        },
        async readFile(path: string) {
          if (path.startsWith(".")) throw new Error("hidden path rejected")
          const value = writes.get(path)
          if (value === undefined) throw new Error("not found")
          return value
        },
        async writeFile(path: string, value: string) {
          if (path.startsWith(".")) throw new Error("hidden path rejected")
          writes.set(path, value)
        },
      },
    } as never)

    await adapter.set("smoke", "ok")

    expect(dirs).toEqual(["vitehub/chat/state"])
    expect(writes.has("vitehub/chat/state/state.json")).toBe(true)
    await expect(adapter.get("smoke")).resolves.toBe("ok")
  })
})
