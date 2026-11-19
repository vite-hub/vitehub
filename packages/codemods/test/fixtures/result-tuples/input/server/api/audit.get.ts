import { aggregateAuthEvents, listAuthEvents } from '@vite-hub/auth/server'

export default async () => {
  const page = await listAuthEvents({ type: 'user.signed_in', limit: 50 })
  return { events: page.events, totals: await aggregateAuthEvents({ groupBy: 'type' }) }
}
