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

const exec = promisify(execFile)

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
  return await exec('gh', args, {
    ...commandOptions,
    env: githubCommandEnvironment(await githubToken({ repository }), options.env),
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

async function fallbackToken(env: GitHubAuthenticationEnv, readCliToken: () => Promise<string>) {
  const configuredToken = env.token?.unseal().trim()
  if (configuredToken) return configuredToken

  const cliToken = (await readCliToken()).trim()
  if (!cliToken) throw new Error('GitHub authentication is not configured.')
  return cliToken
}
