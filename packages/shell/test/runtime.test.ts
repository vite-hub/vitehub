import { describe, expect, it, vi } from "vitest"

import {
  analyzeShellCommand,
  createShellRuntime,
} from "../src/index.ts"
import { createJustBashProvider } from "../src/providers/just-bash.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"
import {
  createReadonlyWorkspaceFs,
  createWritableWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from "../src/workspace/index.ts"
import { createCloudflareShellProvider } from "../src/providers/cloudflare.ts"

import type {
  ShellExecutionProvider,
  ShellProcess,
  ShellRuntimeExecOptions,
} from "../src/index.ts"
import type {
  ReadonlyShellWorkspace,
  WritableShellWorkspace,
} from "../src/workspace/index.ts"

// @ts-expect-error workspace contracts belong to @vitehub/shell/workspace.
import type { ReadonlyShellWorkspace as RootReadonlyShellWorkspace } from "../src/index.ts"

function createReadonlyRuntime(workspace: ReadonlyShellWorkspace) {
  return createShellRuntime({
    provider: createJustBashProvider({
      commands: ["pwd", "ls", "find", "cat", "head", "tail", "wc", "rg"],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace),
    }),
  })
}

describe("@vitehub/shell just-bash runtime", () => {
  it("exposes stable public package subpaths", async () => {
    await expect(import("@vitehub/shell")).resolves.toMatchObject({
      analyzeShellCommand: expect.any(Function),
      createShellRuntime: expect.any(Function),
    })
    await expect(import("@vitehub/shell/workspace")).resolves.toMatchObject({
      cleanWorkspaceShellPath: expect.any(Function),
      createReadonlyWorkspaceFs: expect.any(Function),
      runWorkspaceInspectionCommand: expect.any(Function),
    })
    await expect(import("@vitehub/shell/providers/just-bash")).resolves.toMatchObject({
      createJustBashProvider: expect.any(Function),
    })
    await expect(import("@vitehub/shell/providers/cloudflare")).resolves.toMatchObject({
      createCloudflareShellProvider: expect.any(Function),
    })
  })

  it("creates stateful shell sessions with boundary metadata and one-shot exec sugar", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const runtime = createReadonlyRuntime(workspace)

    expect(runtime.boundary).toMatchObject({
      cwd: true,
      filesystem: {
        mountPoint: "/workspace",
        writable: false,
      },
      processes: {
        background: false,
        interactive: false,
      },
    })
    await expect(runtime.exec("pwd")).resolves.toMatchObject({
      command: "pwd",
      event: "command_finished",
      stdout: "/workspace\n",
    })

    const session = runtime.createSession({ policy: { maxShellCalls: 1, maxOutputLength: 4 } })
    await expect(session.exec("cat README.md", { cwd: workspaceMountPoint })).resolves.toMatchObject({
      outputTruncated: true,
      stdout: "# Do\n[output truncated to 4 characters]\n",
    })
    await expect(session.exec("pwd", { cwd: workspaceMountPoint })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("command budget exhausted after 1 calls"),
    })
    await expect(session.startProcess("sleep 10")).rejects.toThrow("does not support long-running processes")
    await expect(session.dispose()).resolves.toMatchObject({ event: "session_disposed" })
  })

  it("unregisters stopped long-running processes from session state", async () => {
    const provider: ShellExecutionProvider = {
      boundary: {
        cwd: true,
        env: true,
        filesystem: { writable: false },
        network: false,
        processes: {
          background: true,
          interactive: false,
        },
        streaming: false,
        timeout: {
          enforcedBy: "runtime",
          supported: true,
        },
      },
      async exec(command: string, _options?: ShellRuntimeExecOptions) {
        return {
          command,
          event: "command_finished",
          exitCode: 0,
          stderr: "",
          stdout: "",
        }
      },
      async startProcess(command: string): Promise<ShellProcess> {
        return {
          command,
          id: command,
          async stop() {
            return {
              command,
              event: "command_finished",
              exitCode: 0,
              stderr: "",
              stdout: "",
            }
          },
        }
      },
    }
    const session = createShellRuntime({ provider }).createSession({ policy: { maxProcesses: 1 } })

    const first = await session.startProcess("one")
    expect(await session.listProcesses()).toHaveLength(1)
    await expect(session.startProcess("two")).rejects.toThrow("process budget exhausted after 1 processes")

    await expect(first.stop()).resolves.toMatchObject({ exitCode: 0 })
    expect(await session.listProcesses()).toHaveLength(0)
    await expect(session.startProcess("two")).resolves.toMatchObject({ id: "two" })
  })

  it("executes workspace inspection commands", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
      "models/orders.sql": "select * from orders\nwhere id is not null\n",
    })
    const runtime = createReadonlyRuntime(workspace)

    await expect(runtime.exec("pwd")).resolves.toMatchObject({ exitCode: 0, stdout: "/workspace\n" })
    await expect(runtime.exec("ls models")).resolves.toMatchObject({ exitCode: 0, stdout: "customers.sql\norders.sql\n" })
    await expect(runtime.exec("find . -name '*.sql'")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "./models/customers.sql\n./models/orders.sql\n",
    })
    await expect(runtime.exec("cat README.md")).resolves.toMatchObject({ exitCode: 0, stdout: "# Docs\n" })
    await expect(runtime.exec("head -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "select * from orders\n" })
    await expect(runtime.exec("tail -n 1 models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "where id is not null\n" })
    await expect(runtime.exec("wc -l models/orders.sql")).resolves.toMatchObject({ exitCode: 0, stdout: "2 models/orders.sql\n" })
    await expect(runtime.exec("rg orders models")).resolves.toMatchObject({ exitCode: 0, stdout: "models/orders.sql:1:select * from orders\n" })
  })

  it("rejects broad root searches before they can time out", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    await expect(runWorkspaceInspectionCommand(workspace, "rg customers .", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("Workspace root search is too broad"),
      stdout: expect.stringContaining("Workspace search is too broad"),
    })
    await expect(runWorkspaceInspectionCommand(workspace, "rg customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:1:select * from customers\n",
    })
  })

  it("rejects traversal and mutations on the read-only filesystem", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const runtime = createReadonlyRuntime(workspace)

    await expect(runtime.exec("cat ../README.md")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "cat: ../README.md: No such file or directory\n",
    })
    await expect(runtime.exec("rm README.md")).resolves.toMatchObject({
      exitCode: 127,
      stderr: "bash: rm: command not found\n",
    })
  })

  it("keeps resolved paths inside the workspace mount after normalization", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    expect(fs.resolvePath("/workspace/models", "../README.md")).toBe("/workspace/README.md")
    expect(() => fs.resolvePath("/workspace/../outside", ".")).toThrow("[vitehub] Workspace path escapes the workspace root")
    expect(() => fs.resolvePath("/workspace/models", "../../outside")).toThrow("[vitehub] Workspace path escapes the workspace root")
  })

  it("executes real shell pipelines, redirects, chaining, and multiline scripts", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const runtime = createShellRuntime({
      provider: createJustBashProvider({
        commands: ["cat", "echo", "grep", "head", "mkdir", "printf", "test", "tr"],
        cwd: workspaceMountPoint,
        fs: createWritableWorkspaceFs(workspace),
      }),
    })

    await expect(runtime.exec("echo hello | tr a-z A-Z")).resolves.toMatchObject({ exitCode: 0, stdout: "HELLO\n" })
    await expect(runtime.exec("printf 'a\\nb\\n' | grep b")).resolves.toMatchObject({ exitCode: 0, stdout: "b\n" })
    await expect(runtime.exec("mkdir -p tmp && echo ok > tmp/out && cat tmp/out")).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" })
    await expect(runtime.exec("if test -f tmp/out\nthen\ncat tmp/out\nfi")).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" })
  })

  it("exposes writable filesystem adapters", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/orders.sql": "select * from orders\n",
    })
    const fs = createWritableWorkspaceFs(workspace)

    await fs.writeFile("/workspace/notes.md", "notes\n")
    await fs.appendFile("/workspace/notes.md", "more\n")
    await expect(fs.readFile("/workspace/notes.md")).resolves.toBe("notes\nmore\n")

    await fs.cp("/workspace", "/workspace/copy")
    await expect(fs.readFile("/workspace/copy/README.md")).resolves.toBe("# Docs\n")
    await expect(fs.readFile("/workspace/copy/models/orders.sql")).resolves.toBe("select * from orders\n")
    await expect(workspace.exists("copy/opy")).resolves.toBe(false)
  })

  it("does not refresh workspace paths when creating a shell filesystem", () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })
    const list = vi.spyOn(workspace, "list")

    createReadonlyWorkspaceFs(workspace)

    expect(list).not.toHaveBeenCalled()
  })

  it("returns a structured result when workspace inspection times out", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "sleep 1", {
      commands: ["sleep"],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace),
      timeout: 5,
    })).resolves.toMatchObject({
      exitCode: null,
      stderr: "[vitehub] Workspace shell command timed out after 5ms.",
      stdout: "",
    })
  })
})

