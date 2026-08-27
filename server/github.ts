import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type Secret = { unseal: () => string }

export type GitHubAuthenticationEnv = {
  appId: string
  installationId: string
  owner: string
  privateKey?: Secret
  token?: Secret
}

type CreateAppAuth = typeof import('@octokit/auth-app').createAppAuth
type GitHubAppAuth = ReturnType<CreateAppAuth>

type GitHubTokenProviderOptions = {
  loadCreateAuth?: () => Promise<CreateAppAuth>
  readCliToken?: () => Promise<string>
  readEnv: () => GitHubAuthenticationEnv | Promise<GitHubAuthenticationEnv>
}

type GitHubCommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  repository?: string
}

export type GitHubGraphQLRateLimit = {
  checkedAt: number
  remaining: number
  resetAt: number
}

const exec = promisify(execFile)
const githubCommandMaxBuffer = 16 * 1024 * 1024
const githubGraphQLReserve = 1_500
const githubRateLimitCacheMs = 15_000
const githubRateLimitFallbackMs = 5 * 60_000
const githubGraphQLRateLimits = new Map<string, GitHubGraphQLRateLimit>()
const githubGraphQLRateLimitChecks = new Map<string, Promise<GitHubGraphQLRateLimit>>()

export const githubBotLogin = 'vitehub-bot[bot]'
export const githubBotEmail = '320448255+vitehub-bot[bot]@users.noreply.github.com'

export function createGitHubTokenProvider({
  loadCreateAuth = async () => (await import('@octokit/auth-app')).createAppAuth,
  readCliToken = async () => (await exec('gh', ['auth', 'token'])).stdout,
  readEnv,
}: GitHubTokenProviderOptions) {
  let cached: { appId: number, auth: GitHubAppAuth, installationId: number, privateKey: string } | undefined

  return async ({ fallback = false, refresh = false, repository }: { fallback?: boolean, refresh?: boolean, repository?: string } = {}) => {
    const env = await readEnv()
    const appId = env.appId.trim()
    const installationId = env.installationId.trim()
    const owner = env.owner.trim().toLowerCase()
    const privateKey = env.privateKey?.unseal().trim().replace(/\\n/g, '\n') || ''
    const appValues = [appId, installationId, privateKey]

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) {
        throw new Error('GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY must be configured together.')
      }
      if (!owner) throw new Error('GITHUB_APP_OWNER must be configured with GitHub App credentials.')

      const repositoryOwner = repository?.split('/', 1)[0]?.toLowerCase()
      if (fallback || (repositoryOwner && repositoryOwner !== owner)) return await fallbackToken(env, readCliToken)

      const numericAppId = positiveInteger(appId, 'GITHUB_APP_ID')
      const numericInstallationId = positiveInteger(installationId, 'GITHUB_APP_INSTALLATION_ID')
      if (!cached
        || cached.appId !== numericAppId
        || cached.installationId !== numericInstallationId
        || cached.privateKey !== privateKey) {
        const createAuth = await loadCreateAuth()
        cached = {
          appId: numericAppId,
          auth: createAuth({ appId: numericAppId, privateKey }),
          installationId: numericInstallationId,
          privateKey,
        }
      }

      return (await cached.auth({ type: 'installation', installationId: numericInstallationId, refresh })).token
    }

    return await fallbackToken(env, readCliToken)
  }
}

export const githubToken = createGitHubTokenProvider({
  readEnv: async () => {
    // SAFETY: vite.config.ts declares this server-only env shape; deployment compilation regenerates its typed module.
    const environment = (await import('#vitehub/env/server')).useServerEnv() as unknown as { github: GitHubAuthenticationEnv }
    return environment.github
  },
})

export async function runGitHub(args: string[], options: GitHubCommandOptions = {}) {
  const { repository, ...commandOptions } = options
  try {
    return await runBufferedCommand('gh', args, {
      ...commandOptions,
      env: githubCommandEnvironment(await githubToken({ repository }), options.env),
    })
  }
  catch (error) {
    if (repository && isGitHubRateLimitMessage(error)) {
      const limit = { checkedAt: Date.now(), remaining: 0, resetAt: Date.now() + githubRateLimitFallbackMs }
      githubGraphQLRateLimits.set(rateLimitKey(repository), limit)
      throw githubRateLimitError(repository, limit, error)
    }
    throw error
  }
}

