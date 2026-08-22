import { defineEventHandler, getQuery } from 'h3'
import { invocations } from '../../invocations.ts'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined
  const search = typeof query.search === 'string' ? query.search : undefined
  return invocations.list({ cursor, limit: 50, search })
})
