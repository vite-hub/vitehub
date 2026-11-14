import { deserializeResponse, isSerializedResponse } from "@vite-hub/runtime"
import { runSerializedWorkflowHandler } from "./execute.ts"
import { createWorkflowError } from "../errors.ts"
import { getWorkflowProviderStatus, runWorkflowProviderOperation } from "./provider-operation.ts"
import { resolveOpenWorkflowStorage } from "../internal/openworkflow-storage.ts"

import type { RetryPolicy } from "openworkflow"
import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowProviderStep, WorkflowRun, WorkflowRunStatus, WorkflowRuntimeConfigValue, WorkflowRuntimeEnvDeclarationLike, WorkflowStartOptions, WorkflowStepOptions } from "../types.ts"
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
// A variable specifier keeps the optional OpenWorkflow packages out of host bundles. Do not build this
// importer from a string: workerd blocks code generation when the module loads during a request.
const defaultImporter: OpenWorkflowImporter = specifier => import(/* @vite-ignore */ specifier)
let openWorkflowImporter = defaultImporter

interface OpenWorkflowRuntime {
  backend: OpenWorkflowBackend
  client: OpenWorkflowClient
  /** Returns the OpenWorkflow id of the first run of `name` that started with the id `key`. */
  findRunId: (name: string, key: string) => Promise<string | undefined>
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
  const storage = resolveOpenWorkflowStorage({ postgresUrl: explicitPostgresUrl, sqlitePath: explicitSqlitePath }, readEnv)
  if (storage.backend === "sqlite") {
    return {
      backend: "sqlite",
      namespaceId: sqlite.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
      path: normalizeSqlitePath(storage.path),
      runMigrations: sqlite.runMigrations,
    }
  }

  return {
    backend: "postgres",
    namespaceId: postgres.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
    runMigrations: postgres.runMigrations,
    schema: postgres.schema || readEnv("OPENWORKFLOW_SCHEMA") || "openworkflow",
    url: storage.url,
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
      backend = await (backendModule as OpenWorkflowPostgresModule).BackendPostgres.connect(options.url, {
        namespaceId: options.namespaceId,
        ...(typeof options.runMigrations === "boolean" ? { runMigrations: options.runMigrations } : {}),
        schema: options.schema,
      })
    }
    return { backend, client: new OpenWorkflow({ backend }) }
  })

  return {
    backend,
    client,
    findRunId: createRunIdLookup(backend, options),
    workflows: new Map(),
  }
}

interface SqliteHandle {
  prepare: (sql: string) => { get: (...values: unknown[]) => unknown }
}

interface PostgresHandle {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown[]>
  (identifier: string): unknown
}

function isSqliteHandle(value: unknown): value is SqliteHandle {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "prepare") === "function"
}

function isPostgresHandle(value: unknown): value is PostgresHandle {
  return typeof value === "function"
}

function readRowId(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null) return undefined
  const id: unknown = Reflect.get(row, "id")
  return typeof id === "string" ? id : undefined
}

/**
 * ViteHub starts a run with the caller's id as the OpenWorkflow idempotency key, and OpenWorkflow gives the run its own
 * UUID. The OpenWorkflow API reads runs by UUID only, so this lookup reads the key from the backend connection.
 */
function createRunIdLookup(backend: OpenWorkflowBackend, options: OpenWorkflowStorageConfig): OpenWorkflowRuntime["findRunId"] {
  const connection: unknown = Reflect.get(backend, options.backend === "sqlite" ? "db" : "pg")
  return async (name, key) => {
    if (options.backend === "sqlite" && isSqliteHandle(connection)) {
      return readRowId(connection.prepare(`SELECT "id" FROM "workflow_runs" WHERE "namespace_id" = ? AND "workflow_name" = ? AND "idempotency_key" = ? ORDER BY "created_at" ASC, "id" ASC LIMIT 1`)
        .get(options.namespaceId, name, key))
    }
    if (options.backend === "postgres" && isPostgresHandle(connection)) {
      const [row] = await connection`SELECT "id" FROM ${connection(options.schema)}.${connection("workflow_runs")} WHERE "namespace_id" = ${options.namespaceId} AND "workflow_name" = ${name} AND "idempotency_key" = ${key} ORDER BY "created_at" ASC, "id" ASC LIMIT 1`
      return readRowId(row)
    }
    // Internal invariant: OpenWorkflow 0.9 backends keep their connection in `db` (SQLite) or `pg` (Postgres).
    throw new TypeError(`The OpenWorkflow ${options.backend} backend has no connection that ViteHub can read run ids from.`)
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
    const stored = await runtime.backend.getWorkflowRun({ workflowRunId: run.id })
    return await runSerializedWorkflowHandler({
      id: stored?.idempotencyKey || run.id,
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
  const result = (isSerializedResponse(run.output) ? deserializeResponse(run.output) : run.output) as TResult | undefined
  return {
    // The id that the caller passed is the run id. OpenWorkflow keeps it as the idempotency key.
    id: run.idempotencyKey || run.id,
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
  options: WorkflowStartOptions,
  onDispatch?: () => void,
): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getOpenWorkflowRuntime(config)
  // SAFETY: Registration preserves this Workflow Definition's payload and result contract in the provider runnable.
  const workflow = await registerOpenWorkflowDefinition(runtime, name, definition as never)
  onDispatch?.()
  let firstAcknowledgementUnknown = false
  const handle = await runWorkflowProviderOperation("openworkflow", "run", async () => {
    // OpenWorkflow deduplicates a key for 24 hours only. A run id identifies one run for as long as storage keeps it.
    const existingId = options.id ? await runtime.findRunId(name, options.id) : undefined
    const existing = existingId ? await runtime.backend.getWorkflowRun({ workflowRunId: existingId }) : null
    if (existing) return { workflowRun: existing }
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
    const run = await runtime.backend.getWorkflowRun({ workflowRunId: await runtime.findRunId(name, id) ?? id })
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
    await runWorkflowProviderOperation("openworkflow", "cancel", async () => await runtime.client.cancelWorkflowRun(await runtime.findRunId(name, id) ?? id))
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
