import { defineHandler } from 'h3'
import { checkRateLimit } from 'vite-hub/rate-limit'

export default defineHandler(async (event) => {
  if (!(await checkRateLimit(event, 'preview', { limit: 5, window: '1m' })).allowed) return 'cached'
  const [checkRateLimitError, first] = await checkRateLimit(event, 'preview-a', { limit: 5, window: '1m' });
  if (checkRateLimitError) throw checkRateLimitError;
  const [checkRateLimitError2, second] = await checkRateLimit(event, 'preview-b', { limit: 5, window: '1m' });
  if (checkRateLimitError2) throw checkRateLimitError2;
  return first.allowed && second.allowed ? 'fresh' : 'cached';
})
