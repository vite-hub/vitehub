import { deserializeResponse, isSerializedResponse } from "@vite-hub/runtime/internal/response"
import { invariantError } from "@vite-hub/internal/invariant"
import { readNonRetryableStepResult, resolveWorkflowStepOptions, runSerializedWorkflowHandler, toDurationMilliseconds, toNonRetryableStepResult, withWorkflowStepTimeout } from "./execute.ts"
import { createWorkflowError } from "../errors.ts"
import { getWorkflowProviderStatus, runWorkflowProviderOperation } from "./provider-operation.ts"
import { toWorkflowRunError } from "./run-error.ts"
import { emitWorkflowFailed } from "./run-failed.ts"
import { resolveOpenWorkflowStorage } from "../internal/openworkflow-storage.ts"

import type { RetryPolicy } from "openworkflow"
import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowProviderStep, WorkflowRun, WorkflowRunStatus, WorkflowRunStep, WorkflowRuntimeConfigValue, WorkflowRuntimeEnvDeclarationLike, WorkflowStartOptions, WorkflowStepOptions } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { defaultOpenWorkflowSqlitePath } from "../internal/openworkflow-defaults.ts"

type OpenWorkflowModule = typeof import("openworkflow")
type NodeFsModule = typeof import("node:fs")
type NodePathModule = typeof import("node:path")
type OpenWorkflowPostgresModule = typeof import("openworkflow/postgres")
type OpenWorkflowSqliteModule = typeof import("openworkflow/sqlite")
type PostgresModule = { default: typeof import("postgres") }
type OpenWorkflowClient = InstanceType<OpenWorkflowModule["OpenWorkflow"]>
type OpenWorkflowBackend = Awaited<ReturnType<OpenWorkflowPostgresModule["BackendPostgres"]["connect"]>> | ReturnType<OpenWorkflowSqliteModule["BackendSqlite"]["connect"]>
type OpenWorkflowRunnable = ReturnType<OpenWorkflowClient["defineWorkflow"]>
type OpenWorkflowRun = Awaited<ReturnType<OpenWorkflowBackend["getWorkflowRun"]>>
type OpenWorkflowStepAttempt = Awaited<ReturnType<OpenWorkflowBackend["listStepAttempts"]>>["data"][number]
type OpenWorkflowStepApi = Parameters<Parameters<OpenWorkflowClient["defineWorkflow"]>[1]>[0]["step"]
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Dynamic imports preserve the module type supplied by each internal call site.
type OpenWorkflowImporter = <T>(specifier: string) => Promise<T>
const defaultImporter: OpenWorkflowImporter = specifier => import(/* @vite-ignore */ specifier)
let openWorkflowImporter = defaultImporter

interface OpenWorkflowRuntime {
  backend: OpenWorkflowBackend
  client: OpenWorkflowClient
  definitions: Map<string, WorkflowDefinition>
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

function readDatabasePostgresUrl(): string | undefined {
  if (!databaseUrlResolver) return undefined
  const url = databaseUrlResolver()?.trim()
  if (!url) throw workflowErrorDiagnostics.WORKFLOW_OPENWORKFLOW_DATABASE_URL_MISSING()
  return url
}

function getOpenWorkflowConfig(config: ResolvedWorkflowOptions): OpenWorkflowStorageConfig {
  if (config.driver !== "openworkflow") {
    throw workflowErrorDiagnostics.WORKFLOW_R0020({ message: `OpenWorkflow runtime requires workflow.driver "openworkflow", received "${config.driver}".` })
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
    throw workflowErrorDiagnostics.WORKFLOW_OPENWORKFLOW_DATABASE_URL_IGNORED()
  }

  return {
    backend: "sqlite",
    namespaceId: sqlite.namespaceId || readEnv("OPENWORKFLOW_NAMESPACE_ID") || "production",
    path: defaultOpenWorkflowSqlitePath,
    runMigrations: sqlite.runMigrations,
    source: "default",
  }
}

const postgresSetupWaitMs = 120_000
const postgresSecondConnectionTimeoutMs = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref?.())
}

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

