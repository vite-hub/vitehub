import { createError, defineEventHandler, getQuery, getRouterParam } from "h3"
import { lookup } from "mrmime"
import { getViteHubErrorShape } from "@vite-hub/runtime"

import { getWorkspaceCollectionItem, queryWorkspaceCollection, workspaceCollectionEmpty } from "./collections.ts"
import { matchesAny, normalizeSafeWorkspacePath } from "./core/path.ts"
import { resolveWorkspaceAutoCommit } from "./core/rules.ts"
import { useWorkspace } from "./core/use.ts"
import { withWorkspaceProgress } from "./session/progress.ts"

import type { H3Event } from "h3"
import type { WorkspaceCollectionOptions, WorkspaceCollectionQuery, WorkspaceCollectionSort } from "./collections.ts"
import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade } from "./core/use.ts"
import type { ExecResult, WorkspaceDefinition, WorkspaceMaterializeSourcesOptions, WorkspaceName, WorkspacePrepareSessionProgressEvent, WorkspaceSession, WorkspaceSessionHost, WorkspaceSessionOptions } from "./core/types.ts"

export const workspaceDevRoute = "/__vitehub/workspace/dev"
export const workspaceDevHeader = "x-vitehub-workspace-dev"
export const workspaceDevHeaderValue = "1"
export const workspaceDevTokenHeader = "x-vitehub-dev-token"

type WorkspaceInput<Name extends WorkspaceName> =
  | Name
  | ReadonlyWorkspaceFacade<Name>
  | WritableWorkspaceFacade<Name>
  | (() => ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name> | Promise<ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name>>)
type WorkspaceSessionStarter = {
  startSession(options?: WorkspaceSessionOptions): Promise<WorkspaceSession>
}
type WorkspaceSourceMaterializer = (options?: WorkspaceMaterializeSourcesOptions) => Promise<unknown>
type WorkspaceWithMaterializeSources = { materializeSources?: WorkspaceSourceMaterializer }
type ResponseBody = ConstructorParameters<typeof Response>[0]
type ResponseHeaders = ConstructorParameters<typeof Headers>[0]

function hasWorkspaceCommitRules(definition: WorkspaceDefinition): boolean {
  return [
    ...Object.values(definition.rules || {}),
    ...(definition.plugins || []).flatMap(plugin => Object.values(plugin.rules || {})),
  ].some(rule => rule.commit !== undefined)
}

export interface WorkspaceFileResponseOptions<Name extends WorkspaceName = WorkspaceName> {
  allow?: string[]
  cacheControl?: string
  contentTypes?: Record<string, string>
  headers?: ResponseHeaders
  path: string
  root?: string
  workspace: WorkspaceInput<Name>
}

export interface WorkspaceFileHandlerOptions<Name extends WorkspaceName = WorkspaceName> extends Omit<WorkspaceFileResponseOptions<Name>, "path"> {
  param?: string
}

export interface WorkspaceCollectionHandlerOptions<Name extends WorkspaceName = WorkspaceName> extends WorkspaceCollectionOptions<Name> {
  facets?: string[]
  filters?: string[]
  item?: {
    key: string
    select?: string[]
  }
  searchFields?: string[]
  select?: string[]
  sort?: WorkspaceCollectionSort
}

export interface WorkspaceDevCommandInput<Name extends WorkspaceName = WorkspaceName> {
  abortSignal?: AbortSignal
  args?: string[]
  command: string
  definition?: WorkspaceDefinition
  host?: WorkspaceSessionHost
  onProgress?: (event: WorkspacePrepareSessionProgressEvent) => void | Promise<void>
  paths?: readonly string[]
  timeout?: number
  workspace: Name | WritableWorkspaceFacade<Name> | (ReadonlyWorkspaceFacade<Name> & { fs: ReadonlyWorkspaceFacade<Name>["fs"] & Partial<WorkspaceSessionStarter> })
}

export interface WorkspaceDevTokenOptions {
  serverId?: string
}

const workspaceDevTokensKey = Symbol.for("vitehub.workspace.devTokens")

type WorkspaceDevTokensGlobal = typeof globalThis & Record<symbol, Map<string, string> | undefined>

function workspaceDevTokens(): Map<string, string> {
  const scope = globalThis as WorkspaceDevTokensGlobal
  scope[workspaceDevTokensKey] ??= new Map()
  return scope[workspaceDevTokensKey]
}

export function workspaceDevTokenServerId(port?: number | string | null): string {
  return `${process.pid}:${port ?? "unknown"}`
}

