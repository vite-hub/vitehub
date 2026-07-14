import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, rename, rm, rmdir, stat, writeFile } from "node:fs/promises"
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
  /** Enables loopback port URLs when the target shares the ViteHub process network namespace. */
  network?: "direct"
  profile?: string
  /** Replaces an existing static lease for the shared sibling-workspace root. */
  reclaim?: boolean
}

interface CrabboxSandboxOptions extends CrabboxOptions {
  requirements: readonly CrabboxRequirement[]
  workspace: string
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
  remoteWorkspace: string
  root: string
  syncedWorkspacePaths: readonly string[]
}

export function crabbox(options: CrabboxOptions = {}): BoxRuntime {
  return {
    name: "crabbox",
    async resolve(input: ResolvedBoxInput) {
      if (!input.cwd) throw new Error("[vitehub] crabbox() requires box.cwd.")
      if (input.home) throw new Error("[vitehub] crabbox() does not support box.home; configure the remote user Home through Crabbox.")
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
        const syncedWorkspacePaths = await listRemoteWorkspacePaths(sessionOptions, leaseId, remoteWorkspace)
        const session = createCrabboxSession({
          leaseId,
          options: sessionOptions,
          processes: new Set(),
          remoteWorkspace,
          root,
          syncedWorkspacePaths,
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
      if (state.options.network !== "direct") throw new Error("[vitehub] Crabbox Static SSH does not support port forwarding. Set network: \"direct\" only when the target shares the ViteHub process loopback network namespace.")
      return `${protocol}://127.0.0.1:${port}`
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
      for (const child of state.processes) child.kill()
      await Promise.all([...state.processes].map(child => waitForExit(child)))
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
    ...(options.reclaim ? ["--reclaim"] : []),
    "--timing-json",
  ], abortSignal, options.workspace))
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
  const child = spawnCrabbox(state.options, runArgs(state.leaseId, command, options.sync !== true), options.abortSignal, options.localWorkingDirectory)
  state.processes.add(child)
  child.once("close", () => state.processes.delete(child))
  return processHandle(child, options.abortSignal)
}

async function runCrabbox(options: CrabboxSessionOptions, leaseId: string, run: CrabboxRunOptions) {
  const command = shellCommand(run.command, undefined, run.env)
  return await runProcess(spawnCrabbox(options, runArgs(leaseId, command, run.sync !== true), run.abortSignal, run.localWorkingDirectory))
}

function runArgs(leaseId: string, command: string, noSync: boolean) {
  return [
    "run",
    "--provider", "ssh",
    "--target", "linux",
    "--id", leaseId,
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
    "--no-hydrate",
    "--no-sync",
    "--script-stdin",
  ], run.abortSignal)
  child.stdin.end(run.script)
  const result = await runProcess(child)
  if (result.exitCode !== 0) throw crabboxError("run Crabbox script", result)
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

function spawnCrabbox(options: CrabboxSessionOptions, args: string[], abortSignal?: AbortSignal, cwd = options.workspace) {
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
    command: `archive=$(mktemp /tmp/vitehub-workspace.XXXXXX.tar) && manifest=$(mktemp /tmp/vitehub-workspace.XXXXXX.manifest) && trap 'rm -f -- "$archive" "$manifest"' EXIT && if git -C ${shellQuote(state.remoteWorkspace)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -C ${shellQuote(state.remoteWorkspace)} ls-files -z --cached --others --exclude-standard > "$manifest" && tar --ignore-failed-read --null -C ${shellQuote(state.remoteWorkspace)} -cf "$archive" -T "$manifest"; else tar -C ${shellQuote(state.remoteWorkspace)} --exclude ./.git --exclude .git -cf "$archive" .; fi && base64 < "$archive"`,
  })
  if (result.exitCode !== 0) throw crabboxError("sync Crabbox workspace", result)
  const archive = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64")
  const transactionRoot = await mkdtemp(join(dirname(state.options.workspace), ".vitehub-workspace-"))
  const stagedWorkspace = join(transactionRoot, "workspace")
  const backupWorkspace = join(transactionRoot, "backup")
  await withTemporaryFile(async (localPath) => {
    try {
      await writeFile(localPath, archive)
      await cp(state.options.workspace, stagedWorkspace, { recursive: true })
      await rejectSymlinkedArchiveParents(stagedWorkspace, localPath)
      await pruneWorkspaceForArchive(stagedWorkspace, localPath, state.syncedWorkspacePaths)
      const extract = await runProcess(spawnChildProcess("tar", ["-xf", localPath, "-C", stagedWorkspace]))
      if (extract.exitCode !== 0) throw crabboxError("extract Crabbox workspace", extract)
      await rename(state.options.workspace, backupWorkspace)
      try {
        await rename(stagedWorkspace, state.options.workspace)
      }
      catch (error) {
        await rename(backupWorkspace, state.options.workspace)
        throw error
      }
    }
    catch (error) {
      throw error
    }
    finally {
      await rm(transactionRoot, { force: true, recursive: true })
    }
  })
}

