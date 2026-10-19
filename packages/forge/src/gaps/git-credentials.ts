import { Buffer } from "node:buffer"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import type { ForgeKind } from "../provider.ts"

export interface ForgeGitCredentialsInput {
  forge: ForgeKind
  /** The same `baseUrl` as `forgeProvider()`. GitHub: API base. GitLab and Forgejo: instance root. */
  baseUrl?: string
  /** Omitted: anonymous clone. */
  token?: string
  /** `owner/name`. GitLab accepts nested groups, such as `group/subgroup/name`. */
  repository: string
}

/** Git smart HTTP remote and the basic auth pair to send to it. */
export interface ForgeGitCredentials {
  url: string
  username?: string
  password?: string
}

const defaultInstance: Record<ForgeKind, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  forgejo: "https://codeberg.org",
}

// GitHub: `x-access-token` for any token. GitLab: `oauth2` for any token.
// Forgejo reads the token from the password and does not check the user name.
const tokenUsername: Record<ForgeKind, string> = {
  github: "x-access-token",
  gitlab: "oauth2",
  forgejo: "oauth2",
}

function instanceRoot(forge: ForgeKind, baseUrl: string | undefined): string {
  if (!baseUrl) return defaultInstance[forge]
  const url = new URL(baseUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw forgeDiagnostics.FORGE_R0003({ message: `Forge base URL ${JSON.stringify(baseUrl)} must use http or https.` })
  }
  let path = url.pathname.replace(/\/+$/, "")
  if (forge === "github") {
    // github.com: api.github.com. GitHub Enterprise Server: <host>/api/v3.
    if (url.hostname === "api.github.com") return defaultInstance.github
    path = path.replace(/\/api\/v3$/, "")
  }
  return `${url.origin}${path}`
}

function repositoryPath(repository: string): string {
  const segments = repository.replace(/\.git$/, "").split("/")
  if (segments.length < 2 || segments.some(segment => !segment || segment === "." || segment === ".." || /[\s\\?#%]/.test(segment))) {
    throw forgeDiagnostics.FORGE_R0003({ message: `Repository ${JSON.stringify(repository)} must be owner/name.` })
  }
  return segments.map(encodeURIComponent).join("/")
}

/**
 * Git smart HTTP remote and credentials for one repository.
 * Gap: `forges` exposes `Repo.cloneUrls` but no transport credential.
 */
export function forgeGitCredentials(input: ForgeGitCredentialsInput): ForgeGitCredentials {
  const url = `${instanceRoot(input.forge, input.baseUrl)}/${repositoryPath(input.repository)}.git`
  if (!input.token) return { url }
  return { url, username: tokenUsername[input.forge], password: input.token }
}

/**
 * The `http.<url>.extraheader` config entry that sends the credentials to the remote only.
 * Pass it through `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, not `-c`, so the token is not in process arguments.
 * Undefined for anonymous credentials.
 */
export function forgeGitAuthHeader(credentials: ForgeGitCredentials): { key: string, value: string } | undefined {
  if (!credentials.password) return undefined
  const basic = Buffer.from(`${credentials.username ?? ""}:${credentials.password}`).toString("base64")
  return { key: `http.${credentials.url}.extraheader`, value: `AUTHORIZATION: basic ${basic}` }
}