describe("@vitehub/shell cloudflare runtime", () => {
  it("delegates to the cloudflare sandbox client", async () => {
    const sandbox = {
      exec: vi.fn(async (_command: string, _args?: string[], options?: Record<string, unknown>) => {
        if (options?.onStdout) (options.onStdout as (data: string) => void)("out")
        if (options?.onStderr) (options.onStderr as (data: string) => void)("err")
        return {
          exitCode: 0,
          ok: true,
          stderr: "err",
          stdout: "out",
        }
      }),
      provider: "cloudflare",
      supports: {
        deleteFile: true,
        env: true,
        execCwd: true,
        execEnv: true,
        execSudo: false,
        exists: true,
        listFiles: true,
        moveFile: true,
        readFileStream: true,
        startProcess: true,
      },
    } as any

    const runtime = createShellRuntime({
      provider: createCloudflareShellProvider({
        sandbox,
      }),
    })
    const onStdout = vi.fn()
    const onStderr = vi.fn()
    const command = "ls -la /workspace | head -n 1"
    const result = await runtime.exec(command, {
      cwd: "/workspace",
      env: { FOO: "bar" },
      onStderr,
      onStdout,
      stdin: "input",
      timeout: 100,
    })

    expect(result).toMatchObject({
      command,
      event: "command_finished",
      exitCode: 0,
      stderr: "err",
      stdout: "out",
    })
    expect(sandbox.exec).toHaveBeenCalledWith("ls", ["-la", "/workspace", "|", "head", "-n", "1"], expect.objectContaining({
      cwd: "/workspace",
      env: { FOO: "bar" },
      stdin: "input",
      timeout: 100,
    }))
    expect(onStdout).toHaveBeenCalledWith("out")
    expect(onStderr).toHaveBeenCalledWith("err")
  })
})

