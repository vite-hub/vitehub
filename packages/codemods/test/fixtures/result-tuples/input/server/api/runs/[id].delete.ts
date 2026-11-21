import { defineEventHandler, getRouterParam } from 'h3'

// Nuxt auto-imports cancelWorkflow() and resumeWorkflow() in server code.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await cancelWorkflow('onboard-user', id)
  if ((await resumeWorkflow(`approve-${id}`, { approved: false })).id) return { resumed: true }
  return { cancelled: true }
})
