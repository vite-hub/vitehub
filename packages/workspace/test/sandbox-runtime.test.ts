import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace } from "../src/index.ts"
import { createWorkspace } from "../src/workspace.ts"
import { setSandboxRuntimeConfig } from "@vitehub/sandbox/runtime/state"

type FakeEntry = { content?: string | Uint8Array, type: "directory" | "file" }

function createFakeSandbox(provider: "cloudflare" | "vercel") {
  const files = new Map<string, FakeEntry>([
    ["/workspace", { type: "directory" }],
  ])
  const calls: string[] = []

  function parent(path: string) {
    return path.split("/").slice(0, -1).join("/") || "/"
  }

  async function mkdir(path: string) {
    const segments = path.split("/").filter(Boolean)
    let current = ""
    for (const segment of segments) {
      current += `/${segment}`
      files.set(current, { type: "directory" })
    }
  }

  return {
    calls,
    files,
    sandbox: {
      id: "fake-sandbox",
      provider,
      supports: {
        deleteFile: true,
        execCwd: true,
        execEnv: true,
        execSudo: false,
        exists: true,
        listFiles: true,
        moveFile: true,
        readFileStream: true,
        startProcess: true,
      },
      native: {},
      async mkdir(path: string) {
        await mkdir(path)
      },
      async writeFile(path: string, content: string | Uint8Array) {
        await mkdir(parent(path))
        files.set(path, { content, type: "file" })
      },
      async readFile(path: string, options?: { encoding?: "binary" | "utf8" }) {
        const entry = files.get(path)
        if (!entry || entry.type !== "file") throw new Error(`missing file: ${path}`)
        const content = entry.content || ""
        if (options?.encoding === "binary")
          return typeof content === "string" ? new TextEncoder().encode(content) : content
        return typeof content === "string" ? content : new TextDecoder().decode(content)
      },
      async exists(path: string) {
        return files.has(path)
      },
      async listFiles(path: string, options?: { recursive?: boolean }) {
        const prefix = path.endsWith("/") ? path : `${path}/`
        return [...files.entries()]
          .filter(([entryPath]) => entryPath !== path && entryPath.startsWith(prefix))
          .filter(([entryPath]) => options?.recursive || !entryPath.slice(prefix.length).includes("/"))
          .map(([entryPath, entry]) => ({
            name: entryPath.split("/").at(-1) || entryPath,
            path: entryPath,
            size: typeof entry.content === "string" ? entry.content.length : entry.content?.byteLength,
            type: entry.type,
          }))
      },
      async deleteFile(path: string) {
        for (const key of [...files.keys()].filter(key => key === path || key.startsWith(`${path}/`)))
          files.delete(key)
      },
      async moveFile(src: string, dst: string) {
        const entry = files.get(src)
        if (!entry) throw new Error(`missing file: ${src}`)
        files.delete(src)
        files.set(dst, entry)
      },
      async readFileStream() {
        throw new Error("not implemented")
      },
      async startProcess() {
        throw new Error("not implemented")
      },
      async exec(command: string, args: string[] = [], options?: { cwd?: string }) {
        calls.push(`${options?.cwd || ""}:${command} ${args.join(" ")}`.trim())
        if (command === "rm" && args[0] === "-rf") {
          for (const key of [...files.keys()].filter(key => key === args[1] || key.startsWith(`${args[1]}/`)))
            files.delete(key)
        }
        return { code: 0, ok: true, stderr: "", stdout: "ok\n" }
      },
      async stop() {
        calls.push("stop")
      },
    },
  }
}

vi.mock("@vitehub/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vitehub/sandbox")>()
  return {
    ...actual,
    createSandboxWithConfig: vi.fn(),
  }
})

afterEach(async () => {
  setSandboxRuntimeConfig(undefined)
  const sandboxPackage = await import("@vitehub/sandbox")
  vi.mocked(sandboxPackage.createSandboxWithConfig).mockReset()
})

