import { defineHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'

export default defineHandler(async (event) => {
  const [checkRateLimitError, decision] = await checkRateLimit(event, 'preview', { limit: 5, window: '1m' })
  if (checkRateLimitError) throw checkRateLimitError
  if (!decision.allowed) return 'cached'
  const [checkRateLimitError2, first] = await checkRateLimit(event, 'preview-a', { limit: 5, window: '1m' });
  if (checkRateLimitError2) throw checkRateLimitError2;
  const [checkRateLimitError3, second] = await checkRateLimit(event, 'preview-b', { limit: 5, window: '1m' });
  if (checkRateLimitError3) throw checkRateLimitError3;
  return first.allowed && second.allowed ? 'fresh' : 'cached';
})
