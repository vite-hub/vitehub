import { codexDriver, defineAgent } from 'vite-hub/agent'
import { diagnostics, otlp, title } from 'vite-hub/agent/capabilities'
import * as agentChannels from 'vite-hub/agent/channels'
import { createProcessAgentCapacity } from 'vite-hub/agent/runtime/process'
import { nodeRuntimeResources } from 'vite-hub/runtime/node'
import { defaultMaxOwners, resolveMaxOwners } from '../../babysitter.queue.ts'
import { consoleClient } from '../../console.ts'
import { github as githubHost } from '../../github.ts'
import { invocations } from '../../invocations.ts'

type GitHubAccess = Awaited<ReturnType<typeof githubHost.access>>

const capabilityAccess = await githubHost.access({ fallback: true })
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
const createCapabilities = () => [diagnostics({ resources: nodeRuntimeResources() }), title({
  execute: ({ input }) => {
    const context = input.context as { pullRequestTitle: string }
    return context.pullRequestTitle
  },
}), ...(consoleClient
  ? [otlp({
      content: { inputs: true, instructions: true, outputs: true },
      endpoint: consoleClient.endpoint('/api/otlp/v1/traces'),
      headers: consoleClient.headers,
      resource: { 'service.namespace': 'vitehub' },
    })]
  : [])] as const
const capabilities = createCapabilities()
const createDriver = (access: GitHubAccess, checkout?: string) => codexDriver({
  capacity: ownerCapacity,
  env: {
    NODE_OPTIONS: '--max-old-space-size=1024',
    ...access.env,
    ...(checkout ? { GIT_DIR: `${checkout}/.git`, GIT_WORK_TREE: '.' } : {}),
  },
  model: 'gpt-5.6-sol',
})
const driver = createDriver(capabilityAccess)

const settings = {
  capabilities,
  channels: {
    github: agentChannels.github({ activity: true, app: true, webhooks: false }),
  },
  driver,
  invocations,
  name: 'babysitter',
} as const

export function createBabysitterAgent(checkout: string, access: GitHubAccess) {
  if (!checkout) throw new Error('Babysitter requires a checkout.')
  return defineAgent({
    ...settings,
    capabilities: createCapabilities(),
    driver: createDriver(access, checkout),
    workspace: {
      commit: true,
      mode: 'write',
      store: { provider: 'local', root: checkout },
    },
  })
}

export default defineAgent(settings)