async function workspaceDevTokenRoot(rootDir: string, options: WorkspaceDevTokenOptions = {}): Promise<{ file: string, key: string, legacyFile: string }> {
  const [{ createHash }, { tmpdir }, { join, resolve }] = await Promise.all([
    import("node:crypto"),
    import("node:os"),
    import("node:path"),
  ])
  const resolvedRoot = resolve(rootDir)
  const rootKey = createHash("sha256").update(resolvedRoot).digest("hex")
  const serverKey = createHash("sha256").update(options.serverId || "default").digest("hex")
  return {
    file: join(tmpdir(), "vitehub-workspace-dev", rootKey, serverKey, "dev-token"),
    key: `${rootKey}:${serverKey}`,
    legacyFile: join(resolvedRoot, ".vitehub", "dev-token"),
  }
}

function headerValue(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) || undefined
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function randomToken(): string {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

export async function refreshWorkspaceDevToken(rootDir: string, options: WorkspaceDevTokenOptions = {}): Promise<string> {
  const token = randomToken()
  const tokenRoot = await workspaceDevTokenRoot(rootDir, options)
  workspaceDevTokens().set(tokenRoot.key, token)
  const [{ mkdir, rm, writeFile }, { dirname }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ])
  const file = tokenRoot.file
  await mkdir(dirname(file), { mode: 0o700, recursive: true })
  await rm(tokenRoot.legacyFile, { force: true })
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  return token
}

export async function ensureWorkspaceDevToken(rootDir: string, options: WorkspaceDevTokenOptions = {}): Promise<string> {
  const existing = workspaceDevTokens().get((await workspaceDevTokenRoot(rootDir, options)).key)
  return existing || await refreshWorkspaceDevToken(rootDir, options)
}

export async function readWorkspaceDevToken(rootDir: string, options: WorkspaceDevTokenOptions = {}): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const token = (await readFile((await workspaceDevTokenRoot(rootDir, options)).file, "utf8")).trim()
    return token || undefined
  }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function validateWorkspaceDevToken(rootDir: string, headers: Headers | Record<string, string | string[] | undefined>, options: WorkspaceDevTokenOptions = {}): Promise<boolean> {
  const token = headerValue(headers, workspaceDevTokenHeader)
  return typeof token === "string" && token === await ensureWorkspaceDevToken(rootDir, options)
}

async function resolveWorkspace<Name extends WorkspaceName>(
  workspace: WorkspaceInput<Name>,
): Promise<ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name>> {
  if (typeof workspace === "string") return useWorkspace(workspace)
  if (typeof workspace === "function") return await workspace()
  return workspace
}

function resolveWorkspaceFilePath(path: string, root: string | undefined): string {
  const normalizedPath = normalizeSafeWorkspacePath(path, { allowEmpty: false })
  if (!root) return normalizedPath
  return `${normalizeSafeWorkspacePath(root, { allowEmpty: false })}/${normalizedPath}`
}

function resolveContentType(path: string, mediaType: string | undefined, contentTypes: Record<string, string> | undefined): string {
  if (mediaType) return mediaType
  if (contentTypes?.[path]) return contentTypes[path]
  const extension = path.includes(".") ? `.${path.split(".").at(-1)}` : ""
  if (extension && contentTypes?.[extension]) return contentTypes[extension]
  return lookup(path) || "application/octet-stream"
}

function isNotFoundError(error: unknown): boolean {
  const code = getViteHubErrorShape(error)?.code
  return code === "WORKSPACE_NOT_FOUND"
    || code === "WORKSPACE_PATH_INVALID"
    || (error instanceof Error && error.message.includes("Workspace file does not exist:"))
    || (error instanceof Error && error.message.includes("Workspace path does not exist:"))
}

class WorkspaceCollectionRequestError extends Error {}

function collectionQueryValue(query: Record<string, string | string[]>, key: string): string | undefined {
  const value = query[key]
  if (value === undefined) return
  if (Array.isArray(value)) throw new WorkspaceCollectionRequestError(`Workspace collection query parameter "${key}" must have one value.`)
  return value
}

function collectionLimit(query: Record<string, string | string[]>): number | undefined {
  const value = collectionQueryValue(query, "limit")
  if (value === undefined) return
  if (!/^\d+$/.test(value)) throw new WorkspaceCollectionRequestError("Workspace collection limit must be a positive integer.")
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new WorkspaceCollectionRequestError("Workspace collection limit must be a positive integer.")
  return limit
}

