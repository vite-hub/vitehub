import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('uses demand reconciliation instead of a fixed schedule', async () => {
  const [config, plugin, runner] = await Promise.all([
    readFile(new URL('../vite.config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/plugins/babysitter-demand.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/babysitter.schedule.ts', import.meta.url), 'utf8'),
  ])

  assert.match(config, /schedule: false/)
  assert.doesNotMatch(runner, /defineSchedule|runPullRequestJobs/)
  assert.match(plugin, /wake\('startup'\)/)
  assert.match(plugin, /wake\('owner-completed'\)/)
  assert.match(plugin, /repairIntervalMs = 30_000/)
  assert.match(plugin, /if \(running\) \{\s+rerun = true/)
  assert.match(runner, /availableOwnerSlots = Math\.max\(0, ownerLimit - runningJobs\.size\)/)
  assert.match(runner, /\.slice\(0, availableOwnerSlots\)/)
  assert.match(runner, /if \(isGitHubRateLimitError\(error\)\) return \[\]/)
})

test('keeps pull request discovery bounded while preserving feedback fingerprints', async () => {
  const runner = await readFile(new URL('../server/babysitter.schedule.ts', import.meta.url), 'utf8')
  const fields = runner.match(/const pullRequestFields = '([^']+)'/)?.[1]?.split(',')

  assert.ok(fields)
  assert.equal(fields.includes('comments'), false)
  assert.equal(fields.includes('reviews'), false)
  assert.equal(fields.includes('labels'), true)
  assert.match(runner, /comments\(last:1\)\{totalCount nodes\{id\}\}/)
  assert.match(runner, /reviews\(last:1\)\{totalCount nodes\{id\}\}/)
})
