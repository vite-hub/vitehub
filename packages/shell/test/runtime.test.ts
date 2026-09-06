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
} from "../src/index.ts"
import type {
  ReadonlyShellWorkspace,
} from "../src/workspace/index.ts"

// @ts-expect-error workspace contracts belong to @vite-hub/shell/workspace.
import type { ReadonlyShellWorkspace as RootReadonlyShellWorkspace } from "../src/index.ts"

type _RootReadonlyShellWorkspace = RootReadonlyShellWorkspace

function createReadonlyRuntime(workspace: ReadonlyShellWorkspace) {
  return createShellRuntime({
    provider: createJustBashProvider({
      commands: ["pwd", "ls", "find", "cat", "head", "tail", "wc", "rg"],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace),
    }),
  })
}

function createBackgroundProvider(
  startProcess: NonNullable<ShellExecutionProvider["startProcess"]>,
): ShellExecutionProvider {
  return {
    boundary: {
      cwd: true,
      env: true,
      filesystem: { writable: false },
      network: false,
      processes: { background: true, interactive: false },
      streaming: false,
      timeout: { enforcedBy: "runtime", supported: true },
    },
    async exec(command: string) {
      return { command, event: "command_finished", exitCode: 0, stderr: "", stdout: "" }
    },
    startProcess,
  }
}

function stoppedProcessObservation(command: string) {
  return { command, event: "command_finished" as const, exitCode: 0, stderr: "", stdout: "" }
}

