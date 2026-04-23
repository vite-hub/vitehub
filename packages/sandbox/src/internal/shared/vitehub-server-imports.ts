import type { ServerImport } from './runtime-artifacts'
import { dedupeServerImports } from './server-imports'

type ViteHubOptions = Record<string, any> & {
  modules?: string[]
}

export type ViteHubFeatureName
  = | 'blob'
    | 'browser'
    | 'cache'
    | 'analytics'
    | 'cron'
    | 'db'
    | 'email'
    | 'kv'
    | 'queue'
    | 'sandbox'
    | 'vector'
    | 'workflow'

const featureImports = {
  analytics: [
    { name: 'createTrack', from: '@vitehub/analytics' },
    { name: 'defineTrack', from: '@vitehub/analytics' },
    { name: 'getAnalytics', from: '@vitehub/analytics' },
    { name: 'track', from: '@vitehub/analytics' },
    { name: 'AnalyticsCapabilities', as: 'AnalyticsCapabilities', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsClientOptions', as: 'AnalyticsClientOptions', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsClientStrategy', as: 'AnalyticsClientStrategy', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsCloudflareOptions', as: 'AnalyticsCloudflareOptions', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsConfig', as: 'AnalyticsConfig', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsDefinition', as: 'AnalyticsDefinition', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsDefinitionOptions', as: 'AnalyticsDefinitionOptions', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsHandle', as: 'AnalyticsHandle', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsProvider', as: 'AnalyticsProvider', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsPublicOptions', as: 'AnalyticsPublicOptions', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsRuntimeKind', as: 'AnalyticsRuntimeKind', from: '@vitehub/analytics', type: true },
    { name: 'AnalyticsVercelOptions', as: 'AnalyticsVercelOptions', from: '@vitehub/analytics', type: true },
  ],
  blob: [
    { name: 'blob', from: '@vitehub/blob' },
    { name: 'ensureBlob', from: '@vitehub/blob' },
    { name: 'BlobStorage', as: 'BlobStorage', from: '@vitehub/blob', type: true },
    { name: 'BlobObject', as: 'BlobObject', from: '@vitehub/blob', type: true },
    { name: 'BlobListOptions', as: 'BlobListOptions', from: '@vitehub/blob', type: true },
    { name: 'BlobPutOptions', as: 'BlobPutOptions', from: '@vitehub/blob', type: true },
    { name: 'BlobUploadOptions', as: 'BlobUploadOptions', from: '@vitehub/blob', type: true },
  ],
  browser: [
    { name: 'createBrowser', from: '@vitehub/browser' },
    { name: 'defineBrowser', from: '@vitehub/browser' },
    { name: 'getBrowser', from: '@vitehub/browser' },
    { name: 'readValidatedPayload', as: 'readValidatedBrowserPayload', from: '@vitehub/browser' },
    { name: 'runBrowser', from: '@vitehub/browser' },
    { name: 'BrowserClient', as: 'BrowserClient', from: '@vitehub/browser', type: true },
    { name: 'BrowserProvider', as: 'BrowserProvider', from: '@vitehub/browser', type: true },
    { name: 'BrowserRunResult', as: 'BrowserRunResult', from: '@vitehub/browser', type: true },
  ],
  cache: [],
  cron: [
    { name: 'createCron', from: '@vitehub/cron' },
    { name: 'defineCron', from: '@vitehub/cron' },
    { name: 'runCron', from: '@vitehub/cron' },
    { name: 'getCronsForExpression', from: '@vitehub/cron' },
    { name: 'readValidatedPayload', as: 'readValidatedCronPayload', from: '@vitehub/cron' },
    { name: 'runCronsForExpression', from: '@vitehub/cron' },
    { name: 'startScheduleRunner', from: '@vitehub/cron' },
    { name: 'CronProvider', as: 'CronProvider', from: '@vitehub/cron', type: true },
  ],
  db: [],
  email: [
    { name: 'createEmailClient', from: '@vitehub/email' },
    { name: 'renderEmail', from: '@vitehub/email' },
    { name: 'renderEmailMarkdown', from: '@vitehub/email' },
    { name: 'sendEmail', from: '@vitehub/email' },
    { name: 'sendEmails', from: '@vitehub/email' },
    { name: 'EmailSendBatchResult', as: 'EmailSendBatchResult', from: '@vitehub/email', type: true },
    { name: 'EmailMessage', as: 'EmailMessage', from: '@vitehub/email', type: true },
    { name: 'EmailProvider', as: 'EmailProvider', from: '@vitehub/email', type: true },
    { name: 'EmailSendResult', as: 'EmailSendResult', from: '@vitehub/email', type: true },
  ],
  kv: [
    { name: 'kv', from: '@vitehub/kv' },
    { name: 'KVStorage', as: 'KVStorage', from: '@vitehub/kv', type: true },
  ],
  queue: [
    { name: 'createQueue', from: '@vitehub/queue' },
    { name: 'deferQueue', from: '@vitehub/queue' },
    { name: 'defineQueue', from: '@vitehub/queue' },
    { name: 'getQueue', from: '@vitehub/queue' },
    { name: 'readValidatedJob', from: '@vitehub/queue' },
    { name: 'readValidatedPayload', as: 'readValidatedQueuePayload', from: '@vitehub/queue' },
    { name: 'runQueue', from: '@vitehub/queue' },
    { name: 'QueueEnqueueInput', as: 'QueueEnqueueInput', from: '@vitehub/queue', type: true },
    { name: 'QueueClient', as: 'QueueClient', from: '@vitehub/queue', type: true },
    { name: 'QueueProvider', as: 'QueueProvider', from: '@vitehub/queue', type: true },
  ],
  sandbox: [
    { name: 'defineSandbox', from: '@vitehub/sandbox' },
    { name: 'readValidatedPayload', as: 'readValidatedSandboxPayload', from: '@vitehub/sandbox' },
    { name: 'runSandbox', from: '@vitehub/sandbox' },
    { name: 'SandboxDefinition', as: 'SandboxDefinition', from: '@vitehub/sandbox', type: true },
    { name: 'SandboxRunResult', as: 'SandboxRunResult', from: '@vitehub/sandbox', type: true },
  ],
  vector: [
    { name: 'defineVector', from: '@vitehub/vector' },
    { name: 'getVector', from: '@vitehub/vector' },
    { name: 'VectorConfig', as: 'VectorConfig', from: '@vitehub/vector', type: true },
    { name: 'VectorDefinition', as: 'VectorDefinition', from: '@vitehub/vector', type: true },
    { name: 'VectorDefinitionOptions', as: 'VectorDefinitionOptions', from: '@vitehub/vector', type: true },
    { name: 'VectorFilter', as: 'VectorFilter', from: '@vitehub/vector', type: true },
    { name: 'VectorHandle', as: 'VectorHandle', from: '@vitehub/vector', type: true },
    { name: 'VectorMatch', as: 'VectorMatch', from: '@vitehub/vector', type: true },
    { name: 'VectorMetric', as: 'VectorMetric', from: '@vitehub/vector', type: true },
    { name: 'VectorProvider', as: 'VectorProvider', from: '@vitehub/vector', type: true },
    { name: 'VectorQuery', as: 'VectorQuery', from: '@vitehub/vector', type: true },
    { name: 'VectorQueryResult', as: 'VectorQueryResult', from: '@vitehub/vector', type: true },
    { name: 'VectorRecord', as: 'VectorRecord', from: '@vitehub/vector', type: true },
    { name: 'VectorValues', as: 'VectorValues', from: '@vitehub/vector', type: true },
  ],
  workflow: [
    { name: 'createWorkflow', from: '@vitehub/workflow' },
    { name: 'deferWorkflow', from: '@vitehub/workflow' },
    { name: 'defineWorkflow', from: '@vitehub/workflow' },
    { name: 'getWorkflowRun', from: '@vitehub/workflow' },
    { name: 'readValidatedPayload', as: 'readValidatedWorkflowPayload', from: '@vitehub/workflow' },
    { name: 'runWorkflow', from: '@vitehub/workflow' },
    { name: 'WorkflowProvider', as: 'WorkflowProvider', from: '@vitehub/workflow', type: true },
    { name: 'WorkflowRun', as: 'WorkflowRun', from: '@vitehub/workflow', type: true },
    { name: 'WorkflowRunStatus', as: 'WorkflowRunStatus', from: '@vitehub/workflow', type: true },
  ],
} satisfies Record<ViteHubFeatureName, ServerImport[]>

