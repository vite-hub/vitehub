import { ForgeApiError, ForgeTimeoutError, MergeBlockedError } from "forges"
import type { ForgeProvider, MergeOptions, MergeResult, ThreadRef } from "forges"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import { isRecord, repositoryPath, requireGitHub } from "./github.ts"

// Gap: forges `threads.merge()` cannot bypass branch rules. GitHub's asynchronous merge takes `bypass_rules`.

export interface ForgeMergeOptions extends MergeOptions {
  /**
   * GitHub only. Merge past failing branch rules, such as a required check. GitHub accepts it only from an
   * actor that may bypass those rules: a repository admin, or a bypass actor of the ruleset.
   */
  bypassRules?: boolean
  /** How long to wait for GitHub to finish the merge, in milliseconds. Default 30000. */
  timeout?: number
}

const pollDelays = [500, 1000, 2000]

/** `threads.merge()`, which can also bypass GitHub branch rules. */
export async function forgeMerge(provider: ForgeProvider, thread: ThreadRef, options: ForgeMergeOptions = {}): Promise<MergeResult> {
  const { bypassRules, timeout = 30_000, ...mergeOptions } = options
  if (!bypassRules) return await provider.threads.merge(thread, mergeOptions)
  const github = requireGitHub(provider, "forgeMerge({ bypassRules })")
  if (thread.kind !== "pull_request" || !thread.number) throw forgeDiagnostics.FORGE_R0009({ message: "Only a pull request with a number can merge past branch rules." })
  const { method, sha, signal } = mergeOptions
  if (!method || !sha) throw forgeDiagnostics.FORGE_R0009({ message: "A merge past branch rules needs the merge method and the expected head sha." })
  const path = `${repositoryPath(thread.repo)}/pulls/${encodeURIComponent(thread.number)}/merge-async`
  const budget = AbortSignal.timeout(timeout)
  const requestSignal = signal ? AbortSignal.any([signal, budget]) : budget
  const timedOut = (uuid?: string) => new ForgeTimeoutError(uuid
    ? `Merge request ${uuid} for pull request ${thread.number} was still pending after ${timeout}ms; GitHub may still complete it`
    : `Merge of pull request ${thread.number} got no response within ${timeout}ms; GitHub may still complete it`, timeout)
  let uuid: string | undefined
  try {
    let state: unknown
    try {
      state = (await github.request<unknown>("PUT", path, {
        body: { merge_method: method, sha, commit_title: mergeOptions.title, commit_message: mergeOptions.message, merge_action: "direct_merge", bypass_rules: true },
        signal: requestSignal,
      })).data
    }
    catch (error) {
      if (budget.aborted) throw error
      state = pendingMerge(error, method, sha, mergeOptions.title !== undefined || mergeOptions.message !== undefined)
    }
    for (let attempt = 0; isRecord(state) && state.status === "pending"; attempt++) {
      uuid = isRecord(state.details) && typeof state.details.uuid === "string" ? state.details.uuid : undefined
      if (!uuid) throw new ForgeApiError("GitHub reported a pending merge without a request id", 202, JSON.stringify(state).slice(0, 512))
      await sleep(pollDelays[Math.min(attempt, pollDelays.length - 1)]!, requestSignal)
      state = (await github.request<unknown>("GET", `${path}/${encodeURIComponent(uuid)}`, { signal: requestSignal })).data
    }
    const status = isRecord(state) ? state.status : undefined
    const details = isRecord(state) && isRecord(state.details) ? state.details : {}
    const excerpt = JSON.stringify(state).slice(0, 512)
    if (status === "merged") return { status: "merged", ...(typeof details.sha === "string" ? { sha: details.sha } : {}), raw: state }
    if (status === "enqueued") throw new MergeBlockedError("Pull request was added to a merge queue and has not merged", 200, excerpt)
    if (status === "failed") throw new MergeBlockedError(typeof details.message === "string" && details.message ? details.message : "GitHub could not merge the pull request", 200, excerpt)
    throw new ForgeApiError(`GitHub reported an unknown merge status ${JSON.stringify(status)}`, 200, excerpt)
  }
  catch (error) {
    throw budget.aborted && !signal?.aborted ? timedOut(uuid) : error
  }
}

/**
 * GitHub answers 409 while another merge request for the pull request is pending. Wait for that request
 * only when it asked for exactly this merge, so a different request never counts as this one.
 */
function pendingMerge(error: unknown, method: string, sha: string, customMessage: boolean): unknown {
  if (!(error instanceof ForgeApiError) || error.constructor !== ForgeApiError) throw error
  if (error.status === 400) throw new MergeBlockedError("Pull request cannot be merged in its current state", 400, error.body, {}, { cause: error })
  if (error.status !== 409) throw error
  let pending: unknown
  try {
    pending = JSON.parse(error.body)
  }
  catch {
    throw error
  }
  const details = isRecord(pending) && isRecord(pending.details) ? pending.details : undefined
  if (!details || typeof details.uuid !== "string") throw error
  if (customMessage || details.merge_action !== "direct_merge" || details.merge_method !== method || details.bypass_rules !== true || details.expected_head_sha !== sha) {
    throw new MergeBlockedError("Another merge request is pending whose options do not match or cannot be verified", 409, error.body, {}, { cause: error })
  }
  return { status: "pending", details }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
