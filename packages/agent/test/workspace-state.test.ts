import { describe, expect, it, vi } from "vitest"

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

  it("uses collision-free persisted keys", async () => {
    const writes = new Map<string, string>()
    const adapter = createWorkspaceChatStateAdapter({
      fs: {
        async mkdir() {},
        async readFile(path: string) {
          const value = writes.get(path)
          if (value === undefined) throw new Error("not found")
          return value
        },
        async writeFile(path: string, value: string) {
          writes.set(path, value)
        },
      },
    } as never)

    await adapter.set("%", "percent")
    await adapter.set("~25", "tilde")

    await expect(adapter.get("%")).resolves.toBe("percent")
    await expect(adapter.get("~25")).resolves.toBe("tilde")
  })

  it("serializes concurrent workspace state mutations", async () => {
    const writes = new Map<string, string>()
    const adapter = createWorkspaceChatStateAdapter({
      fs: {
        async mkdir() {},
        async readFile(path: string) {
          const value = writes.get(path)
          if (value === undefined) throw new Error("not found")
          return value
        },
        writeFile: vi.fn(async (path: string, value: string) => {
          await new Promise(resolve => setTimeout(resolve, 5))
          writes.set(path, value)
        }),
      },
    } as never)

    await Promise.all([
      adapter.set("first", "a"),
      adapter.set("second", "b"),
    ])

    await expect(adapter.get("first")).resolves.toBe("a")
    await expect(adapter.get("second")).resolves.toBe("b")
  })
})
