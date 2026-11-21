import { aggregateAuthEvents, listAuthEvents } from '@vite-hub/auth/server'

export default async () => {
  const [pageError, page] = await listAuthEvents({ type: 'user.signed_in', limit: 50 })
  if (pageError) throw pageError
  return { events: page.events, totals: await aggregateAuthEvents({ groupBy: 'type' }) }
}
