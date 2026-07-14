import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, posix, resolve } from "node:path"
import { Readable } from "node:stream"

import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness"

import type {
  BoxRuntime,
  ResolvedBoxInput,
  ResolvedBoxRequirement,
} from "../index.ts"

export interface CrabboxOptions {
  /** How ViteHub reaches target ports. Defaults to tunnels; direct access requires a shared loopback network namespace. */
  network?: "direct" | "tunnel"
  profile?: string
  /** Replaces an existing static lease for the shared sibling-workspace root. */
  reclaim?: boolean
}

interface CrabboxSandboxOptions extends CrabboxOptions {
  requirements: readonly CrabboxRequirement[]
  workspace: string
  workRoot: string
}

interface CrabboxRequirement extends ResolvedBoxRequirement {
  readonly args: readonly string[]
}

interface CrabboxSessionOptions extends CrabboxSandboxOptions {
  stateHome: string
}

interface CrabboxRunOptions {
  abortSignal?: AbortSignal
  command: string
  env?: Record<string, string>
  localWorkingDirectory?: string
  sync?: boolean
  workingDirectory?: string
}

interface CrabboxSessionState {
  leaseId: string
  options: CrabboxSessionOptions
  processes: Set<ChildProcessWithoutNullStreams>
  pendingTunnels: Map<number, { child: ChildProcessWithoutNullStreams, promise: Promise<{ child: ChildProcessWithoutNullStreams, localPort: number }> }>
  remoteWorkspace: string
  root: string
  tunnels: Map<number, { child: ChildProcessWithoutNullStreams, localPort: number }>
}

export function crabbox(options: CrabboxOptions = {}): BoxRuntime {
  return {
    name: "crabbox",
    async resolve(input: ResolvedBoxInput) {
      if (!input.cwd) throw new Error("[vitehub] crabbox() requires box.cwd.")
      const workspace = resolve(input.cwd)
      const item = await stat(workspace).catch(() => undefined)
      if (!item?.isDirectory()) throw new Error(`[vitehub] Box workspace directory does not exist: ${workspace}`)
      const requirements = input.requirements.map(resolveRequirement)
      const environment = {} as { env: Readonly<Record<string, string | undefined>> }
      Object.defineProperty(environment, "env", { enumerable: false, value: Object.freeze({}) })
      const box = {
        cache: { state: "disposable" },
        environment,
        isolation: "none",
        requirements,
        runtime: "crabbox",
        sandbox: createCrabboxSandbox({
          ...options,
          requirements,
          workspace,
          workRoot: join(dirname(workspace), ".crabbox"),
        }),
        workspace: { path: workspace, state: "authoritative" },
      } as const
      Object.defineProperty(box, "sandbox", { enumerable: false, value: box.sandbox })
      return box
    },
  }
}

const requirementCommands: Record<string, Pick<ResolvedBoxRequirement, "command"> & { args: string[] }> = {
  codex: { args: ["login", "status"], command: "codex" },
  "codex-cli": { args: [], command: "codex" },
  github: { args: ["auth", "status"], command: "gh" },
}

function resolveRequirement(name: string): CrabboxRequirement {
  if (typeof name !== "string" || !name.trim()) throw new Error("[vitehub] Box requirements must be non-empty names.")
  return {
    ...(requirementCommands[name] || { args: [], command: name }),
    name,
  }
}

