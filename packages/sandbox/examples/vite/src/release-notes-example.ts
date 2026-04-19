import { createError } from 'h3'

export type ReleaseNotesPayload = {
  notes: string
}

export type SandboxProbeData = {
  hasWaitUntil: boolean
  hosting: string | null
  provider: string | null
  runtime: string | null
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

export function getSandboxProbeData(input: SandboxProbeData) {
  return {
    ok: true,
    feature: 'sandbox',
    hasWaitUntil: input.hasWaitUntil,
    hosting: input.hosting,
    provider: input.provider,
    runtime: input.runtime,
  }
}
