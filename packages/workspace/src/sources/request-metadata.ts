import { workspaceError } from "../core/errors.ts"

import type {
  WorkspaceSource,
  WorkspaceSourceRequestDescriptor,
  WorkspaceSourceRequestExecutor,
} from "../core/types.ts"

const requestSourceDescriptors = new WeakMap<WorkspaceSource, WorkspaceSourceRequestDescriptor>()
const requestSourceExecutors = new WeakMap<WorkspaceSource, WorkspaceSourceRequestExecutor>()
const requestOnlySources = new WeakSet<WorkspaceSource>()

export function markWorkspaceSourceRequestDescriptor(
  source: WorkspaceSource,
  descriptor: WorkspaceSourceRequestDescriptor,
  options: { requestOnly?: boolean } = {},
): WorkspaceSource {
  requestSourceDescriptors.set(source, descriptor)
  if (options.requestOnly) requestOnlySources.add(source)
  return source
}

export function markWorkspaceSourceRequestExecutor(
  source: WorkspaceSource,
  executor: WorkspaceSourceRequestExecutor,
): WorkspaceSource {
  requestSourceExecutors.set(source, executor)
  return source
}

export function copyWorkspaceSourceRequestMetadata(source: WorkspaceSource, target: WorkspaceSource): void {
  const requestDescriptor = requestSourceDescriptors.get(source)
  if (requestDescriptor) requestSourceDescriptors.set(target, requestDescriptor)
  const requestExecutor = requestSourceExecutors.get(source)
  if (requestExecutor) requestSourceExecutors.set(target, requestExecutor)
  if (requestOnlySources.has(source)) requestOnlySources.add(target)
}

export function getWorkspaceSourceRequestDescriptor(source: WorkspaceSource): WorkspaceSourceRequestDescriptor | undefined {
  return requestSourceDescriptors.get(source)
}

export function getWorkspaceSourceRequestExecutor(source: WorkspaceSource): WorkspaceSourceRequestExecutor | undefined {
  return requestSourceExecutors.get(source)
}

export function isWorkspaceSourceRequestOnly(source: WorkspaceSource): boolean {
  return requestOnlySources.has(source)
}

export function assertWorkspaceSourceRequestDescriptorKey(sourceKey: string): void {
  const normalized = sourceKey.replace(/\\/g, "/")
  if (
    !normalized
    || normalized.includes("/")
    || normalized === "."
    || normalized === ".."
    || normalized === ".git"
    || normalized === ".vitehub"
    || normalized.endsWith(".json")
  ) {
    throw workspaceError(`[vitehub] Workspace Source Request descriptor key must be a single safe file stem: ${sourceKey}.`)
  }
}

export function workspaceSourceRequestDescriptorPath(sourceKey: string): string {
  assertWorkspaceSourceRequestDescriptorKey(sourceKey)
  return `.vitehub/sources/${sourceKey}.json`
}
