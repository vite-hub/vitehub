import { createError } from 'h3'

export type ReleaseNotesPayload = {
  notes: string
}

export function validateReleaseNotesPayload(input: unknown): ReleaseNotesPayload {
  if (!input || typeof input !== 'object') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Enter release notes before running the sandbox.',
    })
  }

  const notes = typeof (input as { notes?: unknown }).notes === 'string'
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
