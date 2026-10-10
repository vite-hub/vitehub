import * as v from "valibot";
import { hasRuntimeType } from "../../internal/runtime-type.ts";
import type { GitHubHost } from "../../server/github-host.ts";
import type { BabysitterMergeMethod } from "./merge.ts";

const sha = v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/i));
const uuid = v.pipe(v.string(), v.regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i));
const result = v.variant("status", [
  v.object({ status: v.literal("pending"), details: v.object({ uuid, expected_head_sha: sha, merge_method: v.string(), merge_action: v.string(), bypass_rules: v.optional(v.boolean(), false) }) }),
  v.object({ status: v.literal("merged"), details: v.object({ sha }) }),
  v.object({ status: v.literal("enqueued"), details: v.object({ message: v.optional(v.string()) }) }),
  v.object({ status: v.literal("failed"), details: v.object({ message: v.string() }) }),
]);

/** GitHub serializes duplicate requests and compares the exact head when it executes. */
export async function requestAsyncMerge(github: Pick<GitHubHost, "command">, repository: string, number: number, head: string, method: BabysitterMergeMethod, signal: AbortSignal) {
  let stdout: string;
  try {
    ({ stdout } = await github.command(["api", "-X", "PUT", `repos/${repository}/pulls/${number}/merge-async`, "-H", "X-GitHub-Api-Version: 2026-03-10", "-f", `sha=${head}`, "-f", `merge_method=${method}`, "-f", "merge_action=direct_merge", "-F", "bypass_rules=false"], { repository, timeout: 60_000, signal }));
  } catch (error) {
    // A 409 contains the existing request. Only accept a validated pending result,
    // never treat an arbitrary command failure as an accepted merge.
    if (!(error instanceof Error) || !/HTTP 409/.test(error.message) || !("stdout" in error) || !hasRuntimeType(error.stdout, "string")) throw error;
    stdout = error.stdout;
  }
  const response = v.parse(result, JSON.parse(stdout));
  if (response.status === "pending" && (response.details.expected_head_sha !== head || response.details.merge_method !== method || response.details.merge_action !== "direct_merge" || response.details.bypass_rules)) throw new Error("Pending merge options do not match the authorized request.");
  return response;
}

export async function readAsyncMerge(github: Pick<GitHubHost, "command">, repository: string, number: number, requestId: string, signal: AbortSignal) {
  v.parse(uuid, requestId);
  const { stdout } = await github.command(["api", `repos/${repository}/pulls/${number}/merge-async/${requestId}`, "-H", "X-GitHub-Api-Version: 2026-03-10"], { repository, timeout: 60_000, signal });
  const response = v.parse(result, JSON.parse(stdout));
  if (response.status === "pending" && response.details.uuid !== requestId) throw new Error("GitHub returned a different merge request identity.");
  return response;
}