async function withPostgresSetupLock<T>(postgres: PostgresModule, url: string, schema: string, setup: () => Promise<T>): Promise<T> {
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
        const answered = Promise.resolve(probe`select 1`).then(() => {}, () => {})
        if (!await settlesWithin(answered, postgresSecondConnectionTimeoutMs)) {
          void answered.then(() => probe.end())
          throw workflowErrorDiagnostics.WORKFLOW_OPENWORKFLOW_SETUP_CONNECTION_UNAVAILABLE()
        }
        await probe.end()
        result = { value: await setup() }
      })
      if (result) return result.value
      if (Date.now() >= deadline) {
        throw workflowErrorDiagnostics.WORKFLOW_OPENWORKFLOW_SETUP_LOCK_TIMEOUT({ seconds: postgresSetupWaitMs / 1000 })
      }
      await sleep(Math.min(250 * attempt, 2_000))
    }
  }
  finally {
    await sql.end({ timeout: 5 })
  }
}

function reportFailedRuns<TBackend extends OpenWorkflowBackend>(backend: TBackend, definitions: ReadonlyMap<string, WorkflowDefinition>): TBackend {
  const failWorkflowRun: TBackend["failWorkflowRun"] = async (params) => {
    const run = await backend.failWorkflowRun(params)
    if (run.status === "failed") {
      await emitWorkflowFailed(run.workflowName, run.idempotencyKey || run.id, run.error ?? params.error, definitions.get(run.workflowName))
    }
    return run
  }
  return new Proxy(backend, {
    get(target, property) {
      if (property === "failWorkflowRun") return failWorkflowRun
      const value: unknown = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function createOpenWorkflowRuntime(
  options: OpenWorkflowStorageConfig,
  importer: OpenWorkflowImporter,
): Promise<OpenWorkflowRuntime> {
  const definitions = new Map<string, WorkflowDefinition>()
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
    return { backend, client: new OpenWorkflow({ backend: reportFailedRuns(backend, definitions) }) }
  })

  return {
    backend,
    client,
    definitions,
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
    throw invariantError(`OpenWorkflow 0.9 backends keep their connection in \`db\` (SQLite) or \`pg\` (Postgres), but the ${options.backend} backend has neither`)
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

function toOpenWorkflowRetryPolicy(name: string, options: WorkflowStepOptions): Partial<RetryPolicy> {
  const { backoff, delay, limit } = resolveWorkflowStepOptions(name, options).retries
  // SAFETY: `resolveWorkflowStepOptions` accepted `delay`, so it is a valid duration.
  const initial = toDurationMilliseconds(delay)!
  const coefficient = backoff === "exponential" ? 2 : 1
  return {
    backoffCoefficient: coefficient,
    initialInterval: `${initial}ms`,
    maximumAttempts: limit + 1,
    maximumInterval: `${initial * coefficient ** Math.max(limit - 1, 0)}ms`,
  }
}

function createOpenWorkflowProviderStep(step: OpenWorkflowStepApi): WorkflowProviderStep {
  return {
    async do(name, options, run) {
      const output = await step.run({ name, retryPolicy: toOpenWorkflowRetryPolicy(name, options) }, async () => {
        try {
          return await withWorkflowStepTimeout(name, options.timeout, run)()
        }
        catch (error) {
          const result = toNonRetryableStepResult(error)
          if (result) return result
          throw error
        }
      })
      const error = readNonRetryableStepResult(output)
      if (error) throw error
      // SAFETY: Only a step that threw a NonRetryableError returns its result, and the check above throws for it.
      return output as Awaited<ReturnType<typeof run>>
    },
    sleep: async (name, milliseconds) => await step.sleep(name, `${milliseconds}ms`),
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
  runtime.definitions.set(name, definition)
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
  const status = normalizeOpenWorkflowStatus(run.status)
  return {
    ...(status === "failed" ? { error: toWorkflowRunError(run.error) } : {}),
    ...(run.finishedAt ? { completedAt: run.finishedAt } : {}),
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    id: run.idempotencyKey || run.id,
    metadata: {
      namespaceId: run.namespaceId,
      version: run.version,
      workflowName: run.workflowName,
    },
    payload: run.input,
    provider: "openworkflow",
    result,
    status,
  }
}

function toWorkflowRunStepError(error: unknown): WorkflowRunStep["error"] {
  const message: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined
  return { message: typeof message === "string" && message ? message : "Workflow step failed." }
}

function toWorkflowRunSteps(attempts: OpenWorkflowStepAttempt[]): WorkflowRunStep[] {
  const steps = new Map<string, WorkflowRunStep>()
  for (const attempt of attempts) {
    const nonRetryable = readNonRetryableStepResult(attempt.output)
    steps.set(attempt.stepName, {
      attempt: (steps.get(attempt.stepName)?.attempt ?? 0) + 1,
      ...(attempt.finishedAt ? { completedAt: attempt.finishedAt } : {}),
      ...(attempt.status === "failed" || nonRetryable ? { error: toWorkflowRunStepError(nonRetryable ?? attempt.error) } : {}),
      id: attempt.id,
      name: attempt.stepName,
      ...(attempt.context?.kind === "sleep" ? { sleepUntil: new Date(attempt.context.resumeAt) } : {}),
      ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
      status: nonRetryable ? "failed" : normalizeOpenWorkflowStatus(attempt.status),
    })
  }
  return [...steps.values()]
}

async function listOpenWorkflowStepAttempts(backend: OpenWorkflowBackend, workflowRunId: string): Promise<OpenWorkflowStepAttempt[]> {
  const attempts: OpenWorkflowStepAttempt[] = []
  let after: string | undefined
  do {
    const page = await backend.listStepAttempts({ workflowRunId, limit: 100, ...(after ? { after } : {}) })
    attempts.push(...page.data)
    after = page.pagination.next ?? undefined
  } while (after)
  return attempts
}

export async function runOpenWorkflow<TPayload = unknown, TResult = unknown>(
  config: ResolvedWorkflowOptions,
  name: string,
  payload: TPayload | undefined,
  definition: WorkflowDefinition<TPayload, TResult>,
  options: WorkflowStartOptions,
  onDispatch?: () => void,
  startAt?: number,
): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getOpenWorkflowRuntime(config)
  // SAFETY: Registration preserves this Workflow Definition's payload and result contract in the provider runnable.
  const workflow = await registerOpenWorkflowDefinition(runtime, name, definition as never)
  onDispatch?.()
  let firstAcknowledgementUnknown = false
  const handle = await runWorkflowProviderOperation("openworkflow", "run", async () => {
    const existingId = options.id ? await runtime.findRunId(name, options.id) ?? options.id : undefined
    const existing = existingId ? await runtime.backend.getWorkflowRun({ workflowRunId: existingId }) : null
    if (existing?.workflowName === name) return { workflowRun: existing }
    const runOptions = options.id || startAt !== undefined
      ? { ...(options.id ? { idempotencyKey: options.id } : {}), ...(startAt === undefined ? {} : { availableAt: new Date(startAt) }) }
      : undefined
    const start = () => workflow.run(payload, runOptions)
    return await start().catch((error) => {
      if (!options.id) throw error
      firstAcknowledgementUnknown = getWorkflowProviderStatus(error) === undefined
      return start()
    })
  }, {
    acknowledgement: (_error, status) => firstAcknowledgementUnknown || status === undefined
      ? "unknown"
      : status < 500 ? "rejected" : undefined,
  })
  return await runWorkflowProviderOperation("openworkflow", "run", async () => {
    const serialized = serializeOpenWorkflowRun<TResult>(handle.workflowRun, name)
    return {
      ...serialized,
      metadata: { ...(options.id ? { idempotencyKey: options.id } : {}), workflow: name },
      // SAFETY: OpenWorkflow stores the payload of this Workflow Definition as the run input.
      payload: handle.workflowRun.input as TPayload,
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
    if (!run || run.workflowName !== name) return { id, provider: "openworkflow" as const, status: "unknown" as const }
    // SAFETY: The caller's Workflow Definition supplies the payload and result types retained by this provider run.
    const serialized = serializeOpenWorkflowRun(run, name) as WorkflowRun<TPayload, TResult>
    return { ...serialized, steps: toWorkflowRunSteps(await listOpenWorkflowStepAttempts(runtime.backend, run.id)) }
  })
}

const terminalOpenWorkflowStatuses: ReadonlySet<WorkflowRunStatus> = new Set(["cancelled", "completed", "failed"])

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
