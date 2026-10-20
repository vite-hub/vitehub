import { describe, expect, it, vi } from "vitest"

import type { GitHubPullRequestOperations } from "@vite-hub/agent/server/github"
import { resolveAgentCapabilities } from "../../agent/src/capability-runtime.ts"
import { repairCapability } from "../src/babysitter/repair.ts"

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
})
