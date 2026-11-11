import type { GitHubRef } from "@vite-hub/source"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

/** The kind of ref that `content.sources.at()` opened. */
export type ContentSourceRefKind = "commit" | "branch" | "pull"

/** The pull request behind a `pr/<number>` ref. */
export interface ContentSourcePull {
  number: number
  state: "open" | "closed"
  merged: boolean
  /** The head branch, such as `feat/x`. */
  head: string
  /** The repository of the head branch, such as `acme/docs`. Null when the fork was deleted. */
  headRepo: string | null
  /** The base branch, such as `main`. */
  base: string
  /** True when the head branch lives in another repository. */
  fork: boolean
  /** The label names, such as `preview:enabled`. */
  labels: string[]
}

/**
 * The commit that `content.sources.at()` opened, and how its ref reached it. `at()` does not check access: a route
 * decides with these fields whether the caller may read the commit before it serves anything from the view.
 */
export interface ContentSourceRef {
  /** The Content source name, such as `docs`. */
  source: string
  /** The ref as `at()` received it, with a SHA in lower case: `9c1e…`, `feat/x`, or `pr/12`. */
  ref: string
  kind: ContentSourceRefKind
  /** The full commit SHA that the view reads. It does not change for the life of the view. */
  sha: string
  /** The pull request, for a `pr/<number>` ref. Null for other refs. */
  pull: ContentSourcePull | null
}

/** The longest ref that `at()` accepts. */
export const MAX_REF_LENGTH = 200

const fullSha = /^[0-9a-f]{40}$/i
const pullRef = /^pr\/([1-9]\d{0,8})$/
const branchCharacters = /^[\w./-]+$/

/** A ref that `at()` accepts, and how to look it up on GitHub. */
export interface ParsedContentRef {
  ref: string
  kind: ContentSourceRefKind
  lookup: GitHubRef
}

function invalid(ref: unknown, reason: string): Error {
  return contentErrorDiagnostics.CONTENT_R0027({ ref: typeof ref === "string" ? ref.slice(0, MAX_REF_LENGTH + 1) : String(ref), reason })
}

/**
 * Read a ref for `content.sources.at()`. A full 40-character SHA opens that commit, `pr/<number>` opens the head commit
 * of a pull request, and any other value is a branch name. The rules follow `git check-ref-format`, with fewer
 * characters allowed, so a ref is safe in a URL path and a KV key.
 */
export function parseContentRef(ref: unknown): ParsedContentRef {
  if (typeof ref !== "string") throw invalid(ref, "a ref must be a string")
  if (!ref.length || ref.length > MAX_REF_LENGTH) throw invalid(ref, `a ref has 1 to ${MAX_REF_LENGTH} characters`)
  if (fullSha.test(ref)) {
    const sha = ref.toLowerCase()
    return { ref: sha, kind: "commit", lookup: { sha } }
  }
  const pull = pullRef.exec(ref)
  if (pull) return { ref, kind: "pull", lookup: { pull: Number(pull[1]) } }
  if (ref.startsWith("pr/")) throw invalid(ref, "a pull request ref is pr/<number>, such as pr/12")
  if (!branchCharacters.test(ref)) throw invalid(ref, "a branch name uses only letters, digits, and . _ - /")
  if (ref.startsWith("-")) throw invalid(ref, "a branch name cannot start with -")
  if (ref.includes("..")) throw invalid(ref, "a branch name cannot contain ..")
  for (const segment of ref.split("/")) {
    if (!segment) throw invalid(ref, "a branch name cannot start or end with / or contain //")
    if (segment.startsWith(".")) throw invalid(ref, "a part of a branch name cannot start with .")
    if (segment.endsWith(".lock") || segment.endsWith(".")) throw invalid(ref, "a part of a branch name cannot end with .lock or .")
    // `/tree/<ref>/-/<path>` separates the ref from the document path with a `-` part.
    if (segment === "-") throw invalid(ref, "a branch name cannot have a part that is only -")
  }
  return { ref, kind: "branch", lookup: { branch: ref } }
}
