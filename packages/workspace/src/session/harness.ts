import { Buffer } from "node:buffer"
import { unknownExecutionAuthority } from "@vite-hub/runtime"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { resolveWorkspaceAutoCommit } from "../core/rules.ts"
import { isMissingWorkspacePathError } from "./scope.ts"

import type { ExecutionAuthority } from "@vite-hub/runtime"
import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade } from "../core/use.ts"
import type {
  WorkspaceDefinition,
  WorkspaceDiff,
  WorkspaceMaterializeSourcesOptions,
  WorkspacePrepareSessionProgressEvent,
  WorkspaceSession,
  WorkspaceSessionHost,
  WorkspaceSessionHostFileEntry,
  WorkspaceSessionOptions,
} from "../core/types.ts"

export interface HarnessSandboxSession {
  readBinaryFile?(options: { abortSignal?: AbortSignal, path: string }): PromiseLike<Uint8Array | null>
  run(options: { abortSignal?: AbortSignal, command: string, env?: Record<string, string>, workingDirectory?: string }): PromiseLike<{ exitCode: number, stderr?: string, stdout?: string }>
  workspaceHost?: WorkspaceSessionHost
  writeBinaryFile(options: { abortSignal?: AbortSignal, content: Uint8Array, path: string }): PromiseLike<void>
}

export interface HarnessWorkspaceSession {
  close(error?: unknown): Promise<void>
  refreshGitBaseline(): Promise<void>
}

export interface PrepareHarnessWorkspaceSessionOptions {
  abortSignal?: AbortSignal
  commit?: (diff: WorkspaceDiff) => { message?: string } | false | null | undefined
  definition?: WorkspaceDefinition
  executionAuthority?: ExecutionAuthority
  ignoreWriteBackPaths?: readonly string[]
  onMaterializeProgress?: WorkspaceMaterializeSourcesOptions["onProgress"]
  onProgress?: (event: WorkspacePrepareSessionProgressEvent) => void | Promise<void>
  onWriteBack?: (diff: WorkspaceDiff) => void | Promise<void>
  paths?: readonly string[]
  session: HarnessSandboxSession
  sessionWorkDir: string
}

type WorkspaceFacade = ReadonlyWorkspaceFacade | WritableWorkspaceFacade
type SourceMaterializer = (options?: WorkspaceMaterializeSourcesOptions) => Promise<unknown>
type WorkspaceFsWithSession = {
  materializeSources?: SourceMaterializer
  startSession?: (options?: WorkspaceSessionOptions) => Promise<WorkspaceSession>
}

function isWritableWorkspaceFacade(workspace: WorkspaceFacade): workspace is WritableWorkspaceFacade {
  return "startSession" in workspace && typeof workspace.startSession === "function"
}

function workspaceSourceMaterializer(workspace: WorkspaceFacade): SourceMaterializer | undefined {
  if ("materializeSources" in workspace && typeof workspace.materializeSources === "function") {
    return options => workspace.materializeSources(options)
  }
  const materializeSources = (workspace.fs as WorkspaceFsWithSession).materializeSources
  if (typeof materializeSources === "function") return options => materializeSources(options)
}

function workspaceSessionStarter(workspace: WorkspaceFacade) {
  if (isWritableWorkspaceFacade(workspace)) return workspace.startSession.bind(workspace)
  const startSession = (workspace.fs as WorkspaceFsWithSession).startSession
  if (!startSession) throw new Error("[vitehub] Harness Workspace materialization requires Workspace Session support.")
  return startSession
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function normalizeSessionPaths(paths?: readonly string[]): string[] | undefined {
  if (paths === undefined) return undefined
  const normalized = [...new Set(paths.map(path => normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })))]
  if (normalized.includes("")) return undefined
  return normalized.sort((left, right) => left.length - right.length || left.localeCompare(right))
}

