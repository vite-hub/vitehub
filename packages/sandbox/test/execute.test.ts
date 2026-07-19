import { describe, expect, it, vi } from "vitest"

import { executeSandboxDefinition } from "../src/runtime/execute.ts"
import type { SandboxError } from "../src/sandbox/errors.ts"
import type { SandboxClient, SandboxExecResult } from "../src/sandbox/types.ts"

function createFakeSandbox(options: { execError?: Error, execResult?: SandboxExecResult, provider?: "cloudflare" | "vercel" } = {}) {
  const files = new Map<string, string>()
  const execCalls: Array<{ cmd: string, args: string[], options?: { cwd?: string } }> = []

  const sandbox = {
    id: "fake",
    provider: options.provider ?? "vercel",
    supports: {
      execEnv: true,
      execCwd: false,
      execSudo: false,
      listFiles: false,
      exists: false,
      deleteFile: false,
      moveFile: false,
      readFileStream: false,
      startProcess: false,
    },
    native: {},
    async exec(cmd: string, args: string[] = [], execOptions?: { cwd?: string }): Promise<SandboxExecResult> {
      execCalls.push({ cmd, args, options: execOptions })
      if (options.execError)
        throw options.execError
      if (options.execResult)
        return options.execResult

      const outputPath = args.at(-1)
      if (!outputPath)
        throw new Error("Missing output path")

      files.set(outputPath, JSON.stringify({ ok: true, result: { ok: true } }))
      return {
        ok: true,
        stdout: "",
        stderr: "",
        code: 0,
      }
    },
    async writeFile(path: string, content: string) {
      files.set(path, content)
    },
    async readFile(path: string) {
      const content = files.get(path)
      if (typeof content === "undefined")
        throw new Error(`Missing file: ${path}`)
      return content
    },
    async mkdir() {},
    async stop() {},
    async readFileStream() {
      throw new Error("not implemented")
    },
    async startProcess() {
      throw new Error("not implemented")
    },
    async listFiles() {
      throw new Error("not implemented")
    },
    async exists() {
      throw new Error("not implemented")
    },
    async deleteFile() {},
    async moveFile() {
      throw new Error("not implemented")
    },
  } as unknown as SandboxClient

  return { sandbox, execCalls, files }
}

describe("executeSandboxDefinition", () => {
  it("bounds Cloudflare setup with the definition timeout", async () => {
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

    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]?.cmd).toBe("node")
    expect(execCalls[0]?.args.slice(0, 2)).toEqual(["-e", "import(process.argv[1])"])
    expect(execCalls[0]?.options?.cwd).toBeUndefined()
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

  it("deletes Cloudflare execution sessions through the sandbox", async () => {
    const { sandbox, files } = createFakeSandbox({ provider: "cloudflare" })
    const deleteSession = vi.fn(async () => {})
    const createSession = vi.fn(async () => ({
      id: "execution-session",
      exec: vi.fn(async (command: string) => {
        const outputPath = command.trim().split(/\s+/).at(-1)?.replace(/^'|'$/g, "")
        if (outputPath)
          files.set(outputPath, JSON.stringify({ ok: true, result: { ok: true } }))
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
    }))
    Object.assign(sandbox, {
      native: { createSession: vi.fn() },
      cloudflare: {
        createSession,
        deleteSession,
      } as unknown as typeof sandbox.cloudflare,
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
    )).resolves.toEqual({ ok: true })

    expect(deleteSession).toHaveBeenCalledWith("execution-session")
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: expect.stringMatching(/^\/tmp\/vitehub-sandbox\/release-notes-/),
    }))
  })

  it("deletes a Cloudflare session created after the definition timeout", async () => {
    const { sandbox } = createFakeSandbox({ provider: "cloudflare" })
    const sessionExec = vi.fn()
    const deleteSession = vi.fn(async () => {})
    let finishCreation: ((session: unknown) => void) | undefined
    Object.assign(sandbox, {
      native: { createSession: vi.fn() },
      cloudflare: {
        createSession: vi.fn(async () => await new Promise(resolve => {
          finishCreation = resolve
        })),
        deleteSession,
      } as unknown as typeof sandbox.cloudflare,
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
    )).rejects.toMatchObject({ code: "TIMEOUT", provider: "cloudflare" })

    finishCreation?.({ id: "late-session", exec: sessionExec })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sessionExec).not.toHaveBeenCalled()
    expect(deleteSession).toHaveBeenCalledWith("late-session")
  })

  it("bounds Cloudflare session creation with the default exec deadline", async () => {
    vi.useFakeTimers()
    try {
      const { sandbox } = createFakeSandbox({ provider: "cloudflare" })
      Object.assign(sandbox, {
        native: { createSession: vi.fn() },
        cloudflare: {
          createSession: vi.fn(async () => await new Promise(() => {})),
        } as unknown as typeof sandbox.cloudflare,
      })

      const execution = executeSandboxDefinition(
        sandbox,
        "release-notes",
        undefined,
        {
          entry: "definition.mjs",
          modules: {
            "definition.mjs": "export default { run() { return { ok: true } } }",
          },
        },
      )
      const rejection = expect(execution).rejects.toMatchObject({
        code: "TIMEOUT",
        provider: "cloudflare",
        details: { operation: "createSession", timeout: 180_000 },
      } satisfies Partial<SandboxError>)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(180_000)

      await rejection
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("preserves Cloudflare session creation failures for runtime retry", async () => {
    const { sandbox } = createFakeSandbox({ provider: "cloudflare" })
    const creationError = new Error("network connection lost")
    Object.assign(sandbox, {
      native: { createSession: vi.fn() },
      cloudflare: {
        createSession: vi.fn(async () => { throw creationError }),
      } as unknown as typeof sandbox.cloudflare,
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
      message: "network connection lost",
      cause: creationError,
      code: "SANDBOX_TRANSPORT_ERROR",
      details: { operation: "createSession" },
      provider: "cloudflare",
    } satisfies Partial<SandboxError>)
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

  it("wraps missing output from completed non-Cloudflare executions with diagnostics", async () => {
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
