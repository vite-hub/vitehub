import { defineHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'
import { refuseOverLimit } from '../utils/rate-limit'

export default defineHandler(async (event) => {
  const [checkRateLimitError, decision] = await checkRateLimit(event, 'sync', { limit: 3, window: '1m' })
  if (checkRateLimitError) throw checkRateLimitError
  refuseOverLimit(decision)
  const [checkRateLimitError2, { allowed, retryAfter }] = await checkRateLimit(event, 'sync-search', { limit: 5, window: '1m' })
  if (checkRateLimitError2) throw checkRateLimitError2
  const [checkRateLimitError3] = await checkRateLimit(event, 'sync-touch', { limit: 5, window: '1m' })
  if (checkRateLimitError3) throw checkRateLimitError3
  if (allowed && (await checkRateLimit(event, 'sync-burst', { limit: 1, window: '1s' })).allowed) return 'fresh'
  return retryAfter
})

export const later = (event) => checkRateLimit(event, 'sync-later', { limit: 1, window: '1m' })
