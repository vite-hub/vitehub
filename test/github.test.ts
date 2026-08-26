import assert from 'node:assert/strict'
import test from 'node:test'
import { createGitHubTokenProvider, githubAgentEnvironment } from '../server/github.ts'

const secret = (value: string) => ({ unseal: () => value })

test('mints and caches installation authentication from complete App credentials', async () => {
  const calls: unknown[] = []
  const provider = createGitHubTokenProvider({
    async loadCreateAuth() {
      calls.push('load-auth')
      return (options) => {
        calls.push(options)
        return (async (authentication: unknown) => {
          calls.push(authentication)
          return { token: 'installation-token' }
        }) as ReturnType<typeof import('@octokit/auth-app').createAppAuth>
      }
    },
    readEnv: () => ({
      appId: '123',
      installationId: '456',
      owner: 'vite-hub',
      privateKey: secret('line-1\\nline-2'),
    }),
  })

  assert.equal(await provider(), 'installation-token')
  assert.equal(await provider(), 'installation-token')
  assert.equal(await provider({ refresh: true, repository: 'vite-hub/vitehub' }), 'installation-token')
  assert.deepEqual(calls, [
    'load-auth',
    { appId: 123, privateKey: 'line-1\nline-2' },
    { type: 'installation', installationId: 456, refresh: false },
    { type: 'installation', installationId: 456, refresh: false },
    { type: 'installation', installationId: 456, refresh: true },
  ])
})

test('rejects partial App configuration instead of falling through to another identity', async () => {
  const provider = createGitHubTokenProvider({
    readEnv: () => ({ appId: '123', installationId: '', owner: 'vite-hub' }),
  })

  await assert.rejects(provider, /must be configured together/)
})

test('uses the configured token and then local gh auth as development fallbacks', async () => {
  const configured = createGitHubTokenProvider({
    readCliToken: async () => 'cli-token',
    readEnv: () => ({ appId: '', installationId: '', owner: 'vite-hub', token: secret('configured-token') }),
  })
  const local = createGitHubTokenProvider({
    readCliToken: async () => 'cli-token\n',
    readEnv: () => ({ appId: '', installationId: '', owner: 'vite-hub' }),
  })

  assert.equal(await configured(), 'configured-token')
  assert.equal(await local(), 'cli-token')
})

test('keeps the fallback identity for repositories outside the App owner', async () => {
  let appAuthLoads = 0
  const provider = createGitHubTokenProvider({
    async loadCreateAuth() {
      appAuthLoads++
      throw new Error('App auth must remain lazy on the startup fallback path.')
    },
    readCliToken: async () => 'cli-token',
    readEnv: () => ({
      appId: '123',
      installationId: '456',
      owner: 'vite-hub',
      privateKey: secret('private-key'),
    }),
  })

  assert.equal(await provider({ repository: 'onmax/quiver-babysitter' }), 'cli-token')
  assert.equal(await provider({ fallback: true }), 'cli-token')
  assert.equal(appAuthLoads, 0)
})

test('projects the bot token and commit identity into the agent environment', () => {
  assert.deepEqual(githubAgentEnvironment('installation-token'), {
    BABYSITTER_GITHUB_LOGIN: 'vitehub-bot[bot]',
    GH_TOKEN: 'installation-token',
    GITHUB_TOKEN: 'installation-token',
    GIT_AUTHOR_EMAIL: '320448255+vitehub-bot[bot]@users.noreply.github.com',
    GIT_AUTHOR_NAME: 'vitehub-bot[bot]',
    GIT_COMMITTER_EMAIL: '320448255+vitehub-bot[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'vitehub-bot[bot]',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  })
})
