import { forgeEnv } from "./env.ts"
import { forgeErrors } from "./errors.ts"

/**
 * Which GitHub App installation serves each repository owner. Every reader of the GitHub Server Env routes with it,
 * so `useForge()`, Capabilities, Comments, and presets pick the same installation.
 */
export interface GitHubInstallationRouting {
  /** The fixed installation of `owner`. */
  installationId?: number
  /** The lowercase repository owner of `installationId`. */
  owner?: string
  /** Installation IDs by lowercase repository owner. */
  installations: Readonly<Record<string, number>>
}

/** The raw values of `github.installationId`, `github.appOwner`, and `github.appInstallations` in Server Env. */
export interface GitHubInstallationEnv {
  installationId?: string | undefined
  appOwner?: string | undefined
  appInstallations?: string | undefined
}

const names = {
  installationId: forgeEnv.github.installationId.names[0],
  appOwner: forgeEnv.github.appOwner.names[0],
  appInstallations: forgeEnv.github.appInstallations.names[0],
}

function installationNumber(value: unknown, name: string): number {
  const id = typeof value === "string" && value.trim() ? Number(value) : value
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw forgeErrors.FORGE_INVALID_ENV({ name, problem: "must be a positive integer" })
  return id
}

/**
 * Reads the installation routing from Server Env values. Throws `FORGE_INVALID_ENV` when
 * `VITEHUB_GITHUB_INSTALLATION_ID` has no `VITEHUB_GITHUB_APP_OWNER`, because an installation belongs to one owner.
 */
export function githubInstallationRouting(env: GitHubInstallationEnv): GitHubInstallationRouting {
  const owner = env.appOwner?.trim().toLowerCase() || undefined
  const fixed = env.installationId?.trim() || undefined
  if (fixed !== undefined && owner === undefined) {
    throw forgeErrors.FORGE_INVALID_ENV({ name: names.installationId, problem: `needs ${names.appOwner}, the repository owner of that installation. For more owners, set ${names.appInstallations}` })
  }
  let installations: Record<string, number> = {}
  const mappings = env.appInstallations?.trim()
  if (mappings) {
    let parsed: unknown
    try {
      parsed = JSON.parse(mappings)
    }
    catch {
      parsed = undefined
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw forgeErrors.FORGE_INVALID_ENV({ name: names.appInstallations, problem: "must be a JSON object that maps repository owners to installation IDs, such as {\"acme\":123}" })
    }
    // Own properties only, so an owner such as `__proto__` or `constructor` is a plain key.
    installations = Object.fromEntries(Object.entries(parsed).map(([name, id]) => [name.toLowerCase(), installationNumber(id, `${names.appInstallations} entry "${name}"`)]))
  }
  return {
    ...(fixed === undefined ? {} : { installationId: installationNumber(fixed, names.installationId) }),
    ...(owner === undefined ? {} : { owner }),
    installations,
  }
}

/**
 * The configured installation for `repository`: its owner in `installations`, else the fixed installation when the
 * owner matches. Without `repository`, the fixed installation. `undefined` means: ask GitHub which installation can
 * reach the repository.
 */
export function githubInstallationFor(routing: GitHubInstallationRouting, repository: string | undefined): number | undefined {
  if (repository === undefined) return routing.installationId
  const owner = repository.split("/", 1)[0]!.toLowerCase()
  const configured = Object.hasOwn(routing.installations, owner) ? routing.installations[owner] : undefined
  return configured ?? (owner === routing.owner ? routing.installationId : undefined)
}
