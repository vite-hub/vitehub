import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLibsqlAgentState } from '@vite-hub/agent/state'
import { claimStopReason } from '../src/babysitter/inbox/claim-state.ts'
import { PullRequestInbox } from '../src/babysitter/inbox/store.ts'

const repository = 'vite-hub/vitehub'
const hours = 60 * 60_000
const pr = (number: number) => ({ number, state: 'open', user: { login: 'onmax' },
  head: { sha: `head-${number}`, ref: `fix-${number}` }, base: { sha: 'base', ref: 'main' }, updated_at: '2026-11-23T10:00:00Z' })
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function sharedState() {
  const directory = await mkdtemp(join(tmpdir(), 'vitehub-inbox-clock-'))
  directories.push(directory)
  return createLibsqlAgentState({ url: `file:${join(directory, 'state.db')}` })
}

async function withHostClock<T>(skewMs: number, run: () => Promise<T>): Promise<T> {
  const now = Date.now
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now() + skewMs)
  try {
    return await run()
  }
  finally {
    spy.mockRestore()
  }
}

it.each([
  ['a slow claimer and a correct taker', -3 * hours, 0],
  ['a correct claimer and a fast taker', 0, 3 * hours],
])('keeps a live lease when host clocks disagree: %s', async (_, claimerSkew, takerSkew) => {
  const state = await sharedState()
  const storage = state.extension('babysitter')
  const claimer = new PullRequestInbox({ storage, repositories: [repository] })
  const taker = new PullRequestInbox({ storage, repositories: [repository] })
  const [claim] = await withHostClock(claimerSkew, async () => {
    await claimer.seed(repository, pr(7))
    return await claimer.claim(1)
  })
  expect(claim?.snapshot.number).toBe(7)

  const stolen = await withHostClock(takerSkew, async () => {
    const claims = await taker.claim(1)
    const current = await taker.get(repository, 7)
    return { claims, stop: claimStopReason(claim!, current, undefined, taker.now()) }
  })
  expect(stolen.claims).toEqual([])
  expect(stolen.stop).toBeUndefined()

  const renewed = await withHostClock(claimerSkew, async () => await claimer.renew(claim!, claimer.now() + 2 * hours))
  expect(renewed).toBe(true)
  await state.disconnect()
})

it('does not reclaim a live lease after the host clock steps forward', async () => {
  const state = await sharedState()
  try {
    const storage = state.extension('babysitter')
    const claimer = new PullRequestInbox({ storage, repositories: [repository] })
    const taker = new PullRequestInbox({ storage, repositories: [repository] })
    await claimer.seed(repository, pr(7))
    const [claim] = await claimer.claim(1)
    expect(claim?.snapshot.number).toBe(7)
    expect(await taker.claim(1)).toEqual([])
    await withHostClock(3 * hours, async () => {
      expect(await taker.claim(1)).toEqual([])
      expect(claimStopReason(claim!, await claimer.get(repository, 7), undefined, claimer.now())).toBeUndefined()
    })
  }
  finally {
    await state.disconnect()
  }
})

it('keeps the clock option for tests', async () => {
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: [repository], clock: () => 1_000 })
  expect(inbox.now()).toBe(1_000)
  await inbox.seed(repository, pr(7))
  expect(inbox.now()).toBe(1_000)
})
