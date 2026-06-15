import { createSourceContext, normalizeWorkspaceSources } from "./config.ts"
import { getWorkspaceSourceRequestExecutor } from "./request-metadata.ts"

import type {
  WorkspaceDefinition,
  WorkspaceSelectedScope,
  WorkspaceSourceRequestDescriptor,
  WorkspaceSourceRequestExecutionInput,
  WorkspaceSourceRequestExecutionResult,
} from "../core/types.ts"

export interface WorkspaceSourceRequestExecutionTarget {
  executeSourceRequest(input: WorkspaceSourceRequestExecutionInput): Promise<WorkspaceSourceRequestExecutionResult>
}

const sourceRequestExecutions = new WeakMap<object, WorkspaceSourceRequestExecutionTarget>()

export function attachWorkspaceSourceRequestExecution<T extends object>(
  target: T,
  executor: WorkspaceSourceRequestExecutionTarget | undefined,
): T {
  if (!executor) return target
  sourceRequestExecutions.set(target, executor)
  return target
}

export function getWorkspaceSourceRequestExecution(input: object): WorkspaceSourceRequestExecutionTarget | undefined {
  return sourceRequestExecutions.get(input)
}

export function createWorkspaceSourceRequestExecution(
  definition: WorkspaceDefinition,
  options: { selectedWorkspaceScope?: WorkspaceSelectedScope } = {},
): WorkspaceSourceRequestExecutionTarget | undefined {
  const sources = normalizeWorkspaceSources(definition.sources)
    .filter(source => source.requestDescriptor && getWorkspaceSourceRequestExecutor(source.source))

  if (!sources.length) return undefined

  return {
    async executeSourceRequest(input) {
      const targetMatches = sources.filter((source) => {
        const descriptor = source.requestDescriptor
        if (!descriptor || descriptor.method !== input.method) return false
        return sameRequestTarget(descriptor.url, input.url)
      })
      const matches = targetMatches.filter(source => source.requestDescriptor && requestShapeMatches(source.requestDescriptor, input))

      if (matches.length !== 1) {
        throw new Error(matches.length > 1
          ? "[vitehub] Source request is ambiguous; more than one visible Source matches this curl target."
          : "[vitehub] Source request is not visible in the selected workspace scope or does not match a declared Source target.")
      }

      const source = matches[0]!
      const executor = getWorkspaceSourceRequestExecutor(source.source)
      if (!executor) throw new Error("[vitehub] Source request executor is unavailable.")
      return await executor(input, createSourceContext(definition, {
        key: source.key,
        mountPath: source.mountPath,
      }, undefined, { selectedWorkspaceScope: options.selectedWorkspaceScope }))
    },
  }
}

function sameRequestTarget(left: string, right: string): boolean {
  const leftUrl = new URL(left)
  const rightUrl = new URL(right)
  return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname
}

function requestShapeMatches(descriptor: WorkspaceSourceRequestDescriptor, input: WorkspaceSourceRequestExecutionInput): boolean {
  const request = descriptor.request
  if (request?.querySchema) return bodyShapeMatches(request, input)
  if (!jsonEqual(queryFromUrl(new URL(input.url)) || {}, serializedQuery(request?.query) || {})) return false
  return bodyShapeMatches(request, input)
}

function bodyShapeMatches(request: NonNullable<WorkspaceSourceRequestDescriptor["request"]> | undefined, input: WorkspaceSourceRequestExecutionInput): boolean {
  if (request?.bodySchema) return true
  if (typeof request?.body !== "undefined") return jsonEqual(input.body, request.body)
  return typeof input.body === "undefined"
}

function queryFromUrl(url: URL): Record<string, unknown> | undefined {
  const query: Record<string, unknown> = {}
  for (const key of new Set([...url.searchParams.keys()])) {
    const values = url.searchParams.getAll(key)
    query[key] = values.length > 1 ? values : values[0]
  }
  return Object.keys(query).length ? query : undefined
}

function serializedQuery(query: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!query) return undefined
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) params.append(key, String(item))
  }
  return queryFromUrl(new URL(`https://vitehub.local/?${params}`))
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
