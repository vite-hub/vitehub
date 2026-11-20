export default defineEventHandler(async (event) => {
  const { user } = await requireAuth(event)
  return { owner: user.id }
})
