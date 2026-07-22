import { createError, defineEventHandler, readBody } from "h3"

import { runSandbox } from "@vite-hub/sandbox"

export default defineEventHandler(async (event) => {
  const [error, result] = await runSandbox("release-notes", await readBody(event))

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error.message,
      data: {
        code: error.code,
        provider: error.provider,
      },
    })
  }

  return { result }
})
