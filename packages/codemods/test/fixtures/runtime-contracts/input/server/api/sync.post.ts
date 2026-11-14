import { defineHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'
import { refuseOverLimit } from '../utils/rate-limit'

export default defineHandler(async (event) => {
  refuseOverLimit(await checkRateLimit(event, 'sync', { limit: 3, window: '1m' }))
  const { allowed, retryAfter } = await checkRateLimit(event, 'sync-search', { limit: 5, window: '1m' })
  await checkRateLimit(event, 'sync-touch', { limit: 5, window: '1m' })
  if (allowed && (await checkRateLimit(event, 'sync-burst', { limit: 1, window: '1s' })).allowed) return 'fresh'
  if (((await checkRateLimit(event, 'sync-twice', { limit: 1, window: '1s' }))).allowed) return 'twice'
  const noted = (await checkRateLimit(event, 'sync-noted', { limit: 1, window: '1s' }) /* ) */).allowed
  if (noted) return 'noted'
  return retryAfter
})

export const later = (event) => checkRateLimit(event, 'sync-later', { limit: 1, window: '1m' })
