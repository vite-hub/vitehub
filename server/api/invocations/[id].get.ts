import { createError, defineEventHandler, getRouterParam } from 'h3'
import { invocations } from '../../invocations.ts'

export default defineEventHandler(async (event) => {
  const invocation = await invocations.get(getRouterParam(event, 'id') || '')
  if (!invocation) throw createError({ status: 404, statusText: 'Invocation not found' })
  const { observations, ...summary } = invocation
  return { invocation: summary, observations }
})