export async function ensureGitHubGraphQLBudget(repository: string) {
  const key = rateLimitKey(repository)
  const now = Date.now()
  const cached = githubGraphQLRateLimits.get(key)
  if (cached && cached.resetAt > now && cached.remaining < githubGraphQLReserve) throw githubRateLimitError(repository, cached)
  if (cached && now - cached.checkedAt < githubRateLimitCacheMs) return cached
  const pending = githubGraphQLRateLimitChecks.get(key)
  if (pending) return await pending
  const check = (async () => {
    const result = await runBufferedCommand('gh', ['api', 'rate_limit'], {
      env: githubCommandEnvironment(await githubToken({ repository })),
    })
    const rateLimit = parseGitHubGraphQLRateLimit(JSON.parse(result.stdout), now)
    githubGraphQLRateLimits.set(key, rateLimit)
    if (rateLimit.remaining < githubGraphQLReserve && rateLimit.resetAt > now) throw githubRateLimitError(repository, rateLimit)
    return rateLimit
  })().finally(() => githubGraphQLRateLimitChecks.delete(key))
  githubGraphQLRateLimitChecks.set(key, check)
  return await check
}

export function parseGitHubGraphQLRateLimit(value: unknown, checkedAt = Date.now()): GitHubGraphQLRateLimit {
  const resources = value && typeof value === 'object' ? (value as Record<string, unknown>).resources : undefined
  const graphql = resources && typeof resources === 'object' ? (resources as Record<string, unknown>).graphql : undefined
  const record = graphql && typeof graphql === 'object' ? graphql as Record<string, unknown> : undefined
  const remaining = record?.remaining
  const reset = record?.reset
  if (!Number.isSafeInteger(remaining) || (remaining as number) < 0 || !Number.isSafeInteger(reset) || (reset as number) < 1) {
    throw new Error('GitHub did not return a valid GraphQL rate limit.')
  }
  return { checkedAt, remaining: remaining as number, resetAt: (reset as number) * 1_000 }
}

export function githubGraphQLRateLimitSnapshot() {
  const limited = [...githubGraphQLRateLimits.values()]
    .filter(limit => limit.remaining < githubGraphQLReserve && limit.resetAt > Date.now())
  if (!limited.length) return { limited: false as const }
  return {
    limited: true as const,
    remaining: Math.min(...limited.map(limit => limit.remaining)),
    resetAt: Math.max(...limited.map(limit => limit.resetAt)),
  }
}

export function isGitHubRateLimitError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'BABYSITTER_GITHUB_RATE_LIMIT'
}

export async function runBufferedCommand(command: string, args: string[], options: Omit<GitHubCommandOptions, 'repository'> = {}) {
  return await exec(command, args, {
    ...options,
    maxBuffer: githubCommandMaxBuffer,
  })
}

export function githubCommandEnvironment(token: string, env: NodeJS.ProcessEnv = process.env) {
  return { ...env, GH_TOKEN: token }
}

export function githubAgentEnvironment(token: string) {
  return {
    BABYSITTER_GITHUB_LOGIN: githubBotLogin,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_AUTHOR_EMAIL: githubBotEmail,
    GIT_AUTHOR_NAME: githubBotLogin,
    GIT_COMMITTER_EMAIL: githubBotEmail,
    GIT_COMMITTER_NAME: githubBotLogin,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function positiveInteger(value: string, name: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer.`)
  return number
}

function rateLimitKey(repository: string) {
  return repository.split('/', 1)[0]?.toLowerCase() || repository.toLowerCase()
}

function githubRateLimitError(repository: string, limit: GitHubGraphQLRateLimit, cause?: unknown) {
  return Object.assign(new Error(
    `GitHub GraphQL work for ${repository} is queued until ${new Date(limit.resetAt).toISOString()} (${limit.remaining} points remaining).`,
    cause === undefined ? undefined : { cause },
  ), { code: 'BABYSITTER_GITHUB_RATE_LIMIT', resetAt: limit.resetAt })
}

function isGitHubRateLimitMessage(error: unknown) {
  const message = error instanceof Error ? `${error.message}\n${String((error as Error & { stderr?: unknown }).stderr || '')}` : String(error)
  return /rate limit (?:already )?exceeded/i.test(message)
}

async function fallbackToken(env: GitHubAuthenticationEnv, readCliToken: () => Promise<string>) {
  const configuredToken = env.token?.unseal().trim()
  if (configuredToken) return configuredToken

  const cliToken = (await readCliToken()).trim()
  if (!cliToken) throw new Error('GitHub authentication is not configured.')
  return cliToken
}
