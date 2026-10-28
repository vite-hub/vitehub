import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { publishAgentActivity } from '../src/index.ts'
import { createGitHubAppCredentials, createGitHubHost } from '../src/server/github-host.ts'

vi.mock('#vitehub/agent/registry', () => ({ default: {} }))
afterEach(() => vi.restoreAllMocks())

const repository = 'acme/app'
const appId = 4698907
const oldLogin = 'vitehub-bot[bot]'
const newLogin = 'vite-hub[bot]'
const marker = '<!-- vitehub-agent-activity:eyJoaXN0b3J5IjpbXSwicHJldmlvdXNSdW5JZHMiOltdfQ -->'
const comment = (id: number, login = newLogin, sourceApp = appId, body = `${marker}\n\nNew pull request evidence is queued.`) =>
  ({ id, body, user: { login, type: 'Bot' }, performed_via_github_app: { id: sourceApp }, updated_at: id === 10 ? '2026-10-28T13:00:00Z' : '2026-10-28T18:00:00Z' })

test('App credentials preserve the immutable ID used by the host and activity channel', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === '/app') return Response.json({ id: appId, slug: 'vitehub-bot' })
    assert.equal(url.pathname, `/users/${encodeURIComponent(oldLogin)}`)
    return Response.json({ id: 320448255, login: oldLogin })
  })
  const credentials = createGitHubAppCredentials({ appId, privateKey })
  const identity = await credentials.identity()
  assert.equal(identity.appId, appId)
  assert.equal(createGitHubHost({ credentials: credentials.credentials, identity }).appId?.(), appId)
})

test('host activity reuses the original App comment across a rename and restart', async () => {
  const comments = [comment(10), comment(11), comment(12, 'other[bot]', 99)]
  const state = { current: { agentName: 'babysitter-worker', runId: createHash('sha256').update('babysitter-worker\0first').digest('base64url'), status: 'queued', links: [], updatedAt: '2026-10-28T18:00:00Z' }, history: [], previousRunIds: [] }
  comments[1]!.body = `<!-- vitehub-agent-activity:${Buffer.from(JSON.stringify(state)).toString('base64url')} -->\n\nNew pull request evidence is queued.`
  const historicalBody = comments[1]!.body
  const writes: Array<{ method: string; id?: number }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (url.pathname === '/user') return Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
    if (method === 'GET') return Response.json(comments)
    const { body } = JSON.parse(String(init?.body))
    const id = method === 'PATCH' ? Number(url.pathname.split('/').at(-1)) : undefined
    writes.push({ method, id })
    if (id !== undefined) {
      const existing = comments.find(item => item.id === id)
      assert.ok(existing)
      existing.body = body
      existing.updated_at = '2026-10-28T19:00:00Z'
      return Response.json(existing)
    }
    const created = comment(comments.length + 20, newLogin, appId, body)
    comments.push(created)
    return Response.json(created)
  })
  const publish = async (runId: string) => {
    const host = createGitHubHost({ credentials: () => ({ token: 'fixture', rateLimitKey: 'fixture' }), identity: { login: oldLogin, appId } })
    vi.spyOn(host, 'access').mockImplementation(async () => ({ token: 'fixture', env: {} }))
    await publishAgentActivity({ name: 'babysitter-worker', channels: { github: host.channel({ activity: true }) } }, {
      channelId: 'github', target: { repository, issue: 64 },
      activity: { runId, status: 'waiting', links: [], tasks: [], summary: 'Waiting for parent.', updatedAt: '2026-10-28T18:00:00Z' },
    })
  }
  await publish('first')
  await publish('after-restart')
  assert.equal(comments.length, 3, 'a renamed App must edit its existing comment, never create another')
  assert.equal(writes.filter(item => item.method === 'POST').length, 0)
  assert.match(comments[0]!.body, /Waiting for parent/)
  assert.equal(comments[1]!.body, historicalBody, 'publishing current status does not rewrite historical duplicates')
  assert.equal(comments[2]!.body, comment(12, 'other[bot]', 99).body, 'another App owns its own comment')
  assert.deepEqual(writes, [{ method: 'PATCH', id: 10 }, { method: 'PATCH', id: 10 }])
})

