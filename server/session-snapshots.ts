import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type SessionInspectorTarget = 'agent' | 'workspace'

export type SessionTimelineEvent = {
  delivery?: { intent: string, kind: 'reaction' | 'reply' | 'status' | 'update' }
  detail?: string
  group?: string
  inspector?: SessionInspectorTarget
  kind?: 'action' | 'delivery' | 'preparation' | 'system'
  label?: { color: string, name: string, operation: 'added' | 'removed' }
  name: string
  phase?: 'after' | 'before'
  timestamp: string
  title: string
}

export type SessionAgentConfiguration = {
  agent?: { name?: string, version?: string }
  capabilities?: { id: string, metadata?: Record<string, unknown> }[]
  driver?: { kind?: string, model?: { id?: string, provider?: string }, provider?: string }
  instructions?: string[]
  runtime?: { name?: string }
  tools?: { name: string }[]
  workspace?: { mode?: string, name?: string, sources?: string[] }
}

export type SessionSnapshot = {
  agent?: SessionAgentConfiguration
  createdAt: string
  events: SessionTimelineEvent[]
  invocationId: string
  paths: string[]
  pullRequest: number
  repository: string
  revision: string
  sourceRepository?: string
  updatedAt: string
}

export type SessionSnapshotInvocation = {
  id: string
  observations?: readonly {
    attributes?: Record<string, unknown>
  }[]
}

type SessionSnapshotInput = Pick<SessionSnapshot, 'invocationId' | 'pullRequest' | 'repository' | 'revision' | 'sourceRepository'>

export function createSessionSnapshotStore(url = '.vitehub/session-snapshots.sqlite') {
  if (url !== ':memory:') mkdirSync(dirname(url), { recursive: true })
  const database = new DatabaseSync(url)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_snapshots (
      invocation_id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      revision TEXT NOT NULL,
      pull_request INTEGER NOT NULL,
      source_repository TEXT,
      agent_json TEXT,
      paths_json TEXT NOT NULL DEFAULT '[]',
      events_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const columns = database.prepare('PRAGMA table_info(session_snapshots)').all() as { name: string }[]
  if (!columns.some(column => column.name === 'agent_json')) database.exec('ALTER TABLE session_snapshots ADD COLUMN agent_json TEXT')

  const read = database.prepare('SELECT * FROM session_snapshots WHERE invocation_id = ?')
  const readPrepared = database.prepare(`
    SELECT * FROM session_snapshots
    WHERE repository = ? AND revision = ? AND pull_request = ? AND agent_json IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `)
  const insert = database.prepare(`
    INSERT INTO session_snapshots (
      invocation_id, repository, revision, pull_request, source_repository,
      paths_json, events_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?)
    ON CONFLICT(invocation_id) DO UPDATE SET
      repository = excluded.repository,
      revision = excluded.revision,
      pull_request = excluded.pull_request,
      source_repository = excluded.source_repository,
      updated_at = excluded.updated_at
  `)
  const updateEvents = database.prepare('UPDATE session_snapshots SET events_json = ?, updated_at = ? WHERE invocation_id = ?')
  const updatePaths = database.prepare('UPDATE session_snapshots SET paths_json = ?, updated_at = ? WHERE invocation_id = ?')
  const updateAgent = database.prepare('UPDATE session_snapshots SET agent_json = ?, updated_at = ? WHERE invocation_id = ?')
  const readStats = database.prepare('SELECT COUNT(*) AS count, MAX(updated_at) AS updated_at FROM session_snapshots')

  return {
    close() {
      database.close()
    },
    create(input: SessionSnapshotInput, timestamp = new Date().toISOString()) {
      insert.run(
        input.invocationId,
        input.repository,
        input.revision,
        input.pullRequest,
        input.sourceRepository ?? null,
        timestamp,
        timestamp,
      )
      return this.get(input.invocationId)
    },
    get(invocationId: string): SessionSnapshot | undefined {
      const row = read.get(invocationId) as Record<string, unknown> | undefined
      return row ? parseRow(row) : undefined
    },
    getPrepared(repository: string, revision: string, pullRequest: number): SessionSnapshot | undefined {
      const row = readPrepared.get(repository, revision, pullRequest) as Record<string, unknown> | undefined
      return row ? parseRow(row) : undefined
    },
    getForInvocation(invocation: SessionSnapshotInvocation): SessionSnapshot | undefined {
      for (const observation of invocation.observations ?? []) {
        const runId = observation.attributes?.['agent.run.id']
        if (typeof runId !== 'string' || !runId.trim()) continue
        const snapshot = this.get(runId)
        if (snapshot) return snapshot
      }
      return this.get(invocation.id)
    },
    record(invocationId: string, event: SessionTimelineEvent) {
      const snapshot = this.get(invocationId)
      if (!snapshot) throw new Error(`Session snapshot ${invocationId} does not exist.`)
      const events = [...snapshot.events, event]
      updateEvents.run(JSON.stringify(events), event.timestamp, invocationId)
      return events
    },
    setAgent(invocationId: string, agent: SessionAgentConfiguration, timestamp = new Date().toISOString()) {
      updateAgent.run(JSON.stringify(agent), timestamp, invocationId)
      return agent
    },
    setPaths(invocationId: string, paths: readonly string[], timestamp = new Date().toISOString()) {
      const normalized = [...new Set(paths)].sort((left, right) => left.localeCompare(right))
      updatePaths.run(JSON.stringify(normalized), timestamp, invocationId)
      return normalized
    },
    stats() {
      const row = readStats.get() as { count: number, updated_at: string | null }
      return { count: Number(row.count), updatedAt: row.updated_at ?? undefined }
    },
  }
}

let store: ReturnType<typeof createSessionSnapshotStore> | undefined

export function useSessionSnapshotStore() {
  return store ??= createSessionSnapshotStore()
}

function parseRow(row: Record<string, unknown>): SessionSnapshot {
  return {
    ...(typeof row.agent_json === 'string' ? { agent: JSON.parse(row.agent_json) as SessionAgentConfiguration } : {}),
    createdAt: String(row.created_at),
    events: parseArray<SessionTimelineEvent>(row.events_json),
    invocationId: String(row.invocation_id),
    paths: parseArray<string>(row.paths_json),
    pullRequest: Number(row.pull_request),
    repository: String(row.repository),
    revision: String(row.revision),
    ...(typeof row.source_repository === 'string' ? { sourceRepository: row.source_repository } : {}),
    updatedAt: String(row.updated_at),
  }
}

function parseArray<T>(value: unknown): T[] {
  if (typeof value !== 'string') return []
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed as T[] : []
}
