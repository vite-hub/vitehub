export default defineEventHandler(async (event) => {
  await requireUserSession(event, { user: { plan: ['pro', 'team'] } })
  return { plan: 'pro' }
})
