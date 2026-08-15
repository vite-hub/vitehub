import { runWorkflowHandler } from "./execute.ts"
import { createWorkflowError } from "../errors.ts"
import { runWorkflowProviderOperation } from "./provider-operation.ts"

import type { RetryPolicy } from "openworkflow"
import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDeferOptions, WorkflowProviderStep, WorkflowRun, WorkflowRunStatus, WorkflowRuntimeConfigValue, WorkflowRuntimeEnvDeclarationLike, WorkflowStepOptions } from "../types.ts"

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
type OpenWorkflowImporter = <T>(specifier: string) => Promise<T>
const defaultImporter = new Function("specifier", "return import(specifier)") as OpenWorkflowImporter
let openWorkflowImporter = defaultImporter
const defaultOpenWorkflowSqlitePath = ".vitehub/data/openworkflow.sqlite.db"

interface OpenWorkflowRuntime {
  backend: OpenWorkflowBackend
  client: OpenWorkflowClient
  workflows: Map<string, OpenWorkflowRunnable>
}

let runtimes = new Map<string, Promise<OpenWorkflowRuntime>>()

async function importOpenWorkflowModule<T>(specifier: string, importer: OpenWorkflowImporter): Promise<T> {
  return await runWorkflowProviderOperation("openworkflow", "import", () => importer<T>(specifier))
}

function readEnv(name: string): string | undefined {
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
    throw new Error(`OpenWorkflow SQLite storage requires a local SQLite file path, received ${JSON.stringify(path)}.`)
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("file:")) {
    throw new Error(`OpenWorkflow SQLite storage received unsupported storage URL ${JSON.stringify(path)}.`)
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
    throw new Error(`OpenWorkflow runtime requires workflow.provider "openworkflow", received "${config.provider}".`)
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
      backend = await (backendModule as OpenWorkflowSqliteModule).BackendSqlite.connect(await prepareSqlitePath(options.path, importer), {
        namespaceId: options.namespaceId,
        ...(typeof options.runMigrations === "boolean" ? { runMigrations: options.runMigrations } : {}),
      })
    }
    else {
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

  const workflow = runtime.client.defineWorkflow({ name }, async ({ input, run, step }) => {
    return await runWorkflowHandler({
      id: run.id,
      name,
      payload: input,
      provider: "openworkflow",
      step: createOpenWorkflowProviderStep(step),
    }, definition as never)
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

function serializeOpenWorkflowRun(run: OpenWorkflowRun, name: string): WorkflowRun {
  if (!run || run.workflowName !== name) {
    return {
      id: run?.id || "",
      provider: "openworkflow",
      status: "unknown",
    }
  }

  return {
    id: run.id,
    metadata: run.error || {
      namespaceId: run.namespaceId,
      version: run.version,
      workflowName: run.workflowName,
    },
    provider: "openworkflow",
    result: run.output ?? undefined,
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
  const workflow = await registerOpenWorkflowDefinition(runtime, name, definition as never)
  const handle = await runWorkflowProviderOperation("openworkflow", "run", async () => {
    const start = () => workflow.run(payload, options.id ? { idempotencyKey: options.id } : undefined)
    return await start().catch((error) => {
      if (!options.id) throw error
      return start()
    })
  }, { acknowledgementUnknown: (_error, status) => status === undefined })
  return await runWorkflowProviderOperation("openworkflow", "run", async () => {
    return {
      id: handle.workflowRun.id,
      metadata: {
        ...(options.id ? { idempotencyKey: options.id } : {}),
        workflow: name,
      },
      payload,
      provider: "openworkflow" as const,
      status: normalizeOpenWorkflowStatus(handle.workflowRun.status),
    }
  })
}

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
