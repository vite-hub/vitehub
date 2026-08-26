import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionSnapshotStore } from '../server/session-snapshots.ts'
import { sessionTimelineObservations } from '../server/session-timeline.ts'

test('stores immutable workspace references and ordered preparation events', () => {
  const snapshots = createSessionSnapshotStore(':memory:')
  snapshots.create({
    invocationId: 'run-1',
    pullRequest: 42,
    repository: 'vite-hub/example',
    revision: '0123456789012345678901234567890123456789',
    sourceRepository: 'contributor/example',
  }, '2026-08-24T10:00:00.000Z')
  snapshots.record('run-1', {
    name: 'babysitter.workspace.materialized',
    title: 'Workspace materialized',
    detail: '2 files at 0123456',
    inspector: 'workspace',
    timestamp: '2026-08-24T10:00:01.000Z',
  })
  snapshots.setAgent('run-1', {
    agent: { name: 'babysitter' },
    driver: { kind: 'provider', model: { id: 'gpt-5.6-sol', provider: 'openai' } },
    instructions: ['System instructions'],
    tools: [{ name: 'github' }],
  }, '2026-08-24T10:00:01.500Z')
  snapshots.setPaths('run-1', ['src/index.ts', 'README.md', 'src/index.ts'], '2026-08-24T10:00:02.000Z')

  assert.deepEqual(snapshots.get('run-1'), {
    agent: {
      agent: { name: 'babysitter' },
      driver: { kind: 'provider', model: { id: 'gpt-5.6-sol', provider: 'openai' } },
      instructions: ['System instructions'],
      tools: [{ name: 'github' }],
    },
    createdAt: '2026-08-24T10:00:00.000Z',
    events: [{
      name: 'babysitter.workspace.materialized',
      title: 'Workspace materialized',
      detail: '2 files at 0123456',
      inspector: 'workspace',
      timestamp: '2026-08-24T10:00:01.000Z',
    }],
    invocationId: 'run-1',
    paths: ['README.md', 'src/index.ts'],
    pullRequest: 42,
    repository: 'vite-hub/example',
    revision: '0123456789012345678901234567890123456789',
    sourceRepository: 'contributor/example',
    updatedAt: '2026-08-24T10:00:02.000Z',
  })
  assert.equal(snapshots.getPrepared(
    'vite-hub/example',
    '0123456789012345678901234567890123456789',
    42,
  )?.agent?.driver?.model?.provider, 'openai')
  assert.equal(snapshots.getPrepared('vite-hub/example', 'missing', 42), undefined)
  assert.deepEqual(snapshots.stats(), { count: 1, updatedAt: '2026-08-24T10:00:02.000Z' })
  snapshots.close()
})

test('resolves prepared session data through the recorded Agent run id', () => {
  const snapshots = createSessionSnapshotStore(':memory:')
  snapshots.create({
    invocationId: 'scheduled-run-1',
    pullRequest: 42,
    repository: 'vite-hub/example',
    revision: '0123456789012345678901234567890123456789',
  }, '2026-08-24T10:00:00.000Z')
  snapshots.record('scheduled-run-1', {
    detail: '2 files at 0123456',
    inspector: 'workspace',
    name: 'babysitter.workspace.materialized',
    timestamp: '2026-08-24T10:00:01.000Z',
    title: 'Workspace materialized',
  })
  snapshots.setPaths('scheduled-run-1', ['README.md', 'src/index.ts'])

  snapshots.create({
    invocationId: 'sha256_invocation',
    pullRequest: 42,
    repository: 'vite-hub/example',
    revision: '0123456789012345678901234567890123456789',
  }, '2026-08-24T10:00:02.000Z')

  const resolved = snapshots.getForInvocation({
    id: 'sha256_invocation',
    observations: [{ attributes: { 'agent.run.id': 'scheduled-run-1' } }],
  })

  assert.equal(resolved?.invocationId, 'scheduled-run-1')
  assert.deepEqual(resolved?.paths, ['README.md', 'src/index.ts'])
  assert.deepEqual(resolved?.events.map(event => event.name), ['babysitter.workspace.materialized'])
  snapshots.close()
})

test('places ViteHub lifecycle actions around the Agent observations', () => {
  const observations = sessionTimelineObservations([
    {
      detail: 'vite-hub/example · PR #42',
      name: 'babysitter.pull-request.selected',
      timestamp: '2026-08-24T10:00:00.000Z',
      title: 'Pull request selected',
    },
    {
      detail: 'Agent: Queued',
      kind: 'action',
      name: 'babysitter.github.label.queued',
      phase: 'before',
      timestamp: '2026-08-24T10:00:00.500Z',
      title: 'Added Agent: Queued',
    },
    {
      detail: 'Agent: Working',
      kind: 'action',
      name: 'babysitter.github.label.working',
      phase: 'before',
      timestamp: '2026-08-24T10:00:00.750Z',
      title: 'Added Agent: Working',
    },
    {
      delivery: { intent: 'started', kind: 'reaction' },
      detail: 'GitHub pull request',
      kind: 'delivery',
      name: 'babysitter.github.reaction.started',
      phase: 'before',
      timestamp: '2026-08-24T10:00:01.000Z',
      title: 'Reacted with eyes',
    },
    {
      detail: 'Posted the Agent final result',
      kind: 'delivery',
      name: 'babysitter.github.status.finished',
      phase: 'after',
      timestamp: '2026-08-24T10:01:00.000Z',
      title: 'GitHub result posted',
    },
  ], [{ attributes: {}, name: 'agent.message', sequence: 4, timestamp: '2026-08-24T10:00:02.000Z', type: 'event' }])

  assert.deepEqual(observations.map(observation => observation.sequence), [-4, -3, -2, -1, 4, 5])
  assert.deepEqual(observations.map(observation => observation.attributes?.['vitehub.activity.kind']), ['preparation', 'action', 'action', 'delivery', undefined, 'delivery'])
  assert.equal(observations[1]!.attributes?.['vitehub.activity.group'], 'github-lifecycle')
  assert.equal(observations[1]!.attributes?.['github.label.name'], 'Agent: Queued')
  assert.equal(observations[1]!.attributes?.['github.label.color'], 'd0d7de')
  assert.equal(observations[1]!.attributes?.['github.label.operation'], 'added')
  assert.equal(observations[2]!.attributes?.['vitehub.activity.group'], 'github-lifecycle')
  assert.equal(observations[2]!.attributes?.['github.label.name'], 'Agent: Working')
  assert.equal(observations[2]!.attributes?.['github.label.color'], '54aeff')
  assert.equal(observations[2]!.attributes?.['github.label.operation'], 'added')
  assert.equal(observations[3]!.attributes?.['channel.effect.kind'], 'reaction')
  assert.equal(observations[3]!.attributes?.['vitehub.activity.group'], 'github-lifecycle')
  assert.equal(observations[5]!.attributes?.['vitehub.activity.title'], 'GitHub result posted')
})