function createCrabboxSandbox(options: CrabboxSandboxOptions): HarnessV1SandboxProvider {
  return {
    providerId: "crabbox",
    specificationVersion: "harness-sandbox-v1",
    async createSession(createOptions: {
      abortSignal?: AbortSignal
      onFirstCreate?: (session: HarnessV1NetworkSandboxSession, context: { abortSignal?: AbortSignal }) => Promise<void>
      sessionId?: string
    } = {}) {
      await mkdir(options.workRoot, { recursive: true })
      const sessionOptions: CrabboxSessionOptions = {
        ...options,
        stateHome: await mkdtemp(join(tmpdir(), "vitehub-crabbox-state-")),
      }
      try {
        const leaseId = await warmup(sessionOptions, createOptions.abortSignal)
        const setup = await runCrabbox(sessionOptions, leaseId, {
          abortSignal: createOptions.abortSignal,
          command: `root=$(mktemp -d /tmp/vitehub-box.XXXXXX) && trap 'rm -rf -- "$root"' EXIT && workspace=$(pwd -P) && ln -s "$workspace" "$root/workspace" && trap - EXIT && printf '%s\\n%s\\n' "$root" "$workspace"`,
          localWorkingDirectory: options.workspace,
          sync: true,
        })
        if (setup.exitCode !== 0) throw crabboxError("create disposable Box cache", setup)
        const [root, remoteWorkspace] = lastLines(setup.stdout, 2)
        if (!/^\/tmp\/vitehub-box\.[A-Za-z0-9]+$/.test(root)) throw new Error(`[vitehub] Crabbox returned an invalid session root: ${root || "<empty>"}`)
        if (!posix.isAbsolute(remoteWorkspace)) throw new Error(`[vitehub] Crabbox returned an invalid workspace path: ${remoteWorkspace || "<empty>"}`)
        const session = createCrabboxSession({
          leaseId,
          options: sessionOptions,
          pendingTunnels: new Map(),
          processes: new Set(),
          remoteWorkspace,
          root,
          tunnels: new Map(),
        }, createOptions.sessionId)
        try {
          await validateRequirements(session, options.requirements, createOptions.abortSignal)
          await createOptions.onFirstCreate?.(session, { abortSignal: createOptions.abortSignal })
          return session
        }
        catch (error) {
          try {
            await session.destroy?.()
          }
          catch {}
          throw error
        }
      }
      catch (error) {
        await rm(sessionOptions.stateHome, { force: true, recursive: true }).catch(() => undefined)
        throw error
      }
    },
  }
}

