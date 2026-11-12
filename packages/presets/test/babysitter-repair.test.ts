import { describe, expect, it, vi } from "vitest"

import type { GitHubPullRequestOperations } from "../src/github/index.ts"
import { resolveAgentCapabilities } from "../../agent/src/capability-runtime.ts"
import { repairCapability } from "../src/babysitter/repair.ts"
import { GitHubWorkspaceInstallError } from "../src/github/install.ts"

function operations() {
  const mention = vi.fn(async () => {})
  // SAFETY: The repair capability calls only `mention` in these tests.
  return { operations: { mention } as unknown as GitHubPullRequestOperations, mention }
}

const resolveTools = async (definition: ReturnType<typeof repairCapability>) =>
  (await resolveAgentCapabilities({ capabilities: [definition] }, {
    capabilities: {}, memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn(),
  }, {})).tools

describe("Babysitter repair capability", () => {
  it("exposes accepted mention logins and omits unconfigured mentions", async () => {
    const f = operations()
    const capability = repairCapability(f.operations, false, [" stefina ", "MAXI", "octocat-", "octo--cat"])
    const mention = (await resolveTools(capability))?.mentionOnPullRequest
    expect(mention?.inputSchema).toMatchObject({ properties: { login: { type: "string", enum: ["stefina", "maxi"] } } })
    if (!mention?.execute) throw new Error("Missing configured mention tool.")
    await mention.execute({ login: "stefina", body: "Please restore the service." })
    expect(f.mention).toHaveBeenCalledWith("stefina", "Please restore the service.")
    expect(await resolveTools(repairCapability(f.operations, false))).not.toHaveProperty("mentionOnPullRequest")
    expect(await resolveTools(repairCapability(f.operations, false, [" "]))).not.toHaveProperty("mentionOnPullRequest")
    expect(await resolveTools(repairCapability(f.operations, false, ["octocat-", "octo--cat"]))).not.toHaveProperty("mentionOnPullRequest")
  })

  it("joins a refresh that is still running and refunds the refresh allowance for a retryable failure", async () => {
    let finish = () => {}
    const pending = new Promise<void>(resolve => { finish = resolve })
    const refreshDependencies = vi.fn(async () => { await pending })
    let charges = 0
    const workspace = {
      beforeRepair: async () => {},
      afterRefresh: async () => {},
      admitRefresh: () => { charges++; return () => { charges-- } },
    }
    // SAFETY: The repair capability calls only refreshDependencies in this test.
    const tools = await resolveTools(repairCapability({ refreshDependencies } as unknown as GitHubPullRequestOperations, false, [], undefined, workspace))
    const first = tools?.refreshDependencies?.execute?.({})
    const retry = tools?.refreshDependencies?.execute?.({})
    finish()
    await expect(Promise.all([first, retry])).resolves.toEqual([{ refreshed: true }, { refreshed: true }])
    expect(refreshDependencies).toHaveBeenCalledTimes(1)
    expect(charges).toBe(1)

    const failing = vi.fn(async () => { throw new GitHubWorkspaceInstallError(new Error("ECONNRESET"), true) })
    // SAFETY: The repair capability calls only refreshDependencies in this test.
    const retryable = await resolveTools(repairCapability({ refreshDependencies: failing } as unknown as GitHubPullRequestOperations, false, [], undefined, workspace))
    await expect(retryable?.refreshDependencies?.execute?.({})).rejects.toThrow(/ECONNRESET/)
    expect(charges).toBe(1)

    const defect = vi.fn(async () => { throw new GitHubWorkspaceInstallError(new Error("ERR_PNPM_OUTDATED_LOCKFILE"), false) })
    // SAFETY: The repair capability calls only refreshDependencies in this test.
    const rejected = await resolveTools(repairCapability({ refreshDependencies: defect } as unknown as GitHubPullRequestOperations, false, [], undefined, workspace))
    await expect(rejected?.refreshDependencies?.execute?.({})).rejects.toThrow(/OUTDATED_LOCKFILE/)
    expect(charges).toBe(2)
  })

  it("reports dependency drift before validation", async () => {
    const checkDependencies = vi.fn(async () => ({ current: false, changedInputs: ["pnpm-lock.yaml"], reason: "Dependency inputs changed: pnpm-lock.yaml." }))
    // SAFETY: The repair capability calls only checkDependencies in this test.
    const tools = await resolveTools(repairCapability({ checkDependencies } as unknown as GitHubPullRequestOperations, false))
    await expect(tools?.checkDependencies?.execute?.({})).resolves.toEqual({ current: false, changedInputs: ["pnpm-lock.yaml"], reason: "Dependency inputs changed: pnpm-lock.yaml." })
  })
})
