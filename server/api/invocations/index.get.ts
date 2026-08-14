import { defineEventHandler, getQuery } from 'h3'
import { invocations } from '../../invocations.ts'

export default defineEventHandler((event) => {
  const cursor = getQuery(event).cursor
  return invocations.list(typeof cursor === 'string' ? { cursor } : undefined)
})