function createCrabboxSession(state: CrabboxSessionState, sessionId: string | undefined): HarnessV1NetworkSandboxSession {
  const session = {
    defaultWorkingDirectory: state.root,
    description: "Crabbox session.",
    id: sessionId || randomUUID(),
    ports: [0],
    async destroy() {
      try {
        await this.stop()
        await syncWorkspaceBack(state)
        const result = await runCrabbox(state.options, state.leaseId, { command: `rm -rf -- ${shellQuote(state.root)}` })
        if (result.exitCode !== 0) throw crabboxError("remove disposable Box cache", result)
      }
      finally {
        await rm(state.options.stateHome, { force: true, recursive: true })
      }
    },
    async getPortUrl({ port, protocol = "http" }: { port: number, protocol?: "http" | "https" | "ws" }) {
      if (state.options.network === "direct") return `${protocol}://127.0.0.1:${port}`
      const existing = state.tunnels.get(port)
      if (existing) return `${protocol}://127.0.0.1:${existing.localPort}`
      const pending = state.pendingTunnels.get(port) || startTunnel(state, port)
      state.pendingTunnels.set(port, pending)
      const tunnel = await pending.promise
      return `${protocol}://127.0.0.1:${tunnel.localPort}`
    },
    async readBinaryFile({ abortSignal, path }: { abortSignal?: AbortSignal, path: string }) {
      const remotePath = resolveSessionPath(state.root, path)
      const probe = await this.run({ abortSignal, command: `test -f ${shellQuote(remotePath)}` })
      if (probe.exitCode === 1) return null
      if (probe.exitCode !== 0) throw crabboxError(`read ${path}`, probe)
      const result = await runCrabbox(state.options, state.leaseId, {
        abortSignal,
        command: `base64 < ${shellQuote(remotePath)}`,
      })
      if (result.exitCode !== 0) throw crabboxError(`read ${path}`, result)
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64")
    },
    async readFile(options: { abortSignal?: AbortSignal, path: string }) {
      const bytes = await this.readBinaryFile(options)
      return bytes ? readableStream(bytes) : null
    },
    async readTextFile({ abortSignal, encoding = "utf8", endLine, path, startLine }: { abortSignal?: AbortSignal, encoding?: string, endLine?: number, path: string, startLine?: number }) {
      const bytes = await this.readBinaryFile({ abortSignal, path })
      if (!bytes) return null
      const text = Buffer.from(bytes).toString(encoding as BufferEncoding)
      if (startLine === undefined && endLine === undefined) return text
      return text.split(/\r?\n/).slice((startLine || 1) - 1, endLine).join("\n")
    },
    restricted() {
      return this
    },
    async run(runOptions: CrabboxRunOptions) {
      const child = await this.spawn(runOptions)
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        child.wait(),
      ])
      return { exitCode, stderr, stdout }
    },
    async spawn(runOptions: CrabboxRunOptions) {
      return spawnCrabboxRun(state, runOptions)
    },
    async stop() {
      for (const { child } of state.pendingTunnels.values()) child.kill()
      for (const { child } of state.tunnels.values()) child.kill()
      for (const child of state.processes) child.kill()
      await Promise.all([
        ...state.pendingTunnels.values(),
        ...state.tunnels.values(),
        ...[...state.processes].map(child => ({ child })),
      ].map(({ child }) => waitForExit(child)))
      state.tunnels.clear()
      state.pendingTunnels.clear()
      state.processes.clear()
    },
    async writeBinaryFile({ abortSignal, content, path }: { abortSignal?: AbortSignal, content: Uint8Array, path: string }) {
      const remotePath = resolveSessionPath(state.root, path)
      const directory = posix.dirname(remotePath)
      const prepared = await this.run({ abortSignal, command: `mkdir -p -- ${shellQuote(directory)}` })
      if (prepared.exitCode !== 0) throw crabboxError(`prepare ${path}`, prepared)
      await runCrabboxScript(state.options, state.leaseId, {
        abortSignal,
        script: `set -eu\nbase64 -d > ${shellQuote(remotePath)} <<'VITEHUB_FILE'\n${Buffer.from(content).toString("base64")}\nVITEHUB_FILE\n`,
      })
    },
    async writeFile({ abortSignal, content, path }: { abortSignal?: AbortSignal, content: ReadableStream<Uint8Array>, path: string }) {
      await this.writeBinaryFile({ abortSignal, content: await bytesFromStream(content), path })
    },
    async writeTextFile({ abortSignal, content, encoding = "utf8", path }: { abortSignal?: AbortSignal, content: string, encoding?: string, path: string }) {
      await this.writeBinaryFile({ abortSignal, content: Buffer.from(content, encoding as BufferEncoding), path })
    },
  } satisfies HarnessV1NetworkSandboxSession
  return session
}

async function warmup(options: CrabboxSessionOptions, abortSignal: AbortSignal | undefined) {
  const result = await runProcess(spawnCrabbox(options, [
    "warmup",
    "--provider", "ssh",
    "--target", "linux",
    "--static-work-root", options.workRoot,
    ...(options.reclaim ? ["--reclaim"] : []),
    "--timing-json",
  ], abortSignal))
  if (result.exitCode !== 0) throw crabboxError("warm Crabbox", result)
  const timing = result.stderr.trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith("{"))
  try {
    const leaseId = timing && (JSON.parse(timing) as { leaseId?: unknown }).leaseId
    if (typeof leaseId === "string" && leaseId) return leaseId
  }
  catch {}
  throw new Error("[vitehub] Crabbox warmup did not return a lease id.")
}

function spawnCrabboxRun(state: CrabboxSessionState, options: CrabboxRunOptions) {
  const workingDirectory = resolveSessionPath(state.root, options.workingDirectory)
  const command = shellCommand(options.command, workingDirectory, options.env)
  const child = spawnCrabbox(state.options, runArgs(state.options.workRoot, state.leaseId, command, options.sync !== true), options.abortSignal, options.localWorkingDirectory)
  state.processes.add(child)
  child.once("close", () => state.processes.delete(child))
  return processHandle(child, options.abortSignal)
}