async function listRemoteWorkspacePaths(options: CrabboxSessionOptions, leaseId: string, workspace: string) {
  const result = await runCrabbox(options, leaseId, {
    command: `if git -C ${shellQuote(workspace)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -C ${shellQuote(workspace)} ls-files -z --cached --others --exclude-standard; else cd ${shellQuote(workspace)} && find . -mindepth 1 \\( -name .git -o -path '*/.git/*' \\) -prune -o \\( -type f -o -type l \\) -exec printf '%s\\0' {} +; fi`,
  })
  if (result.exitCode !== 0) throw crabboxError("inspect Crabbox workspace", result)
  return result.stdout
    .split("\0")
    .map(path => normalizeRelativeArchivePath(path))
    .filter((path): path is string => Boolean(path))
}

export async function rejectSymlinkedArchiveParents(workspace: string, archivePath: string): Promise<void> {
  await rejectSymlinkedParents(workspace, await listArchiveEntries(archivePath))
}

async function rejectSymlinkedParents(workspace: string, entries: readonly string[]) {
  const checked = new Set<string>()
  for (const entry of entries) {
    const parts = entry.split("/")
    for (let length = 1; length < parts.length; length++) {
      const path = parts.slice(0, length).join("/")
      if (checked.has(path)) continue
      checked.add(path)
      const item = await lstat(join(workspace, path)).catch(() => undefined)
      if (item?.isSymbolicLink()) throw new Error(`[vitehub] Crabbox workspace archive conflicts with local symlink: ${path}`)
    }
  }
}

export async function pruneWorkspaceForArchive(workspace: string, archivePath: string, manifest: readonly string[]): Promise<void> {
  if (!manifest.length) return
  const archive = await listArchiveEntries(archivePath)
  const archived = new Set(archive)
  const removed = manifest.filter(path => !archived.has(path))
  await rejectSymlinkedParents(workspace, removed)
  await Promise.all(removed.map(async (path) => {
    await rm(join(workspace, path), { force: true, recursive: true })
  }))
  const parents = [...new Set(removed.flatMap((path) => {
    const parts = path.split("/")
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"))
  }))].sort((a, b) => b.length - a.length)
  for (const path of parents) {
    await rmdir(join(workspace, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error
    })
  }
}

async function listArchiveEntries(archivePath: string) {
  const result = await runProcess(spawnChildProcess("tar", ["-tf", archivePath]))
  if (result.exitCode !== 0) throw crabboxError("inspect Crabbox workspace", result)
  return result.stdout
    .split(/\r?\n/)
    .map(path => normalizeRelativeArchivePath(path))
    .filter((path): path is string => Boolean(path))
}

function normalizeRelativeArchivePath(path: string) {
  const normalized = posix.normalize(path.replace(/^\.\//, "").replace(/\/$/, ""))
  if (!normalized || normalized === "." || normalized.startsWith("../") || posix.isAbsolute(normalized)) return undefined
  return normalized
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

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>(resolvePromise => child.once("close", () => resolvePromise()))
}
