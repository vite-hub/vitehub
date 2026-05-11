import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import workspaceNitroModule from "../src/nitro/module.ts"

const tempDirs: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-nitro-sync-"))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  delete process.env.VITEHUB_WORKSPACE_DEV
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Nitro workspace assets", () => {
  it("aliases workspace subpaths before the main package alias", async () => {
    const root = await createRoot()
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
        alias: {} as Record<string, string>,
        rootDir: root,
        runtimeConfig: {},
      },
    }

    await workspaceNitroModule.setup!(nitro as never)

    expect(nitro.options.alias["@vitehub/workspace/source"]).toContain("source")
    expect(nitro.options.alias["@vitehub/workspace/runtime/state"]).toContain("runtime/state")

    const keys = Object.keys(nitro.options.alias)
    expect(keys.indexOf("@vitehub/workspace/source")).toBeLessThan(keys.indexOf("@vitehub/workspace"))
    expect(keys.indexOf("@vitehub/workspace/runtime/state")).toBeLessThan(keys.indexOf("@vitehub/workspace"))
  })

  it("uses a local workspace store in Nitro dev even for Cloudflare presets", async () => {
    const root = await createRoot()
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
        dev: true,
        preset: "cloudflare-module",
        rootDir: root,
        runtimeConfig: {} as { workspace?: unknown },
        workspace: {},
      },
    }

    await workspaceNitroModule.setup!(nitro as never)

    expect((nitro.options.runtimeConfig as { workspace?: unknown }).workspace).toMatchObject({
      store: { provider: "local" },
    })
  })

  it("uses a local workspace store when Vite marks the process as workspace dev", async () => {
    const root = await createRoot()
    process.env.VITEHUB_WORKSPACE_DEV = "true"
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
        preset: "cloudflare-module",
        rootDir: root,
        runtimeConfig: {} as { workspace?: unknown },
        workspace: {},
      },
    }

    await workspaceNitroModule.setup!(nitro as never)

    expect((nitro.options.runtimeConfig as { workspace?: unknown }).workspace).toMatchObject({
      store: { provider: "local" },
    })
  })

  it("bundles selected workspaces during build:before", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server/workspaces"), { recursive: true })
    await writeFile(join(root, "server/workspaces/selected.mjs"), `
export default {
  store: { provider: "memory" },
  sources: {
    files: {
      name: "inline",
      async getKeys() {
        return ["selected.txt"]
      },
      async getItem(key) {
        return { key, path: key, content: "selected\\n" }
      },
    },
  },
  publish: [{
    name: "asset",
    async publish(ctx) {
      const { mkdir, writeFile } = await import("node:fs/promises")
      const { dirname, join } = await import("node:path")
      const target = join(ctx.rootDir, "server/assets/context/selected.txt")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await ctx.store.readFile("files/selected.txt").then(file => file.content))
    },
  }],
}
`, "utf8")
    await writeFile(join(root, "server/workspaces/skipped.mjs"), `
export default {
  store: { provider: "memory" },
  sources: {
    files: {
      name: "inline",
      async getKeys() {
        return ["skipped.txt"]
      },
      async getItem(key) {
        return { key, path: key, content: "skipped\\n" }
      },
    },
  },
  publish: [{
    name: "asset",
    async publish(ctx) {
      const { mkdir, writeFile } = await import("node:fs/promises")
      const { dirname, join } = await import("node:path")
      const target = join(ctx.rootDir, "server/assets/context/skipped.txt")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await ctx.store.readFile("files/skipped.txt").then(file => file.content))
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
          assets: ["selected"],
        },
      },
    }

    await workspaceNitroModule.setup!(nitro as never)
    for (const callback of hooks["build:before"] ?? []) await callback()

    await expect(readFile(join(root, "server/assets/context/selected.txt"), "utf8")).resolves.toBe("selected\n")
    await expect(readFile(join(root, "server/assets/context/skipped.txt"), "utf8")).rejects.toThrow()
  })

  it("bundles all discovered workspaces during build:before by default", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server/workspaces"), { recursive: true })
    await writeFile(join(root, "server/workspaces/one.mjs"), `
export default {
  store: { provider: "memory" },
  sources: {
    files: {
      name: "inline",
      async getKeys() {
        return ["one.txt"]
      },
      async getItem(key) {
        return { key, path: key, content: "one\\n" }
      },
    },
  },
}
`, "utf8")
    await writeFile(join(root, "server/workspaces/two.mjs"), `
export default {
  store: { provider: "memory" },
  sources: {
    files: {
      name: "inline",
      async getKeys() {
        return ["two.txt"]
      },
      async getItem(key) {
        return { key, path: key, content: "two\\n" }
      },
    },
  },
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
      },
    }

    await workspaceNitroModule.setup!(nitro as never)
    for (const callback of hooks["build:before"] ?? []) await callback()

    const registryFile = join(root, ".vitehub/nitro-runtime/workspace/assets/registry.mjs")
    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default

    await expect(registry.one.readFile("files/one.txt")).resolves.toBe("one\n")
    await expect(registry.two.readFile("files/two.txt")).resolves.toBe("two\n")
  })

  it("emits bundled workspace assets for selected workspaces", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server/workspaces"), { recursive: true })
    await writeFile(join(root, "server/workspaces/docs.mjs"), `
export default {
  store: { provider: "memory" },
  sources: {
    files: {
      name: "inline",
      async getKeys() {
        return ["README.md"]
      },
      async getItem(key) {
        return { key, path: key, content: "docs\\n" }
      },
    },
  },
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
          assets: ["docs"],
        },
      },
    }

    await workspaceNitroModule.setup!(nitro as never)
    for (const callback of hooks["build:before"] ?? []) await callback()

    const registryFile = join(root, ".vitehub/nitro-runtime/workspace/assets/registry.mjs")
    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default

    await expect(registry.docs.readFile("files/README.md")).resolves.toBe("docs\n")
    await expect(registry.docs.list()).resolves.toEqual([
      expect.objectContaining({ path: "files", type: "directory" }),
    ])
  })

  it("auto-mounts visible sibling files for directory workspaces", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "workspaces", "docs", "nested"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "docs", "config.mjs"), [
      `export default {`,
      `  store: { provider: "memory" },`,
      `}`,
      ``,
    ].join("\n"))
    await writeFile(join(root, "server", "workspaces", "docs", "AGENTS.md"), "# Instructions\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "docs", "agent.ts"), "export default {}\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "docs", "notes.txt"), "notes\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "docs", "nested", "glossary.md"), "glossary\n", "utf8")
    await writeFile(join(root, "server", "workspaces", "docs", ".hidden.md"), "hidden\n", "utf8")

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
          assets: ["docs"],
        },
      },
    }

    await workspaceNitroModule.setup!(nitro as never)
    for (const callback of hooks["build:before"] ?? []) await callback()

    const registryFile = join(root, ".vitehub/nitro-runtime/workspace/assets/registry.mjs")
    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default
    await expect(registry.docs.list("", { recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "AGENTS.md", type: "file" }),
      expect.objectContaining({ path: "nested", type: "directory" }),
      expect.objectContaining({ path: "nested/glossary.md", type: "file" }),
      expect.objectContaining({ path: "notes.txt", type: "file" }),
    ])
    await expect(registry.docs.readFile("AGENTS.md")).resolves.toBe("# Instructions\n")
    await expect(registry.docs.readFile("notes.txt")).resolves.toBe("notes\n")
    await expect(registry.docs.readFile("nested/glossary.md")).resolves.toBe("glossary\n")
    await expect(registry.docs.exists("config.mjs" as never)).resolves.toBe(false)
    await expect(registry.docs.exists("agent.ts" as never)).resolves.toBe(false)
    await expect(registry.docs.exists(".hidden.md" as never)).resolves.toBe(false)
  })

  it("auto-mounts AGENTS.md for colocated agent workspaces", async () => {
    const root = await createRoot()
    await mkdir(join(root, "server", "agents", "docs"), { recursive: true })
    await writeFile(join(root, "server", "agents", "docs", "config.ts"), "const defineAgent = <T>(value: T): T => value\nexport default defineAgent({ workspace: {}, model: {} })\n", "utf8")
    await writeFile(join(root, "server", "agents", "docs", "AGENTS.md"), "# Agent Instructions\n", "utf8")

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
          assets: ["docs"],
        },
      },
    }

    await workspaceNitroModule.setup!(nitro as never)
    for (const callback of hooks["build:before"] ?? []) await callback()

    const registryFile = join(root, ".vitehub/nitro-runtime/workspace/assets/registry.mjs")
    const registry = (await import(`${pathToFileURL(registryFile).href}?t=${Date.now()}`)).default
    await expect(registry.docs.readFile("AGENTS.md")).resolves.toBe("# Agent Instructions\n")
    await expect(registry.docs.exists("config.ts" as never)).resolves.toBe(false)
  })

})
