import { posix } from "node:path"

import type {
  ReadonlyWorkspaceFacade,
  WritableWorkspaceFacade,
} from "../core/use.ts"
import type {
  WorkspaceEntry,
  WorkspaceSession,
} from "../core/types.ts"

export interface HarnessSandboxSession {
  readBinaryFile?(options: { abortSignal?: AbortSignal, path: string }): PromiseLike<Uint8Array | null>
  run?(options: { abortSignal?: AbortSignal, command: string, workingDirectory?: string }): PromiseLike<{ exitCode: number, stderr: string, stdout: string }>
  writeBinaryFile(options: { abortSignal?: AbortSignal, content: Uint8Array, path: string }): PromiseLike<void>
}

export interface HarnessWorkspaceSession {
  close(error?: unknown): Promise<void>
}

export interface PrepareHarnessWorkspaceSessionOptions {
  abortSignal?: AbortSignal
  session: HarnessSandboxSession
  sessionWorkDir: string
}

type WorkspaceFacade = ReadonlyWorkspaceFacade | WritableWorkspaceFacade

function isWritableWorkspaceFacade(workspace: WorkspaceFacade): workspace is WritableWorkspaceFacade {
  return "startSession" in workspace && typeof workspace.startSession === "function"
}

function sandboxPath(root: string, path: string) {
  return posix.join(root, path)
}

function workspaceFiles(entries: WorkspaceEntry[]) {
  return entries
    .filter(entry => entry.type === "file")
    .map(entry => entry.path)
    .sort((left, right) => left.localeCompare(right))
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array) {
  if (!left || left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function pathsFromFindOutput(stdout: string) {
  return stdout
    .split("\n")
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => path.replace(/^\.\//, ""))
    .filter(path => path && path !== ".")
    .sort((left, right) => left.localeCompare(right))
}

async function copyWorkspaceToSandbox(
  workspace: WorkspaceFacade,
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  abortSignal: AbortSignal | undefined,
) {
  const files = workspaceFiles(await workspace.fs.list("", { recursive: true }))
  const initialFiles = new Map<string, Uint8Array>()
  for (const path of files) {
    const content = await workspace.fs.readFile(path, { encoding: "binary" })
    initialFiles.set(path, content)
    await sandbox.writeBinaryFile({
      abortSignal,
      content,
      path: sandboxPath(sessionWorkDir, path),
    })
  }
  return initialFiles
}

async function copySandboxChangesToWorkspace(
  session: WorkspaceSession,
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  initialFiles: Map<string, Uint8Array>,
  abortSignal: AbortSignal | undefined,
) {
  if (!sandbox.run || !sandbox.readBinaryFile) return
  const result = await sandbox.run({
    abortSignal,
    command: "find . -type f -print",
    workingDirectory: sessionWorkDir,
  })
  if (result.exitCode !== 0) {
    throw new Error(`[vitehub] Failed to inspect Harness Workspace Session files: ${result.stderr || "find failed"}`)
  }

  for (const path of pathsFromFindOutput(result.stdout)) {
    const content = await sandbox.readBinaryFile({
      abortSignal,
      path: sandboxPath(sessionWorkDir, path),
    })
    if (!content || bytesEqual(initialFiles.get(path), content)) continue
    await session.writeFile(path, content)
  }

  // ponytail: deletions wait until WorkspaceSession exposes rm; additions and updates still commit through Workspace rules.
  const diff = await session.diff()
  if (diff.entries.length) await session.commit({ message: "harness-workspace-session" })
}

export async function prepareHarnessWorkspaceSession(
  workspace: WorkspaceFacade,
  options: PrepareHarnessWorkspaceSessionOptions,
): Promise<HarnessWorkspaceSession> {
  const initialFiles = await copyWorkspaceToSandbox(workspace, options.session, options.sessionWorkDir, options.abortSignal)
  const workspaceSession = isWritableWorkspaceFacade(workspace)
    ? await workspace.startSession()
    : undefined

  return {
    async close(error?: unknown) {
      try {
        if (!error && workspaceSession) {
          await copySandboxChangesToWorkspace(
            workspaceSession,
            options.session,
            options.sessionWorkDir,
            initialFiles,
            options.abortSignal,
          )
        }
      }
      finally {
        await workspaceSession?.close()
      }
    },
  }
}
