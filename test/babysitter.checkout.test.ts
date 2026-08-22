import assert from 'node:assert/strict'
import test from 'node:test'
import { withPullRequestCheckout } from '../server/babysitter.checkout.ts'
import type { PullRequest } from '../server/babysitter.queue.ts'

test('launches the owner without installing consumer dependencies', async () => {
  const checkout = '/tmp/babysitter-checkout-test'
  const commands: string[] = []
  let launched = false
  let removed = false
  const pullRequest: PullRequest = {
    body: '',
    comments: [],
    headRefName: 'feature',
    headRefOid: 'expected-head',
    headRepository: { nameWithOwner: 'example/fork' },
    isDraft: true,
    mergeStateStatus: 'CLEAN',
    number: 1,
    reviewDecision: null,
    reviews: [],
    state: 'OPEN',
    statusCheckRollup: [],
    title: 'Feature',
    updatedAt: '2026-07-17T00:00:00Z',
    url: 'https://github.com/example/repo/pull/1',
  }

  await withPullRequestCheckout('example/repo', pullRequest, async preparedCheckout => {
    launched = true
    assert.equal(preparedCheckout, checkout)
  }, {
    async makeTemporaryDirectory() {
      return checkout
    },
    async remove(path) {
      assert.equal(path, checkout)
      removed = true
    },
    async runCommand(file, args) {
      commands.push([file, ...args].join(' '))
      if (file === 'corepack') throw new Error('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH')
      return { stdout: args.at(-1) === 'HEAD' ? 'expected-head\n' : '' }
    },
  })

  assert.equal(launched, true)
  assert.equal(removed, true)
  assert.equal(commands.some(command => command.startsWith('corepack ')), false)
})
