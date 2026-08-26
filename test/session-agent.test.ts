import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInspectionMetadata } from 'vite-hub/agent'
import { sessionAgentConfiguration } from '../server/session-agent.ts'

test('projects materialized Agent inspection metadata into persisted UI configuration', () => {
  assert.deepEqual(sessionAgentConfiguration({
    capabilities: [{ id: 'github', metadata: { preset: 'code-review' } }],
    config: { driver: {
      executionAuthority: 'provider',
      kind: 'provider',
      provider: { model: 'gpt-5.6-sol', provider: 'openai' },
    } },
    files: [
      { kind: 'file', path: 'AGENTS.md', source: 'repository' },
      { kind: 'file', path: 'README.md', source: 'repository' },
    ],
    instructions: ['System instructions'],
    name: 'babysitter',
    tools: [{ name: 'github' }],
    version: '1',
  } as unknown as AgentInspectionMetadata), {
    agent: { name: 'babysitter', version: '1' },
    capabilities: [{ id: 'github', metadata: { preset: 'code-review' } }],
    driver: {
      kind: 'provider',
      model: { id: 'gpt-5.6-sol', provider: 'openai' },
      provider: 'openai',
    },
    instructions: ['System instructions'],
    runtime: { name: 'ViteHub' },
    tools: [{ name: 'github' }],
    workspace: { mode: 'write', name: 'Pull request checkout', sources: ['repository'] },
  })
})
