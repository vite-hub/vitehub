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
    { name: 'createTrack', from: '@vite-hub/analytics' },
    { name: 'defineTrack', from: '@vite-hub/analytics' },
    { name: 'getAnalytics', from: '@vite-hub/analytics' },
    { name: 'track', from: '@vite-hub/analytics' },
    { name: 'AnalyticsCapabilities', as: 'AnalyticsCapabilities', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsClientOptions', as: 'AnalyticsClientOptions', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsClientStrategy', as: 'AnalyticsClientStrategy', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsCloudflareOptions', as: 'AnalyticsCloudflareOptions', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsConfig', as: 'AnalyticsConfig', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsDefinition', as: 'AnalyticsDefinition', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsDefinitionOptions', as: 'AnalyticsDefinitionOptions', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsHandle', as: 'AnalyticsHandle', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsProvider', as: 'AnalyticsProvider', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsPublicOptions', as: 'AnalyticsPublicOptions', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsRuntimeKind', as: 'AnalyticsRuntimeKind', from: '@vite-hub/analytics', type: true },
    { name: 'AnalyticsVercelOptions', as: 'AnalyticsVercelOptions', from: '@vite-hub/analytics', type: true },
  ],
  blob: [
    { name: 'blob', from: '@vite-hub/blob' },
    { name: 'ensureBlob', from: '@vite-hub/blob' },
    { name: 'BlobStorage', as: 'BlobStorage', from: '@vite-hub/blob', type: true },
    { name: 'BlobObject', as: 'BlobObject', from: '@vite-hub/blob', type: true },
    { name: 'BlobListOptions', as: 'BlobListOptions', from: '@vite-hub/blob', type: true },
    { name: 'BlobPutOptions', as: 'BlobPutOptions', from: '@vite-hub/blob', type: true },
    { name: 'BlobUploadOptions', as: 'BlobUploadOptions', from: '@vite-hub/blob', type: true },
  ],
  browser: [
    { name: 'createBrowser', from: '@vite-hub/browser' },
    { name: 'defineBrowser', from: '@vite-hub/browser' },
    { name: 'getBrowser', from: '@vite-hub/browser' },
    { name: 'readValidatedPayload', as: 'readValidatedBrowserPayload', from: '@vite-hub/browser' },
    { name: 'runBrowser', from: '@vite-hub/browser' },
    { name: 'BrowserClient', as: 'BrowserClient', from: '@vite-hub/browser', type: true },
    { name: 'BrowserProvider', as: 'BrowserProvider', from: '@vite-hub/browser', type: true },
    { name: 'BrowserRunResult', as: 'BrowserRunResult', from: '@vite-hub/browser', type: true },
  ],
  cache: [],
  cron: [
    { name: 'createCron', from: '@vite-hub/cron' },
    { name: 'defineCron', from: '@vite-hub/cron' },
    { name: 'runCron', from: '@vite-hub/cron' },
    { name: 'getCronsForExpression', from: '@vite-hub/cron' },
    { name: 'readValidatedPayload', as: 'readValidatedCronPayload', from: '@vite-hub/cron' },
    { name: 'runCronsForExpression', from: '@vite-hub/cron' },
    { name: 'startScheduleRunner', from: '@vite-hub/cron' },
    { name: 'CronProvider', as: 'CronProvider', from: '@vite-hub/cron', type: true },
  ],
  db: [],
  email: [
    { name: 'createEmailClient', from: '@vite-hub/email' },
    { name: 'renderEmail', from: '@vite-hub/email' },
    { name: 'renderEmailMarkdown', from: '@vite-hub/email' },
    { name: 'sendEmail', from: '@vite-hub/email' },
    { name: 'sendEmails', from: '@vite-hub/email' },
    { name: 'EmailSendBatchResult', as: 'EmailSendBatchResult', from: '@vite-hub/email', type: true },
    { name: 'EmailMessage', as: 'EmailMessage', from: '@vite-hub/email', type: true },
    { name: 'EmailProvider', as: 'EmailProvider', from: '@vite-hub/email', type: true },
    { name: 'EmailSendResult', as: 'EmailSendResult', from: '@vite-hub/email', type: true },
  ],
  kv: [
    { name: 'kv', from: '@vite-hub/kv' },
    { name: 'KVStorage', as: 'KVStorage', from: '@vite-hub/kv', type: true },
  ],
  queue: [
    { name: 'createQueue', from: '@vite-hub/queue' },
    { name: 'deferQueue', from: '@vite-hub/queue' },
    { name: 'defineQueue', from: '@vite-hub/queue' },
    { name: 'getQueue', from: '@vite-hub/queue' },
    { name: 'readValidatedJob', from: '@vite-hub/queue' },
    { name: 'readValidatedPayload', as: 'readValidatedQueuePayload', from: '@vite-hub/queue' },
    { name: 'runQueue', from: '@vite-hub/queue' },
    { name: 'QueueEnqueueInput', as: 'QueueEnqueueInput', from: '@vite-hub/queue', type: true },
    { name: 'QueueClient', as: 'QueueClient', from: '@vite-hub/queue', type: true },
    { name: 'QueueProvider', as: 'QueueProvider', from: '@vite-hub/queue', type: true },
  ],
  sandbox: [
    { name: 'defineSandbox', from: '@vite-hub/sandbox' },
    { name: 'readValidatedPayload', as: 'readValidatedSandboxPayload', from: '@vite-hub/sandbox' },
    { name: 'runSandbox', from: '@vite-hub/sandbox' },
    { name: 'SandboxDefinition', as: 'SandboxDefinition', from: '@vite-hub/sandbox', type: true },
    { name: 'SandboxRunResult', as: 'SandboxRunResult', from: '@vite-hub/sandbox', type: true },
  ],
  vector: [
    { name: 'defineVector', from: '@vite-hub/vector' },
    { name: 'getVector', from: '@vite-hub/vector' },
    { name: 'VectorConfig', as: 'VectorConfig', from: '@vite-hub/vector', type: true },
    { name: 'VectorDefinition', as: 'VectorDefinition', from: '@vite-hub/vector', type: true },
    { name: 'VectorDefinitionOptions', as: 'VectorDefinitionOptions', from: '@vite-hub/vector', type: true },
    { name: 'VectorFilter', as: 'VectorFilter', from: '@vite-hub/vector', type: true },
    { name: 'VectorHandle', as: 'VectorHandle', from: '@vite-hub/vector', type: true },
    { name: 'VectorMatch', as: 'VectorMatch', from: '@vite-hub/vector', type: true },
    { name: 'VectorMetric', as: 'VectorMetric', from: '@vite-hub/vector', type: true },
    { name: 'VectorProvider', as: 'VectorProvider', from: '@vite-hub/vector', type: true },
    { name: 'VectorQuery', as: 'VectorQuery', from: '@vite-hub/vector', type: true },
    { name: 'VectorQueryResult', as: 'VectorQueryResult', from: '@vite-hub/vector', type: true },
    { name: 'VectorRecord', as: 'VectorRecord', from: '@vite-hub/vector', type: true },
    { name: 'VectorValues', as: 'VectorValues', from: '@vite-hub/vector', type: true },
  ],
  workflow: [
    { name: 'createWorkflow', from: '@vite-hub/workflow' },
    { name: 'deferWorkflow', from: '@vite-hub/workflow' },
    { name: 'defineWorkflow', from: '@vite-hub/workflow' },
    { name: 'getWorkflowRun', from: '@vite-hub/workflow' },
    { name: 'readValidatedPayload', as: 'readValidatedWorkflowPayload', from: '@vite-hub/workflow' },
    { name: 'runWorkflow', from: '@vite-hub/workflow' },
    { name: 'WorkflowProvider', as: 'WorkflowProvider', from: '@vite-hub/workflow', type: true },
    { name: 'WorkflowRun', as: 'WorkflowRun', from: '@vite-hub/workflow', type: true },
    { name: 'WorkflowRunStatus', as: 'WorkflowRunStatus', from: '@vite-hub/workflow', type: true },
  ],
} satisfies Record<ViteHubFeatureName, ServerImport[]>

function getDbFeatureImports(options: ViteHubOptions): ServerImport[] {
  return [
    { name: 'db', from: '@vite-hub/database/drizzle' },
    { name: 'schema', from: '@vite-hub/database/drizzle' },
  ]
}

const featureNitroModules: Partial<Record<ViteHubFeatureName, string>> = {
  analytics: '@vite-hub/analytics/nitro',
  blob: '@vite-hub/blob/nitro',
  browser: '@vite-hub/browser/nitro',
  cache: '@vite-hub/cache/nitro',
  cron: '@vite-hub/cron/nitro',
  db: '@vite-hub/database/nitro',
  email: '@vite-hub/email/nitro',
  kv: '@vite-hub/kv/nitro',
  queue: '@vite-hub/queue/nitro',
  vector: '@vite-hub/vector/nitro',
  workflow: '@vite-hub/workflow/nitro',
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
