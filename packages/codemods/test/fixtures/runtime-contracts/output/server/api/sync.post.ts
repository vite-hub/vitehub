import { defineHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'
import { refuseOverLimit } from '../utils/rate-limit'

export default defineHandler(async (event) => {
  const [checkRateLimitError, decision] = await checkRateLimit(event, 'sync', { limit: 3, window: '1m' })
  if (checkRateLimitError) throw checkRateLimitError
  refuseOverLimit(decision)
  const [checkRateLimitError2, decision2] = await checkRateLimit(event, 'sync-search', { limit: 5, window: '1m' })
  if (checkRateLimitError2) throw checkRateLimitError2
  const { allowed, retryAfter } = decision2
  const [checkRateLimitError3] = await checkRateLimit(event, 'sync-touch', { limit: 5, window: '1m' })
  if (checkRateLimitError3) throw checkRateLimitError3
  if (allowed && (await checkRateLimit(event, 'sync-burst', { limit: 1, window: '1s' })).allowed) return 'fresh'
  const [checkRateLimitError4, decision3] = await checkRateLimit(event, 'sync-twice', { limit: 1, window: '1s' })
  if (checkRateLimitError4) throw checkRateLimitError4
  if (((decision3)).allowed) return 'twice'
  const [checkRateLimitError5, decision4] = await checkRateLimit(event, 'sync-noted', { limit: 1, window: '1s' })
  if (checkRateLimitError5) throw checkRateLimitError5
  const noted = (decision4 /* ) */).allowed
  if (noted) return 'noted'
  return retryAfter
})

export const later = (event) => checkRateLimit(event, 'sync-later', { limit: 1, window: '1m' })
