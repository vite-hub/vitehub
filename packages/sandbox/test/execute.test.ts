import { describe, expect, it, vi } from "vitest"
import { posix } from "node:path"
import { unknownExecutionAuthority } from "@vite-hub/runtime"

import { executeSandboxDefinition } from "../src/runtime/execute.ts"
import type { SandboxError } from "../src/sandbox/errors.ts"
import type { SandboxExecutionBox } from "../src/runtime/execution-box.ts"

type SandboxExecResult = Awaited<ReturnType<SandboxExecutionBox["exec"]>>

function createFakeSandbox(options: { execError?: Error, execResult?: SandboxExecResult, holdExecution?: boolean, holdInstall?: boolean, provider?: "cloudflare" | "vercel" } = {}) {
  const files = new Map<string, Uint8Array>()
  const directories = new Set<string>(["/"])
  const normalize = (path: string) => posix.resolve("/", path)
  const addParents = (path: string) => {
    let current = posix.dirname(normalize(path))
    while (!directories.has(current)) {
      directories.add(current)
      current = posix.dirname(current)
    }
  }
  const execCalls: Array<{ cmd: string, args: string[], options?: { cwd?: string, env?: Record<string, string>, signal?: AbortSignal } }> = []
  const mkdirCalls: string[] = []
  let releaseInstall = () => {}
  const installGate = new Promise<void>(resolve => releaseInstall = resolve)

  const sandbox = {
    executionAuthority: unknownExecutionAuthority,
    id: "fake",
    provider: options.provider ?? "vercel",
    async close() {},
    async exec(cmd: string, args: string[] = [], execOptions?: { cwd?: string, env?: Record<string, string>, signal?: AbortSignal }): Promise<SandboxExecResult> {
      execCalls.push({ cmd, args, options: execOptions })
      if (options.execError)
        throw options.execError
      if (options.execResult)
        return options.execResult

      if (cmd === "mkdir") {
        const target = normalize(args[0] || "")
        if (directories.has(target)) return { ok: false, stdout: "", stderr: "exists", code: 1 }
        addParents(target)
        directories.add(target)
        return { ok: true, stdout: "", stderr: "", code: 0 }
      }

      const outputPath = args.at(-1)
      if (!outputPath)
        throw new Error("Missing output path")

      if (cmd === "pnpm" && execOptions?.cwd) {
        if (options.holdInstall) await installGate
        const installed = `${execOptions.cwd}/node_modules/.installed`
        addParents(installed)
        files.set(installed, new TextEncoder().encode("ready"))
        return { ok: true, stdout: "", stderr: "", code: 0 }
      }
      if (cmd === "node" && args[1]?.includes('rename(process.argv[1], process.argv[2])')) {
        const source = normalize(args[2] || "")
        const destination = normalize(args[3] || "")
        if (directories.has(destination)) return { ok: false, stdout: "", stderr: "exists", code: 1 }
        for (const directory of [...directories]) {
          if (directory === source || directory.startsWith(`${source}/`)) {
            directories.delete(directory)
            directories.add(`${destination}${directory.slice(source.length)}`)
          }
        }
        for (const [path, content] of [...files]) {
          if (path === source || path.startsWith(`${source}/`)) {
            files.delete(path)
            files.set(`${destination}${path.slice(source.length)}`, content)
          }
        }
        return { ok: true, stdout: "", stderr: "", code: 0 }
      }
      if (options.holdExecution && cmd === "node" && args[1] === "import(process.argv[1])") {
        return await new Promise<SandboxExecResult>((_resolve, reject) => {
          execOptions?.signal?.addEventListener("abort", () => reject(execOptions.signal?.reason), { once: true })
        })
      }
      if (cmd === "rm") {
        await sandbox.files.remove(args.at(-1) || "", { recursive: true })
        return { ok: true, stdout: "", stderr: "", code: 0 }
      }
      files.set(normalize(outputPath), new TextEncoder().encode(JSON.stringify({ ok: true, result: { ok: true } })))
      return { ok: true, stdout: "", stderr: "", code: 0 }
    },
    files: {
      async exists(path: string) {
        const target = normalize(path)
        return files.has(target) || directories.has(target)
      },
      async list(path: string, listOptions?: { recursive?: boolean }) {
        const root = normalize(path)
        const prefix = root === "/" ? "/" : `${root}/`
        return [
          ...[...directories].filter(path => path !== root && path.startsWith(prefix)).map(path => ({ path, type: "directory" as const })),
          ...[...files].filter(([path]) => path.startsWith(prefix)).map(([path, content]) => ({ path, size: content.byteLength, type: "file" as const })),
        ].filter(entry => listOptions?.recursive || !entry.path.slice(prefix.length).includes("/"))
      },
      async mkdir(path: string) {
        const target = normalize(path)
        addParents(target)
        directories.add(target)
      },
      async read(path: string) {
        return files.get(normalize(path)) || null
      },
      async remove(path: string, removeOptions?: { recursive?: boolean }) {
        const target = normalize(path)
        files.delete(target)
        directories.delete(target)
        if (removeOptions?.recursive) {
          for (const file of [...files.keys()]) if (file.startsWith(`${target}/`)) files.delete(file)
          for (const directory of [...directories]) if (directory.startsWith(`${target}/`)) directories.delete(directory)
        }
      },
      async write(path: string, content: Uint8Array) {
        const target = normalize(path)
        addParents(target)
        files.set(target, content)
      },
    },
    async writeFile(path: string, content: string) {
      const target = normalize(path)
      addParents(target)
      files.set(target, new TextEncoder().encode(content))
    },
    async readFile(path: string) {
      const content = files.get(normalize(path))
      if (typeof content === "undefined")
        throw new Error("Missing file: " + path)
      return new TextDecoder().decode(content)
    },
    async mkdir(path: string) {
      mkdirCalls.push(path)
      const target = normalize(path)
      addParents(target)
      directories.add(target)
    },
    async exists(path: string) {
      return files.has(normalize(path)) || directories.has(normalize(path))
    },
  } as SandboxExecutionBox

  return { sandbox, execCalls, hasFile: (path: string) => files.has(normalize(path)), mkdirCalls, releaseInstall }
}

