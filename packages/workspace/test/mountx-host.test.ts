import { createLoopback } from "mountx"
import { unknownExecutionAuthority } from "@vite-hub/runtime"
import { describe, expect, it, vi } from "vitest"

import { defineWorkspace } from "../src/core/define.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { tryCreateMountXHostedWorkspaceSession } from "../src/session/mountx-host.ts"

import type { Loopback } from "mountx"
import type { WorkspaceSessionHost } from "../src/core/types.ts"

function workspace() {
  return createWorkspace({
    ...defineWorkspace({ store: { provider: "memory" } }),
    name: "mounted-host",
  })
}

describe("MountX hosted Workspace sessions", () => {
  it("projects capable local hosts without materializing Workspace files", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before")
    await docs.snapshot({ name: "baseline" })

    let projected: Loopback | undefined
    let mounts = 0
    let restores = 0
    let unmounts = 0
    const unexpected = vi.fn(() => {
      throw new Error("copy-based host access is not expected")
    })
    const host: WorkspaceSessionHost = {
      executionAuthority: unknownExecutionAuthority,
      files: {
        exists: unexpected,
        async localPath(path) {
          expect(path).toBe("/workspace")
          return "/private/session/workspace"
        },
        list: unexpected,
        async mkdir() {},
        read: unexpected,
        async remove() {},
        write: unexpected,
      },
      async exec(command, args = []) {
        if (command !== "write" || !projected)
          return { code: 127, stderr: `Unsupported command: ${command}`, stdout: "" }
        await projected.writeFile(`/${args[0]}`, args[1] || "")
        return { code: 0, stderr: "", stdout: "" }
      },
    }

    const session = await tryCreateMountXHostedWorkspaceSession(
      docs,
      { host },
      {
        async mount(driver, mountpoint) {
          expect(mountpoint).toBe("/private/session/workspace")
          mounts += 1
          projected = createLoopback(driver)
          return {
            async unmount() {
              unmounts += 1
              projected = undefined
            },
          }
        },
      },
      async () => {
        restores += 1
      },
    )

    expect(session).toBeDefined()
    expect(await session!.exec("write", ["result.txt", "done"])).toMatchObject({ exitCode: 0 })
    await expect(session!.readFile("result.txt")).resolves.toBe("done")
    await expect(docs.exists("result.txt")).resolves.toBe(false)

    await session!.commit({ message: "accept mounted result" })
    await session!.close()

    await expect(docs.readFile("result.txt")).resolves.toBe("done")
    expect({ mounts, restores, unmounts }).toEqual({ mounts: 2, restores: 1, unmounts: 2 })
    expect(unexpected).not.toHaveBeenCalled()
  })
})