function getDbFeatureImports(options: ViteHubOptions): ServerImport[] {
  const db = options.db as { orm?: string } | undefined
  if (db?.orm === 'prisma') {
    return [
      { name: 'prisma', from: '@vitehub/db/prisma' },
    ]
  }

  return [
    { name: 'db', from: '@vitehub/db/drizzle' },
    { name: 'schema', from: '@vitehub/db/drizzle' },
  ]
}

const featureNitroModules: Partial<Record<ViteHubFeatureName, string>> = {
  analytics: '@vitehub/analytics/nitro',
  blob: '@vitehub/blob/nitro',
  browser: '@vitehub/browser/nitro',
  cache: '@vitehub/cache/nitro',
  cron: '@vitehub/cron/nitro',
  db: '@vitehub/db/nitro',
  email: '@vitehub/email/nitro',
  kv: '@vitehub/kv/nitro',
  queue: '@vitehub/queue/nitro',
  vector: '@vitehub/vector/nitro',
  workflow: '@vitehub/workflow/nitro',
}

function hasNitroModule(options: ViteHubOptions, modulePath: string) {
  return Array.isArray(options.modules) && options.modules.includes(modulePath)
}

function isFeatureEnabled(feature: ViteHubFeatureName, options: ViteHubOptions) {
  if (feature === 'db')
    return typeof options.db !== 'undefined'

  const optionValue = options[feature]
  if (optionValue === false)
    return false
  if (typeof optionValue !== 'undefined')
    return true

  const nitroModule = featureNitroModules[feature]
  return !!nitroModule && hasNitroModule(options, nitroModule)
}

export function getViteHubFeatureServerImports(
  feature: ViteHubFeatureName,
  options: ViteHubOptions = {},
): ServerImport[] {
  if (feature === 'db')
    return dedupeServerImports(getDbFeatureImports(options))

  return dedupeServerImports(featureImports[feature])
}

export function resolveViteHubFeatureServerImports(
  feature: ViteHubFeatureName,
  options: ViteHubOptions = {},
): ServerImport[] {
  if (!isFeatureEnabled(feature, options))
    return []

  return getViteHubFeatureServerImports(feature, options)
}

export function resolveEnabledViteHubServerImports(options: ViteHubOptions = {}): ServerImport[] {
  return dedupeServerImports(
    (Object.keys(featureImports) as ViteHubFeatureName[]).flatMap((feature) => {
      if (!isFeatureEnabled(feature, options))
        return []

      return getViteHubFeatureServerImports(feature, options)
    }),
  )
}

export function resolveEffectiveViteHubServerImports(
  options: ViteHubOptions = {},
  feature?: ViteHubFeatureName,
): ServerImport[] {
  return dedupeServerImports([
    ...resolveEnabledViteHubServerImports(options),
    ...(feature ? getViteHubFeatureServerImports(feature, options) : []),
  ])
}
