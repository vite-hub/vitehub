import { runWorkflowHandler } from "./execute.ts"
import { createWorkflowError } from "../errors.ts"
import { getWorkflowProviderStatus, runWorkflowProviderOperation } from "./provider-operation.ts"

import type { RetryPolicy } from "openworkflow"
import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDeferOptions, WorkflowProviderStep, WorkflowRun, WorkflowRunStatus, WorkflowRuntimeConfigValue, WorkflowRuntimeEnvDeclarationLike, WorkflowStepOptions } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

type OpenWorkflowModule = typeof import("openworkflow")
type NodeFsModule = typeof import("node:fs")
type NodePathModule = typeof import("node:path")
type OpenWorkflowPostgresModule = typeof import("openworkflow/postgres")
type OpenWorkflowSqliteModule = typeof import("openworkflow/sqlite")
type OpenWorkflowClient = InstanceType<OpenWorkflowModule["OpenWorkflow"]>
type OpenWorkflowBackend = Awaited<ReturnType<OpenWorkflowPostgresModule["BackendPostgres"]["connect"]>> | ReturnType<OpenWorkflowSqliteModule["BackendSqlite"]["connect"]>
type OpenWorkflowRunnable = ReturnType<OpenWorkflowClient["defineWorkflow"]>
type OpenWorkflowRun = Awaited<ReturnType<OpenWorkflowBackend["getWorkflowRun"]>>
type OpenWorkflowStepApi = Parameters<Parameters<OpenWorkflowClient["defineWorkflow"]>[1]>[0]["step"]
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Dynamic imports preserve the module type supplied by each internal call site.
type OpenWorkflowImporter = <T>(specifier: string) => Promise<T>
// SAFETY: The generated function implements the importer signature above and returns the requested dynamic module.
const defaultImporter = new Function("specifier", "return import(specifier)") as OpenWorkflowImporter
let openWorkflowImporter = defaultImporter
const defaultOpenWorkflowSqlitePath = ".vitehub/data/openworkflow.sqlite.db"

interface OpenWorkflowRuntime {
  backend: OpenWorkflowBackend
  client: OpenWorkflowClient
  workflows: Map<string, OpenWorkflowRunnable>
}

let runtimes = new Map<string, Promise<OpenWorkflowRuntime>>()

// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The internal importer contract carries each requested module type.
async function importOpenWorkflowModule<T>(specifier: string, importer: OpenWorkflowImporter): Promise<T> {
  return await runWorkflowProviderOperation("openworkflow", "import", () => importer<T>(specifier))
}