async function runCrabbox(options: CrabboxSessionOptions, leaseId: string, run: CrabboxRunOptions) {
  const command = shellCommand(run.command, undefined, run.env)
  return await runProcess(spawnCrabbox(options, runArgs(options.workRoot, leaseId, command, run.sync !== true), run.abortSignal, run.localWorkingDirectory))
}

function runArgs(workRoot: string, leaseId: string, command: string, noSync: boolean) {
  return [
    "run",
    "--provider", "ssh",
    "--target", "linux",
    "--id", leaseId,
    "--static-work-root", workRoot,
    "--no-hydrate",
    ...(noSync ? ["--no-sync"] : []),
    "--shell", command,
  ]
}

async function runCrabboxScript(options: CrabboxSessionOptions, leaseId: string, run: { abortSignal?: AbortSignal, script: string }) {
  const child = spawnCrabbox(options, [
    "run",
    "--provider", "ssh",
    "--target", "linux",
    "--id", leaseId,
    "--static-work-root", options.workRoot,
    "--no-hydrate",
    "--no-sync",
    "--script-stdin",
  ], run.abortSignal)
  child.stdin.end(run.script)
  const result = await runProcess(child)
  if (result.exitCode !== 0) throw crabboxError("run Crabbox script", result)
}

function startTunnel(state: CrabboxSessionState, remotePort: number) {
  const child = spawnCrabbox(state.options, [
    "tunnel",
    "--provider", "ssh",
    "--target", "linux",
    "--id", state.leaseId,
    "--static-work-root", state.options.workRoot,
    "--port", String(remotePort),
    "--json",
  ])
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", chunk => stderr += chunk)
  const ready = (async () => {
    const line = await firstLine(child.stdout, child)
    let localPort: unknown
    try {
      localPort = (JSON.parse(line) as { port?: unknown }).port
    }
    catch {}
    if (!Number.isInteger(localPort)) {
      child.kill()
      await waitForExit(child)
      throw new Error(`[vitehub] Crabbox tunnel failed${stderr.trim() ? `: ${stderr.trim()}` : "."}`)
    }
    const tunnel = { child, localPort: localPort as number }
    state.tunnels.set(remotePort, tunnel)
    child.once("close", () => {
      if (state.tunnels.get(remotePort)?.child === child) state.tunnels.delete(remotePort)
    })
    return tunnel
  })()
  ready.catch(() => undefined)
  const promise = ready.finally(() => state.pendingTunnels.delete(remotePort))
  promise.catch(() => undefined)
  return { child, promise }
}

async function validateRequirements(session: HarnessV1NetworkSandboxSession, requirements: readonly CrabboxRequirement[], abortSignal: AbortSignal | undefined) {
  for (const requirement of requirements) {
    const command = ["command -v", shellQuote(requirement.command), ">/dev/null"]
    if (requirement.args.length) command.push("&&", shellQuote(requirement.command), ...requirement.args.map(shellQuote))
    const result = await session.run({
      abortSignal,
      command: command.join(" "),
      workingDirectory: posix.join(session.defaultWorkingDirectory, "workspace"),
    })
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(`[vitehub] Box requirement "${requirement.name}" failed${detail ? `: ${detail}` : "."}`)
    }
  }
}

function spawnCrabbox(options: CrabboxSessionOptions, args: string[], abortSignal?: AbortSignal, cwd = options.workRoot) {
  return spawnChildProcess("crabbox", args, {
    cwd,
    env: {
      ...process.env,
      XDG_STATE_HOME: options.stateHome,
      ...(options.profile ? { CRABBOX_PROFILE: options.profile } : {}),
    },
    signal: abortSignal,
  })
}

function processHandle(child: ChildProcessWithoutNullStreams, abortSignal: AbortSignal | undefined) {
  let abortReason: unknown
  const abort = () => abortReason = abortSignal?.reason || new Error("Crabbox command aborted.")
  abortSignal?.addEventListener("abort", abort, { once: true })
  const wait = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
    child.once("error", reject)
    child.once("close", (code) => {
      abortSignal?.removeEventListener("abort", abort)
      if (abortReason) reject(abortReason)
      else resolvePromise({ exitCode: code ?? 1 })
    })
  })
  return {
    pid: child.pid,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    wait: () => wait,
    async kill() {
      child.kill()
      await wait.catch(() => undefined)
    },
  }
}