function collectionFilters(query: Record<string, string | string[]>, allowed: string[] | undefined): WorkspaceCollectionQuery["filters"] {
  const filters: NonNullable<WorkspaceCollectionQuery["filters"]> = {}
  const allowedFields = new Set(allowed || [])
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("filter.") && !key.startsWith("empty.")) continue
    const empty = key.startsWith("empty.")
    const field = key.slice(empty ? "empty.".length : "filter.".length)
    if (!allowedFields.has(field)) throw new WorkspaceCollectionRequestError(`Workspace collection filter "${field}" is not allowed.`)
    if (empty) {
      if (value !== "true") throw new WorkspaceCollectionRequestError(`Workspace collection empty filter "${field}" must be true.`)
      filters[field] = workspaceCollectionEmpty
      continue
    }
    const values = (Array.isArray(value) ? value : [value]).map(item => item.trim())
    filters[field] = values
  }
  return filters
}

function parseWorkspaceCollectionQuery(
  query: Record<string, string | string[]>,
  options: WorkspaceCollectionHandlerOptions,
): { itemValue?: string, page: WorkspaceCollectionQuery } {
  for (const key of Object.keys(query)) {
    if (!["cursor", "limit", "search", "value"].includes(key) && !key.startsWith("filter.") && !key.startsWith("empty.")) {
      throw new WorkspaceCollectionRequestError(`Workspace collection query parameter "${key}" is not allowed.`)
    }
  }
  const itemValue = collectionQueryValue(query, "value")
  if (itemValue !== undefined && !options.item) throw new WorkspaceCollectionRequestError("Workspace collection item lookup is not enabled.")
  const search = collectionQueryValue(query, "search")
  if (search && !options.searchFields?.length) throw new WorkspaceCollectionRequestError("Workspace collection search is not enabled.")
  return {
    itemValue,
    page: {
      cursor: collectionQueryValue(query, "cursor"),
      facets: options.facets,
      filters: collectionFilters(query, options.filters),
      limit: collectionLimit(query),
      search,
      searchFields: options.searchFields,
      select: options.select,
      sort: options.sort,
    },
  }
}

function workspaceSessionStarter(input: unknown): WorkspaceSessionStarter | undefined {
  return input && typeof input === "object" && typeof (input as Partial<WorkspaceSessionStarter>).startSession === "function"
    ? input as WorkspaceSessionStarter
    : undefined
}

function workspaceSourceMaterializer(input: unknown): WorkspaceSourceMaterializer | undefined {
  return input && typeof input === "object" && typeof (input as WorkspaceWithMaterializeSources).materializeSources === "function"
    ? (input as WorkspaceWithMaterializeSources).materializeSources!.bind(input)
    : undefined
}

async function materializeWorkspaceDevSources(
  workspace: Awaited<ReturnType<typeof resolveWorkspace>>,
  input: WorkspaceDevCommandInput,
) {
  const materialize = workspaceSourceMaterializer(workspace) ?? workspaceSourceMaterializer(workspace.fs)
  if (!materialize) return
  const paths = input.paths?.length ? input.paths : [""]
  await withWorkspaceProgress(input.onProgress, {
    data: { paths },
    id: "workspace.dev.materialize",
    label: "Materializing workspace sources",
  }, async () => {
    await Promise.all(paths.map(async (path) => {
      await materialize({
        abortSignal: input.abortSignal,
        onProgress: async event => await input.onProgress?.({
          data: { ...event },
          durationMs: event.durationMs,
          error: event.error,
          id: `workspace.dev.materialize.${event.source}`,
          label: `Materializing source ${event.source}`,
          status: event.status,
        }),
        path,
      }).catch((error) => {
        if (path && isNotFoundError(error)) return
        throw error
      })
    }))
  })
}

export async function readWorkspaceFileResponse<Name extends WorkspaceName>(
  options: WorkspaceFileResponseOptions<Name>,
): Promise<Response> {
  let filePath: string
  try {
    filePath = resolveWorkspaceFilePath(options.path, options.root)
    if (!matchesAny(filePath, options.allow)) {
      throw createError({ statusCode: 404, statusMessage: "Workspace file not found." })
    }
  }
  catch (error) {
    if (isNotFoundError(error)) {
      throw createError({ statusCode: 404, statusMessage: "Workspace file not found." })
    }
    throw error
  }

  const workspace = await resolveWorkspace(options.workspace)
  try {
    const [content, stat] = await Promise.all([
      workspace.fs.readFile(filePath as never, { encoding: "binary" }),
      workspace.fs.stat(filePath as never),
    ])
    if (stat.type !== "file") {
      throw createError({ statusCode: 404, statusMessage: "Workspace file not found." })
    }

    const headers = new Headers(options.headers)
    headers.set("content-type", resolveContentType(filePath, stat.mediaType, options.contentTypes))
    headers.set("x-content-type-options", "nosniff")
    if (options.cacheControl) {
      headers.set("cache-control", options.cacheControl)
    }
    return new Response(content as ResponseBody, { headers })
  }
  catch (error) {
    if (isNotFoundError(error)) {
      throw createError({ statusCode: 404, statusMessage: "Workspace file not found." })
    }
    throw error
  }
}

