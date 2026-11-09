import { deserializeResponse, isSerializedResponse } from "@vite-hub/runtime"
import { runSerializedWorkflowHandler } from "./execute.ts"
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
// `postgres` declares `export =`, and a dynamic import returns it as `default`.
type PostgresModule = { default: typeof import("postgres") }
type OpenWorkflowClient = InstanceType<OpenWorkflowModule["OpenWorkflow"]>
type OpenWorkflowBackend = Awaited<ReturnType<OpenWorkflowPostgresModule["BackendPostgres"]["connect"]>> | ReturnType<OpenWorkflowSqliteModule["BackendSqlite"]["connect"]>
type OpenWorkflowRunnable = ReturnType<OpenWorkflowClient["defineWorkflow"]>
type OpenWorkflowRun = Awaited<ReturnType<OpenWorkflowBackend["getWorkflowRun"]>>
type OpenWorkflowStepApi = Parameters<Parameters<OpenWorkflowClient["defineWorkflow"]>[1]>[0]["step"]
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Dynamic imports preserve the module type supplied by each internal call site.
type OpenWorkflowImporter = <T>(specifier: string) => Promise<T>
// A variable specifier keeps the optional OpenWorkflow packages out of host bundles. Do not build this
// importer from a string: workerd blocks code generation when the module loads during a request.
const defaultImporter: OpenWorkflowImporter = specifier => import(/* @vite-ignore */ specifier)
let openWorkflowImporter = defaultImporter
const defaultOpenWorkflowSqlitePath = ".vitehub/data/openworkflow.sqlite.db"

