/** Options of the `cms` preset that name a resource of the Blob + Database store. */
export const cmsNameOptions = ["blob", "database", "workspace"] as const

/** Options that only the GitHub store reads. */
export const cmsGitHubOptions = ["repo", "branch", "draftBranch", "root", "publish"] as const

/** Every option of the `cms` preset. */
export const cmsOptionKeys: readonly string[] = [...cmsNameOptions, "store", ...cmsGitHubOptions]

export const cmsStores = ["blob-database", "github"] as const
export const cmsPublishModes = ["commit", "pr"] as const

const namePattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i
const repoPattern = /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const branchPattern = /^[\w-]+(?:[./][\w-]+)*$/
const rootPattern = /^[\w.-]+(?:\/[\w.-]+)*$/

/** What the GitHub store of the `cms` preset uses when an option is left out. */
export const cmsGitHubDefaults = { branch: "main", draftBranch: "vitehub/content", publish: "commit", root: "" } as const

/**
 * Why `value` is not valid for the `cms` preset option `key`, worded to complete `option "key" ...`, or undefined when
 * it is valid. The build and the runtime check the same rules.
 */
export function cmsOptionProblem(key: string, value: unknown): string | undefined {
  if (value === undefined) return
  const text = String(value) === value ? value : undefined
  if ((cmsNameOptions as readonly string[]).includes(key)) {
    return text !== undefined && namePattern.test(text) ? undefined : "must be a name of letters, numbers, dots, underscores, dashes, and slashes."
  }
  if (key === "store") {
    return text !== undefined && (cmsStores as readonly string[]).includes(text) ? undefined : `must be "blob-database" or "github".`
  }
  if (key === "repo") {
    return text !== undefined && repoPattern.test(text) ? undefined : "must be a repository in owner/name format."
  }
  if (key === "branch" || key === "draftBranch") {
    return text !== undefined && text.length <= 128 && branchPattern.test(text) ? undefined : "must be a branch name of letters, numbers, underscores, and dashes, separated by single dots or slashes."
  }
  if (key === "root") {
    // The empty string is the repository root.
    return text !== undefined && (text === "" || (rootPattern.test(text) && !text.split("/").some(part => part === "." || part === ".."))) ? undefined : "must be a folder inside the repository, such as \"content\", or \"\" for the repository root."
  }
  if (key === "publish") {
    return text !== undefined && (cmsPublishModes as readonly string[]).includes(text) ? undefined : `must be "commit" or "pr".`
  }
  return "is not a cms preset option."
}

/** A problem with the combination of options, or undefined. Pass only the options that the app set. */
export function cmsOptionsProblem(options: object): string | undefined {
  const get = (key: string): unknown => Reflect.get(options, key)
  if (get("store") !== "github") {
    const used = cmsGitHubOptions.filter(key => get(key) !== undefined)
    if (used.length) return `option${used.length === 1 ? "" : "s"} ${used.map(key => JSON.stringify(key)).join(", ")} only ${used.length === 1 ? "applies" : "apply"} to store: "github". Add store: "github" or remove ${used.length === 1 ? "it" : "them"}.`
    return
  }
  if (get("blob") !== undefined) return `option "blob" does not apply to store: "github", which keeps files in Git and needs no Blob store.`
  const branch = get("branch") ?? cmsGitHubDefaults.branch
  const draft = get("draftBranch") ?? cmsGitHubDefaults.draftBranch
  if (branch === draft) return `option "draftBranch" must differ from "branch". Both are ${JSON.stringify(branch)}.`
}
