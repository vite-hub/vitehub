import { Buffer } from "node:buffer"

import { BranchMovedError } from "forges"
import type { BaseOptions, CommitFilesInput, FileChange, ForgeProvider, RepoRef } from "forges"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import { forgeErrorStatus, forgeResponseError } from "../provider.ts"

/** Git file modes: a regular file, an executable file and a symlink. The content of a symlink is its target. */
export type ForgeFileMode = "100644" | "100755" | "120000"

export interface ForgeFileChange extends FileChange {
  mode?: ForgeFileMode
}

export interface ForgeCommitFilesInput extends Omit<CommitFilesInput, "changes"> {
  changes: ForgeFileChange[]
}

/**
 * `provider.contents.commitFiles()` with Git file modes, and the sha of the new commit.
 * Without a `mode` or a GitHub author, the call goes to `commitFiles()`. Every write without a mode is `100644`.
 * Rejects with `BranchMovedError` when the branch no longer points at `expectedHead`, as `commitFiles()` does.
 * Gap: `FileChange` has no mode, so `commitFiles()` cannot write a symlink or an executable file.
 * Proposed upstream as `FileChange.mode`.
 */
export async function forgeCommitFiles(provider: ForgeProvider, repo: RepoRef, input: ForgeCommitFilesInput, options: BaseOptions = {}): Promise<string> {
  // GitHub's Contents API rejects an empty change set, but history commits must
  // still create a revision. Use the Git database for empty commits as well.
  if (!(provider.forge === "github" && input.author) && input.changes.length > 0 && !input.changes.some(change => change.mode)) return (await provider.contents.commitFiles(repo, input, options)).sha
  if (provider.forge !== "github") {
    throw forgeDiagnostics.FORGE_R0005({ message: `Git file modes are not supported for ${provider.forge}.` })
  }
  const signal = options.signal
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git`
  const branchRef = `heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`
  const readHead = async () => sha((await provider.request<unknown>("GET", `${base}/ref/${branchRef}`, { signal })).data, "object", "branch")
  const parent = input.createFrom === undefined
    ? input.expectedHead ?? await readHead()
    : await provider.contents.resolveRef(repo, input.createFrom, { signal })
  const baseTree = sha((await provider.request<unknown>("GET", `${base}/commits/${encodeURIComponent(parent)}`, { signal })).data, "tree", "commit")
  const tree = await Promise.all(input.changes.map(async (change) => {
    if (change.content === null) return { mode: change.mode ?? "100644", path: change.path, sha: null, type: "blob" }
    const content = Buffer.from(change.content).toString("base64")
    const blob = await provider.request<unknown>("POST", `${base}/blobs`, { body: { content, encoding: "base64" }, signal })
    return { mode: change.mode ?? "100644", path: change.path, sha: sha(blob.data, undefined, "blob"), type: "blob" }
  }))
  const treeSha = sha((await provider.request<unknown>("POST", `${base}/trees`, { body: { base_tree: baseTree, tree }, signal })).data, undefined, "tree")
  const body = { message: input.message, parents: [parent], tree: treeSha }
  let result = (await provider.request<unknown>("POST", `${base}/commits`, { body, signal })).data
  if (input.author) {
    // Let GitHub derive the credential's identity, including for installation
    // tokens, which cannot call /user. This first object is never attached to a
    // ref. Reuse its committer on the authored object with the same tree/parents.
    // Omitting committer here would make GitHub copy the supplied author.
    const committer = result instanceof Object && "committer" in result ? result.committer : undefined
    if (!(committer instanceof Object) || !("name" in committer) || typeof committer.name !== "string"
      || !("email" in committer) || typeof committer.email !== "string") {
      throw forgeResponseError("GitHub returned a malformed commit committer response.")
    }
    result = (await provider.request<unknown>("POST", `${base}/commits`, {
      body: { ...body, author: input.author, committer: { name: committer.name, email: committer.email } },
      signal,
    })).data
  }
  const commit = sha(result, undefined, "commit")
  if (input.createFrom !== undefined) {
    await provider.request("POST", `${base}/refs`, { body: { ref: `refs/heads/${input.branch}`, sha: commit }, signal })
    return commit
  }
  try {
    await provider.request("PATCH", `${base}/refs/${branchRef}`, { body: { force: false, sha: commit }, signal })
  }
  catch (error) {
    const status = forgeErrorStatus(error)
    if (status !== 409 && status !== 422) throw error
    const head = await readHead()
    if (head === parent) throw error
    throw new BranchMovedError(`${input.branch} is at ${head}, not ${parent}`, status, "", { forge: provider.forge, instance: provider.instance }, { cause: error })
  }
  return commit
}

/** The `sha` of a GitHub Git database response, or of its `key` object. */
function sha(value: unknown, key: "object" | "tree" | undefined, description: string): string {
  const target: unknown = key && value instanceof Object && key in value ? Reflect.get(value, key) : value
  const result: unknown = target instanceof Object && "sha" in target ? target.sha : undefined
  if (typeof result !== "string" || !result) throw forgeResponseError(`GitHub returned a malformed ${description} response.`)
  return result
}
