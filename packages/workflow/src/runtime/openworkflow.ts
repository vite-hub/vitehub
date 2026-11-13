import { deserializeResponse, isSerializedResponse } from "@vite-hub/runtime"
import { runSerializedWorkflowHandler } from "./execute.ts"
import { createWorkflowError } from "../errors.ts"
import { getWorkflowProviderStatus, runWorkflowProviderOperation } from "./provider-operation.ts"
import { resolveOpenWorkflowStorage } from "../internal/openworkflow-storage.ts"

import type { RetryPolicy } from "openworkflow"
import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowProviderStep, WorkflowRun, WorkflowRunStatus, WorkflowRuntimeConfigValue, WorkflowRuntimeEnvDeclarationLike, WorkflowStartOptions, WorkflowStepOptions } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { defaultOpenWorkflowSqlitePath } from "../internal/openworkflow-defaults.ts"

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

/**
 * Where the storage came from: `configured` options or environment variables, the Postgres Default `database` of the
 * app, or the `default` SQLite file.
 */
export type OpenWorkflowStorageSource = "configured" | "database" | "default"

type OpenWorkflowStorageConfig =
  | { backend: "postgres", namespaceId: string, runMigrations?: boolean, schema: string, source: OpenWorkflowStorageSource, url: string }
  | { backend: "sqlite", namespaceId: string, path: string, runMigrations?: boolean, source: OpenWorkflowStorageSource }

let databaseUrlResolver: (() => string | undefined) | undefined

/**
 * Makes OpenWorkflow use the Postgres Default Database of the app when no OpenWorkflow storage is configured. The
 * generated startup plugin installs it when the build has a Postgres Default Database.
 */
export function setOpenWorkflowDatabaseUrl(resolve: (() => string | undefined) | undefined): void {
  databaseUrlResolver = resolve
}

/** The Postgres URL of the Default Database, when the app has a Postgres Default Database. */
function readDatabasePostgresUrl(): string | undefined {
  if (!databaseUrlResolver) return undefined
  const url = databaseUrlResolver()?.trim()
  if (!url) throw workflowErrorDiagnostics.WORKFLOW_R0036()
  return url
}

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
  if (storage.backend === "sqlite" && storage.source !== "default") {
    return {
      backend: "sqlite",
      namespaceId: sqlite.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
      path: normalizeSqlitePath(storage.path),
      runMigrations: sqlite.runMigrations,
      source: "configured",
    }
  }

  const configuredUrl = storage.backend === "postgres" ? storage.url : undefined
  const url = configuredUrl || readDatabasePostgresUrl()
  if (url) {
    return {
      backend: "postgres",
      namespaceId: postgres.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
      runMigrations: postgres.runMigrations,
      schema: postgres.schema || readEnv("OPENWORKFLOW_SCHEMA") || "openworkflow",
      source: configuredUrl ? "configured" : "database",
      url,
    }
  }

  if (/^postgres(?:ql)?:\/\//i.test(readEnv("DATABASE_URL") || "")) {
    throw workflowErrorDiagnostics.WORKFLOW_R0038()
  }

  return {
    backend: "sqlite",
    namespaceId: sqlite.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
    path: defaultOpenWorkflowSqlitePath,
    runMigrations: sqlite.runMigrations,
    source: "default",
  }
}

/** How long a server waits for the setup lock that another server holds, before the worker start tries again. */
const postgresSetupWaitMs = 120_000
/** How long the server that holds the setup lock waits for the second connection that the OpenWorkflow migration needs. */
const postgresSecondConnectionTimeoutMs = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref?.())
}

/** Resolves `true` when `task` settles first, `false` when `ms` passes first. */
function settlesWithin(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    task.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * OpenWorkflow creates its Postgres schema without a lock. When servers start together, all but one fail with
 * `duplicate key value violates unique constraint`, and OpenWorkflow leaves the failed migration connection open in an
 * aborted transaction. So one server at a time sets up the schema, and the others then find it up to date.
 *
 * OpenWorkflow does not export its migrations, so they cannot run on the connection that holds the lock: they run on a
 * connection that `BackendPostgres.connect()` opens.
 * - A server tries the lock with `pg_try_advisory_xact_lock` in a short transaction. A server that does not get it
 *   commits at once and tries again later, so a waiting server holds no connection.
 * - The server that gets it first checks that it can open a second connection. A pool of one connection, such as a
 *   pooler with one server connection, cannot run the migration while the lock holds that connection, so the server
 *   stops with `WORKFLOW_R0037` before the setup starts.
 * - Then it holds the lock until OpenWorkflow finished the setup.
 * A transaction lock also works through a pooler in transaction mode, such as PgBouncer.
 */
async function withPostgresSetupLock<T>(postgres: PostgresModule, url: string, schema: string, setup: () => Promise<T>): Promise<T> {
  // `idle_timeout` closes the connection between attempts, so a waiting server holds none.
  const sql = postgres.default(url, { idle_timeout: 1, max: 1, onnotice: () => {} })
  const key = `vitehub:openworkflow:${schema}`
  const deadline = Date.now() + postgresSetupWaitMs
  try {
    for (let attempt = 1; ; attempt++) {
      let result: { value: T } | undefined
      await sql.begin(async (transaction) => {
        const [lock] = await transaction<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as locked`
        if (!lock?.locked) return
        const probe = postgres.default(url, { max: 1, onnotice: () => {} })
        // A probe that fails also got an answer: a database that is down fails the setup next.
        const answered = Promise.resolve(probe`select 1`).then(() => {}, () => {})
        if (!await settlesWithin(answered, postgresSecondConnectionTimeoutMs)) {
          // Ending the probe while it waits destroys its socket, and postgres.js then rejects a promise that no code
          // handles. The rollback below frees the connection, so the probe gets its answer and ends after it.
          void answered.then(() => probe.end())
          throw workflowErrorDiagnostics.WORKFLOW_R0037()
        }
        await probe.end()
        result = { value: await setup() }
      })
      if (result) return result.value
      if (Date.now() >= deadline) {
        throw workflowErrorDiagnostics.WORKFLOW_R0039({ seconds: postgresSetupWaitMs / 1000 })
      }
      await sleep(Math.min(250 * attempt, 2_000))
    }
  }
  finally {
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
    workflows: new Map(),
  }
}

/** The storage that OpenWorkflow uses for `config` now, without credentials. */
export function describeOpenWorkflowStorage(config: ResolvedWorkflowOptions): { backend: "postgres" | "sqlite", location: string, source: OpenWorkflowStorageSource } {
  const storage = getOpenWorkflowConfig(config)
  return storage.backend === "sqlite"
    ? { backend: "sqlite", location: storage.path, source: storage.source }
    : { backend: "postgres", location: `schema ${storage.schema}`, source: storage.source }
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
  options: WorkflowStartOptions,
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
  openWorkflowImporter = defaultImporter
  databaseUrlResolver = undefined
  await detachOpenWorkflowRuntimes()()
}

/**
 * Starts a new runtime cache, so the next acquisition opens a fresh backend. Returns a function that closes the
 * backends of the old cache. Call it after the work that still uses them, such as a stopping worker, finishes.
 */
export function detachOpenWorkflowRuntimes(): () => Promise<void> {
  const closing = runtimes
  runtimes = new Map()
  return () => closeOpenWorkflowRuntimes(closing)
}

async function closeOpenWorkflowRuntimes(closing: Map<string, Promise<OpenWorkflowRuntime>>): Promise<void> {
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
