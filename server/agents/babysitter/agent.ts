import github from '@github-tools/eve-extension'
import { createProcessAgentCapacity } from '@vite-hub/agent/runtime/process'
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { diagnostics, otlp, title } from 'vite-hub/agent/capabilities'
import { nodeRuntimeResources } from '@vite-hub/runtime/node'
import { reportOperationalDiagnostic } from '../../babysitter.operations.ts'
import { createCheckoutGitEnvironment } from '../../babysitter.checkout.ts'
import { createProviderResourceEnvironment } from '../../babysitter.provider.ts'
import { defaultMaxOwners, resolveMaxOwners } from '../../babysitter.queue.ts'
import { consoleClient } from '../../console.ts'
import { githubAgentEnvironment, githubToken } from '../../github.ts'
import { invocations } from '../../invocations.ts'

const capabilityToken = await githubToken({ fallback: true })
const maxOwners = resolveMaxOwners(process.env.BABYSITTER_MAX_OWNERS || defaultMaxOwners)
export const ownerCapacity = createProcessAgentCapacity({
  concurrency: maxOwners,
  cpu: { pausePressure: 0.25, resumePressure: 0.10 },
  fallbackConcurrency: 1,
  intervalMs: 5_000,
  memory: {
    pausePressure: 0.05,
    perInvocationBytes: 1024 ** 3,
    reserveBytes: 1024 ** 3,
    resumePressure: 0.01,
  },
  queue: { maxPending: 100 },
  rampUp: 1,
})
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
      resource: { 'service.namespace': 'vitehub' },
    })]
  : [])] as const
const createDriver = (token: string, checkout?: string) => codexDriver({
  capacity: ownerCapacity,
  env: {
    ...createProviderResourceEnvironment(),
    ...githubAgentEnvironment(token),
    ...(checkout ? createCheckoutGitEnvironment(checkout) : {}),
  },
  model: 'gpt-5.6-sol',
})
const driver = createDriver(capabilityToken)

const settings = {
  capabilities,
  driver,
  invocations,
  name: 'babysitter',
} as const

export function createBabysitterAgent(checkout: string, token: string) {
  if (!checkout) throw new Error('Babysitter requires a checkout.')
  return defineAgent({
    ...settings,
    driver: createDriver(token, checkout),
    workspace: {
      commit: true,
      mode: 'write',
      store: { provider: 'local', root: checkout },
    },
  })
}

export default defineAgent(settings)
