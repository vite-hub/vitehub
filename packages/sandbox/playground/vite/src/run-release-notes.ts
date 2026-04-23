import { createError, defineEventHandler } from 'h3'
import { readRequestPayload, readValidatedPayload, runSandbox } from '@vitehub/sandbox'

function readNotes(input: unknown) {
  const notes = input && typeof input === 'object' && typeof (input as { notes?: unknown }).notes === 'string'
    ? (input as { notes: string }).notes.trim()
    : ''

  if (!notes) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Enter release notes before running the sandbox.',
    })
  }

  return { notes }
}

export default defineEventHandler(async (event) => {
  const payload = await readValidatedPayload(await readRequestPayload(event), readNotes)
  const result = await runSandbox('release-notes', payload)

  if (result.isErr()) {
    throw createError({
      statusCode: 500,
      statusMessage: result.error.message,
      data: {
        code: result.error.code,
        provider: result.error.provider,
      },
    })
  }

  return { result: result.value }
})