export function defineWorkspaceFileHandler<Name extends WorkspaceName>(
  options: WorkspaceFileHandlerOptions<Name>,
): ReturnType<typeof defineEventHandler> {
  return defineEventHandler((event: H3Event) => {
    const path = getRouterParam(event, options.param || "path") || ""
    return readWorkspaceFileResponse({ ...options, path })
  })
}

export function defineWorkspaceCollectionHandler<Name extends WorkspaceName>(
  options: WorkspaceCollectionHandlerOptions<Name>,
): ReturnType<typeof defineEventHandler> {
  return defineEventHandler(async (event: H3Event) => {
    try {
      const parsed = parseWorkspaceCollectionQuery(getQuery(event), options as WorkspaceCollectionHandlerOptions)
      if (parsed.itemValue !== undefined && options.item) {
        return await getWorkspaceCollectionItem({
          ...options,
          query: {
            key: options.item.key,
            select: options.item.select,
            value: parsed.itemValue,
          },
        })
      }
      return await queryWorkspaceCollection({ ...options, query: parsed.page })
    }
    catch (error) {
      if (error instanceof WorkspaceCollectionRequestError) {
        throw createError({ cause: error, statusCode: 400, statusMessage: error.message })
      }
      if (getViteHubErrorShape(error)?.code === "WORKSPACE_COLLECTION_CURSOR_INVALID") {
        const reason = getViteHubErrorShape(error)?.details?.reason
        throw createError({
          cause: error,
          statusCode: reason === "stale" ? 409 : 400,
          statusMessage: error instanceof Error ? error.message : "Invalid workspace collection cursor.",
        })
      }
      if (isNotFoundError(error)) {
        throw createError({ cause: error, statusCode: 404, statusMessage: "Workspace collection not found." })
      }
      throw createError({ cause: error, statusCode: 500, statusMessage: "Workspace collection query failed." })
    }
  })
}

export async function runWorkspaceDevCommand<Name extends WorkspaceName>(
  input: WorkspaceDevCommandInput<Name>,
): Promise<ExecResult> {
  const command = input.command.trim()
  if (!command) throw new Error("Workspace Dev command cannot be empty.")
  const definition = input.definition
  const workspace = typeof input.workspace === "string"
    ? await useWorkspace(input.workspace, definition ? { definition, mode: "write" } as { mode: "write" } : { mode: "write" })
    : input.workspace
  const starter = workspaceSessionStarter(workspace) ?? workspaceSessionStarter(workspace.fs)
  const startSession = starter?.startSession.bind(starter)
  if (!startSession) throw new Error("Workspace Dev command requires a Workspace Session.")
  await materializeWorkspaceDevSources(workspace, input)
  let session: WorkspaceSession | undefined
  const execOptions = { abortSignal: input.abortSignal, timeout: input.timeout }
  let result
  try {
    await withWorkspaceProgress(input.onProgress, {
      data: { paths: input.paths ?? null },
      id: "workspace.dev.start-session",
      label: "Starting workspace session",
    }, async () => {
      session = await startSession({ abortSignal: input.abortSignal, host: input.host, paths: input.paths })
      return session
    })
    if (!session) throw new Error("Workspace Dev Session did not start.")
    result = input.args
      ? await session.exec(command, input.args, execOptions)
      : await session.exec("sh", ["-lc", command], execOptions)
    const diff = result.exitCode === 0 ? await session.diff() : undefined
    if (diff?.entries.length) {
      const commit = definition ? resolveWorkspaceAutoCommit(definition, diff) : undefined
      if (!definition || !hasWorkspaceCommitRules(definition) || commit) await session.commit({ message: commit?.message || "workspace dev command" })
    }
  }
  catch (error) {
    if (!session) throw error
    try {
      await session.close()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], "[vitehub] Workspace Dev command failed and session cleanup also failed.")
    }
    throw error
  }
  if (!session) throw new Error("Workspace Dev Session did not start.")
  await session.close()
  return result
}