describe("@vitehub/shell analyzer", () => {
  it("parses shell commands with sh-syntax and returns conservative metadata", async () => {
    await expect(analyzeShellCommand("FOO=bar echo $(pwd) | tr a-z A-Z > out")).resolves.toMatchObject({
      commands: ["echo", "tr"],
      hasCommandSubstitution: true,
      hasPipelines: true,
      hasRedirects: true,
      ok: true,
      parser: "sh-syntax",
    })
  })

  it("reports malformed shell and input limits without throwing", async () => {
    await expect(analyzeShellCommand("if then")).resolves.toMatchObject({
      ok: false,
      parser: "sh-syntax",
    })
    await expect(analyzeShellCommand("x".repeat(12), { maxInputBytes: 8 })).resolves.toMatchObject({
      error: "Shell command exceeds 8 bytes.",
      ok: false,
      parser: "sh-syntax",
    })
  })

  it("detects heredocs and parser timeouts as structured analysis failures", async () => {
    await expect(analyzeShellCommand("cat <<EOF\nhello\nEOF")).resolves.toMatchObject({
      hasHeredocs: true,
      ok: true,
    })
    await expect(analyzeShellCommand("echo ok", { timeoutMs: 0 })).resolves.toMatchObject({
      ok: false,
      parser: "sh-syntax",
    })
  })
})
