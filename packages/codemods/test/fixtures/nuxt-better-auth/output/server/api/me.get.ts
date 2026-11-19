export default defineEventHandler(async (event) => {
  const session = await useAuth(event).api.getSession({ headers: event.req.headers })
  const auth = useAuth(event)
  const accounts = await auth.api.listUserAccounts({ headers: event.req.headers })
  return { user: session?.user ?? null, accounts }
})