describe("sandbox workspace runtime", () => {
  it.each(["cloudflare", "vercel"] as const)("materializes a workspace into the configured %s app sandbox and commits changes", async (provider) => {
    const fake = createFakeSandbox(provider)
    const sandboxPackage = await import("@vitehub/sandbox")
    vi.mocked(sandboxPackage.createSandboxWithConfig).mockResolvedValue(fake.sandbox as never)
    setSandboxRuntimeConfig(provider === "cloudflare"
      ? { provider: "cloudflare", binding: "SANDBOX" }
      : { provider: "vercel", runtime: "node24" })

    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "sandbox",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.sync()
    await workspace.writeFile("README.md", "# Docs\n")

    const session = await workspace.open()
    await expect(session.readFile("README.md")).resolves.toBe("# Docs\n")
    await expect(session.exec("pnpm", ["test"])).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" })
    await session.writeFile("generated/result.txt", "done")

    expect((await session.diff()).entries).toEqual([
      expect.objectContaining({ path: "generated", type: "added" }),
      expect.objectContaining({ path: "generated/result.txt", type: "added" }),
    ])

    await session.commit()
    await session.close()

    await expect(workspace.readFile("generated/result.txt")).resolves.toBe("done")
    expect(fake.calls).toContain("/workspace:pnpm test")
    if (provider === "vercel")
      expect(fake.calls).toContain("stop")
    else
      expect(fake.calls).not.toContain("stop")
  })

  it("resets reused sandbox roots and materializes empty directories", async () => {
    const fake = createFakeSandbox("cloudflare")
    fake.files.set("/workspace/stale.txt", { content: "stale", type: "file" })
    const sandboxPackage = await import("@vitehub/sandbox")
    vi.mocked(sandboxPackage.createSandboxWithConfig).mockResolvedValue(fake.sandbox as never)
    setSandboxRuntimeConfig({ provider: "cloudflare", binding: "SANDBOX", sandboxId: "app-sandbox" })

    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "sandbox",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.sync()
    await workspace.mkdir("empty", { recursive: true })
    await workspace.writeFile("README.md", "# Docs\n")

    const session = await workspace.open()

    expect((await session.list("", { recursive: true })).map(entry => entry.path).sort()).toEqual(["README.md", "empty"].sort())
    expect((await session.diff()).entries).toEqual([])
    await session.commit()
    await session.close()
    await expect(workspace.exists("empty")).resolves.toBe(true)
    await expect(workspace.exists("stale.txt")).resolves.toBe(false)
  })

  it("keeps lazy source files out of the initial sandbox diff", async () => {
    const fake = createFakeSandbox("cloudflare")
    const sandboxPackage = await import("@vitehub/sandbox")
    vi.mocked(sandboxPackage.createSandboxWithConfig).mockResolvedValue(fake.sandbox as never)
    setSandboxRuntimeConfig({ provider: "cloudflare", binding: "SANDBOX" })

    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "sandbox",
        store: { provider: "memory" },
        sources: {
          docs: {
            name: "docs",
            materialize: "lazy",
            async getKeys() {
              return ["README.md"]
            },
            async getItem() {
              return { content: "# Lazy docs\n", key: "README.md" }
            },
          },
        },
      }),
      name: "docs",
    })
    await workspace.sync()

    const session = await workspace.open()

    await expect(session.readFile("docs/README.md")).resolves.toBe("# Lazy docs\n")
    expect((await session.diff()).entries).toEqual([])
  })

  it("round-trips binary file contents through sandbox sessions", async () => {
    const fake = createFakeSandbox("vercel")
    const sandboxPackage = await import("@vitehub/sandbox")
    vi.mocked(sandboxPackage.createSandboxWithConfig).mockResolvedValue(fake.sandbox as never)
    setSandboxRuntimeConfig({ provider: "vercel", runtime: "node24" })

    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "sandbox",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    const input = new Uint8Array([0, 159, 255, 64])
    const output = new Uint8Array([1, 2, 3, 254])
    await workspace.sync()
    await workspace.writeFile("asset.bin", input)

    const session = await workspace.open()

    await expect(session.readFile("asset.bin", { encoding: "binary" })).resolves.toEqual(input)
    expect((await session.diff()).entries).toEqual([])
    await session.writeFile("generated/out.bin", output)
    await session.commit()

    await expect(workspace.readFile("generated/out.bin", { encoding: "binary" })).resolves.toEqual(output)
  })

  it("scopes sandbox session search by cwd", async () => {
    const fake = createFakeSandbox("cloudflare")
    const sandboxPackage = await import("@vitehub/sandbox")
    vi.mocked(sandboxPackage.createSandboxWithConfig).mockResolvedValue(fake.sandbox as never)
    setSandboxRuntimeConfig({ provider: "cloudflare", binding: "SANDBOX" })

    const workspace = createWorkspace({
      ...defineWorkspace({
        runtime: "sandbox",
        store: { provider: "memory" },
      }),
      name: "docs",
    })
    await workspace.sync()
    await workspace.writeFile("docs/a.md", "target\n")
    await workspace.writeFile("notes/b.md", "target\n")

    const session = await workspace.open()

    expect(await session.search({ cwd: "docs", pattern: "target" })).toEqual([
      expect.objectContaining({ path: "docs/a.md" }),
    ])
  })

  it("keeps session methods present for non-executable workspaces", async () => {
    const workspace = createWorkspace({
      name: "docs",
      store: { provider: "memory" },
    })

    const session = await workspace.open()

    expect(session.exec).toBeTypeOf("function")
    expect(session.commit).toBeTypeOf("function")
    expect(session.close).toBeTypeOf("function")
    await expect(session.exec("pnpm", ["test"])).rejects.toThrow("runtime")
  })
})
