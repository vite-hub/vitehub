import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentResultText,
  ensureLifecycleLabels,
  finishPullRequestLifecycle,
  markPullRequestQueued,
  queuedLabel,
  startPullRequestLifecycle,
  workingLabel,
} from '../server/babysitter.github-lifecycle.ts'

test('moves a pull request through queued and working labels and updates one status comment', async () => {
  const labels = new Set(['ready-for-agent'])
  const comments: { body: string, html_url: string, id: number, user: { login: string } }[] = []
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    const path = args.find(value => value.startsWith('repos/')) || ''
    const method = args[args.indexOf('--method') + 1]
    if (args[0] === 'label') return { stdout: '' }
    if (path.endsWith('/issues/42') && args.includes('--jq')) return { stdout: [...labels].join('\n') }
    if (path.endsWith('/issues/42/labels') && method === 'POST') {
      labels.add(args.find(value => value.startsWith('labels[]='))!.slice('labels[]='.length))
      return { stdout: '{}' }
    }
    if (path.includes('/issues/42/labels/') && method === 'DELETE') {
      labels.delete(decodeURIComponent(path.split('/').at(-1)!))
      return { stdout: '' }
    }
    if (path.includes('/issues/42/comments?')) return { stdout: JSON.stringify([comments]) }
    if (path.endsWith('/issues/42/comments') && method === 'POST') {
      const body = args.find(value => value.startsWith('body='))!.slice('body='.length)
      const comment = { body, html_url: 'https://github.com/vite-hub/example/pull/42#issuecomment-7', id: 7, user: { login: 'vitehub-bot[bot]' } }
      comments.push(comment)
      return { stdout: JSON.stringify(comment) }
    }
    if (path.endsWith('/issues/comments/7') && method === 'PATCH') {
      comments[0]!.body = args.find(value => value.startsWith('body='))!.slice('body='.length)
      return { stdout: JSON.stringify(comments[0]) }
    }
    if (path.endsWith('/issues/42/reactions') && method === 'POST') return { stdout: '{}' }
    throw new Error(`Unexpected GitHub call: ${args.join(' ')}`)
  }

  await ensureLifecycleLabels('vite-hub/example', run)
  await markPullRequestQueued('vite-hub/example', 42, run)
  assert.deepEqual(labels, new Set([queuedLabel]))

  const lifecycle = await startPullRequestLifecycle('vite-hub/example', 42, 'scheduled run:42', run)
  assert.deepEqual(labels, new Set([workingLabel]))
  assert.equal(comments.length, 1)
  assert.match(comments[0]!.body, /Babysitter is working/)
  assert.match(comments[0]!.body, /invocation=scheduled%20run%3A42/)

  await finishPullRequestLifecycle('vite-hub/example', 42, lifecycle, { text: 'Merged after focused tests passed.' }, run)
  assert.deepEqual(labels, new Set())
  assert.equal(comments.length, 1)
  assert.match(comments[0]!.body, /Merged after focused tests passed\./)
  assert.doesNotMatch(comments[0]!.body, /Babysitter is working/)
  assert.equal(calls.filter(args => args.includes('content=eyes')).length, 1)
})

test('extracts only a usable final response from an Agent result', () => {
  assert.equal(agentResultText({ text: '  Ready to merge.  ' }), 'Ready to merge.')
  assert.equal(agentResultText({ raw: 'not the rendered result' }), undefined)
  assert.equal(agentResultText('  Closed as obsolete. '), 'Closed as obsolete.')
})

test('uses only the last assistant message when an invocation record is available', () => {
  const observations = [
    { attributes: { 'message.content': 'I am inspecting CI.', 'message.role': 'assistant' }, name: 'agent.message.delta' },
    { attributes: { 'tool.name': 'run command' }, name: 'agent.tool.finish' },
    { attributes: { 'message.content': 'Stopped unchanged. Required CI is pending.', 'message.role': 'assistant' }, name: 'agent.message.delta' },
    { attributes: { 'finish.reason': 'completed' }, name: 'agent.stream.finish' },
  ]

  assert.equal(
    agentResultText({ text: 'I am inspecting CI.Stopped unchanged. Required CI is pending.' }, observations),
    'Stopped unchanged. Required CI is pending.',
  )
  assert.equal(agentResultText({ text: 'Do not leak this fallback.' }, []), undefined)
})
