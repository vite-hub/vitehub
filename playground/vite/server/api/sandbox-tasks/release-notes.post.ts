import { defineEventHandler, readBody } from "h3"

import { runSandboxTask } from "@vite-hub/sandbox-task"

export default defineEventHandler(async (event) => {
  const response = await runSandboxTask("release-notes", await readBody(event))
  if (!response.ok)
    return response

  return { result: await response.json() }
})
