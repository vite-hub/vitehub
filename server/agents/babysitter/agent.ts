import github from '@github-tools/eve-extension'
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { diagnostics, otlp, title } from 'vite-hub/agent/capabilities'
import { nodeRuntimeResources } from '@vite-hub/runtime'
import { reportOperationalDiagnostic } from '../../babysitter.operations.ts'
import { consoleClient } from '../../console.ts'
import { githubAgentEnvironment, githubToken } from '../../github.ts'
import { invocations } from '../../invocations.ts'

const capabilityToken = await githubToken({ fallback: true })
const capabilities = [diagnostics({
  reporter: reportOperationalDiagnostic,
  resources: nodeRuntimeResources(),
}), title({
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
  token: capabilityToken,
}), ...(consoleClient
  ? [otlp({
      content: { inputs: true, instructions: true, outputs: true },
      endpoint: consoleClient.endpoint('/api/otlp/v1/traces'),
      headers: consoleClient.headers,
      live: true,
      resource: { 'service.namespace': 'vitehub' },
    })]
  : [])] as const
const settings = {
  capabilities,
  invocations,
  name: 'babysitter',
} as const

export function createBabysitterAgent(checkout: string, token: string) {
  if (!checkout) throw new Error('Babysitter requires a checkout.')
  return defineAgent({
    ...settings,
    driver: driver(token),
    workspace: {
      commit: true,
      mode: 'write',
      store: { provider: 'local', root: checkout },
    },
  })
}

export default defineAgent({
  ...settings,
  driver: driver(capabilityToken),
})

function driver(token: string) {
  return codexDriver({
    env: githubAgentEnvironment(token),
    model: 'gpt-5.6-sol',
  })
}
