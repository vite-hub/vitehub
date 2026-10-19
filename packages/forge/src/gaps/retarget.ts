import type { BaseOptions, ForgeProvider, ThreadRef } from "forges"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import { repositoryPath, requireGitHub } from "./github.ts"

// Gap: forges `threads.update()` cannot change the base branch of a pull request.

/** Change the base branch of a GitHub pull request. */
export async function retargetPullRequest(provider: ForgeProvider, thread: ThreadRef, base: string, options?: BaseOptions): Promise<void> {
  requireGitHub(provider, "retargetPullRequest()")
  if (thread.kind !== "pull_request" || !thread.number) throw forgeDiagnostics.FORGE_R0009({ message: "Only a pull request with a number can change its base branch." })
  if (!base.trim()) throw forgeDiagnostics.FORGE_R0009({ message: "The new base branch must not be empty." })
  await provider.request("PATCH", `${repositoryPath(thread.repo)}/pulls/${encodeURIComponent(thread.number)}`, { body: { base }, signal: options?.signal })
}
