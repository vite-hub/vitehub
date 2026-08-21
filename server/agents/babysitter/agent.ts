import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import github from '@github-tools/eve-extension'
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { otlp, title } from 'vite-hub/agent/capabilities'
import { consoleClient } from '../../console.ts'
import { invocations } from '../../invocations.ts'

const exec = promisify(execFile)
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
}), ...(consoleClient
  ? [otlp({
      content: { inputs: true, instructions: true, outputs: true },
      endpoint: consoleClient.endpoint('/api/otlp/v1/traces'),
      headers: consoleClient.headers,
      live: true,
      resource: { 'service.namespace': 'vitehub' },
    })]
  : [])] as const
const driver = codexDriver({
  env: {
    GH_TOKEN: githubToken,
    GIT_AUTHOR_EMAIL: await readGitConfig('user.email'),
    GIT_AUTHOR_NAME: await readGitConfig('user.name'),
    GIT_COMMITTER_EMAIL: await readGitConfig('user.email'),
    GIT_COMMITTER_NAME: await readGitConfig('user.name'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  },
  model: 'gpt-5.6-sol',
})

const settings = {
  capabilities,
  driver,
  invocations,
  name: 'babysitter',
} as const

export function createBabysitterAgent(checkout: string) {
  if (!checkout) throw new Error('Babysitter requires a checkout.')
  return defineAgent({
    ...settings,
    workspace: {
      commit: true,
      mode: 'write',
      store: { provider: 'local', root: checkout },
    },
  })
}

export default defineAgent(settings)

async function readGitConfig(key: string) {
  try {
    return (await exec('git', ['config', '--get', key])).stdout.trim()
  }
  catch {
    const login = (await exec('gh', ['api', 'user', '--jq', '.login'])).stdout.trim()
    return key === 'user.name' ? login : `${login}@users.noreply.github.com`
  }
}
