import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import workspaceNitroModule from "../src/nitro/module.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-nitro-sync-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Nitro syncOnBuild", () => {
  it("syncs selected workspaces during build:before", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server/workspaces"), { recursive: true })
    await writeFile(join(root, "server/workspaces/selected.mjs"), `
export default {
  store: { provider: "memory" },
  sources: [{
    name: "inline",
    async getKeys() {
      return ["selected.txt"]
    },
    async getItem(key) {
      return { key, path: key, content: "selected\\n" }
    },
  }],
  publish: [{
    name: "asset",
    async publish(ctx) {
      const { mkdir, writeFile } = await import("node:fs/promises")
      const { dirname, join } = await import("node:path")
      const target = join(ctx.rootDir, "server/assets/context/selected.txt")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await ctx.store.readFile("selected.txt").then(file => file.content))
    },
  }],
}
`, "utf8")
    await writeFile(join(root, "server/workspaces/skipped.mjs"), `
export default {
  store: { provider: "memory" },
  sources: [{
    name: "inline",
    async getKeys() {
      return ["skipped.txt"]
    },
    async getItem(key) {
      return { key, path: key, content: "skipped\\n" }
    },
  }],
  publish: [{
    name: "asset",
    async publish(ctx) {
      const { mkdir, writeFile } = await import("node:fs/promises")
      const { dirname, join } = await import("node:path")
      const target = join(ctx.rootDir, "server/assets/context/skipped.txt")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await ctx.store.readFile("skipped.txt").then(file => file.content))
    },
  }],
}
`, "utf8")

    const hooks: Record<string, Array<() => Promise<void>>> = {}
    const nitro = {
      hooks: {
        hook(name: string, callback: () => Promise<void>) {
          hooks[name] ||= []
          hooks[name].push(callback)
        },
      },
      logger: {
        info() {},
      },
      options: {
        _config: {},
        rootDir: root,
        runtimeConfig: {},
        workspace: {
          syncOnBuild: ["selected"],
        },
      },
    }

    await workspaceNitroModule.setup!(nitro as never)
    for (const callback of hooks["build:before"] ?? []) await callback()

    await expect(readFile(join(root, "server/assets/context/selected.txt"), "utf8")).resolves.toBe("selected\n")
    await expect(readFile(join(root, "server/assets/context/skipped.txt"), "utf8")).rejects.toThrow()
  })
})
