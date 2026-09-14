import { defineEventHandler, readBody } from "h3"

import { runSandbox } from "@vite-hub/sandbox"

export default defineEventHandler(async (event) => {
  const response = await runSandbox("release-notes", await readBody(event))
  if (!response.ok)
    return response

  return { result: await response.json() }
})