interface OpenWorkflowRuntime {
  backend: OpenWorkflowBackend
  client: OpenWorkflowClient
  /** Called after a new Workflow Definition is registered on the client. */
  definitionListeners: Set<() => void>
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
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function resolveRuntimeConfigValue(value: WorkflowRuntimeConfigValue | undefined): string | undefined {
  if (typeof value === "string" || typeof value === "undefined") {
    return value
  }
  for (const name of getRuntimeEnvNames(value)) {
    const resolved = readEnv(name)
    if (resolved) return resolved
  }
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
  if ("database" in config && config.database !== undefined) {
    throw workflowErrorDiagnostics.WORKFLOW_R0027({ message: "`workflow.database` is not supported. Set `workflow.sqlite.path` or `workflow.postgres.url` explicitly." })
  }

  const sqlite = config.sqlite || {}
  const postgres = config.postgres || {}
  if (postgres.url !== undefined && sqlite.path !== undefined) {
    throw workflowErrorDiagnostics.WORKFLOW_R0030({ message: "`workflow.postgres.url` and `workflow.sqlite.path` cannot both configure OpenWorkflow storage." })
  }
  const explicitSqlitePath = resolveRuntimeConfigValue(sqlite.path)
  const explicitPostgresUrl = resolveRuntimeConfigValue(postgres.url)?.trim()
  if (sqlite.path !== undefined && !explicitSqlitePath?.trim()) {
    throw workflowErrorDiagnostics.WORKFLOW_R0028({ message: "`workflow.sqlite.path` must resolve to a non-empty local SQLite path. Check its runtime environment declaration." })
  }
  if (postgres.url !== undefined && !explicitPostgresUrl) {
    throw workflowErrorDiagnostics.WORKFLOW_R0029({ message: "`workflow.postgres.url` must resolve to a non-empty Postgres URL. Check its runtime environment declaration." })
  }
  const sqlitePath = explicitSqlitePath || (!explicitPostgresUrl ? readEnv("OPENWORKFLOW_SQLITE_PATH") : undefined)
  if (sqlitePath) {
    return {
      backend: "sqlite",
      namespaceId: sqlite.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
      path: normalizeSqlitePath(sqlitePath),
      runMigrations: sqlite.runMigrations,
    }
  }

  const url = explicitPostgresUrl || readEnv("OPENWORKFLOW_POSTGRES_URL") || readEnv("DATABASE_URL")
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

/**
 * OpenWorkflow creates its Postgres schema without a lock, so servers that start together fail with
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`. A session advisory lock on the
 * schema name lets one process set it up while the others wait, then find it up to date.
 */
async function withPostgresSetupLock<T>(postgres: PostgresModule, url: string, schema: string, setup: () => Promise<T>): Promise<T> {
  const sql = postgres.default(url, { max: 1, onnotice: () => {} })
  const key = `vitehub:openworkflow:${schema}`
  try {
    await sql`select pg_advisory_lock(hashtextextended(${key}, 0))`
    try {
      return await setup()
    }
    finally {
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`
    }
  }
  finally {
    // Closing the session also releases the lock when the unlock query fails.
    await sql.end({ timeout: 5 })
  }
}

async function createOpenWorkflowRuntime(
  options: OpenWorkflowStorageConfig,
  importer: OpenWorkflowImporter,
): Promise<OpenWorkflowRuntime> {
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
        ...(typeof options.runMigrations === "boolean" ? { runMigrations: options.runMigrations } : {}),
      })
    }
    else {
      // SAFETY: The discriminated storage options select the matching dynamically imported backend module.
      const { BackendPostgres } = backendModule as OpenWorkflowPostgresModule
      const connect = () => BackendPostgres.connect(options.url, {
        namespaceId: options.namespaceId,
        ...(typeof options.runMigrations === "boolean" ? { runMigrations: options.runMigrations } : {}),
        schema: options.schema,
      })
      backend = options.runMigrations === false
        ? await connect()
        : await withPostgresSetupLock(await importOpenWorkflowModule<PostgresModule>("postgres", importer), options.url, options.schema, connect)
    }
    return { backend, client: new OpenWorkflow({ backend }) }
  })

  return {
    backend,
    client,
    definitionListeners: new Set(),
    workflows: new Map(),
  }
}

export async function getOpenWorkflowRuntime(config: ResolvedWorkflowOptions): Promise<OpenWorkflowRuntime> {
  const cache = runtimes
  const options = getOpenWorkflowConfig(config)
  const key = JSON.stringify(options)
  let runtime = cache.get(key)
  if (!runtime) {
    runtime = createOpenWorkflowRuntime(options, openWorkflowImporter)
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
    return await runSerializedWorkflowHandler({
      id: run.id,
      name,
      payload: input,
      provider: "openworkflow",
      step: createOpenWorkflowProviderStep(step),
    }, openWorkflowDefinition)
  })
  runtime.workflows.set(name, workflow)
  for (const listener of runtime.definitionListeners) listener()
  return workflow
}

/**
 * Calls `listener` each time a new Workflow Definition is registered on this runtime. An OpenWorkflow worker copies
 * the definitions when it is created, so a worker must be replaced to run a definition registered later, such as an
 * inline `createWorkflow()` or an Agent Workflow. Returns a function that removes the listener.
 */
export function watchOpenWorkflowDefinitions(runtime: OpenWorkflowRuntime, listener: () => void): () => void {
  runtime.definitionListeners.add(listener)
  return () => runtime.definitionListeners.delete(listener)
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
  const result = (isSerializedResponse(run.output) ? deserializeResponse(run.output) : run.output) as TResult | undefined
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
  onDispatch?: () => void,
): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getOpenWorkflowRuntime(config)
  // SAFETY: Registration preserves this Workflow Definition's payload and result contract in the provider runnable.
  const workflow = await registerOpenWorkflowDefinition(runtime, name, definition as never)
  onDispatch?.()
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

const terminalOpenWorkflowStatuses: ReadonlySet<WorkflowRunStatus> = new Set(["cancelled", "completed", "failed"])

/**
 * Cancels a pending or running OpenWorkflow run of this Workflow and returns its state afterwards. A run of another
 * Workflow, or an unknown run, reports `unknown` without being cancelled. A finished run keeps and reports its status.
 */
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Workflow handles intentionally retain their definition's payload and result types across provider reads.
export async function cancelOpenWorkflowRun<TPayload = unknown, TResult = unknown>(
  config: ResolvedWorkflowOptions,
  name: string,
  id: string,
): Promise<WorkflowRun<TPayload, TResult>> {
  const current = await getOpenWorkflowRun<TPayload, TResult>(config, name, id)
  if (current.status === "unknown" || terminalOpenWorkflowStatuses.has(current.status)) return current
  const runtime = await getOpenWorkflowRuntime(config)
  try {
    await runWorkflowProviderOperation("openworkflow", "cancel", () => runtime.client.cancelWorkflowRun(id))
  }
  catch (error) {
    // A worker may finish between the initial read and OpenWorkflow's atomic cancellation update.
    const latest = await getOpenWorkflowRun<TPayload, TResult>(config, name, id).catch(() => undefined)
    if (latest && terminalOpenWorkflowStatuses.has(latest.status)) return latest
    throw error
  }
  return await getOpenWorkflowRun<TPayload, TResult>(config, name, id)
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
