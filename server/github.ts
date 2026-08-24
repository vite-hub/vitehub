import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createAppAuth } from '@octokit/auth-app'
import { useServerEnv } from '#vitehub/env/server'

type Secret = { unseal: () => string }

export type GitHubAuthenticationEnv = {
  appId: string
  installationId: string
  privateKey?: Secret
  token?: Secret
}

type GitHubAppAuth = ReturnType<typeof createAppAuth>

type GitHubTokenProviderOptions = {
  createAuth?: typeof createAppAuth
  readCliToken?: () => Promise<string>
  readEnv: () => GitHubAuthenticationEnv
}

type GitHubCommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

const exec = promisify(execFile)

export const githubBotLogin = 'vitehub-bot[bot]'
export const githubBotEmail = '320448255+vitehub-bot[bot]@users.noreply.github.com'

export function createGitHubTokenProvider({
  createAuth = createAppAuth,
  readCliToken = async () => (await exec('gh', ['auth', 'token'])).stdout,
  readEnv,
}: GitHubTokenProviderOptions) {
  let cached: { appId: number, auth: GitHubAppAuth, installationId: number, privateKey: string } | undefined

  return async ({ refresh = false }: { refresh?: boolean } = {}) => {
    const env = readEnv()
    const appId = env.appId.trim()
    const installationId = env.installationId.trim()
    const privateKey = env.privateKey?.unseal().trim().replace(/\\n/g, '\n') || ''
    const appValues = [appId, installationId, privateKey]

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) {
        throw new Error('GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY must be configured together.')
      }

      const numericAppId = positiveInteger(appId, 'GITHUB_APP_ID')
      const numericInstallationId = positiveInteger(installationId, 'GITHUB_APP_INSTALLATION_ID')
      if (!cached
        || cached.appId !== numericAppId
        || cached.installationId !== numericInstallationId
        || cached.privateKey !== privateKey) {
        cached = {
          appId: numericAppId,
          auth: createAuth({ appId: numericAppId, privateKey }),
          installationId: numericInstallationId,
          privateKey,
        }
      }

      return (await cached.auth({ type: 'installation', installationId: numericInstallationId, refresh })).token
    }

    const configuredToken = env.token?.unseal().trim()
    if (configuredToken) return configuredToken

    const cliToken = (await readCliToken()).trim()
    if (!cliToken) throw new Error('GitHub authentication is not configured.')
    return cliToken
  }
}

export const githubToken = createGitHubTokenProvider({
  readEnv: () => useServerEnv().github,
})

export async function runGitHub(args: string[], options: GitHubCommandOptions = {}) {
  return await exec('gh', args, {
    ...options,
    env: githubCommandEnvironment(await githubToken(), options.env),
  })
}

export function githubCommandEnvironment(token: string, env: NodeJS.ProcessEnv = process.env) {
  return { ...env, GH_TOKEN: token }
}

export function githubAgentEnvironment(token: string) {
  return {
    BABYSITTER_GITHUB_LOGIN: githubBotLogin,
    GH_TOKEN: token,
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
