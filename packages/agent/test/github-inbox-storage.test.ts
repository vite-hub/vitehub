import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PullRequestInbox } from '../src/server/github-inbox.ts'
import { createLibsqlAgentState } from '../src/state/sqlite.ts'

const repository = 'vite-hub/vitehub'
const pr = (number: number, patch: Record<string, unknown> = {}) => ({ number, state: 'open', user: { login: 'onmax' },
  head: { sha: `head-${number}`, ref: `fix-${number}` }, base: { sha: 'base', ref: 'main' }, updated_at: '2026-09-13T10:00:00Z', ...patch })
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'vitehub-inbox-storage-'))
  directories.push(path)
  return path
}

it('keeps the inbox in Agent State tables next to the webhook queue', async () => {
  const state = createLibsqlAgentState({ url: `file:${join(await directory(), 'state.db')}` })
  const storage = state.extension('babysitter')
  expect(storage.tablePrefix).toBe('vitehub_agent_state_babysitter_')
  const inbox = new PullRequestInbox({ storage, repositories: [repository] })
  await inbox.seed(repository, pr(7))
  const [claim] = await inbox.claim(1)
  expect(claim?.snapshot.number).toBe(7)
  expect(await inbox.finish(claim!, { text: 'done' })).toBe(true)
  const tables = (await storage.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(row => row.name)
  expect(tables).toEqual(expect.arrayContaining(['vitehub_agent_state_babysitter_pull_requests', 'vitehub_agent_state_webhook_queue']))
  await state.disconnect()
})

it('rejects invalid extension names and rolls back a failed extension transaction', async () => {
  const state = createLibsqlAgentState({ url: `file:${join(await directory(), 'state.db')}` })
  expect(() => state.extension('Bad-Name')).toThrow(/extension name/)
  const storage = state.extension('sample')
  await storage.transaction(async tx => { await tx.execute(`CREATE TABLE ${storage.tablePrefix}items (id TEXT PRIMARY KEY)`) })
  await expect(storage.transaction(async (tx) => {
    await tx.execute(`INSERT INTO ${storage.tablePrefix}items (id) VALUES ('kept-out')`)
    throw new Error('rollback')
  })).rejects.toThrow('rollback')
  expect(await storage.execute(`SELECT id FROM ${storage.tablePrefix}items`)).toEqual([])
  await state.disconnect()
})

it('separates inboxes that share one storage by scope', async () => {
  const state = createLibsqlAgentState({ url: `file:${join(await directory(), 'state.db')}` })
  const storage = state.extension('babysitter')
  const first = new PullRequestInbox({ storage, scope: 'first', repositories: [repository] })
  const second = new PullRequestInbox({ storage, scope: 'second', repositories: [repository] })
  await first.seed(repository, pr(7))
  expect(await second.get(repository, 7)).toBeUndefined()
  expect(await second.claim(1)).toEqual([])
  expect((await first.claim(1)).map(claim => claim.snapshot.number)).toEqual([7])
  await state.disconnect()
})

it('keeps summaries equal to the stored snapshots after every mutation', async () => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository] })
  const consistent = async () => {
    const snapshots = await inbox.all()
    expect(await inbox.summary()).toEqual(snapshots.map(s => ({ repository: s.repository, number: s.number, head: s.pr?.head?.sha,
      generation: s.generation, handled: s.handled, status: s.status, reasons: s.reasons, wait: s.wait, dirty: s.generation > s.handled,
      attempts: s.attempts, nextAt: s.nextAt, lastResult: s.lastResult, progressBudget: s.progressBudget })))
  }
  await inbox.seed(repository, pr(7)); await consistent()
  const [claim] = await inbox.claim(1); await consistent()
  await inbox.ingest('comment', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 1, body: 'Fix', user: { login: 'human' } } })
  await consistent()
  await inbox.finish(claim!, { text: 'retry', retry: true }); await consistent()
  await inbox.ingest('close', 'pull_request', { repository: { full_name: repository }, action: 'closed', pull_request: pr(7, { state: 'closed', updated_at: '2026-09-13T11:00:00Z' }) })
  await consistent()
  await inbox.close()
})

it('claims from columns without parsing terminal snapshots and matches pushes by indexed refs', async () => {
  const path = join(await directory(), 'inbox.sqlite')
  const inbox = new PullRequestInbox({ path, repositories: [repository] })
  await inbox.seed(repository, pr(7))
  await inbox.seed(repository, pr(8, { state: 'closed' }))
  const db = new DatabaseSync(path)
  // A terminal row is never a claim candidate, so its snapshot is not parsed.
  db.prepare('UPDATE vitehub_babysitter_pull_requests SET value=? WHERE number=8').run('{"broken":true}')
  db.close()
  expect((await inbox.claim(5)).map(claim => claim.snapshot.number)).toEqual([7])
  const pushed = await inbox.ingest('push', 'push', { repository: { full_name: repository }, ref: 'refs/heads/fix-7', after: 'other' })
  expect(pushed.updated).toEqual([7])
  await inbox.close()
})

