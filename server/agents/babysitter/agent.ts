import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import github from '@github-tools/eve-extension'
import { codexDriver, defineAgent, otlpHttpJson } from 'vite-hub/agent'
import { title } from 'vite-hub/agent/capabilities'
import { consoleClient } from '../../console.ts'
import { invocations } from '../../invocations.ts'

const exec = promisify(execFile)
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const codexAuth = join(codexHome, 'auth.json')
const githubToken = process.env.GITHUB_TOKEN || (await exec('gh', ['auth', 'token'])).stdout.trim()
const capabilities = [title({
  execute: ({ input }) => {
    const context = input.context as { pullRequestTitle: string }
    return context.pullRequestTitle
  },
}), github({
  exclude: [
    'addPullRequestComment',
    'createPullRequestReview',
    'deletePullRequestComment',
    'requestReviewers',
    'updatePullRequest',
    'updatePullRequestComment',
  ],
  preset: 'code-review',
  token: githubToken,
})] as const
const driver = codexDriver({ model: 'gpt-5.6-sol' }).withCallOptions<{ checkout: string }>()

export default defineAgent({
  box: {
    runtime: 'trusted-host',
    cwd: ({ input }) => {
      const checkout = input.options?.checkout
      if (!checkout) throw new Error('Babysitter requires a checkout.')
      return checkout
    },
    env: {
      GH_TOKEN: async () => (await exec('gh', ['auth', 'token'])).stdout.trim(),
      GIT_AUTHOR_EMAIL: () => readGitConfig('user.email'),
      GIT_AUTHOR_NAME: () => readGitConfig('user.name'),
      GIT_COMMITTER_EMAIL: () => readGitConfig('user.email'),
      GIT_COMMITTER_NAME: () => readGitConfig('user.name'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    home: {
      files: {
        ...(existsSync(codexAuth) ? {
          '.codex/auth.json': { contents: () => readFile(codexAuth) },
          '.codex/config.toml': { contents: 'cli_auth_credentials_store = "file"\n' },
        } : {}),
        '.gitconfig': { contents: '[credential "https://github.com"]\n\thelper = !gh auth git-credential\n' },
      },
    },
    requires: [
      'git',
      { command: 'gh', args: ['auth', 'status'] },
      'pnpm',
    ],
  },
  capabilities,
  driver,
  invocations,
  name: 'babysitter',
  telemetry: consoleClient && otlpHttpJson({
    endpoint: consoleClient.endpoint('/api/otlp/v1/traces'),
    headers: consoleClient.headers,
    resource: { 'service.namespace': 'vitehub' },
  }),
})

async function readGitConfig(key: string) {
  try {
    return (await exec('git', ['config', '--get', key])).stdout.trim()
  }
  catch {
    const login = (await exec('gh', ['api', 'user', '--jq', '.login'])).stdout.trim()
    return key === 'user.name' ? login : `${login}@users.noreply.github.com`
  }
}
