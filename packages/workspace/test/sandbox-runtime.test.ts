import { afterEach, describe, expect, it, vi } from "vitest"

import { defineWorkspace } from "../src/index.ts"
import { createWorkspace } from "../src/workspace.ts"
import { setSandboxRuntimeConfig } from "@vitehub/sandbox/runtime/state"

type FakeEntry = { content?: string, type: "directory" | "file" }

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
      async writeFile(path: string, content: string) {
        await mkdir(parent(path))
        files.set(path, { content, type: "file" })
      },
      async readFile(path: string) {
        const entry = files.get(path)
        if (!entry || entry.type !== "file") throw new Error(`missing file: ${path}`)
        return entry.content || ""
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
            size: entry.content?.length,
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