async function withPrepareProgress<T>(
  onProgress: PrepareHarnessWorkspaceSessionOptions["onProgress"],
  event: Pick<WorkspacePrepareSessionProgressEvent, "id" | "label"> & { data?: Record<string, unknown> },
  fn: () => Promise<T>,
) {
  const startedAt = Date.now()
  await onProgress?.({ data: event.data, id: event.id, label: event.label, status: "started" })
  try {
    const result = await fn()
    await onProgress?.({ data: event.data, durationMs: Date.now() - startedAt, id: event.id, label: event.label, status: "completed" })
    return result
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await onProgress?.({ data: { ...event.data, error: message }, durationMs: Date.now() - startedAt, error: message, id: event.id, label: event.label, status: "failed" })
    throw error
  }
}

async function materializeWorkspaceSourcesForSession(
  workspace: WorkspaceFacade,
  paths: string[] | undefined,
  options: Pick<WorkspaceMaterializeSourcesOptions, "abortSignal" | "onProgress">,
) {
  const materialize = workspaceSourceMaterializer(workspace)
  if (!materialize || (paths && !paths.length)) return
  await Promise.all((paths || [""]).map(async (path) => {
    await materialize({ ...options, path }).catch((error) => {
      if (path && isMissingWorkspacePathError(error)) return
      throw error
    })
  }))
}

function parseHostEntries(stdout: string): WorkspaceSessionHostFileEntry[] {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [type, size, encoded] = line.split("\t")
    if ((type !== "directory" && type !== "file" && type !== "symlink") || !encoded) {
      throw new Error("[vitehub] Harness Workspace host returned an invalid file entry.")
    }
    return {
      path: Buffer.from(encoded, "base64").toString("utf8"),
      ...(size ? { size: Number(size) } : {}),
      type,
    }
  })
}

function harnessWorkspaceHost(options: PrepareHarnessWorkspaceSessionOptions): {
  detachAbortSignal: () => void
  host: WorkspaceSessionHost
} {
  const sandbox = options.session
  if (sandbox.workspaceHost) {
    return {
      detachAbortSignal() {},
      host: {
        executionAuthority: options.executionAuthority || sandbox.workspaceHost.executionAuthority,
        files: sandbox.workspaceHost.files,
        exec: (command, args, execOptions) => sandbox.workspaceHost!.exec(command, args, execOptions),
      },
    }
  }
  let abortSignal = options.abortSignal
  const run = async (command: string, args: readonly string[] = [], runOptions: { cwd?: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal } = {}) => {
    const result = await sandbox.run({
      abortSignal: runOptions.signal || abortSignal,
      command: [command, ...args].map(shellQuote).join(" "),
      ...(runOptions.cwd ? { workingDirectory: runOptions.cwd } : {}),
      ...(runOptions.env ? { env: { ...runOptions.env } } : {}),
    })
    return { code: result.exitCode, stderr: result.stderr || "", stdout: result.stdout || "" }
  }

  const host: WorkspaceSessionHost = {
    executionAuthority: options.executionAuthority || unknownExecutionAuthority,
    files: {
      async exists(path) {
        return (await run("sh", ["-c", `test -e "$1" || test -L "$1"`, "sh", path])).code === 0
      },
      async list(path, listOptions) {
        const depth = listOptions?.recursive ? "" : " -maxdepth 1"
        const command = `find "$1" -mindepth 1${depth} -exec sh -c 'for path do if [ -L "$path" ]; then type=symlink; size=; elif [ -d "$path" ]; then type=directory; size=; else type=file; size=$(wc -c < "$path") || exit $?; fi; encoded=$(printf %s "$path" | base64 | tr -d "\\n") || exit $?; printf "%s\\t%s\\t%s\\n" "$type" "$size" "$encoded"; done' sh {} +`
        const result = await run("sh", ["-c", command, "sh", path])
        if (result.code !== 0) throw new Error(`[vitehub] Failed to list Harness Workspace host: ${result.stderr || "find failed"}`)
        return parseHostEntries(result.stdout)
      },
      async mkdir(path, mkdirOptions) {
        const result = await run("mkdir", [...(mkdirOptions?.recursive ? ["-p"] : []), "--", path])
        if (result.code !== 0) throw new Error(`[vitehub] Failed to create Harness Workspace directory: ${result.stderr || "mkdir failed"}`)
      },
      async read(path) {
        if (!sandbox.readBinaryFile) throw new Error("[vitehub] Harness Workspace Session requires sandbox.readBinaryFile.")
        return await sandbox.readBinaryFile({ abortSignal, path })
      },
      async remove(path, removeOptions) {
        const result = removeOptions?.recursive
          ? await run("rm", ["-rf", "--", path])
          : await run("rm", ["-f", "--", path])
        if (result.code !== 0) throw new Error(`[vitehub] Failed to remove Harness Workspace path: ${result.stderr || "remove failed"}`)
      },
      async write(path, content) {
        await sandbox.writeBinaryFile({ abortSignal, content, path })
      },
    },
    exec: run,
  }
  return {
    detachAbortSignal() {
      abortSignal = undefined
    },
    host,
  }
}

