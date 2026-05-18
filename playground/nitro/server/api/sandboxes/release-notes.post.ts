import { defineEventHandler, readBody, setResponseStatus } from "h3"
import { runSandbox } from "@vitehub/sandbox"

export default defineEventHandler(async (event) => {
  try {
    const result = await runSandbox("release-notes", await readBody(event))

    if (result.isErr()) {
      setResponseStatus(event, 500)
      return {
        code: result.error.code,
        message: result.error.message,
        provider: result.error.provider,
      }
    }

    return { result: result.value }
  }
  catch (error) {
    setResponseStatus(event, 500)
    return {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    }
  }
})
