import { normalizeExecutionAuthority } from "@vite-hub/runtime"

import { workspaceError } from "../core/errors.ts"
import { createWorkspaceDriver } from "../mountx.ts"
import { createBasicWorkspaceSession } from "./basic.ts"
import { normalizeHostTarget, toHostCwd } from "./host-path.ts"

import type { FsDriver } from "mountx"
import type { Workspace, WorkspaceSession, WorkspaceSessionOptions } from "../core/types.ts"

interface WorkspaceMount {
  unmount(): Promise<void>
}

interface WorkspaceMounter {
  mount(driver: FsDriver, mountpoint: string): Promise<WorkspaceMount>
}

export async function tryCreateMountXHostedWorkspaceSession(
  workspace: Workspace,
  options: WorkspaceSessionOptions & { host: NonNullable<WorkspaceSessionOptions["host"]> },
  mounter?: WorkspaceMounter,
  restoreHost?: () => Promise<void>,
): Promise<WorkspaceSession | undefined> {
  if (options.attach || !options.host.files.localPath) return undefined

  let resolvedMounter = mounter
  if (!resolvedMounter) {
    try {
      const auto = await import("mountx/auto")
      if (!(await auto.probeTransports()).chosen) return undefined
      resolvedMounter = {
        async mount(driver, mountpoint) {
          return await auto.mount(driver, mountpoint, { signals: false })
        },
      }
    }
    catch {
      return undefined
    }
  }
  const activeMounter = resolvedMounter

  let executionAuthority
  try {
    executionAuthority = normalizeExecutionAuthority(options.host.executionAuthority)
  }
  catch {
    throw new TypeError("[vitehub] Workspace session host must declare executionAuthority.")
  }

  const root = normalizeHostTarget(options.target)
  const session = await createBasicWorkspaceSession(workspace, options)
  let mounted: WorkspaceMount | undefined
  let closed = false

  try {
    await options.host.files.remove(root, { recursive: true }).catch(() => undefined)
    await options.host.files.mkdir(root, { recursive: true })
    const localPath = await options.host.files.localPath(root)
    mounted = await activeMounter.mount(createWorkspaceDriver(session), localPath)
  }
  catch {
    await session.close()
    return undefined
  }

  function assertOpen() {
    if (closed) throw workspaceError("[vitehub] Workspace host session is already closed.")
  }

  async function project() {
    const localPath = await options.host.files.localPath!(root)
    mounted = await activeMounter.mount(createWorkspaceDriver(session), localPath)
  }

  async function unmount() {
    const current = mounted
    await current?.unmount()
    if (mounted === current) mounted = undefined
  }

  return {
    executionAuthority,
    async readFile(path, readOptions) {
      assertOpen()
      return await session.readFile(path, readOptions)
    },
    async writeFile(path, content, writeOptions) {
      assertOpen()
      await session.writeFile(path, content, writeOptions)
    },
    async mkdir(path, mkdirOptions) {
      assertOpen()
      await session.mkdir(path, mkdirOptions)
    },
    async rm(path, rmOptions) {
      assertOpen()
      await session.rm(path, rmOptions)
    },
    async list(path, listOptions) {
      assertOpen()
      return await session.list(path, listOptions)
    },
    async glob(pattern, globOptions) {
      assertOpen()
      return await session.glob(pattern, globOptions)
    },
    async search(query) {
      assertOpen()
      return await session.search(query)
    },
    async diff() {
      assertOpen()
      return await session.diff()
    },
    async commit(commitOptions) {
      assertOpen()
      await unmount()
      let commitError: unknown
      try {
        await session.commit(commitOptions)
      }
      catch (error) {
        commitError = error
      }
      try {
        await project()
      }
      catch (mountError) {
        closed = true
        const failures = commitError ? [commitError, mountError] : [mountError]
        await session.close().catch(error => failures.push(error))
        await restoreHost?.().catch(error => failures.push(error))
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "[vitehub] Workspace commit and remount failed.")
      }
      if (commitError) throw commitError
    },
    async exec(command, args = [], execOptions = {}) {
      assertOpen()
      const result = await options.host.exec(command, args, {
        cwd: toHostCwd(root, execOptions.cwd),
        env: execOptions.env,
        signal: execOptions.abortSignal,
        timeout: execOptions.timeout,
      })
      return { args, command, exitCode: result.code, stderr: result.stderr, stdout: result.stdout }
    },
    async close() {
      if (closed) return
      closed = true
      const failures: unknown[] = []
      let unmounted = true
      await unmount().catch((error) => {
        unmounted = false
        failures.push(error)
      })
      await session.close().catch(error => failures.push(error))
      if (unmounted) await restoreHost?.().catch(error => failures.push(error))
      if (failures.length) throw new AggregateError(failures, "[vitehub] Failed to close the mounted Workspace session.")
    },
  }
}
