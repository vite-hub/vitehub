import { defineEventHandler, getRouterParam } from 'h3'

// Nuxt auto-imports cancelWorkflow() and resumeWorkflow() in server code.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const [error] = await cancelWorkflow('onboard-user', id)
  if (error) throw error
  const [error2, signal] = await resumeWorkflow(`approve-${id}`, { approved: false })
  if (error2) throw error2
  if (signal.id) return { resumed: true }
  return { cancelled: true }
})