describe("executeSandboxDefinition", () => {
  it("bounds setup with the definition timeout", async () => {
    const { sandbox, execCalls } = createFakeSandbox({ provider: "cloudflare" })
    let finishSetup: (() => void) | undefined
    sandbox.mkdir = async () => await new Promise<void>((resolve) => {
      finishSetup = resolve
    })

    await expect(executeSandboxDefinition(
      sandbox,
      "release-notes",
      { timeout: 10 },
      {
        entry: "definition.mjs",
        modules: {
          "definition.mjs": "export default { run() { return { ok: true } } }",
        },
      },
    )).rejects.toMatchObject({
      code: "TIMEOUT",
      provider: "cloudflare",
    } satisfies Partial<SandboxError>)

    finishSetup?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(execCalls.some(call => call.cmd === "node")).toBe(false)
  })

  it("imports the generated entry once with the default Node launcher", async () => {
    const { sandbox, execCalls } = createFakeSandbox()

    await expect(executeSandboxDefinition(
      sandbox,
      "release-notes",
      undefined,
      {
        entry: "definition.mjs",
        modules: {
          "definition.mjs": "export default { run() { return { ok: true } } }",
        },
      },
    )).resolves.toEqual({ ok: true })

    const launchCalls = execCalls.filter(call => call.cmd === "node")
    expect(launchCalls).toHaveLength(1)
    expect(launchCalls[0]?.args.slice(0, 2)).toEqual(["-e", "import(process.argv[1])"])
    expect(launchCalls[0]?.options?.cwd).toMatch(/^\/tmp\/vitehub-sandbox\/release-notes-/)
  })

  it("awaits an executable module default export", async () => {
    const { sandbox, execCalls } = createFakeSandbox()

    await expect(executeSandboxDefinition(
      sandbox,
      "release-notes",
      undefined,
      {
        entry: "definition.mjs",
        execution: "module",
        modules: {
          "definition.mjs": "await Promise.resolve(); export default { ok: true }",
        },
      },
    )).resolves.toEqual({ ok: true })

    const launch = execCalls.find(call => call.cmd === "node")!
    const entry = await sandbox.readFile(launch.args[2]!)
    expect(entry).toContain("const result = await mod.default")
    expect(entry).not.toContain("definition.run")
  })

  it("enforces timeout during executable module evaluation", async () => {
    const { sandbox, execCalls } = createFakeSandbox({ holdExecution: true, provider: "cloudflare" })

    await expect(executeSandboxDefinition(
      sandbox,
      "release-notes",
      { timeout: 10 },
      {
        entry: "definition.mjs",
        execution: "module",
        modules: {
          "definition.mjs": "await new Promise(() => {}); export default null",
        },
      },
    )).rejects.toMatchObject({
      code: "TIMEOUT",
      provider: "cloudflare",
    } satisfies Partial<SandboxError>)

    expect(execCalls.some(call => call.cmd === "node" && call.args[1] === "import(process.argv[1])")).toBe(true)
  })

  it("prepares one package project once per digest", async () => {
    const { sandbox, execCalls, hasFile, mkdirCalls } = createFakeSandbox()
    const bundle = {
      entry: ".vitehub-sandbox/definition.js",
      modules: { ".vitehub-sandbox/definition.js": "export default { run() { return { ok: true } } }" },
      project: {
        digest: "a".repeat(64),
        files: {
          "package.json": {
            contents: Buffer.from(JSON.stringify({ private: true, type: "module" })).toString("base64"),
            encoding: "base64" as const,
          },
        },
        install: { args: ["install", "--frozen-lockfile"], command: "pnpm" as const, cwd: "." },
        packagePath: ".",
      },
    }

    await expect(executeSandboxDefinition(sandbox, "release-notes", { env: { SECRET: "handler-only" } }, bundle))
      .resolves.toEqual({ ok: true })
    await expect(executeSandboxDefinition(sandbox, "release-notes", { env: { SECRET: "handler-only" } }, bundle))
      .resolves.toEqual({ ok: true })

    expect(execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(1)
    expect(execCalls.filter(call => call.cmd === "node" && call.args[1] === "import(process.argv[1])")).toHaveLength(2)
    expect(hasFile(`/tmp/vitehub-sandbox/projects/${"a".repeat(64)}/node_modules/.installed`)).toBe(true)
    expect(execCalls.find(call => call.cmd === "pnpm")).toMatchObject({
      cmd: "pnpm",
      args: ["install", "--frozen-lockfile"],
      options: { cwd: expect.stringMatching(new RegExp(`^/tmp/vitehub-sandbox/projects/${"a".repeat(64)}\\.staging-`)) },
    })
    expect(execCalls.find(call => call.cmd === "pnpm")?.options?.env).toBeUndefined()
    expect(mkdirCalls).toContainEqual(expect.stringMatching(new RegExp(`^/tmp/vitehub-sandbox/projects/${"a".repeat(64)}\\.staging-.+/\\.vitehub$`)))
    expect(execCalls.filter(call => call.cmd === "node" && call.args[1] === "import(process.argv[1])"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ options: expect.objectContaining({ env: { SECRET: "handler-only" } }) }),
      ]))
  })

  it("serializes concurrent preparation for one project digest", async () => {
    const { sandbox, execCalls, releaseInstall } = createFakeSandbox({ holdInstall: true })
    const bundle = {
      entry: ".vitehub-sandbox/definition.js",
      modules: { ".vitehub-sandbox/definition.js": "export default { run() { return { ok: true } } }" },
      project: {
        digest: "b".repeat(64),
        files: {
          "package.json": {
            contents: Buffer.from(JSON.stringify({ private: true, type: "module" })).toString("base64"),
            encoding: "base64" as const,
          },
        },
        install: { args: ["install", "--frozen-lockfile"], command: "pnpm" as const, cwd: "." },
        packagePath: ".",
      },
    }

    const first = executeSandboxDefinition(sandbox, "release-notes", undefined, bundle)
    await vi.waitFor(() => expect(execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(1))
    const second = executeSandboxDefinition(sandbox, "release-notes", undefined, bundle)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(1)
    releaseInstall()

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(1)
  })

  it("prepares separate Box filesystems that share an id", async () => {
    const firstBox = createFakeSandbox({ holdInstall: true })
    const secondBox = createFakeSandbox()
    const bundle = {
      entry: ".vitehub-sandbox/definition.js",
      modules: { ".vitehub-sandbox/definition.js": "export default { run() { return { ok: true } } }" },
      project: {
        digest: "c".repeat(64),
        files: {
          "package.json": {
            contents: Buffer.from(JSON.stringify({ private: true })).toString("base64"),
            encoding: "base64" as const,
          },
        },
        install: { args: ["install", "--frozen-lockfile"], command: "pnpm" as const, cwd: "." },
        packagePath: ".",
      },
    }

    const first = executeSandboxDefinition(firstBox.sandbox, "first", undefined, bundle)
    await vi.waitFor(() => expect(firstBox.execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(1))
    const second = executeSandboxDefinition(secondBox.sandbox, "second", undefined, bundle)
    firstBox.releaseInstall()

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(firstBox.execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(1)
    expect(secondBox.execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(1)
  })

  it("cleans up the staging project when a concurrent publisher loses", async () => {
    const shared = createFakeSandbox({ holdInstall: true })
    const competing = { ...shared.sandbox, id: "competing" } as SandboxExecutionBox
    const digest = "d".repeat(64)
    const bundle = {
      entry: ".vitehub-sandbox/definition.js",
      modules: { ".vitehub-sandbox/definition.js": "export default { run() { return { ok: true } } }" },
      project: {
        digest,
        files: {
          "package.json": {
            contents: Buffer.from(JSON.stringify({ private: true })).toString("base64"),
            encoding: "base64" as const,
          },
        },
        install: { args: ["install", "--frozen-lockfile"], command: "pnpm" as const, cwd: "." },
        packagePath: ".",
      },
    }

    const first = executeSandboxDefinition(shared.sandbox, "first", undefined, bundle)
    const second = executeSandboxDefinition(competing, "second", undefined, bundle)
    await vi.waitFor(() => expect(shared.execCalls.filter(call => call.cmd === "pnpm")).toHaveLength(2))
    shared.releaseInstall()

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    const entries = await shared.sandbox.files.list("/tmp/vitehub-sandbox/projects", { recursive: true })
    expect(entries.some(entry => entry.path.includes(".staging-"))).toBe(false)
    expect(entries.some(entry => entry.path === `/tmp/vitehub-sandbox/projects/${digest}/.vitehub/prepared`)).toBe(true)
  })

  it("recursively deletes successful Cloudflare invocation files before reuse", async () => {
    const { sandbox, execCalls } = createFakeSandbox({ provider: "cloudflare" })

    await expect(executeSandboxDefinition(
      sandbox,
      "release-notes",
      undefined,
      {
        entry: "definition.mjs",
        modules: {
          "definition.mjs": "export default { run() { return { ok: true } } }",
        },
      },
    )).resolves.toEqual({ ok: true })

    expect(execCalls.at(-1)).toMatchObject({
      cmd: "rm",
      args: ["-rf", "--", expect.stringMatching(/^\/tmp\/vitehub-sandbox\/release-notes-/)],
    })
  })

  it("rethrows unrecoverable exec errors instead of masking them as output parse failures", async () => {
    const execError = new Error("vercel transport unavailable")
    const { sandbox } = createFakeSandbox({ execError })

    await expect(executeSandboxDefinition(
      sandbox,
      "release-notes",
      undefined,
      {
        entry: "definition.mjs",
        modules: {
          "definition.mjs": "export default { run() { return { ok: true } } }",
        },
      },
    )).rejects.toThrow(execError)
  })

  it("wraps missing output from completed executions with diagnostics", async () => {
    const { sandbox } = createFakeSandbox({
      execResult: {
        ok: false,
        stdout: "booted",
        stderr: "runtime command failed",
        code: 127,
      },
    })

    await expect(executeSandboxDefinition(
      sandbox,
      "release-notes",
      undefined,
      {
        entry: "definition.mjs",
        modules: {
          "definition.mjs": "export default { run() { return { ok: true } } }",
        },
      },
    )).rejects.toMatchObject({
      name: "SandboxError",
      code: "SANDBOX_HANDLER_ERROR",
      provider: "vercel",
      details: {
        exitCode: 127,
        stderrPreview: "runtime command failed",
        stdoutPreview: "booted",
      },
    } satisfies Partial<SandboxError>)
  })
})
