import type { AgentInvocationRecord } from 'vite-hub/agent'
import { runGitHub } from './github.ts'
import { type SessionSnapshot, useSessionSnapshotStore } from './session-snapshots.ts'

const maxWorkspaceFileSize = 512 * 1024
type GitHubRunner = typeof runGitHub

export async function resolveSessionWorkspace(invocation: AgentInvocationRecord, runner: GitHubRunner = runGitHub) {
  const snapshots = useSessionSnapshotStore()
  const stored = snapshots.getForInvocation(invocation)
  let snapshot = stored ?? snapshotFromAnnotations(invocation)
  if (!snapshot) return undefined
  if (!stored) {
    snapshots.create(snapshot, snapshot.createdAt)
  }
  if (!snapshot.paths.length) {
    const paths = await readWorkspaceTree(snapshot.repository, snapshot.revision, runner)
    snapshots.setPaths(invocation.id, paths)
    snapshot = { ...snapshot, paths }
  }
  return snapshot
}

export async function readWorkspaceTree(repository: string, revision: string, runner: GitHubRunner = runGitHub) {
  assertRepository(repository)
  assertRevision(revision)
  const result = await runner([
    'api',
    '--method', 'GET',
    '-f', 'recursive=1',
    `repos/${repository}/git/trees/${revision}`,
  ], { repository })
  const payload = JSON.parse(result.stdout) as { tree?: unknown, truncated?: unknown }
  if (payload.truncated === true) throw new Error('The Workspace tree is too large to inspect safely.')
  if (!Array.isArray(payload.tree)) throw new Error('GitHub did not return a Workspace tree.')
  return payload.tree.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    return item.type === 'blob' && typeof item.path === 'string' ? [item.path] : []
  }).sort((left, right) => left.localeCompare(right))
}

export async function readWorkspaceFile(snapshot: SessionSnapshot, path: string, runner: GitHubRunner = runGitHub) {
  assertWorkspacePath(path)
  if (!snapshot.paths.includes(path)) throw new Error('The requested file is not part of this Workspace snapshot.')
  const endpointPath = path.split('/').map(encodeURIComponent).join('/')
  const result = await runner([
    'api',
    '--method', 'GET',
    '-f', `ref=${snapshot.revision}`,
    `repos/${snapshot.repository}/contents/${endpointPath}`,
  ], { repository: snapshot.repository })
  const payload = JSON.parse(result.stdout) as Record<string, unknown>
  if (payload.type !== 'file' || typeof payload.content !== 'string') throw new Error('GitHub did not return a file.')
  const size = typeof payload.size === 'number' ? payload.size : 0
  if (size > maxWorkspaceFileSize) throw new Error('This file is too large to preview.')
  if (payload.encoding !== 'base64') throw new Error('This file cannot be previewed as text.')
  const bytes = Buffer.from(payload.content.replaceAll(/\s/g, ''), 'base64')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    throw new Error('This binary file cannot be previewed as text.')
  }
  if (content.includes('\0')) throw new Error('This binary file cannot be previewed as text.')
  return { content, path, revision: snapshot.revision, size: bytes.byteLength }
}

export function assertWorkspacePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid Workspace path.')
  }
}

function snapshotFromAnnotations(invocation: AgentInvocationRecord): SessionSnapshot | undefined {
  const repository = invocation.annotations?.['github.repository']
  const revision = invocation.annotations?.['github.head']
  const pullRequest = invocation.annotations?.['github.pullRequest']
  if (typeof repository !== 'string' || typeof revision !== 'string' || typeof pullRequest !== 'number') return undefined
  assertRepository(repository)
  assertRevision(revision)
  return {
    createdAt: invocation.createdAt,
    events: [],
    invocationId: invocation.id,
    paths: [],
    pullRequest,
    repository,
    revision,
    updatedAt: invocation.updatedAt,
  }
}

function assertRepository(repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.')
}

function assertRevision(revision: string) {
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('Invalid Git revision.')
}
