import { defineCapability } from 'vite-hub/agent'
import { kv } from 'vite-hub/kv'
import { useSessionSnapshotStore } from './session-snapshots.ts'

export const prMemoryArtifactPath = 'PRMemory.md'

export type PRMemoryItem = {
  content: string
  createdAt: string
  head: string
  invocationId: string
  sources: string[]
}

export type PRMemory = {
  items: PRMemoryItem[]
  pullRequest: number
  repository: string
}

type PRMemoryContext = {
  head: string
  invocationId: string
  pullRequest: number
  repository: string
}

type PRMemoryStorage = Pick<typeof kv, 'get' | 'set'>

const appendInputSchema = {
  additionalProperties: false,
  properties: {
    items: {
      items: {
        additionalProperties: false,
        properties: {
          content: { description: 'Detailed Markdown preserving the finding, reasoning, affected hooks or behavior, and consequences.', minLength: 1, type: 'string' },
          sources: { description: 'URLs supporting this memory item.', items: { format: 'uri', type: 'string' }, minItems: 1, type: 'array' },
        },
        required: ['content', 'sources'],
        type: 'object',
      },
      minItems: 1,
      type: 'array',
    },
  },
  required: ['items'],
  type: 'object',
} as const

export function prMemoryKey(repository: string, pullRequest: number) {
  return `babysitter:pr-memory:${repository}:${pullRequest}`
}

export async function readPRMemory(repository: string, pullRequest: number, storage: PRMemoryStorage = kv): Promise<PRMemory> {
  const [error, stored] = await storage.get<PRMemory>(prMemoryKey(repository, pullRequest))
  if (error) throw error
  return stored ?? { items: [], pullRequest, repository }
}

export async function appendPRMemory(
  context: PRMemoryContext,
  input: { items: Array<{ content: string, sources: string[] }> },
  storage: PRMemoryStorage = kv,
  now = () => new Date().toISOString(),
) {
  const additions = input.items.map((item) => ({
    content: item.content.trim(),
    createdAt: now(),
    head: context.head,
    invocationId: context.invocationId,
    sources: item.sources.map(assertSourceUrl),
  }))
  if (additions.some(item => !item.content)) throw new Error('PR memory items require detailed content.')
  const current = await readPRMemory(context.repository, context.pullRequest, storage)
  const memory = { ...current, items: [...current.items, ...additions] }
  const [error] = await storage.set(prMemoryKey(context.repository, context.pullRequest), memory)
  if (error) throw error
  return memory
}

export function renderPRMemory(memory: PRMemory) {
  if (!memory.items.length) return '# PRMemory\n\nNo durable findings have been recorded for this pull request.\n'
  const items = memory.items.map(item => {
    const content = item.content.split('\n').map((line, index) => `${index ? '  ' : '- '}${line}`).join('\n')
    const sources = item.sources.map(source => `  - ${source}`).join('\n')
    return `${content}\n\n  Sources:\n${sources}\n\n  Recorded from \`${item.head}\` at ${item.createdAt}.`
  })
  return `# PRMemory\n\n${items.join('\n\n')}\n`
}

export function prMemoryCapability(context: PRMemoryContext) {
  return defineCapability({
    id: 'pr-memory',
    tools: {
      append_pr_memory: {
        name: 'append_pr_memory',
        description: 'Append durable, detailed findings to this pull request memory. Include reasoning, affected hooks or behavior, consequences, and supporting source URLs. Do not add transient status, completed-task narration, or instructions for a future agent.',
        inputSchema: appendInputSchema,
        async execute(input: { items: Array<{ content: string, sources: string[] }> }) {
          const memory = await appendPRMemory(context, input)
          const content = renderPRMemory(memory)
          useSessionSnapshotStore().setArtifact(context.invocationId, {
            content,
            mediaType: 'text/markdown',
            path: prMemoryArtifactPath,
          })
          return {
            added: input.items.length,
            artifact: { mediaType: 'text/markdown', path: prMemoryArtifactPath },
            total: memory.items.length,
          }
        },
      },
    },
  })
}

function assertSourceUrl(source: string) {
  const value = source.trim()
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new Error(`Invalid PR memory source URL: ${source}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Invalid PR memory source URL: ${source}`)
  return value
}