async function initializeSandboxGitBaseline(session: WorkspaceSession, onProgress: PrepareHarnessWorkspaceSessionOptions["onProgress"]) {
  await withPrepareProgress(onProgress, {
    id: "workspace.prepare.git-status",
    label: "Preparing workspace status",
  }, async () => {
    await session.exec("sh", ["-c", "if command -v git >/dev/null 2>&1; then git init -q && git config user.email vitehub@example.invalid && git config user.name ViteHub && git add -A -f && git commit --allow-empty --no-gpg-sign --no-verify -qm workspace-baseline || true; fi"])
  })
}

export async function prepareHarnessWorkspaceSession(
  workspace: WorkspaceFacade,
  options: PrepareHarnessWorkspaceSessionOptions,
): Promise<HarnessWorkspaceSession> {
  const paths = normalizeSessionPaths(options.paths)
  await withPrepareProgress(options.onProgress, {
    data: { paths: paths ?? null },
    id: "workspace.prepare.materialize",
    label: "Materializing workspace sources",
  }, async () => await materializeWorkspaceSourcesForSession(workspace, paths, {
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.onMaterializeProgress ? { onProgress: options.onMaterializeProgress } : {}),
  }))

  const sessionHost = harnessWorkspaceHost(options)
  const session = await withPrepareProgress(options.onProgress, {
    data: { paths: paths ?? null },
    id: "workspace.prepare.start-session",
    label: "Starting workspace session",
  }, async () => await workspaceSessionStarter(workspace)({
    abortSignal: options.abortSignal,
    host: sessionHost.host,
    onProgress: options.onProgress,
    paths,
    target: options.sessionWorkDir,
    writeBack: { exclude: options.ignoreWriteBackPaths },
  }))
  await initializeSandboxGitBaseline(session, options.onProgress)

  return {
    async close(error?: unknown) {
      try {
        if (error || !isWritableWorkspaceFacade(workspace)) return
        const diff = await session.diff()
        if (!diff.entries.length) return
        if (options.commit) {
          const commit = options.commit(diff)
          if (!commit) return
          await session.commit({ message: commit.message || "harness-workspace-session" })
          await options.onWriteBack?.(diff)
          return
        }
        const autoCommit = options.definition ? resolveWorkspaceAutoCommit(options.definition, diff) : undefined
        if (options.definition && !autoCommit) return
        await session.commit({ message: autoCommit?.message || "harness-workspace-session" })
        await options.onWriteBack?.(diff)
      }
      finally {
        sessionHost.detachAbortSignal()
        await session.close()
      }
    },
    async refreshGitBaseline() {
      await initializeSandboxGitBaseline(session, options.onProgress)
    },
  }
}