function readEnv(name: string): string | undefined {
  // SAFETY: This provider runs in hosts where Node's process global is optional.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const value = env?.[name]
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Environment values cross an optional host boundary and require representation validation.
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function resolveRuntimeConfigValue(value: WorkflowRuntimeConfigValue | undefined): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Runtime configuration accepts a string or an environment declaration at this boundary.
  if (typeof value === "string" || typeof value === "undefined") {
    return value
  }
  for (const name of getRuntimeEnvNames(value)) {
    const resolved = readEnv(name)
    if (resolved) return resolved
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Declaration defaults cross the runtime configuration boundary as unknown values.
  return typeof value.default === "string" && value.default.trim() ? value.default.trim() : undefined
}

function getRuntimeEnvNames(value: WorkflowRuntimeEnvDeclarationLike): string[] {
  return value.source?.names ?? (value.source?.name ? [value.source.name] : [])
}

function normalizeSqlitePath(path: string): string {
  if (/^(?:libsql:|https?:\/\/)/i.test(path)) {
    throw workflowErrorDiagnostics.WORKFLOW_R0018({ message: `OpenWorkflow SQLite storage requires a local SQLite file path, received ${JSON.stringify(path)}.` })
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("file:")) {
    throw workflowErrorDiagnostics.WORKFLOW_R0019({ message: `OpenWorkflow SQLite storage received unsupported storage URL ${JSON.stringify(path)}.` })
  }
  return path.startsWith("file:") ? path.slice("file:".length) : path
}

async function prepareSqlitePath(path: string, importer: OpenWorkflowImporter): Promise<string> {
  if (path !== ":memory:") {
    const [{ mkdirSync }, { dirname }] = await Promise.all([
      importOpenWorkflowModule<NodeFsModule>("node:fs", importer),
      importOpenWorkflowModule<NodePathModule>("node:path", importer),
    ])
    mkdirSync(dirname(path), { recursive: true })
  }
  return path
}

type OpenWorkflowStorageConfig =
  | { backend: "postgres", namespaceId: string, runMigrations?: boolean, schema: string, url: string }
  | { backend: "sqlite", namespaceId: string, path: string, runMigrations?: boolean }

function getOpenWorkflowConfig(config: ResolvedWorkflowOptions): OpenWorkflowStorageConfig {
  if (config.provider !== "openworkflow") {
    throw workflowErrorDiagnostics.WORKFLOW_R0020({ message: `OpenWorkflow runtime requires workflow.provider "openworkflow", received "${config.provider}".` })
  }

  const sqlite = config.sqlite || {}
  const sqlitePath = resolveRuntimeConfigValue(sqlite.path) || readEnv("OPENWORKFLOW_SQLITE_PATH")
  if (sqlitePath) {
    return {
      backend: "sqlite",
      namespaceId: sqlite.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
      path: normalizeSqlitePath(sqlitePath),
      runMigrations: sqlite.runMigrations,
    }
  }

  const postgres = config.postgres || {}
  const url = resolveRuntimeConfigValue(postgres.url) || readEnv("OPENWORKFLOW_POSTGRES_URL") || readEnv("DATABASE_URL")
  if (url) {
    return {
      backend: "postgres",
      namespaceId: postgres.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
      runMigrations: postgres.runMigrations,
      schema: postgres.schema || readEnv("OPENWORKFLOW_SCHEMA") || "openworkflow",
      url,
    }
  }

  return {
    backend: "sqlite",
    namespaceId: sqlite.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
    path: defaultOpenWorkflowSqlitePath,
    runMigrations: sqlite.runMigrations,
  }
}

function getRuntimeKey(config: ResolvedWorkflowOptions): string {
  return JSON.stringify(getOpenWorkflowConfig(config))
}

async function createOpenWorkflowRuntime(
  config: ResolvedWorkflowOptions,
  importer: OpenWorkflowImporter,
): Promise<OpenWorkflowRuntime> {
  const options = getOpenWorkflowConfig(config)
  const [{ OpenWorkflow }, backendModule] = await Promise.all([
    importOpenWorkflowModule<OpenWorkflowModule>("openworkflow", importer),
    options.backend === "sqlite"
      ? importOpenWorkflowModule<OpenWorkflowSqliteModule>("openworkflow/sqlite", importer)
      : importOpenWorkflowModule<OpenWorkflowPostgresModule>("openworkflow/postgres", importer),
  ])
  const { backend, client } = await runWorkflowProviderOperation("openworkflow", "connect", async () => {
    let backend: OpenWorkflowBackend
    if (options.backend === "sqlite") {
      // SAFETY: The discriminated storage options select the matching dynamically imported backend module.
      backend = await (backendModule as OpenWorkflowSqliteModule).BackendSqlite.connect(await prepareSqlitePath(options.path, importer), {
        namespaceId: options.namespaceId,
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider configuration accepts an optional external boolean.
        ...(typeof options.runMigrations === "boolean" ? { runMigrations: options.runMigrations } : {}),
      })
    }
    else {
      // SAFETY: The discriminated storage options select the matching dynamically imported backend module.
      backend = await (backendModule as OpenWorkflowPostgresModule).BackendPostgres.connect(options.url, {
        namespaceId: options.namespaceId,
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider configuration accepts an optional external boolean.
        ...(typeof options.runMigrations === "boolean" ? { runMigrations: options.runMigrations } : {}),
        schema: options.schema,
      })
    }
    return { backend, client: new OpenWorkflow({ backend }) }
  })

  return {
    backend,
    client,
    workflows: new Map(),
  }
}

export async function getOpenWorkflowRuntime(config: ResolvedWorkflowOptions): Promise<OpenWorkflowRuntime> {
  const cache = runtimes
  const key = getRuntimeKey(config)
  let runtime = cache.get(key)
  if (!runtime) {
    runtime = createOpenWorkflowRuntime(config, openWorkflowImporter)
    cache.set(key, runtime)
    void runtime.catch(() => {
      if (cache.get(key) === runtime) cache.delete(key)
    })
  }
  const resolved = await runtime
  if (cache !== runtimes) {
    throw createWorkflowError({
      code: "OPENWORKFLOW_RUNTIME_RESET",
      details: { provider: "openworkflow" },
    })
  }
  return resolved
}

function toOpenWorkflowRetryPolicy(options: WorkflowStepOptions): Partial<RetryPolicy> | undefined {
  const retries = options.retries
  if (!retries) {
    return undefined
  }

  return {
    ...(retries.backoff ? { backoffCoefficient: retries.backoff === "exponential" ? 2 : 1 } : {}),
    // SAFETY: ViteHub's duration input matches OpenWorkflow's accepted interval representation.
    ...(retries.delay ? { initialInterval: retries.delay as RetryPolicy["initialInterval"] } : {}),
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Retry limits enter through public Workflow step options and require numeric validation.
    ...(typeof retries.limit === "number" ? { maximumAttempts: retries.limit } : {}),
  }
}

function createOpenWorkflowProviderStep(step: OpenWorkflowStepApi): WorkflowProviderStep {
  return {
    async do(name, options, run) {
      return await step.run({
        name,
        ...(toOpenWorkflowRetryPolicy(options) ? { retryPolicy: toOpenWorkflowRetryPolicy(options) } : {}),
      }, run)
    },
    // SAFETY: ViteHub's duration input matches OpenWorkflow's accepted sleep duration representation.
    sleep: async (name, duration) => await step.sleep(name, duration as Parameters<OpenWorkflowStepApi["sleep"]>[1]),
  }
}

export async function registerOpenWorkflowDefinition(
  runtime: OpenWorkflowRuntime,
  name: string,
  definition: WorkflowDefinition,
): Promise<OpenWorkflowRunnable> {
  const existing = runtime.workflows.get(name)
  if (existing) {
    return existing
  }

  // SAFETY: The registered ViteHub definition and OpenWorkflow runnable share this payload and result contract.
  const openWorkflowDefinition = definition as never
  const workflow = runtime.client.defineWorkflow({ name }, async ({ input, run, step }) => {
    return await runWorkflowHandler({
      id: run.id,
      name,
      payload: input,
      provider: "openworkflow",
      step: createOpenWorkflowProviderStep(step),
    }, openWorkflowDefinition)
  })
  runtime.workflows.set(name, workflow)
  return workflow
}

function normalizeOpenWorkflowStatus(status: unknown): WorkflowRunStatus {
  switch (String(status || "").toLowerCase()) {
    case "completed":
    case "succeeded":
      return "completed"
    case "canceled":
      return "cancelled"
    case "failed":
      return "failed"
    case "pending":
      return "queued"
    case "running":
    case "sleeping":
      return "running"
    default:
      return "unknown"
  }
}

// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The registered Workflow Definition determines the provider result type.
function serializeOpenWorkflowRun<TResult = unknown>(run: OpenWorkflowRun, name: string): WorkflowRun<unknown, TResult> {
  if (!run || run.workflowName !== name) {
    return {
      id: run?.id || "",
      provider: "openworkflow",
      status: "unknown",
    }
  }

  // SAFETY: OpenWorkflow returns the result produced by the registered WorkflowDefinition<TResult>.
  const result = run.output as TResult | undefined
  return {
    id: run.id,
    metadata: run.error || {
      namespaceId: run.namespaceId,
      version: run.version,
      workflowName: run.workflowName,
    },
    provider: "openworkflow",
    result,
    status: normalizeOpenWorkflowStatus(run.status),
  }
}

export async function runOpenWorkflow<TPayload = unknown, TResult = unknown>(
  config: ResolvedWorkflowOptions,
  name: string,
  payload: TPayload | undefined,
  definition: WorkflowDefinition<TPayload, TResult>,
  options: WorkflowDeferOptions,
): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getOpenWorkflowRuntime(config)
  // SAFETY: Registration preserves this Workflow Definition's payload and result contract in the provider runnable.
  const workflow = await registerOpenWorkflowDefinition(runtime, name, definition as never)
  let firstAcknowledgementUnknown = false
  const handle = await runWorkflowProviderOperation("openworkflow", "run", async () => {
    const start = () => workflow.run(payload, options.id ? { idempotencyKey: options.id } : undefined)
    return await start().catch((error) => {
      if (!options.id) throw error
      firstAcknowledgementUnknown = getWorkflowProviderStatus(error) === undefined
      return start()
    })
  }, { acknowledgementUnknown: (_error, status) => firstAcknowledgementUnknown || status === undefined })
  return await runWorkflowProviderOperation("openworkflow", "run", async () => {
    const serialized = serializeOpenWorkflowRun<TResult>(handle.workflowRun, name)
    return {
      ...serialized,
      metadata: serialized.status === "failed"
        ? serialized.metadata
        : { ...(options.id ? { idempotencyKey: options.id } : {}), workflow: name },
      payload,
    }
  })
}

// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Workflow handles intentionally retain their definition's payload and result types across provider reads.
export async function getOpenWorkflowRun<TPayload = unknown, TResult = unknown>(
  config: ResolvedWorkflowOptions,
  name: string,
  id: string,
): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getOpenWorkflowRuntime(config)
  return await runWorkflowProviderOperation("openworkflow", "get", async () => {
    const run = await runtime.backend.getWorkflowRun({ workflowRunId: id })
    const serialized = serializeOpenWorkflowRun(run, name)
    return serialized.id
      // SAFETY: The caller's Workflow Definition supplies the payload and result types retained by this provider run.
      ? serialized as WorkflowRun<TPayload, TResult>
      : {
          id,
          provider: "openworkflow" as const,
          status: "unknown" as const,
        }
  })
}

export async function resetOpenWorkflowRuntime(): Promise<void> {
  const closing = runtimes
  runtimes = new Map()
  openWorkflowImporter = defaultImporter
  const settled = await Promise.allSettled(closing.values())
  const fulfilled = settled.flatMap(entry => entry.status === "fulfilled"
    ? [entry.value]
    : [])
  const stopped = await Promise.allSettled(fulfilled.map(runtime => Promise.resolve().then(() => runtime.backend.stop())))
  const failures = stopped.flatMap(entry => entry.status === "rejected"
    ? [createWorkflowError({
        cause: entry.reason,
        code: "OPENWORKFLOW_BACKEND_CLOSE_FAILED",
        details: { provider: "openworkflow" },
      })]
    : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, "OpenWorkflow backend cleanup failed for multiple runtimes.")
  }
}

export function setOpenWorkflowImporter(importer: OpenWorkflowImporter): void {
  openWorkflowImporter = importer
}
