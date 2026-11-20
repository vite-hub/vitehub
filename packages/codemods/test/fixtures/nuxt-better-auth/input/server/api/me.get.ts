export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const auth = serverAuth(event)
  const accounts = await auth.api.listUserAccounts({ headers: event.req.headers })
  return { user: session?.user ?? null, accounts }
})
