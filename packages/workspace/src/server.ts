import { createError, defineEventHandler, getRouterParam } from "h3"
import { lookup } from "mrmime"

import { WorkspaceNotFoundError, WorkspacePathError } from "./core/errors.ts"
import { matchesAny, normalizeSafeWorkspacePath } from "./core/path.ts"
import { useWorkspace } from "./core/use.ts"

import type { H3Event } from "h3"
import type { ReadonlyWorkspaceFacade, WritableWorkspaceFacade } from "./core/use.ts"
import type { WorkspaceName } from "./core/types.ts"

type WorkspaceInput<Name extends WorkspaceName> =
  | Name
  | ReadonlyWorkspaceFacade<Name>
  | WritableWorkspaceFacade<Name>
  | (() => ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name> | Promise<ReadonlyWorkspaceFacade<Name> | WritableWorkspaceFacade<Name>>)
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
