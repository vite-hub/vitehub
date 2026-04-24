import { createError, defineEventHandler, readBody } from "h3"
import { runSandbox } from "@vitehub/sandbox"

export default defineEventHandler(async (event) => {
  const result = await runSandbox("release-notes", await readBody(event))

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
