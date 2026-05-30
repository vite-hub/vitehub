import { getWorkflowRun } from "@vite-hub/workflow"

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id")
  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing workflow run id.",
    })
  }

  return await getWorkflowRun("welcome", id)
})
