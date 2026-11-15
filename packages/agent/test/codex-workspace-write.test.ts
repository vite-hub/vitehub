import { execFile } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { SandboxSession } from "@vite-hub/sandbox"
import { describe, expect, it } from "vitest"
import { codexWorkspaceWritePolicy } from "../src/internal/codex-workspace-write.ts"

const exec = promisify(execFile)

describe("codexWorkspaceWritePolicy", () => {
  it("reads package caches inside the Sandbox instead of the host", async () => {
    const home = await mkdtemp(join(tmpdir(), "vitehub-sandbox-caches-"))
    const store = join(home, "pnpm-store")
    // SAFETY: The policy only calls exec on the Sandbox session.
    const sandbox = {
      exec: async (command: string, args: string[]) => {
        const result = await exec(command, args, { env: { PATH: process.env.PATH, HOME: home, npm_config_store_dir: store } })
        return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
      },
    } as unknown as SandboxSession
    try {
      await expect(codexWorkspaceWritePolicy({ packageCaches: true }, { sandbox })).resolves.toEqual({
        type: "workspaceWrite",
        networkAccess: false,
        writableRoots: [store, join(home, ".local/share/pnpm"), join(home, ".cache/pnpm"), join(home, ".cache/node/corepack"), join(home, ".npm")],
      })
      await expect(stat(store)).resolves.toMatchObject({})
    }
    finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("adds nothing when no access is granted", async () => {
    await expect(codexWorkspaceWritePolicy({}, { environment: {} })).resolves.toBeUndefined()
    await expect(codexWorkspaceWritePolicy(undefined, { environment: {} })).resolves.toBeUndefined()
  })
})
