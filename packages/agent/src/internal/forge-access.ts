import {
  forgeEnv,
  forgeGitAuthHeader,
  forgeGitCredentials,
  githubAppCredentials,
  readGitHubAppPrivateKey,
  withSignal,
} from "@vite-hub/forge"
import type { ForgeKind } from "@vite-hub/forge"
import * as v from "valibot"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import type { AgentCallbackContext } from "../types.ts"
import { readBuiltInEnv } from "./builtin-env.ts"
import { hasRuntimeType } from "./runtime-type.ts"

/** Scope of one forge access request. */
export interface ForgeAccessScope {
  /** `owner/name` of the repository that the token must reach. */
  repository: string
  signal?: AbortSignal
}

/** Resolves a repository-scoped GitHub token. A github() Channel with an `app` supplies one to its Agent. */
export type ForgeAccess = (context: AgentCallbackContext, scope: ForgeAccessScope) => Promise<string | undefined>

/** Private key of the forge access on a github() Channel and on the Agent runtime context. */
export const forgeAccessKey = Symbol.for("vitehub.agent.forgeAccess")

type ForgeAccessCarrier = { [forgeAccessKey]?: unknown }

/** Read the forge access that a github() Channel or a runtime context carries. */
export function readForgeAccess(value: object | undefined): ForgeAccess | undefined {
  // SAFETY: github() and withForgeAccess() are the only writers of this private symbol.
  const access = (value as ForgeAccessCarrier | undefined)?.[forgeAccessKey]
  // SAFETY: the writers store only ForgeAccess functions under this key.
  return hasRuntimeType(access, "function") ? access as ForgeAccess : undefined
}

/** The forge access of the Agent's github() Channels, when exactly one Channel supplies it. */
export function channelForgeAccess(channels: Readonly<Record<string, object>> | undefined): ForgeAccess | undefined {
  const found = new Set<ForgeAccess>()
  for (const channel of Object.values(channels || {})) {
    const access = readForgeAccess(channel)
    if (access) found.add(access)
  }
  return found.size === 1 ? [...found][0] : undefined
}

/** Give the Invocation the forge access of the Agent's github() Channel. Access that the context already has stays. */
export function withForgeAccess<TContext extends object>(channels: Readonly<Record<string, object>> | undefined, context: TContext): TContext {
  if (readForgeAccess(context)) return context
  const access = channelForgeAccess(channels)
  return access ? { ...context, [forgeAccessKey]: access } : context
}

const sealedEnvSchema = v.looseObject({ unseal: v.function() })
const envTextSchema = v.pipe(v.string(), v.trim(), v.minLength(1))

/** Server Env values can be plain strings or sealed secrets. Empty values count as missing. */
function envString(value: unknown): string | undefined {
  const parsed = v.safeParse(envTextSchema, v.is(sealedEnvSchema, value) ? value.unseal() : value)
  return parsed.success ? parsed.output : undefined
}

function isGitHubDotCom(baseUrl: string | undefined): boolean {
  return baseUrl === undefined || new URL(baseUrl).href === "https://api.github.com/"
}

/**
 * Forge connection for one repository. GitHub on github.com uses the forge access of the Agent's
 * github() Channel first. Other forges, and Agents without that access, read Server Env.
 */
export async function forgeConnection(
  context: AgentCallbackContext & { runtimeContext?: object },
  input: { forge: ForgeKind, repository: string, baseUrl?: string, signal?: AbortSignal },
): Promise<{ forge: ForgeKind, baseUrl?: string, token: string }> {
  const { forge: kind, repository, baseUrl, signal } = input
  const access = kind === "github" && isGitHubDotCom(baseUrl) ? readForgeAccess(context.runtimeContext) : undefined
  if (access) {
    const token = await access(context, { repository, signal })
    if (token) return { forge: kind, baseUrl, token }
  }
  const specs = forgeEnv[kind]
  // Keep the capability context object: Server Env is cached by its identity for one Invocation.
  const env = await withSignal(readBuiltInEnv(kind, specs, Object.keys(specs), context), signal)
  const resolvedBaseUrl = baseUrl ?? envString(env.baseUrl)
  if (kind === "github") {
    const appId = envString(env.appId)
    const privateKey = appId
      ? await readGitHubAppPrivateKey(envString(env.privateKey), envString(env.privateKeyPath))
      : undefined
    if (appId && privateKey) {
      const app = githubAppCredentials({ appId, privateKey, baseUrl: resolvedBaseUrl })
      const installation = envString(env.installationId) ?? (await app.installation(repository, signal))
      return {
        forge: kind,
        baseUrl: resolvedBaseUrl,
        token: (await app.installationToken(installation, { signal })).token,
      }
    }
  }
  const token = envString(env.token)
  if (!token) {
    const names =
      kind === "github"
        ? "VITEHUB_GITHUB_APP_ID with VITEHUB_GITHUB_PRIVATE_KEY or VITEHUB_GITHUB_PRIVATE_KEY_PATH; optional VITEHUB_GITHUB_INSTALLATION_ID; or VITEHUB_GITHUB_TOKEN. FORGES_GITHUB_* names are also read"
        : specs.token.names.join(", ")
    throw agentDiagnostics.AGENT_R0941({ message: `[vitehub] Forge requires Server Env credentials: ${names}.` })
  }
  return { forge: kind, baseUrl: resolvedBaseUrl, token }
}

/** Repositories of one pull request run. */
export interface ForgeGitScope {
  repository: string
  /** Head repository when it differs from `repository`, such as a fork. */
  headRepository?: string
}

/** `GIT_CONFIG_*` entries that send the token only to this repository, with and without the `.git` suffix. */
function gitAuthEntries(repository: string, token: string): { key: string, value: string }[] {
  const header = forgeGitAuthHeader(forgeGitCredentials({ forge: "github", repository, token }))
  if (!header) return []
  const withoutSuffix = header.key.replace(/\.git\.extraheader$/, ".extraheader")
  return [header, { key: withoutSuffix, value: header.value }]
}

/**
 * Environment for `git` and `gh` in a GitHub pull request run. It uses the forge access of the
 * Agent's github() Channel. Git credentials go in `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`,
 * scoped to the base and head repositories, so the token is not in process arguments.
 * Empty without forge access or without a repository.
 */
export async function forgeGitEnvironment(
  context: AgentCallbackContext,
  runtimeContext: object | undefined,
  scope: { repository?: string, headRepository?: string } | undefined,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const access = readForgeAccess(runtimeContext)
  const repository = scope?.repository
  if (!access || !repository) return {}
  const token = await access(context, signal ? { repository, signal } : { repository })
  if (!token) return {}
  const entries = gitAuthEntries(repository, token)
  const headRepository = scope.headRepository
  if (headRepository && headRepository.toLowerCase() !== repository.toLowerCase()) {
    const headToken = await access(context, signal ? { repository: headRepository, signal } : { repository: headRepository })
    if (headToken) entries.push(...gitAuthEntries(headRepository, headToken))
  }
  const env: Record<string, string> = {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    // Ignore ambient system and global Git configuration. The scoped entries
    // above are the only credentials a run is allowed to use.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(entries.length),
    GIT_TERMINAL_PROMPT: "0",
  }
  for (const [index, entry] of entries.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = entry.key
    env[`GIT_CONFIG_VALUE_${index}`] = entry.value
  }
  return env
}
