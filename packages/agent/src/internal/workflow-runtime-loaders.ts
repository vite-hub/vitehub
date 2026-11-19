import { invariant } from "@vite-hub/internal/invariant"

const workflowSpecifier = "@vite-hub/workflow"
const workflowRuntimeStateSpecifier = "@vite-hub/workflow/runtime/state"
// Module-level specifiers stay variables in the built output. The bundler inlines a local constant,
// and then `vite dev` resolves the import eagerly and fails when the app disables Blob or Database.
const blobSpecifier = "@vite-hub/blob"
const databaseSpecifier = "@vite-hub/database/runtime/registry"

type WorkflowModule = typeof import("@vite-hub/workflow")
type WorkflowRuntimeStateModule = typeof import("@vite-hub/workflow/runtime/state")

export interface AgentWorkflowRuntimeLoaders {
  state: () => Promise<WorkflowRuntimeStateModule>
  workflow: () => Promise<WorkflowModule>
}

export interface AgentWorkflowCapabilityLoaders {
  blob?: () => Promise<unknown> | unknown
  console?: () => Promise<unknown> | unknown
  db?: () => Promise<unknown> | unknown
}

let workflowRuntimeLoaders: AgentWorkflowRuntimeLoaders | false = {
  state: () => import(/* @vite-ignore */ workflowRuntimeStateSpecifier),
  workflow: () => import(/* @vite-ignore */ workflowSpecifier),
}
let workflowCapabilityLoaders: AgentWorkflowCapabilityLoaders = {}

export function setAgentWorkflowRuntimeLoaders(loaders: AgentWorkflowRuntimeLoaders | false): void {
  workflowRuntimeLoaders = loaders
}

export function setAgentWorkflowCapabilityLoaders(loaders: AgentWorkflowCapabilityLoaders): void {
  workflowCapabilityLoaders = loaders
}

function getAgentWorkflowCapabilityLoader(name: string): (() => Promise<unknown> | unknown) | undefined {
  switch (name) {
    case "blob": return workflowCapabilityLoaders.blob
    case "console": return workflowCapabilityLoaders.console
    case "db": return workflowCapabilityLoaders.db
    default: return undefined
  }
}

export async function loadConfiguredAgentWorkflowCapabilities(
  mask: Record<string, boolean> = {},
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(Object.entries(mask).map(async ([name, enabled]) => {
    if (!enabled) return [name, false] as const
    const load = getAgentWorkflowCapabilityLoader(name)
    return load ? [name, await load()] as const : undefined
  }))
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, unknown] => entry !== undefined))
}

export function loadAgentWorkflowModule(): Promise<WorkflowModule> {
  return requireAgentWorkflowLoaders().workflow()
}

export function loadAgentWorkflowRuntimeStateModule(): Promise<WorkflowRuntimeStateModule> {
  return requireAgentWorkflowLoaders().state()
}

function requireAgentWorkflowLoaders(): AgentWorkflowRuntimeLoaders {
  if (workflowRuntimeLoaders === false) {
    throw new Error("[vitehub] This Agent requires Workflow. Set `workflow: true` in your ViteHub config or remove the `agentWorkflow()` runtime binding.")
  }
  return workflowRuntimeLoaders
}

/**
 * Loads Workflow state only when the host has not disabled Workflow and the optional peer is installed.
 */
export async function loadInstalledAgentWorkflowRuntimeStateModule(): Promise<WorkflowRuntimeStateModule | undefined> {
  if (workflowRuntimeLoaders === false) return undefined
  try {
    return await workflowRuntimeLoaders.state()
  }
  catch (error) {
    if (isMissingWorkflowPackage(error)) return undefined
    throw error
  }
}

// Node quotes the missing specifier: "Cannot find package '@vite-hub/workflow' imported from ...".
// A missing dependency of `@vite-hub/workflow` quotes that dependency instead, so it still fails.
const missingWorkflowPackage = /'@vite-hub\/workflow(?:\/[^']*)?'/u

function isMissingWorkflowPackage(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
    && missingWorkflowPackage.test(error.message)
}

export async function loadAgentWorkflowBlobPrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.blob) return await workflowCapabilityLoaders.blob()
  // SAFETY: The official Blob package export is the primitive registered by generated Workflow hosts.
  return ((await import(/* @vite-ignore */ blobSpecifier)) as { blob: unknown }).blob
}

export async function loadAgentWorkflowConsolePrimitive(): Promise<unknown> {
  const load = workflowCapabilityLoaders.console
  invariant(load, "the generated Workflow host sets a Console capability loader before the Console Workflow capability loads")
  return await load()
}

export async function loadAgentWorkflowDatabasePrimitive(): Promise<unknown> {
  if (workflowCapabilityLoaders.db) return await workflowCapabilityLoaders.db()
  // SAFETY: The official Database package export is the primitive registered by generated Workflow hosts.
  return ((await import(/* @vite-ignore */ databaseSpecifier)) as { agentDb: unknown }).agentDb
}
