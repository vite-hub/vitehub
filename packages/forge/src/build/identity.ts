/** The build of an app: the commit and branch, the GitHub repository, and the pull request when the host names it. */
export interface ForgeBuild {
  commit?: string
  branch?: string
  /** The GitHub repository, as `owner/name`. */
  repository?: string
  /** The pull request that the build previews, when the host names it. Never trust it to grant access. */
  pullRequest?: number
}

/** The repository and commit a page says it was built from. A claim, not a proof: check it against the Forge. */
export interface BuildIdentity {
  /** `owner/name`. */
  repository: string
  /** The full commit SHA, lowercase. */
  commit: string
}

/** The `name` of the `<meta>` tag that holds a page's {@link BuildIdentity}. */
export const buildMetaName = "vitehub:build"

const repositoryPattern = /^[\w.-]+\/[\w.-]+$/
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The identity of a build, when it has a valid repository and a full commit SHA. */
export function buildIdentity(build: ForgeBuild): BuildIdentity | undefined {
  const repository = build.repository?.trim()
  const commit = build.commit?.trim().toLowerCase()
  if (!repository || !repositoryPattern.test(repository) || !commit || !commitPattern.test(commit)) return undefined
  return { repository, commit }
}

/** The `content` of the `vitehub:build` meta tag, or `undefined` when the build has no identity. */
export function buildMetaContent(build: ForgeBuild): string | undefined {
  const identity = buildIdentity(build)
  return identity ? JSON.stringify(identity) : undefined
}

/** The identity in a `vitehub:build` meta tag's `content`, or `undefined` when it is missing or malformed. */
export function parseBuildMeta(content: string | null | undefined): BuildIdentity | undefined {
  if (!content) return undefined
  let value: unknown
  try {
    value = JSON.parse(content)
  }
  catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const { repository, commit } = value as Record<string, unknown>
  return typeof repository === "string" && typeof commit === "string" ? buildIdentity({ repository, commit }) : undefined
}
