import { createError, defineEventHandler, getRouterParam } from "h3"
import { lookup } from "mrmime"

import { WorkspaceNotFoundError, WorkspacePathError } from "./core/errors.ts"
import { matchesAny, normalizeSafeWorkspacePath } from "./core/path.ts"
import { useWorkspace } from "./core/use.ts"

import type { H3Event } from "h3"
import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade } from "./core/use.ts"
import type { ExecResult, WorkspaceDefinition, WorkspaceName, WorkspaceSession, WorkspaceSessionOptions } from "./core/types.ts"

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
type ResponseBody = ConstructorParameters<typeof Response>[0]
type ResponseHeaders = ConstructorParameters<typeof Headers>[0]

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

export interface WorkspaceDevCommandInput<Name extends WorkspaceName = WorkspaceName> {
  args?: string[]
  command: string
  definition?: WorkspaceDefinition
  paths?: readonly string[]
  timeout?: number
  workspace: Name | WritableWorkspaceFacade<Name> | (ReadonlyWorkspaceFacade<Name> & { fs: ReadonlyWorkspaceFacade<Name>["fs"] & Partial<WorkspaceSessionStarter> })
}

const workspaceDevTokenFile = ".vitehub/dev-token"
const workspaceDevTokens = new Map<string, string>()

async function workspaceDevTokenPath(rootDir: string): Promise<string> {
  const { join } = await import("node:path")
  return join(rootDir, workspaceDevTokenFile)
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

export async function refreshWorkspaceDevToken(rootDir: string): Promise<string> {
  const token = randomToken()
  workspaceDevTokens.set(rootDir, token)
  const [{ mkdir, writeFile }, { dirname }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ])
  const file = await workspaceDevTokenPath(rootDir)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  return token
}

export async function ensureWorkspaceDevToken(rootDir: string): Promise<string> {
  const existing = workspaceDevTokens.get(rootDir)
  return existing || await refreshWorkspaceDevToken(rootDir)
}

export async function readWorkspaceDevToken(rootDir: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const token = (await readFile(await workspaceDevTokenPath(rootDir), "utf8")).trim()
    return token || undefined
  }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function validateWorkspaceDevToken(rootDir: string, headers: Headers | Record<string, string | string[] | undefined>): Promise<boolean> {
  const token = headerValue(headers, workspaceDevTokenHeader)
  return typeof token === "string" && token === await ensureWorkspaceDevToken(rootDir)
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
  return error instanceof WorkspaceNotFoundError
    || error instanceof WorkspacePathError
    || (error instanceof Error && error.message.includes("Workspace file does not exist:"))
    || (error instanceof Error && error.message.includes("Workspace path does not exist:"))
}

function workspaceSessionStarter(input: unknown): WorkspaceSessionStarter | undefined {
  return input && typeof input === "object" && typeof (input as Partial<WorkspaceSessionStarter>).startSession === "function"
    ? input as WorkspaceSessionStarter
    : undefined
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

export async function runWorkspaceDevCommand<Name extends WorkspaceName>(
  input: WorkspaceDevCommandInput<Name>,
): Promise<ExecResult> {
  const command = input.command.trim()
  if (!command) throw new Error("Workspace Dev command cannot be empty.")
  const workspace = typeof input.workspace === "string"
    ? await useWorkspace(input.workspace, input.definition ? { definition: input.definition, mode: "write" } as { mode: "write" } : { mode: "write" })
    : input.workspace
  const starter = workspaceSessionStarter(workspace) ?? workspaceSessionStarter(workspace.fs)
  const startSession = starter?.startSession.bind(starter)
  if (!startSession) throw new Error("Workspace Dev command requires a Workspace Session.")
  const session = await startSession(input.paths ? { paths: input.paths } : undefined)
  try {
    const result = input.args
      ? await session.exec(command, input.args, { timeout: input.timeout })
      : await session.exec("bash", ["-lc", command], { timeout: input.timeout })
    if (result.exitCode === 0) await session.commit({ message: "workspace dev command" })
    return result
  }
  finally {
    await session.close()
  }
}
