import { describe, expect, it } from "vitest"

import { executeSandboxDefinition } from "../src/runtime/execute.ts"
import type { SandboxError } from "../src/sandbox/errors.ts"
import type { SandboxClient, SandboxExecResult } from "../src/sandbox/types.ts"

function createFakeSandbox(options: { execError?: Error, execResult?: SandboxExecResult } = {}) {
  const files = new Map<string, string>()
  const execCalls: Array<{ cmd: string, args: string[] }> = []

  const sandbox = {
    id: "fake",
    provider: "vercel",
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
    async exec(cmd: string, args: string[] = []): Promise<SandboxExecResult> {
      execCalls.push({ cmd, args })
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
    async deleteFile() {
      throw new Error("not implemented")
    },
    async moveFile() {
      throw new Error("not implemented")
    },
  } as unknown as SandboxClient

  return { sandbox, execCalls }
}

describe("executeSandboxDefinition", () => {
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
