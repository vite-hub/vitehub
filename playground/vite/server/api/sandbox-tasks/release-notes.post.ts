import { defineEventHandler, readBody } from "h3"

import { runSandboxTask } from "@vite-hub/sandbox/task"

export default defineEventHandler(async (event) => {
  const [error, result] = await runSandboxTask("release-notes", await readBody(event))
  if (error)
    throw error

  return { result }
})