async function runProcess(child: ChildProcessWithoutNullStreams) {
  const handle = processHandle(child, undefined)
  const [stdout, stderr, { exitCode }] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.wait()])
  return { exitCode, stderr, stdout }
}

function shellCommand(command: string, workingDirectory: string | undefined, env: Record<string, string> | undefined) {
  const parts = []
  if (workingDirectory) parts.push(`cd -P -- ${shellQuote(workingDirectory)}`)
  const names = Object.keys(env || {})
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`[vitehub] Invalid Box environment variable: ${name}`)
  }
  const run = names.length
    ? `env ${names.map(name => `${name}=${shellQuote(env![name])}`).join(" ")} sh -c ${shellQuote(command)}`
    : command
  parts.push(run)
  return parts.join(" && ")
}

function resolveSessionPath(root: string, path = "") {
  const normalizedRoot = posix.normalize(root)
  const candidate = posix.isAbsolute(path)
    ? path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)
      ? posix.normalize(path)
      : posix.join(normalizedRoot, path.replace(/^\/+/, ""))
    : posix.join(normalizedRoot, path)
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`[vitehub] Crabbox path escapes the session root: ${path}`)
  }
  return candidate
}

function readableStream(bytes: Uint8Array) {
  return new Response(bytes).body!
}

async function bytesFromStream(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return await new Response(stream).text()
}

async function withTemporaryFile<T>(run: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-box-"))
  try {
    return await run(join(directory, "file"))
  }
  finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function syncWorkspaceBack(state: CrabboxSessionState) {
  const result = await runCrabbox(state.options, state.leaseId, {
    command: `archive=$(mktemp /tmp/vitehub-workspace.XXXXXX.tar) && trap 'rm -f -- "$archive"' EXIT && tar -C ${shellQuote(state.remoteWorkspace)} -cf "$archive" . && base64 < "$archive"`,
  })
  if (result.exitCode !== 0) throw crabboxError("sync Crabbox workspace", result)
  const archive = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64")
  const extractedWorkspace = await mkdtemp(join(dirname(state.options.workspace), ".vitehub-workspace-"))
  await withTemporaryFile(async (localPath) => {
    try {
      await writeFile(localPath, archive)
      const extract = await runProcess(spawnChildProcess("tar", ["-xf", localPath, "-C", extractedWorkspace]))
      if (extract.exitCode !== 0) throw crabboxError("extract Crabbox workspace", extract)
      await rm(state.options.workspace, { force: true, recursive: true })
      await rename(extractedWorkspace, state.options.workspace)
    }
    catch (error) {
      await rm(extractedWorkspace, { force: true, recursive: true })
      throw error
    }
  })
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function lastLines(value: string, count: number) {
  return value.trim().split(/\r?\n/).slice(-count)
}

function crabboxError(action: string, result: { stderr: string, stdout: string }) {
  const detail = result.stderr.trim() || result.stdout.trim()
  return new Error(`[vitehub] Failed to ${action}${detail ? `: ${detail}` : "."}`)
}

function firstLine(stream: NodeJS.ReadableStream, child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let value = ""
    const data = (chunk: Buffer | string) => {
      value += chunk.toString()
      const index = value.indexOf("\n")
      if (index < 0) return
      cleanup()
      resolvePromise(value.slice(0, index))
    }
    const close = () => {
      cleanup()
      reject(new Error("[vitehub] Crabbox tunnel exited before readiness."))
    }
    const error = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    const cleanup = () => {
      stream.off("data", data)
      child.off("close", close)
      child.off("error", error)
    }
    stream.on("data", data)
    child.once("close", close)
    child.once("error", error)
  })
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolvePromise => child.once("close", () => resolvePromise()))
}
