import {
  createExecutionContext,
  ViteHubError,
  type ExecutionContext,
  type RuntimeCapabilities,
  type ViteHubErrorShape,
} from "@vite-hub/runtime"

type RuntimeExports = typeof import("@vite-hub/runtime")
const hasNoResolveExecutionContext: "resolveExecutionContext" extends keyof RuntimeExports ? false : true = true
const hasNoResolveRuntimeContext: "resolveRuntimeContext" extends keyof RuntimeExports ? false : true = true

void hasNoResolveExecutionContext
void hasNoResolveRuntimeContext

const defaultContext = createExecutionContext({
  memo: (_key, create) => create(),
  runtime: "node",
  waitUntil: () => {},
})

defaultContext satisfies ExecutionContext
defaultContext.capabilities satisfies RuntimeCapabilities
defaultContext.runtimeConfig satisfies Record<string, unknown>

const capabilities: RuntimeCapabilities = {}
const runtimeConfig = { region: "local" }
const configuredContext = createExecutionContext({
  capabilities,
  memo: (_key, create) => create(),
  runtime: "node",
  runtimeConfig,
  waitUntil: () => {},
})

configuredContext.capabilities satisfies RuntimeCapabilities
configuredContext.runtimeConfig satisfies { region: string }

const explicitlyUndefinedContext = createExecutionContext({
  capabilities: undefined,
  memo: (_key, create) => create(),
  runtime: "node",
  runtimeConfig: undefined,
  source: "host" as const,
  waitUntil: () => {},
})

explicitlyUndefinedContext.capabilities satisfies RuntimeCapabilities
explicitlyUndefinedContext.runtimeConfig satisfies Record<string, unknown>
explicitlyUndefinedContext.source satisfies "host"

const error = new ViteHubError("PROVIDER_FAILED", "The provider request failed.", {
  details: { provider: "fixture" },
})

error.toJSON() satisfies ViteHubErrorShape<"PROVIDER_FAILED", { provider: string }>
new ViteHubError("CAPABILITY_NOT_FOUND", "Capability was not found.").code satisfies "CAPABILITY_NOT_FOUND"
new ViteHubError("APPROVAL_REQUIRED", "Approval is required.", {
  details: { id: "approval-1", state: "awaiting-approval" },
}).toJSON() satisfies ViteHubErrorShape<"APPROVAL_REQUIRED", { id: string, state: string }>