describe("@vite-hub/shell just-bash runtime", () => {
  it("exposes stable public package subpaths", async () => {
    await expect(import("@vite-hub/shell")).resolves.toMatchObject({
      analyzeShellCommand: expect.any(Function),
      createShellRuntime: expect.any(Function),
    })
    await expect(import("@vite-hub/shell/workspace")).resolves.toMatchObject({
      cleanWorkspaceShellPath: expect.any(Function),
      createReadonlyWorkspaceFs: expect.any(Function),
      runWorkspaceInspectionCommand: expect.any(Function),
    })
    await expect(import("@vite-hub/shell/providers/just-bash")).resolves.toMatchObject({
      createJustBashProvider: expect.any(Function),
    })
    await expect(import("@vite-hub/shell/providers/cloudflare")).resolves.toMatchObject({
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

  it("runs controlled curl through the just-bash provider network boundary", async () => {
    const workspace = new MemoryWorkspace({})
    const executeSourceRequest = vi.fn(async () => ({ content: "ok\n" }))
    const runtime = createShellRuntime({
      provider: createJustBashProvider({
        commands: ["curl"],
        cwd: workspaceMountPoint,
        fs: createReadonlyWorkspaceFs(workspace),
        networkGrants: { executeSourceRequest },
      }),
    })

    expect(runtime.boundary.network).toBe(true)
    await expect(runtime.exec("curl -d '{\"region\":\"eu\"}' https://portal.example.com/runtime/inventory-health")).resolves.toMatchObject({
      event: "command_finished",
      exitCode: 0,
      stdout: "ok\n",
    })
    expect(executeSourceRequest).toHaveBeenCalledWith({
      body: { region: "eu" },
      method: "POST",
      url: "https://portal.example.com/runtime/inventory-health",
    })
  })

  it("unregisters stopped long-running processes from session state", async () => {
    const stops = new Map<string, ReturnType<typeof vi.fn>>()
    const provider = createBackgroundProvider(async (command: string): Promise<ShellProcess> => {
      const stop = vi.fn(async () => stoppedProcessObservation(command))
      stops.set(command, stop)
      return { command, id: command, stop }
    })
    const session = createShellRuntime({ provider }).createSession({ policy: { maxProcesses: 1 } })

    const first = await session.startProcess("one")
    expect(await session.listProcesses()).toHaveLength(1)
    await expect(session.startProcess("two")).rejects.toThrow("process budget exhausted after 1 processes")

    await expect(first.stop()).resolves.toMatchObject({ exitCode: 0 })
    await expect(first.stop()).resolves.toMatchObject({ exitCode: 0 })
    expect(stops.get("one")).toHaveBeenCalledOnce()
    expect(await session.listProcesses()).toHaveLength(0)
    await expect(session.startProcess("two")).resolves.toMatchObject({ id: "two" })
    await expect(session.dispose()).resolves.toMatchObject({ event: "session_disposed" })
    await expect(session.dispose()).resolves.toMatchObject({ event: "session_disposed" })
    expect(stops.get("two")).toHaveBeenCalledOnce()
    expect(await session.listProcesses()).toHaveLength(0)
    await expect(session.startProcess("three")).rejects.toThrow("Shell session is disposed")
  })

  it("returns background-process cleanup failures without FiberFailure", async () => {
    const firstError = new Error("first stop failed")
    const secondError = new Error("second stop failed")
    const provider = createBackgroundProvider(async (command: string): Promise<ShellProcess> => ({
      command,
      id: command,
      async stop() {
        if (command === "one") throw firstError
        if (command === "two") throw secondError
        return stoppedProcessObservation(command)
      },
    }))
    const session = createShellRuntime({ provider }).createSession()

    await session.startProcess("one")
    await session.startProcess("two")
    // SAFETY: dispose rejects with AggregateError when multiple process stops fail.
    const failure = await session.dispose().catch(error => error) as AggregateError

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([secondError, firstError])
    expect(failure.name).not.toBe("FiberFailure")
    expect(await session.listProcesses()).toHaveLength(2)
  })

  it("keeps failed process cleanup retryable while coalescing each attempt", async () => {
    const firstError = new Error("first stop failed")
    const secondError = new Error("second stop failed")
    const stop = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockResolvedValue(stoppedProcessObservation("retryable"))
    const provider = createBackgroundProvider(async (): Promise<ShellProcess> => ({
      command: "retryable",
      id: "retryable",
      stop,
    }))
    const session = createShellRuntime({ provider }).createSession()
    const process = await session.startProcess("retryable")

    const firstStop = process.stop()
    const concurrentStop = process.stop()
    expect(firstStop).toBe(concurrentStop)
    await expect(firstStop).rejects.toBe(firstError)
    await expect(concurrentStop).rejects.toBe(firstError)
    expect(stop).toHaveBeenCalledOnce()
    expect(await session.listProcesses()).toEqual([process])

    const firstDispose = session.dispose()
    const concurrentDispose = session.dispose()
    expect(firstDispose).toBe(concurrentDispose)
    await expect(firstDispose).rejects.toBe(secondError)
    await expect(concurrentDispose).rejects.toBe(secondError)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(await session.listProcesses()).toEqual([process])

    await expect(session.dispose()).resolves.toMatchObject({ event: "session_disposed" })
    expect(stop).toHaveBeenCalledTimes(3)
    expect(await session.listProcesses()).toHaveLength(0)
  })

  it("waits for a process that resolves after disposal and stops it once", async () => {
    let resolveProcess: ((process: ShellProcess) => void) | undefined
    let resolveStop: (() => void) | undefined
    const stop = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveStop = resolve
      })
      return stoppedProcessObservation("late")
    })
    const provider = createBackgroundProvider(() => new Promise(resolve => {
      resolveProcess = resolve
    }))
    const session = createShellRuntime({ provider }).createSession()
    const starting = session.startProcess("late")
    const disposing = session.dispose()

    resolveProcess?.({ command: "late", id: "late", stop })
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    let disposed = false
    void disposing.then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    resolveStop?.()

    await expect(disposing).resolves.toMatchObject({ event: "session_disposed" })
    await expect(starting).rejects.toThrow("Shell session is disposed")
    expect(stop).toHaveBeenCalledOnce()
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
      workspaceGuardrail: { kind: "broad_search" },
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

  it("keeps yq XML conversion unavailable in the portable provider", async () => {
    const workspace = new MemoryWorkspace({
      "input.xml": `<?xml version="1.0"?>
<!DOCTYPE root [<!ENTITY a "x">]>
<!DOCTYPE root [<!ENTITY b "&a;&a;">]>
<root>&b;</root>
`,
    })
    const runtime = createShellRuntime({
      provider: createJustBashProvider({
        commands: ["yq"],
        cwd: workspaceMountPoint,
        fs: createReadonlyWorkspaceFs(workspace),
      }),
    })

    await expect(runtime.exec("yq -p xml -o json '.' input.xml")).resolves.toMatchObject({
      exitCode: 127,
      stderr: expect.stringContaining("yq: command not available in browser environments"),
      stdout: "",
    })
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
      event: "command_timed_out",
      exitCode: null,
      stderr: "[vitehub] Workspace shell command timed out after 5ms.",
      stdout: "",
      timedOut: true,
    })
  })
})

describe("@vite-hub/shell cloudflare runtime", () => {
  it("delegates to the cloudflare sandbox client", async () => {
    const sandbox = {
      exec: vi.fn(async (_command: string, _args?: string[], options?: {
        onStderr?: (data: string) => void
        onStdout?: (data: string) => void
      }) => {
        options?.onStdout?.("out")
        options?.onStderr?.("err")
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
    }

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

describe("@vite-hub/shell analyzer", () => {
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
