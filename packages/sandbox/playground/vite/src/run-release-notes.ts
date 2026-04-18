import { createError, defineEventHandler } from 'h3'
import { readRequestPayload, readValidatedPayload, runSandbox } from '@vitehub/sandbox'
import { validateReleaseNotesPayload } from './release-notes-example'

export default defineEventHandler(async (event) => {
  const payload = await readValidatedPayload(await readRequestPayload(event), validateReleaseNotesPayload)
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
