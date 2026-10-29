import {
  forgeEnv,
  forgeGitAuthHeader,
  forgeGitCredentials,
  githubAppCredentials,
  readGitHubAppPrivateKey,
  withSignal,
} from "@vite-hub/forge"
import type { ForgeKind } from "@vite-hub/forge"
import type { WorkspaceDefinition } from "@vite-hub/workspace"
import { normalizeWorkspaceSourcesMetadata } from "@vite-hub/workspace/source-metadata"
import * as v from "valibot"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import type { AgentCallbackContext } from "../types.ts"
import { readBuiltInEnv } from "./builtin-env.ts"
import { pullRequestCheckoutPlan, pullRequestRepositories } from "./pull-request-checkout.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

/** Scope of one forge access request. */
export interface ForgeAccessScope {
  /** `owner/name` of the repository that the token must reach. */
  repository: string
  signal?: AbortSignal
}

/** Resolves a repository-scoped GitHub token. A github() Channel with an `app` supplies one to its Agent. */
export interface ForgeAccessResult { token: string, baseUrl?: string }

export type ForgeAccess = (context: AgentCallbackContext, scope: ForgeAccessScope) => Promise<ForgeAccessResult | undefined>

/** Private key of the forge access on a github() Channel and on the Agent runtime context. */
export const forgeAccessKey: unique symbol = Symbol.for("vitehub.agent.forgeAccess")

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

function sameGitHubHost(left: string | undefined, right: string | undefined): boolean {
  const root = (value: string | undefined) => {
    if (!value) return "https://github.com"
    const url = new URL(value)
    const host = url.hostname === "api.github.com" ? "github.com" : url.host
    return `${url.protocol}//${host}${url.pathname.replace(/\/api\/v3\/?$/, "").replace(/\/+$/, "")}`
  }
  return root(left) === root(right)
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
  const access = kind === "github" ? readForgeAccess(context.runtimeContext) : undefined
  if (access) {
    const result = await access(context, { repository, signal })
    if (result && sameGitHubHost(baseUrl, result.baseUrl)) return { forge: kind, baseUrl: result.baseUrl ?? baseUrl, token: result.token }
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

/** Repositories that one run's `git` and `gh` can reach. */
export interface ForgeGitScope {
  /** Base repository of a pull request run. */
  repository?: string
  /** Head repository when it differs from `repository`, such as a fork. */
  headRepository?: string
  /** Repositories a run without a pull request can reach: the Agent's GitHub Sources. */
  repositories?: readonly string[]
}

/** `owner/name` of each GitHub Source in the Workspace, once per repository. */
export function workspaceGitHubRepositories(definition: WorkspaceDefinition | undefined): string[] {
  if (!definition?.sources) return []
  let sources
  try {
    sources = normalizeWorkspaceSourcesMetadata(definition.sources)
  }
  catch {
    return []
  }
  const repositories: string[] = []
  for (const { source } of sources) {
    const fingerprint = source.fingerprint
    if (!isRuntimeRecord(fingerprint)) continue
    const resolved = isRuntimeRecord(fingerprint.sourceResolution) && isRuntimeRecord(fingerprint.source) ? fingerprint.source : fingerprint
    const options = resolved.inferredSource === "github" && isRuntimeRecord(resolved.options) ? resolved.options : resolved
    const repo = options.repo
    if (!hasRuntimeType(repo, "string") || !/^[\w.-]+\/[\w.-]+$/.test(repo)) continue
    if (!repositories.some(known => known.toLowerCase() === repo.toLowerCase())) repositories.push(repo)
  }
  return repositories
}

/**
 * Git scope of one run: its pull request's repositories, or else the Agent's GitHub Sources,
 * so a Teams or chat run can clone the repositories its Workspace already names.
 */
export function forgeGitScope(
  context: { get(key: string): unknown } | undefined,
  workspace: WorkspaceDefinition | undefined,
): ForgeGitScope | undefined {
  const pullRequest = pullRequestCheckoutPlan(context) ?? pullRequestRepositories(context)
  if (pullRequest) return pullRequest
  const repositories = workspaceGitHubRepositories(workspace)
  return repositories.length ? { repositories } : undefined
}

/** `GIT_CONFIG_*` entries that send the token only to this repository, with and without the `.git` suffix. */
function gitAuthEntries(repository: string, token: string, baseUrl?: string): { key: string, value: string }[] {
  const header = forgeGitAuthHeader(forgeGitCredentials({ forge: "github", repository, token, baseUrl }))
  if (!header) return []
  const withoutSuffix = header.key.replace(/\.git\.extraheader$/, ".extraheader")
  return [header, { key: withoutSuffix, value: header.value }]
}

/**
 * Environment for `git` and `gh` in a GitHub run. It uses the forge access of the Agent's
 * github() Channel. Git credentials go in `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`,
 * scoped to the pull request's base and head repositories, or else to `scope.repositories`,
 * so the token is not in process arguments. A Source repository the forge access cannot
 * reach is left out, and `git` reports it as unauthenticated.
 * Empty without forge access or without a repository.
 */
export async function forgeGitEnvironment(
  context: AgentCallbackContext,
  runtimeContext: object | undefined,
  scope: ForgeGitScope | undefined,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const access = readForgeAccess(runtimeContext)
  if (!access || !scope) return {}
  const request = (repository: string) => access(context, signal ? { repository, signal } : { repository })
  const entries: { key: string, value: string }[] = []
  let primary: ForgeAccessResult | undefined
  if (scope.repository) {
    primary = await request(scope.repository)
    if (!primary) return {}
    entries.push(...gitAuthEntries(scope.repository, primary.token, primary.baseUrl))
    const headRepository = scope.headRepository
    if (headRepository && headRepository.toLowerCase() !== scope.repository.toLowerCase()) {
      const headToken = await request(headRepository)
      if (headToken) entries.push(...gitAuthEntries(headRepository, headToken.token, headToken.baseUrl))
    }
  }
  else {
    for (const repository of scope.repositories || []) {
      // One Source outside the App installation must not fail the run.
      const result = await request(repository).catch((error: unknown) => {
        if (signal?.aborted) throw error
        return undefined
      })
      if (!result) continue
      primary ??= result
      entries.push(...gitAuthEntries(repository, result.token, result.baseUrl))
    }
    if (!primary) return {}
  }
  const { token, baseUrl } = primary
  const publicGitHub = isGitHubDotCom(baseUrl)
  const env: Record<string, string> = {
    GH_HOST: publicGitHub ? "github.com" : new URL(baseUrl!).hostname,
    // Ignore ambient system and global Git configuration. The scoped entries
    // above are the only credentials a run is allowed to use.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(entries.length),
    GIT_TERMINAL_PROMPT: "0",
  }
  if (publicGitHub) {
    env.GH_TOKEN = token
    env.GITHUB_TOKEN = token
  }
  else {
    env.GH_ENTERPRISE_TOKEN = token
    env.GITHUB_ENTERPRISE_TOKEN = token
  }
  for (const [index, entry] of entries.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = entry.key
    env[`GIT_CONFIG_VALUE_${index}`] = entry.value
  }
  return env
}