it('compacts terminal snapshots so historical evidence cannot grow the scheduler state', async () => {
  const path = join(await directory(), 'inbox.sqlite')
  const inbox = new PullRequestInbox({ path, repositories: [repository] })
  await inbox.seed(repository, pr(7))
  await inbox.ingest('comment', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 1, body: 'Fix', user: { login: 'human' } } })
  const [claim] = await inbox.claim(1)
  expect((await inbox.get(repository, 7))?.comments).toHaveProperty('1')
  await inbox.finish(claim!, { text: 'closed', terminal: true })
  const snapshot = await inbox.get(repository, 7)
  expect(snapshot?.status).toBe('terminal')
  expect(snapshot?.comments).toEqual({})
  expect(snapshot?.reviews).toEqual({})
  expect(snapshot?.checks).toEqual({})
  expect(snapshot?.threads).toEqual([])
  await inbox.close()
})

it('prunes delivery payloads and old delivery IDs', async () => {
  let now = 0
  const path = join(await directory(), 'inbox.sqlite')
  const inbox = new PullRequestInbox({ path, repositories: [repository], clock: () => now })
  await inbox.seed(repository, pr(7))
  await inbox.ingest('old', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 1, body: 'Old', user: { login: 'human' } } })
  now = 6 * 24 * 60 * 60_000
  await inbox.ingest('recent', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 2, body: 'New', user: { login: 'human' } } })
  await inbox.pruneDeliveries()
  const db = new DatabaseSync(path)
  const rows = db.prepare('SELECT id, payload IS NULL AS pruned FROM vitehub_babysitter_deliveries ORDER BY id').all()
  expect(rows.map(row => ({ ...row }))).toEqual([{ id: 'old', pruned: 1 }, { id: 'recent', pruned: 0 }])
  now = 14 * 24 * 60 * 60_000
  await inbox.pruneDeliveries()
  expect(db.prepare('SELECT id FROM vitehub_babysitter_deliveries').all().map(row => row.id)).toEqual([])
  db.close()
  await inbox.close()
})

it('imports an older inbox file once and converts its waits and leases', async () => {
  const root = await directory()
  const legacyPath = join(root, 'pull-request-inbox.sqlite')
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(`CREATE TABLE pr_snapshots (repository TEXT, number INTEGER, value TEXT NOT NULL, PRIMARY KEY(repository,number));
    CREATE TABLE deliveries (id TEXT PRIMARY KEY, event TEXT, received INTEGER, payload TEXT, result TEXT);
    CREATE TABLE inbox_meta (key TEXT PRIMARY KEY, value TEXT);`)
  const base = { repository: 'Vite-Hub/ViteHub', generation: 3, handled: 3, dirtyAt: 1, nextAt: 0, attempts: 0, hydrated: true, refresh: false, feedbackRefresh: false,
    comments: {}, reviews: {}, reviewComments: {}, checks: {}, statuses: {}, threads: [], reasons: [] }
  const insert = legacy.prepare('INSERT INTO pr_snapshots VALUES (?,?,?)')
  insert.run(repository, 7, JSON.stringify({ ...base, number: 7, pr: pr(7), status: 'waiting', lease: null, leaseUntil: 0,
    waitForChecks: { headSha: 'head-7', contextKey: 'context', knownFailures: [] } }))
  insert.run(repository, 8, JSON.stringify({ ...base, number: 8, pr: pr(8), generation: 4, status: 'working', lease: 'old-lease', leaseUntil: Date.now() + 60_000 }))
  insert.run(repository, 9, JSON.stringify({ ...base, number: 9, pr: pr(9), status: 'attention', lease: null, leaseUntil: 0, generation: 5 }))
  insert.run(repository, 10, '{"not":"a snapshot"}')
  legacy.prepare('INSERT INTO inbox_meta VALUES (?,?)').run(`bootstrap-rest-v1:${repository}`, JSON.stringify({ at: '2026-09-30T00:00:00Z' }))
  legacy.prepare('INSERT INTO inbox_meta VALUES (?,?)').run(`snapshot-probe:${repository}:7`, '123')
  legacy.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?)').run('delivery-1', 'issue_comment', Date.now(), '{}', '{}')
  legacy.close()

  const inbox = new PullRequestInbox({ path: join(root, 'state.sqlite'), repositories: [repository] })
  await inbox.setMeta(`bootstrap-rest-v1:${repository}`, { at: '2026-10-01T00:00:00Z' })
  expect(await inbox.importLegacyFile(legacyPath)).toEqual({ imported: true, snapshots: 3, skipped: 1, deliveries: 1 })
  expect(await inbox.importLegacyFile(legacyPath)).toMatchObject({ imported: false })
  expect((await inbox.get(repository, 7))?.wait).toEqual({ headSha: 'head-7', reason: 'checks', evidenceKey: 'context' })
  expect(await inbox.get(repository, 8)).toMatchObject({ lease: null, status: 'ready' })
  expect((await inbox.get(repository, 9))?.status).toBe('ready')
  expect(await inbox.meta(`bootstrap-rest-v1:${repository}`)).toEqual({ at: '2026-10-01T00:00:00Z' })
  expect(await inbox.meta(`snapshot-probe:${repository}:7`)).toBeUndefined()
  const duplicate = await inbox.ingest('delivery-1', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 3, body: 'Again', user: { login: 'human' } } })
  expect(duplicate.duplicate).toBe(true)
  // Imported snapshot 8 was claimable work with a stale lease; it is claimable again.
  expect((await inbox.claim(5)).map(claim => claim.snapshot.number)).toEqual([8, 9])
  await inbox.close()
})
